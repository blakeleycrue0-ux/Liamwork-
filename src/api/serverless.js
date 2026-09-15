import serverless from 'serverless-http';

/**
 * Bridges a web-platform Request/Response (the Netlify Functions v2 signature)
 * to the Express app through serverless-http, which speaks AWS-style events.
 *
 * Kept in src/ instead of netlify/ so it can be unit-tested without deploying.
 */
export function createRequestHandler(app) {
  const handler = serverless(app, { provider: 'aws' });

  return async function handleRequest(request, context = {}) {
    const url = new URL(request.url);

    const headers = {};
    const multiValueHeaders = {};
    for (const [key, value] of request.headers) {
      headers[key] = value;
      multiValueHeaders[key] = key === 'cookie' ? value.split('; ') : [value];
    }

    const queryStringParameters = {};
    const multiValueQueryStringParameters = {};
    for (const [key, value] of url.searchParams) {
      queryStringParameters[key] = value;
      (multiValueQueryStringParameters[key] ||= []).push(value);
    }

    const hasBody = !['GET', 'HEAD'].includes(request.method);
    const bodyBuffer = hasBody ? Buffer.from(await request.arrayBuffer()) : null;

    const sourceIp =
      request.headers.get('x-nf-client-connection-ip') ||
      request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
      context?.ip ||
      '127.0.0.1';

    const event = {
      httpMethod: request.method,
      path: url.pathname,
      headers,
      multiValueHeaders,
      queryStringParameters: Object.keys(queryStringParameters).length ? queryStringParameters : null,
      multiValueQueryStringParameters: Object.keys(multiValueQueryStringParameters).length
        ? multiValueQueryStringParameters
        : null,
      body: bodyBuffer?.length ? bodyBuffer.toString('base64') : null,
      isBase64Encoded: Boolean(bodyBuffer?.length),
      requestContext: {
        http: { method: request.method, path: url.pathname, sourceIp },
        identity: { sourceIp },
        protocol: 'HTTP/1.1',
      },
    };

    const result = await handler(event, {});

    const responseHeaders = new Headers();
    for (const [key, value] of Object.entries(result.headers ?? {})) {
      if (value !== undefined && value !== null) responseHeaders.set(key, String(value));
    }
    // Repeated headers (Set-Cookie above all) arrive here, not in `headers`.
    for (const [key, values] of Object.entries(result.multiValueHeaders ?? {})) {
      responseHeaders.delete(key);
      for (const value of [].concat(values)) responseHeaders.append(key, String(value));
    }

    const empty = result.statusCode === 204 || result.statusCode === 304 || !result.body;
    const body = empty
      ? null
      : result.isBase64Encoded
        ? Buffer.from(result.body, 'base64')
        : result.body;

    return new Response(body, { status: result.statusCode, headers: responseHeaders });
  };
}
