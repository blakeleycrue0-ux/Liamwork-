import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'web');
const read = (file) => fs.readFileSync(path.join(WEB_DIR, file), 'utf8');

const html = read('index.html');
const app = read('app.js');
const css = read('styles.css');

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

test('no invented logo, no emoji, no decoration masquerading as an icon', () => {
  // The rule was never "no SVG": it was no made-up brand mark and no glyph
  // standing in for a real icon. The interface now carries a small set of
  // functional line icons, defined once as <symbol> and used by reference.
  assert.match(html, /<link rel="icon" href="data:,">/, 'the favicon is deliberately blank');

  for (const glyph of ['◉', '◧', '◍', '◎', '◈', '◐', '◇']) {
    assert.ok(!html.includes(glyph), `no ${glyph} decoration`);
  }
  // No emoji anywhere: an emoji is not an icon, and it renders differently on
  // every machine that opens the panel.
  assert.ok(
    !/\p{Extended_Pictographic}/u.test(html),
    'no emoji in the dashboard shell',
  );

  // Every icon is a reference to the shared sprite. A one-off <svg> with its
  // own artwork would be exactly the invented logo this test exists to stop.
  const sprites = [...html.matchAll(/<symbol id="(i-[a-z-]+)"/g)].map((match) => match[1]);
  assert.ok(sprites.length >= 10, 'the icon sprite is defined once, at the top');

  const used = [...html.matchAll(/<use href="#(i-[a-z-]+)"\/>/g)].map((match) => match[1]);
  for (const name of new Set(used)) {
    assert.ok(sprites.includes(name), `#${name} is defined in the sprite`);
  }

  const inlineSvgs = html.match(/<svg[^>]*>/g) ?? [];
  // One sprite container plus one <svg><use> per icon: nothing draws its own.
  for (const [index, tag] of inlineSvgs.entries()) {
    if (index === 0) continue; // the sprite container itself
    assert.ok(/class="icon/.test(tag), `inline <svg> ${index} is an icon, not artwork`);
  }
});

test('the four pages are one product, not four loose HTML files', () => {
  for (const id of ['page-summary', 'page-websites', 'page-workers', 'page-activity']) {
    assert.ok(html.includes(`id="${id}"`), `${id} lives in the same shell`);
  }
  // One navigation, one header, one stylesheet: the shell is shared.
  assert.equal((html.match(/id="tabs"/g) ?? []).length, 1, 'a single navigation');
  assert.equal((html.match(/<link rel="stylesheet"/g) ?? []).length, 1);
  assert.ok(html.includes('class="header"'), 'the top header carries the navigation');
  // Below 900px the same tabs fold into one sheet, built from them in JS, so
  // there is never a second hand-written list of pages to fall out of sync.
  assert.ok(html.includes('id="mobile-nav"'), 'and a mobile sheet to fold into');
  assert.ok(app.includes('function buildMobileNav'), 'built from the header tabs');
  assert.ok(!html.includes('id="sidebar"'), 'no sidebar: the tables need the width');
});

test('the tables read as tables on a phone, not as a sideways scroll', () => {
  // Every cell carries its own column name, so a row stacks into a legible
  // block instead of forcing a horizontal drag on a 390px screen.
  assert.ok(app.includes('const label = (node, text)'), 'cells are labelled');
  assert.ok(css.includes('content: attr(data-label)'), 'and the label is what mobile prints');
  assert.ok(css.includes('overflow-x: visible'), 'the sideways scroll is switched off there');
});

test('the ambient background is decoration the app can lose', () => {
  // It must never be load-bearing: no layout, no events, no dependency.
  assert.ok(css.includes('prefers-reduced-motion'), 'motion is opt-out');
  assert.ok(css.includes('pointer-events: none'), 'it never swallows a click');
  assert.ok(!html.includes('<canvas'), 'no canvas');
  assert.ok(!/<script[^>]*src="https?:/.test(html), 'no third-party script');
});

test('the report card states the behaviour instead of leaving it to be guessed', () => {
  // The morning the report did not arrive, nothing on screen said whether an
  // empty day was even supposed to produce an email.
  assert.ok(html.includes('id="digest-next"'), 'when the next report goes out');
  assert.ok(html.includes('id="digest-empty"'), 'what happens on a day with no changes');
  assert.ok(html.includes('id="digest-last"'), 'when the last one was sent');
  assert.ok(html.includes('id="digest-attempt"'), 'what happened on the last attempt');
  assert.ok(app.includes("'ACTIVADO'"), 'and it is spelled out, not implied');
  assert.ok(app.includes("'DESACTIVADO'"));
});

test('an error is explained, never repainted', () => {
  assert.ok(app.includes('function errorCell'), 'the error has its own cell');
  assert.ok(app.includes('website.error_detail'), 'it shows the reason the server gave');
  assert.ok(!app.includes('last_error = null'), 'nothing clears an error for display');
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
