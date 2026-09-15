import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

/** Isolated database per test file; must run before any src/ import. */
export function useTempDatabase(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `web-monitor-${name}-`));
  process.env.DATABASE_FILE = path.join(dir, 'test.sqlite');
  process.env.MAIL_TRANSPORT = 'console';
  // Individual tests override this before importing the app.
  process.env.AUTH_PROVIDER = 'local';
  process.env.SESSION_SECRET = 'test-secret-value-for-sessions';
  process.env.ADMIN_PASSWORD = 'test-password';
  process.env.RUN_SCHEDULER_IN_WEB = 'false';
  process.env.SEED_WEBSITE_URL = '';
  process.env.SEED_WORKER_EMAIL = '';
  return () => fs.rmSync(dir, { recursive: true, force: true });
}

/** Tiny fixture site whose content can be mutated during a test. */
export function startFixtureSite({ posts = [], withFeed = true, failing = false } = {}) {
  const state = { posts: [...posts], requests: 0, failing };

  const server = http.createServer((req, res) => {
    state.requests += 1;
    if (state.failing) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      return res.end('boom');
    }
    if (req.url.startsWith('/feed')) {
      if (!withFeed) {
        res.writeHead(404);
        return res.end('no feed');
      }
      const items = state.posts
        .map(
          (post) => `<item><title>${post.title}</title><link>${post.url}</link>
            <guid>${post.url}</guid><pubDate>${post.date ?? 'Mon, 15 Sep 2026 16:42:00 GMT'}</pubDate></item>`,
        )
        .join('');
      res.writeHead(200, { 'content-type': 'application/rss+xml' });
      return res.end(`<?xml version="1.0"?><rss version="2.0"><channel><title>Fixture</title>${items}</channel></rss>`);
    }
    const articles = state.posts
      .map(
        (post) => `<article class="post"><h2><a href="${post.url}">${post.title}</a></h2>
          <time datetime="2026-09-15">15/09/2026</time></article>`,
      )
      .join('');
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(`<!doctype html><html><head><title>Fixture</title>
      ${withFeed ? '<link rel="alternate" type="application/rss+xml" href="/feed">' : ''}
      </head><body><main>${articles}</main></body></html>`);
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        state,
        addPost: (post) => state.posts.unshift(post),
        setFailing: (value) => { state.failing = value; },
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

/**
 * Minimal stand-in for the Supabase Auth endpoints the app talks to
 * (GET /auth/v1/user and the admin users API), so the legacy HS256 flow can be
 * tested without network access.
 */
export function startFakeSupabase({ users = {}, adminUsers = [] } = {}) {
  const state = { users, adminUsers, calls: 0 };

  const server = http.createServer((req, res) => {
    state.calls += 1;
    const url = new URL(req.url, 'http://localhost');
    const token = (req.headers.authorization || '').replace(/^Bearer /i, '');
    const json = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (url.pathname === '/auth/v1/user') {
      const user = state.users[token];
      return user ? json(200, user) : json(401, { msg: 'invalid claim' });
    }
    if (url.pathname === '/auth/v1/admin/users' && req.method === 'GET') {
      return json(200, { users: state.adminUsers });
    }
    if (url.pathname === '/auth/v1/admin/users' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      return req.on('end', () => {
        const created = { id: `id-${state.adminUsers.length + 1}`, ...JSON.parse(body || '{}') };
        state.adminUsers.push(created);
        json(200, created);
      });
    }
    return json(404, { msg: 'not found' });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        state,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}
