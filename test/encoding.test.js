import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import test from 'node:test';
import {
  charsetFromContentType,
  charsetFromMarkup,
  decodeBody,
  decodeLine,
  decodeText,
  looksLikeUtf8,
  repairMojibake,
} from '../src/crawler/encoding.js';

const utf8 = (text) => Buffer.from(text, 'utf8');

test('a server that lies about its charset still decodes correctly', () => {
  // The exact bug: Swedish UTF-8 bytes served as ISO-8859-1. Believing the
  // header is what produced "VÃ¤lkommen" in the emails.
  const bytes = utf8('<html><body>Välkommen till Albatross</body></html>');
  assert.equal(
    decodeBody(bytes, { contentType: 'text/html; charset=iso-8859-1' }),
    '<html><body>Välkommen till Albatross</body></html>',
  );
});

test('a genuinely Latin-1 page is still read as Latin-1', () => {
  // Not every declaration is a lie: these bytes are NOT valid UTF-8, so the
  // header is the only thing we have and it must be obeyed.
  const bytes = Buffer.from([0x56, 0xe4, 0x6c, 0x6b, 0x6f, 0x6d, 0x6d, 0x65, 0x6e]);
  assert.equal(decodeBody(bytes, { contentType: 'text/html; charset=iso-8859-1' }), 'Välkommen');
  assert.equal(looksLikeUtf8(bytes), false);
});

test('the charset is taken from the markup when no header declares one', () => {
  const bytes = utf8('<meta charset="utf-8"><p>Öresunds Golfklubb</p>');
  assert.equal(charsetFromMarkup(bytes), 'utf-8');
  assert.equal(decodeBody(bytes, { contentType: 'text/html' }), '<meta charset="utf-8"><p>Öresunds Golfklubb</p>');
});

test('a BOM outranks every other declaration', () => {
  const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), utf8('Båstad')]);
  assert.equal(decodeBody(bytes, { contentType: 'text/html; charset=windows-1252' }), 'Båstad');
});

test('an undeclared page is decoded by looking at the bytes', () => {
  assert.equal(decodeBody(utf8('Kårsta Golfklubb'), {}), 'Kårsta Golfklubb');
  assert.equal(decodeBody(Buffer.from([0x53, 0xe4, 0x72, 0xf6]), {}), 'Särö');
});

test('charsetFromContentType normalises the names servers actually send', () => {
  assert.equal(charsetFromContentType('text/html; charset=UTF-8'), 'utf-8');
  assert.equal(charsetFromContentType('text/html; charset="ISO-8859-1"'), 'windows-1252');
  assert.equal(charsetFromContentType('text/html'), null);
  assert.equal(charsetFromContentType('text/html; charset=nonsense-9'), null);
});

test('HTML entities are decoded, including the nested ones feeds produce', () => {
  assert.equal(decodeText('Styrelsen har n&#xF6;jet'), 'Styrelsen har nöjet');
  assert.equal(decodeText('V&#xC3;R'), 'VÃR');
  assert.equal(decodeText('Herr &amp; Fru'), 'Herr & Fru');
  // An entity inside an entity: one pass leaves "&#246;" behind.
  assert.equal(decodeText('n&amp;#246;jet'), 'nöjet');
  assert.equal(decodeText('&ouml;&aring;&auml; &ntilde; &eacute; &ccedil;'), 'öåä ñ é ç');
});

test('text that arrived already broken is repaired', () => {
  assert.equal(repairMojibake('VÃ¤lkommen'), 'Välkommen');
  assert.equal(repairMojibake('BÃ¥stad GK'), 'Båstad GK');
  // The real byte sequence: a UTF-8 non-breaking space read as Latin-1.
  assert.equal(decodeText('Nyhetsbrev\u00c2\u00a0f\u00c3\u00b6r september'), 'Nyhetsbrev för september');
  // Curly quotes broken through Windows-1252, the other common shape.
  assert.equal(repairMojibake('\u00e2\u20ac\u0153Hej\u00e2\u20ac\u009d'), '\u201cHej\u201d');
});

test('text that is already correct is never "repaired" into rubbish', () => {
  for (const good of ['Välkommen', 'Öresund', 'señor', 'Français', 'plain ascii', 'Ça va']) {
    assert.equal(repairMojibake(good), good, good);
    assert.equal(decodeText(good), good, good);
  }
});

test('invisible characters are stripped so they cannot fake a change', () => {
  const withNoise = 'Turnering​ i  september﻿';
  assert.equal(decodeText(withNoise), 'Turnering i september');
  // Same visible text, same output: a zero-width space must not move the hash.
  assert.equal(decodeText(withNoise), decodeText('Turnering i september'));
});

test('decodeLine flattens to a single line, decodeText keeps paragraphs', () => {
  assert.equal(decodeLine('  Nya   tider\n\nför  hösten '), 'Nya tider för hösten');
  assert.equal(decodeText('Ett\n\n\n\nTvå'), 'Ett\n\nTvå');
});

test('empty and missing input never throw', () => {
  assert.equal(decodeText(null), '');
  assert.equal(decodeText(undefined), '');
  assert.equal(decodeBody(Buffer.alloc(0), {}), '');
});
