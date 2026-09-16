import assert from 'node:assert/strict';
import test from 'node:test';
import { parseWebsiteList } from '../src/api/importList.js';

test('parses the real list: a club name, then its URL', () => {
  const { entries, problems } = parseWebsiteList(`
Albatross
https://www.albatrossgolfklubb.se/
Åkersberga
https://akersbergagk.se/
Bro Hof
https://www.brohofslott.com/
Ullna Indoor
https://ullnaindoor.se/
`);

  assert.equal(problems.length, 0);
  assert.equal(entries.length, 4);
  assert.deepEqual(entries[0], { name: 'Albatross', url: 'https://www.albatrossgolfklubb.se/' });
  assert.equal(entries[1].name, 'Åkersberga');
  assert.equal(entries[2].name, 'Bro Hof');
  assert.equal(entries[3].name, 'Ullna Indoor');
});

test('accepts name and URL on the same line, and a bare URL', () => {
  const { entries } = parseWebsiteList(`
Vasatorp  https://vasatorp.golf/en/
https://oresundsgk.se/
`);
  assert.deepEqual(entries[0], { name: 'Vasatorp', url: 'https://vasatorp.golf/en/' });
  // No name given: derived from the domain rather than left blank.
  assert.equal(entries[1].name, 'Oresundsgk');
});

test('a URL without a trailing slash or with trailing punctuation still works', () => {
  const { entries } = parseWebsiteList('NSGK\nhttps://www.nsgk.se\nLund\nhttps://lagk.se/,');
  assert.equal(entries[0].url, 'https://www.nsgk.se/');
  assert.equal(entries[1].url, 'https://lagk.se/');
});

test('one bad line does not lose the rest of the list', () => {
  const { entries, problems } = parseWebsiteList(`
Bueno
https://bgk.se/
Malo
htp:/roto
Otro bueno
https://dgk.nu/
`);
  assert.equal(entries.length, 2);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /roto/);
});

test('the same URL pasted twice is imported once', () => {
  const { entries } = parseWebsiteList('A\nhttps://bgk.se/\nB\nhttps://bgk.se');
  assert.equal(entries.length, 1);
});

test('an empty paste or a list with no URLs is rejected with a clear message', () => {
  assert.throws(() => parseWebsiteList('   '), /Pega la lista/);
  assert.throws(() => parseWebsiteList('Albatross\nÅkersberga'), /ninguna URL/);
});

test('the whole list of 27 clubs imports cleanly', () => {
  const list = `Albatross
https://www.albatrossgolfklubb.se/
Åkersberga
https://akersbergagk.se/
Bro Hof
https://www.brohofslott.com/
Bråviken
https://bragk.se/
Båstad
https://bgk.se/
Barsebäck
https://www.barseback.com/
Borås
https://www.borasgolfklubb.se/
Djursholm
https://dgk.nu/
Hagge
https://haggegk.se/
Haninge
https://www.haningegk.se/
Karlskoga
https://karlskogagk.se/
Kristianstad
https://kristianstadsgk.com/
Kårsta
https://www.karstagk.se/
NSGK
https://www.nsgk.se
Luleå
https://www.luleagolf.se/
Lund
https://lagk.se/
Skaftö
https://skaftogk.se/
Sundsvall
https://sundsvallsgk.se/
Särö
https://www.sarogolfclub.se/
Upsala
https://upsalagk.se/
Ullna Indoor
https://ullnaindoor.se/
Ullna 
https://ullnagolf.se/
Vallda
https://valldagolf.se/
Vasatorp
https://vasatorp.golf/en/
Veckefjärdens
https://veckefjarden.com/
Wermdö
https://www.wermdogolf.se/
Öresund
https://oresundsgk.se/`;

  const { entries, problems } = parseWebsiteList(list);
  assert.equal(problems.length, 0);
  assert.equal(entries.length, 27);
  assert.equal(entries.at(-1).name, 'Öresund');
  assert.ok(entries.every((entry) => entry.url.startsWith('https://')));
  assert.equal(new Set(entries.map((e) => e.url)).size, 27, 'no duplicates');
});
