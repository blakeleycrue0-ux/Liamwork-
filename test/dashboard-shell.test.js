import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'web');
const read = (file) => fs.readFileSync(path.join(WEB_DIR, file), 'utf8');

const html = read('index.html');
const app = read('app.js');

test('the list of websites cannot be changed from the dashboard', () => {
  // The 27 clubs live in src/config/sites.js. Nobody adds or removes them here.
  assert.ok(!html.includes('id="add-website"'), 'the "add website" button is gone');
  assert.ok(!html.includes('id="import-websites"'), 'the "import list" button is gone');
  assert.ok(!app.includes("'#add-website'"), 'nothing wires up an add-website button');
  assert.ok(!app.includes("'#import-websites'"), 'nothing wires up an import button');
  assert.ok(
    !app.includes('¿Eliminar "${website.name}'),
    'no per-row delete for websites',
  );
  // Editing how a site is read is still allowed.
  assert.ok(app.includes('function websiteModal'), 'editing a website is still possible');
});

test('no invented logo or icon anywhere in the shell', () => {
  assert.match(html, /<link rel="icon" href="data:,">/, 'the favicon is deliberately blank');
  for (const glyph of ['◉', '◧', '◍', '◎', '◈', '◐', '◇']) {
    assert.ok(!html.includes(glyph), `no ${glyph} decoration`);
  }
  assert.ok(!html.includes('<svg'), 'no inline artwork');
});

test('every legal page exists and links back to the others', () => {
  const pages = ['legal.html', 'terminos.html', 'privacidad.html', 'cookies.html'];
  for (const page of pages) {
    const body = read(page);
    assert.ok(body.includes('Crue Bryn Blakley'), `${page} carries the credit`);
    assert.ok(body.includes('href="/"'), `${page} links back to the dashboard`);
    for (const other of ['/legal', '/terminos', '/privacidad', '/cookies']) {
      assert.ok(body.includes(`href="${other}"`), `${page} links to ${other}`);
    }
  }
  for (const other of ['/legal', '/terminos', '/privacidad', '/cookies']) {
    assert.ok(html.includes(`href="${other}"`), `the dashboard footer links to ${other}`);
  }
});
