/**
 * A line diff, computed locally, before anything is sent to Claude.
 *
 * This is the single biggest cost decision in the system. Handing the model
 * two full versions of a page would mean tens of thousands of tokens for an
 * edit that moved one date; handing it the changed lines plus a little
 * context means a few hundred. Same verdict, roughly one fiftieth of the bill.
 */

/** Blank lines carry no meaning here and would only pad the diff. */
const toLines = (text) =>
  String(text ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

/**
 * Longest common subsequence over lines.
 *
 * Bounded on purpose: the table is O(n*m), and a pair of very long pages
 * would otherwise allocate hundreds of megabytes inside a serverless function
 * with a hard memory limit. Past the cap we fall back to a set comparison,
 * which is cruder but bounded and still tells us what appeared and vanished.
 */
const MAX_CELLS = 4_000_000;

export function diffLines(before, after) {
  const a = toLines(before);
  const b = toLines(after);

  if (a.length * b.length > MAX_CELLS) return coarseDiff(a, b);

  // table[i][j] = length of the LCS of a[i..] and b[j..]
  const table = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  const ops = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ type: 'same', line: a[i] });
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      ops.push({ type: 'removed', line: a[i] });
      i += 1;
    } else {
      ops.push({ type: 'added', line: b[j] });
      j += 1;
    }
  }
  while (i < a.length) ops.push({ type: 'removed', line: a[i++] });
  while (j < b.length) ops.push({ type: 'added', line: b[j++] });
  return ops;
}

/** Order-insensitive fallback for pages too large to diff properly. */
function coarseDiff(a, b) {
  const before = new Set(a);
  const after = new Set(b);
  return [
    ...a.filter((line) => !after.has(line)).map((line) => ({ type: 'removed', line })),
    ...b.filter((line) => !before.has(line)).map((line) => ({ type: 'added', line })),
  ];
}

/**
 * Groups the diff into hunks: runs of changed lines with a little unchanged
 * text either side, so the model can see what the change is ABOUT and not
 * just that some string moved.
 */
export function buildHunks(ops, { context = 2 } = {}) {
  const changedAt = ops
    .map((op, index) => (op.type === 'same' ? -1 : index))
    .filter((index) => index >= 0);
  if (!changedAt.length) return [];

  const ranges = [];
  for (const index of changedAt) {
    const start = Math.max(0, index - context);
    const end = Math.min(ops.length - 1, index + context);
    const last = ranges[ranges.length - 1];
    if (last && start <= last.end + 1) last.end = Math.max(last.end, end);
    else ranges.push({ start, end });
  }

  return ranges.map((range) => ops.slice(range.start, range.end + 1));
}

/**
 * The diff as the text Claude actually reads, with a hard character budget.
 *
 * @returns {{text: string, added: number, removed: number, truncated: boolean,
 *            addedLines: string[], removedLines: string[]}}
 */
export function renderDiff(before, after, { context = 2, maxChars = 6000 } = {}) {
  const ops = diffLines(before, after);
  const hunks = buildHunks(ops, { context });

  const addedLines = ops.filter((op) => op.type === 'added').map((op) => op.line);
  const removedLines = ops.filter((op) => op.type === 'removed').map((op) => op.line);

  const marks = { same: '  ', added: '+ ', removed: '- ' };
  const blocks = [];
  let length = 0;
  let truncated = false;

  for (const hunk of hunks) {
    const block = hunk.map((op) => `${marks[op.type]}${op.line}`).join('\n');
    if (length + block.length > maxChars) {
      truncated = true;
      break;
    }
    blocks.push(block);
    length += block.length + 4;
  }

  return {
    text: blocks.join('\n@@\n'),
    added: addedLines.length,
    removed: removedLines.length,
    hunks: hunks.length,
    truncated,
    addedLines,
    removedLines,
  };
}

/**
 * How much of the page moved, 0 to 1.
 *
 * Used as a cheap pre-filter: a page where three characters changed inside a
 * thousand lines is almost always a rotating widget, and not worth a token.
 */
export function changeRatio(before, after) {
  const a = toLines(before);
  const b = toLines(after);
  if (!a.length && !b.length) return 0;

  const counts = new Map();
  for (const line of a) counts.set(line, (counts.get(line) ?? 0) + 1);
  let shared = 0;
  for (const line of b) {
    const left = counts.get(line) ?? 0;
    if (left > 0) {
      shared += 1;
      counts.set(line, left - 1);
    }
  }
  const total = Math.max(a.length, b.length);
  return total === 0 ? 0 : 1 - shared / total;
}
