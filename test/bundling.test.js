import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const sourceFiles = (dir) =>
  fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(full);
      return /\.(js|mts)$/.test(entry.name) ? [full] : [];
    });

/**
 * Netlify wraps every ESM function with a banner that declares __dirname and
 * __filename. A second declaration anywhere in the bundle is a SyntaxError,
 * and the function never loads: every route answers 502 with no explanation.
 * This exact bug cost a whole afternoon; it must not come back.
 */
test('no source file declares __dirname or __filename', () => {
  const offenders = [];
  for (const file of [...sourceFiles(path.join(ROOT, 'src')), ...sourceFiles(path.join(ROOT, 'netlify'))]) {
    const source = fs.readFileSync(file, 'utf8');
    if (/(?:const|let|var)\s+(__dirname|__filename)\b/.test(source)) {
      offenders.push(path.relative(ROOT, file));
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `estos ficheros declaran __dirname/__filename y romperían la función en Netlify: ${offenders.join(', ')}`,
  );
});
