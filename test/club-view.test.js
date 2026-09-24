import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

/**
 * El panel, en inglés, y la ficha de un club.
 *
 * Son pruebas sobre el código fuente del frontend porque el panel no tiene
 * build ni framework: lo que se lee aquí es literalmente lo que llega al
 * navegador. No sustituyen a abrirlo -eso se hizo-, pero sí impiden que una
 * cadena en castellano vuelva a colarse sin que nadie se entere.
 */

const app = fs.readFileSync(new URL('../src/web/app.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../src/web/index.html', import.meta.url), 'utf8');

/** Cadenas y textos visibles, sin comentarios: lo que de verdad se pinta. */
function visibleStrings(source, isHtml = false) {
  const out = [];
  for (const line of source.split('\n')) {
    if (/^\s*(\/\/|\*|\/\*|<!--)/.test(line)) continue;
    const patterns = isHtml
      ? [/>([^<>{}]{2,})</g, /(?:title|aria-label|placeholder)="([^"]+)"/g]
      : [/'((?:[^'\\]|\\.)*)'/g, /`((?:[^`\\]|\\.)*)`/g];
    for (const pattern of patterns) {
      for (const match of line.matchAll(pattern)) {
        const text = (match[1] ?? '').trim();
        if (text && /[A-Za-z]/.test(text)) out.push(text);
      }
    }
  }
  return out;
}

test('el panel no tiene ni una cadena en castellano', () => {
  // Acentos y eñes: el detector más barato y más difícil de discutir. Lo que
  // sí puede llevarlos es el CONTENIDO que viene de la base de datos, y eso
  // no está en estos ficheros.
  for (const [name, source, isHtml] of [['app.js', app, false], ['index.html', html, true]]) {
    const spanish = visibleStrings(source, isHtml).filter((text) => /[áéíóúñüÁÉÍÓÚÑ¿¡]/.test(text));
    assert.deepEqual(spanish, [], `${name} tiene texto en castellano`);
  }
});

test('las pestañas y los botones principales están en inglés', () => {
  for (const label of ['>Overview<', '>Websites<', '>Workers<', '>Activity<', '>Check now<']) {
    assert.ok(html.includes(label), `falta ${label}`);
  }
  // Y los de antes ya no están.
  for (const old of ['>Resumen<', '>Trabajadores<', '>Actividad<', '>Comprobar<']) {
    assert.ok(!html.includes(old), `${old} sigue ahí`);
  }
});

test('el tiempo relativo se dice en inglés', () => {
  // "hace 7 d" se coló hasta que se abrió el panel de verdad: estaba en un
  // ayudante, no en una etiqueta, y por eso no salía en ninguna búsqueda.
  assert.match(app, /return `\$\{fmtDuration\(seconds\)\} ago`/, 'X ago');
  assert.match(app, /return 'just now'/);
  assert.match(app, /return 'never'/);
  assert.ok(!app.includes('`hace ${'), 'no queda "hace X"');
});

test('pulsar el nombre de un club abre su ficha', () => {
  assert.match(app, /className: 'cell-name cell-open'/, 'el nombre es pulsable');
  assert.match(app, /name\.addEventListener\('click', \(\) =>\s*showClub\(website\)/s);
  assert.ok(app.includes('async function showClub(website)'), 'la ficha existe');
});

test('la ficha enseña titular y descripción, no sólo el resumen', () => {
  const start = app.indexOf('function clubChange(change)');
  assert.ok(start > 0, 'clubChange existe');
  const body = app.slice(start, start + 2600);

  // El titular, como titular.
  assert.match(body, /className: 'club-change-title'/, 'hay un titular propio');
  assert.match(body, /change\.title \|\| 'Change detected'/);

  // Y la descripción entera: el resumen Y lo que cambió, no una de las dos.
  assert.match(body, /change\.summary \?/, 'el resumen se pinta');
  assert.match(body, /change\.what_changed/, 'y lo que cambió también');
  assert.match(body, /What changed: /);
  assert.match(body, /change\.draft_message/, 'y el borrador');

  // Sin plegar: dentro de un club no hay que volver a pulsar para leer.
  assert.ok(!/details/.test(body), 'los cambios del club no van plegados');
});

test('la ficha separa lo relevante de lo descartado, y cuenta lo segundo', () => {
  const start = app.indexOf('async function showClub(website)');
  const body = app.slice(start, app.indexOf('function clubChange(change)'));

  assert.match(body, /\['NEW', 'UPDATED'\]\.includes\(change\.change_type\)/, 'separa por tipo');
  assert.match(body, /change\$\{ignored\.length === 1 \? '' : 's'\} discarded/, 'los descartados se cuentan');
  assert.match(body, /el\('details'/, 'y se despliegan, no se pintan de entrada');
  assert.match(body, /'No relevant changes recorded for this club yet\.'/, 'y un club sin nada lo dice');
});
