import assert from 'node:assert/strict';
import test from 'node:test';

/**
 * Two websites sat in the dashboard in red for days:
 *
 *   Sundsvall  HTTP 403 for https://sundsvallsgk.se/
 *   Hagge      fetch failed
 *
 * The first is a real answer from a real server and must be shown as one. The
 * second is not a diagnosis at all - Node says "fetch failed" and puts the
 * actual reason in `error.cause`, which the crawler used to throw away. These
 * tests cover the unwrapping and the sentence the dashboard prints, for both
 * the rows stored from now on and the ones already in the database.
 */

const { NetworkError, HttpError } = await import('../src/crawler/httpClient.js');
const { explainError, errorKind } = await import('../src/monitor/errors.js');

/* ================= 1) "fetch failed" deja de ser opaco ================== */

test('un fallo de DNS dice que el dominio no resuelve', () => {
  const error = new NetworkError('https://haggegk.se/', Object.assign(new Error('getaddrinfo ENOTFOUND haggegk.se'), { code: 'ENOTFOUND' }));
  assert.equal(error.code, 'ENOTFOUND');
  assert.match(error.message, /dominio no existe/i);
  assert.match(error.message, /haggegk\.se/);
});

test('un certificado caducado se nombra como tal', () => {
  const error = new NetworkError('https://club.example/', Object.assign(new Error('certificate has expired'), { code: 'CERT_HAS_EXPIRED' }));
  assert.match(error.message, /certificado del servidor ha caducado/i);
});

test('una causa anidada también se lee', () => {
  const error = new NetworkError('https://club.example/', { cause: { code: 'ECONNREFUSED' } });
  assert.equal(error.code, 'ECONNREFUSED');
  assert.match(error.message, /rechazó la conexión/i);
});

test('sin causa reconocible no se inventa una explicación', () => {
  const error = new NetworkError('https://club.example/', undefined);
  assert.match(error.message, /No se pudo conectar con https:\/\/club\.example\//);
  assert.equal(error.code, null);
});

/* ================= 2) La frase que ve la persona ======================= */

test('el 403 de Sundsvall se explica sin ocultarlo', () => {
  const explained = explainError('HTTP 403 for https://sundsvallsgk.se/');
  assert.equal(explained.code, 'HTTP 403');
  assert.equal(explained.text, 'HTTP 403 — el servidor rechazó la petición');
  assert.equal(explained.kind, 'blocked', 'se distingue de una web caída');
});

test('cada código HTTP tiene su frase, y los desconocidos no mienten', () => {
  assert.match(explainError('HTTP 404 for https://x.example/').text, /ya no existe/);
  assert.match(explainError('HTTP 503 for https://x.example/').text, /caído o en mantenimiento/);
  assert.match(explainError('HTTP 429 for https://x.example/').text, /demasiadas peticiones/);
  const rare = explainError('HTTP 451 for https://x.example/');
  assert.equal(rare.code, 'HTTP 451');
  assert.match(rare.text, /respuesta inesperada/);
});

test('el "fetch failed" que ya está guardado se admite como lo que es', () => {
  // Filas anteriores al arreglo: no se puede recuperar la causa, así que se
  // dice que no se registró en lugar de adivinarla.
  const explained = explainError('fetch failed');
  assert.match(explained.text, /causa no registrada/);
  assert.equal(explained.kind, 'network');
});

test('un timeout se cuenta en segundos', () => {
  const explained = explainError('Timeout after 15000ms for https://x.example/');
  assert.equal(explained.text, 'Tiempo agotado — el servidor no respondió en 15 s');
  assert.equal(explained.kind, 'timeout');
});

test('una frase ya escrita se conserva, sin repetir la URL', () => {
  const raw = new NetworkError('https://haggegk.se/', { code: 'ENOTFOUND' }).message;
  const explained = explainError(raw);
  assert.doesNotMatch(explained.text, /https:\/\//, 'la URL ya está en la fila de al lado');
  assert.match(explained.text, /ENOTFOUND/, 'pero el código técnico se mantiene');
  assert.equal(explained.kind, 'dns');
});

test('sin error no hay explicación que dar', () => {
  assert.equal(explainError(null), null);
  assert.equal(explainError(''), null);
  assert.equal(errorKind(null), null);
});

/* ================= 3) El estado sigue estando disponible =============== */

test('HttpError conserva el código para quien lo necesite', () => {
  const error = new HttpError(403, 'https://sundsvallsgk.se/');
  assert.equal(error.status, 403);
  assert.equal(error.url, 'https://sundsvallsgk.se/');
  assert.equal(error.name, 'HttpError');
});
