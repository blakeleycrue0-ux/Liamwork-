import assert from 'node:assert/strict';
import test from 'node:test';
import { useTempDatabase } from './helpers.js';

/**
 * El enlace que lleva del correo al panel.
 *
 * Un enlace roto aquí no falla de forma ruidosa: se queda en localhost, y
 * quien recibe el correo pulsa y ve "no se puede conectar al servidor" sin
 * ninguna pista. Pasó de verdad, así que esto está probado.
 */

const cleanup = useTempDatabase('app-base-url');
const { resolveAppBaseUrl } = await import('../src/config/index.js');

test.after(cleanup);

test('lo que se configura a mano manda sobre todo lo demás', () => {
  assert.equal(
    resolveAppBaseUrl({
      APP_BASE_URL: 'https://panel.miclub.es',
      URL: 'https://webcrawer.netlify.app',
    }),
    'https://panel.miclub.es',
    'un dominio propio no lo pisa la plataforma',
  );
});

test('en Netlify, sin configurar nada, sale la dirección real del sitio', () => {
  // Éste es el caso que estaba roto: el correo enlazaba a localhost porque
  // nadie había puesto APP_BASE_URL, aunque Netlify siempre define URL.
  assert.equal(
    resolveAppBaseUrl({ URL: 'https://webcrawer.netlify.app' }),
    'https://webcrawer.netlify.app',
  );
});

test('un despliegue de rama también da un enlace que abre', () => {
  assert.equal(
    resolveAppBaseUrl({ DEPLOY_PRIME_URL: 'https://rama--webcrawer.netlify.app' }),
    'https://rama--webcrawer.netlify.app',
  );
});

test('una dirección local configurada por error NO gana en producción', () => {
  // El caso que rompió el correo de verdad: .env.example trae la línea
  // APP_BASE_URL=http://localhost:3000, y copiarla a Netlify es lo natural.
  // Un enlace a localhost dentro de un correo es incorrecto por definición:
  // el destinatario nunca es esta máquina.
  for (const local of [
    'http://localhost:3000',
    'http://localhost',
    'http://127.0.0.1:3000',
    'http://0.0.0.0:3000',
  ]) {
    assert.equal(
      resolveAppBaseUrl({ APP_BASE_URL: local, URL: 'https://webcrawer.netlify.app' }),
      'https://webcrawer.netlify.app',
      `${local} configurado a mano no debe llegar a un correo`,
    );
  }

  // Y también cuando lo único que hay es un despliegue de rama.
  assert.equal(
    resolveAppBaseUrl({
      APP_BASE_URL: 'http://localhost:3000',
      DEPLOY_PRIME_URL: 'https://rama--webcrawer.netlify.app',
    }),
    'https://rama--webcrawer.netlify.app',
  );
});

test('en local, y sólo en local, se queda en localhost', () => {
  // Sin URL de plataforma no hay nada mejor, y es lo que se quiere al
  // desarrollar: el enlace tiene que abrir el panel de esta máquina.
  assert.equal(resolveAppBaseUrl({ APP_BASE_URL: 'http://localhost:3000' }), 'http://localhost:3000');

  assert.equal(resolveAppBaseUrl({}), 'http://localhost:3000');
  assert.equal(resolveAppBaseUrl({ APP_BASE_URL: '' }), 'http://localhost:3000');
  assert.equal(resolveAppBaseUrl({ APP_BASE_URL: '   ' }), 'http://localhost:3000');
});

test('la barra final se quita, para no construir enlaces con //', () => {
  assert.equal(resolveAppBaseUrl({ URL: 'https://webcrawer.netlify.app/' }), 'https://webcrawer.netlify.app');
  assert.equal(resolveAppBaseUrl({ URL: 'https://webcrawer.netlify.app///' }), 'https://webcrawer.netlify.app');
});

test('el correo y Slack enlazan al mismo sitio', async () => {
  // Dos ajustes distintos apuntando a dominios distintos es la clase de
  // deriva que nadie nota hasta que un trabajador enseña su móvil.
  const { config } = await import('../src/config/index.js');
  assert.equal(config.mail.appBaseUrl, config.slack.appBaseUrl);
});

test('el correo real lleva el enlace resuelto, no un localhost pegado', async () => {
  const { buildReportEmail } = await import('../src/monitor/report.email.js');
  const { config } = await import('../src/config/index.js');

  const email = buildReportEmail(
    {
      date: '2026-09-21',
      total_changes: 0,
      websitesQuiet: 1,
      websitesTotal: 1,
      daily_summary: 'Nothing today.',
      payload: { changes: [] },
    },
    { timeZone: 'Europe/Madrid' },
  );

  assert.ok(email.text.includes(config.mail.appBaseUrl), 'el texto enlaza al panel');
  assert.ok(email.html.includes(config.mail.appBaseUrl), 'y el HTML también');
});
