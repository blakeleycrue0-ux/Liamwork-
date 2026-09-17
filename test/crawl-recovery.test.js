import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

/**
 * Las dos formas en que un servidor sano rechaza una primera petición buena.
 *
 * Sundsvall lleva días contestando 403 y Hagge "fetch failed". Ninguno de los
 * dos se puede alcanzar desde aquí, así que lo que se prueba no es "ese sitio
 * concreto ya funciona" - eso sólo lo puede decir una comprobación real -,
 * sino que el crawler sabe recuperarse de las dos situaciones que producen
 * exactamente esos dos mensajes. Servidores de verdad, peticiones de verdad,
 * sin simulacros ni monkeypatching.
 */

const { fetchText, HttpError, NetworkError } = await import('../src/crawler/httpClient.js');

/** Levanta un servidor y devuelve su URL, más lo que fue recibiendo. */
async function serve(handler) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, host: req.headers.host, cookie: req.headers.cookie ?? null, headers: req.headers });
    handler(req, res, seen.length);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/`,
    seen,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/* ============ 1) EL 403 CON COOKIE (el caso de Sundsvall) ============== */

test('un 403 que deja una cookie se reintenta con ella, y entra', async () => {
  // Es lo que hace un cortafuegos tipo Cloudflare: rechaza la primera y de
  // paso te entrega __cf_bm. Un navegador la guarda y vuelve a pedir.
  const site = await serve((req, res, nth) => {
    if (nth === 1) {
      res.writeHead(403, {
        'set-cookie': ['__cf_bm=abc123; Path=/; HttpOnly', 'otra=1; Path=/'],
        'content-type': 'text/html',
      });
      return res.end('<html><body>Just a moment...</body></html>');
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<html><body><h1>Välkommen till klubben</h1></body></html>');
  });

  try {
    const page = await fetchText(site.url);
    assert.match(page.body, /Välkommen till klubben/, 'la segunda petición trae la página');
    assert.equal(site.seen.length, 2, 'exactamente un reintento, ni uno más');
    assert.equal(site.seen[0].cookie, null, 'la primera va sin cookie, como debe');
    assert.match(site.seen[1].cookie, /__cf_bm=abc123/, 'la segunda devuelve lo que le dieron');
    assert.match(site.seen[1].cookie, /otra=1/, 'todas las cookies, no sólo la primera');
  } finally {
    await site.close();
  }
});

test('un 403 sin cookie no se reintenta: no habría nada distinto que enviar', async () => {
  const site = await serve((req, res) => {
    res.writeHead(403, { 'content-type': 'text/plain' });
    res.end('Forbidden');
  });

  try {
    await assert.rejects(() => fetchText(site.url), (error) => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.status, 403, 'y el 403 se cuenta tal cual, sin maquillar');
      return true;
    });
    assert.equal(site.seen.length, 1, 'una sola petición');
  } finally {
    await site.close();
  }
});

test('si el reintento con cookie también falla, gana el error real', async () => {
  // Lo importante: NO se marca como correcta una web que sigue rechazando.
  const site = await serve((req, res) => {
    res.writeHead(403, { 'set-cookie': ['__cf_bm=x; Path=/'] });
    res.end('no');
  });

  try {
    await assert.rejects(() => fetchText(site.url), (error) => {
      assert.equal(error.status, 403);
      return true;
    });
    assert.equal(site.seen.length, 2, 'lo intentó dos veces y se rindió');
  } finally {
    await site.close();
  }
});

test('un 404 no se reintenta aunque traiga cookies', async () => {
  // Una página que no existe no existe más por pedirla otra vez.
  const site = await serve((req, res) => {
    res.writeHead(404, { 'set-cookie': ['sesion=1; Path=/'] });
    res.end('no existe');
  });

  try {
    await assert.rejects(() => fetchText(site.url), { status: 404 });
    assert.equal(site.seen.length, 1);
  } finally {
    await site.close();
  }
});

/* ============ 2) LA CONEXIÓN QUE NO ABRE (el caso de Hagge) ============ */

test('si el dominio no abre, se prueba el gemelo con www', async () => {
  // Un puerto cerrado en localhost da el mismo ECONNREFUSED que un dominio
  // que no resuelve: la conexión no llega a existir.
  const cerrado = await serve(() => {});
  const puertoMuerto = new URL(cerrado.url).port;
  await cerrado.close();

  await assert.rejects(() => fetchText(`http://127.0.0.1:${puertoMuerto}/`), (error) => {
    assert.ok(error instanceof NetworkError, 'llega como fallo de red, no como "fetch failed"');
    assert.match(error.message, /conexión|conectar/i, 'y con una causa en castellano');
    return true;
  });
});

test('el gemelo se prueba UNA vez y sólo ante un fallo de conexión', async () => {
  // Con una respuesta HTTP -sea la que sea- no hay nada que adivinar: el
  // servidor contestó, así que probar otro nombre sería inventarse un sitio.
  const site = await serve((req, res) => {
    res.writeHead(500);
    res.end('roto');
  });

  try {
    await assert.rejects(() => fetchText(site.url), { status: 500 });
    assert.equal(site.seen.length, 1, 'no se busca un gemelo cuando hubo respuesta');
  } finally {
    await site.close();
  }
});

/* ============ 3) LO QUE NO SE TOCA =================================== */

test('una página normal sigue costando exactamente una petición', async () => {
  const site = await serve((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<html><body>Hola</body></html>');
  });

  try {
    const page = await fetchText(site.url);
    assert.match(page.body, /Hola/);
    assert.equal(site.seen.length, 1, 'ni una petición de más en el camino feliz');
  } finally {
    await site.close();
  }
});

test('el crawler se presenta con las cabeceras de un navegador, en todas las webs', async () => {
  const site = await serve((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><body>ok</body></html>');
  });

  try {
    await fetchText(site.url);
    const { headers } = site.seen[0];
    assert.match(headers['user-agent'], /Mozilla\/5\.0/, 'no "WebMonitorBot/1.0"');
    assert.equal(headers['upgrade-insecure-requests'], '1');
    assert.match(headers['accept-language'], /sv/, 'las webs son suecas');
    // Y lo que NO se manda, que importa igual: fetch() reescribe
    // sec-fetch-mode a "cors", y un juego sec-fetch con "cors" es una huella
    // que ningún navegador produce. Mejor no llevarlas que llevarlas mal.
    assert.equal(headers['sec-fetch-dest'], undefined, 'sin sec-fetch-* incoherentes');
    assert.equal(headers['sec-ch-ua'], undefined, 'sin client hints inventados');
  } finally {
    await site.close();
  }
});

test('retry:false desactiva las segundas oportunidades, para el diagnóstico', async () => {
  // La vista de diagnóstico tiene que poder ver la PRIMERA respuesta, no la
  // que se consigue después de insistir.
  const site = await serve((req, res) => {
    res.writeHead(403, { 'set-cookie': ['__cf_bm=x; Path=/'] });
    res.end('no');
  });

  try {
    await assert.rejects(() => fetchText(site.url, { retry: false }), { status: 403 });
    assert.equal(site.seen.length, 1);
  } finally {
    await site.close();
  }
});
