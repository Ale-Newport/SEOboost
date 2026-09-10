/**
 * A small word-level diff, written here rather than pulled in as a dependency.
 *
 * The algorithm is a longest-common-subsequence in Hirschberg's linear-space formulation: the
 * classic DP table for a 3,000-word draft against another 3,000-word draft would be nine million
 * cells, which is exactly the sort of allocation that makes an editor feel broken. Hirschberg
 * keeps two rows and recurses, so memory is O(min(n, m)) while the running time stays O(n · m).
 *
 * Two passes are run: lines first, then words inside the blocks that changed. Diffing words
 * across the whole document in one pass produces technically-correct output that is unreadable —
 * a moved paragraph turns into confetti. Aligning lines first keeps edits where the author made
 * them.
 */

export type DiffOp = 'equal' | 'insert' | 'delete';

export interface DiffSegment {
  op: DiffOp;
  text: string;
}

export type DiffRowKind = 'equal' | 'changed' | 'added' | 'removed';

export interface DiffRow {
  kind: DiffRowKind;
  /** `null` when this row exists only on the right (an addition). */
  left: DiffSegment[] | null;
  right: DiffSegment[] | null;
  leftNumber: number | null;
  rightNumber: number | null;
}

export interface TextDiff {
  rows: DiffRow[];
  addedWords: number;
  removedWords: number;
  changedRows: number;
}

// ── LCS ──────────────────────────────────────────────────────

/** Maps tokens to ints so the inner loop compares numbers instead of strings. */
function intern(a: readonly string[], b: readonly string[]): { a: Int32Array; b: Int32Array } {
  const ids = new Map<string, number>();
  const encode = (tokens: readonly string[]): Int32Array => {
    const out = new Int32Array(tokens.length);
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i] ?? '';
      let id = ids.get(token);
      if (id === undefined) {
        id = ids.size;
        ids.set(token, id);
      }
      out[i] = id;
    }
    return out;
  };
  return { a: encode(a), b: encode(b) };
}

/**
 * LCS lengths of `a[ao … ao+an)` against every prefix of `b[bo … bo+bn)`.
 * With `reverse`, both sequences are walked backwards, which is the half Hirschberg needs to
 * find the split point.
 */
function lcsRow(
  a: Int32Array,
  ao: number,
  an: number,
  b: Int32Array,
  bo: number,
  bn: number,
  reverse: boolean,
): Int32Array {
  let previous = new Int32Array(bn + 1);
  let current = new Int32Array(bn + 1);

  for (let i = 0; i < an; i++) {
    const aValue = a[reverse ? ao + an - 1 - i : ao + i];
    current[0] = 0;
    for (let j = 0; j < bn; j++) {
      const bValue = b[reverse ? bo + bn - 1 - j : bo + j];
      current[j + 1] =
        aValue === bValue
          ? (previous[j] ?? 0) + 1
          : Math.max(current[j] ?? 0, previous[j + 1] ?? 0);
    }
    const swap = previous;
    previous = current;
    current = swap;
  }
  return previous;
}

/** Emits `[indexInA, indexInB]` pairs for every token the two sequences share, in order. */
function lcsPairs(
  a: Int32Array,
  ao: number,
  an: number,
  b: Int32Array,
  bo: number,
  bn: number,
  out: Array<[number, number]>,
): void {
  if (an === 0 || bn === 0) return;

  if (an === 1) {
    const needle = a[ao];
    for (let j = 0; j < bn; j++) {
      if (b[bo + j] === needle) {
        out.push([ao, bo + j]);
        return;
      }
    }
    return;
  }

  const mid = an >> 1;
  const head = lcsRow(a, ao, mid, b, bo, bn, false);
  const tail = lcsRow(a, ao + mid, an - mid, b, bo, bn, true);

  let bestSplit = 0;
  let best = -1;
  for (let j = 0; j <= bn; j++) {
    const total = (head[j] ?? 0) + (tail[bn - j] ?? 0);
    if (total > best) {
      best = total;
      bestSplit = j;
    }
  }

  lcsPairs(a, ao, mid, b, bo, bestSplit, out);
  lcsPairs(a, ao + mid, an - mid, b, bo + bestSplit, bn - bestSplit, out);
}

interface Block {
  aStart: number;
  aEnd: number;
  bStart: number;
  bEnd: number;
  equal: boolean;
}

/** Turns the matched pairs into alternating equal / changed blocks covering both sequences. */
function alignBlocks(aLength: number, bLength: number, pairs: Array<[number, number]>): Block[] {
  const blocks: Block[] = [];
  let aCursor = 0;
  let bCursor = 0;

  const pushEqual = (aStart: number, bStart: number, length: number): void => {
    const last = blocks[blocks.length - 1];
    if (last && last.equal && last.aEnd === aStart && last.bEnd === bStart) {
      last.aEnd += length;
      last.bEnd += length;
      return;
    }
    blocks.push({ aStart, aEnd: aStart + length, bStart, bEnd: bStart + length, equal: true });
  };

  for (const [aIndex, bIndex] of pairs) {
    if (aIndex > aCursor || bIndex > bCursor) {
      blocks.push({ aStart: aCursor, aEnd: aIndex, bStart: bCursor, bEnd: bIndex, equal: false });
    }
    pushEqual(aIndex, bIndex, 1);
    aCursor = aIndex + 1;
    bCursor = bIndex + 1;
  }

  if (aCursor < aLength || bCursor < bLength) {
    blocks.push({ aStart: aCursor, aEnd: aLength, bStart: bCursor, bEnd: bLength, equal: false });
  }
  return blocks;
}

// ── tokenisation ─────────────────────────────────────────────

function splitLines(text: string): string[] {
  return text.replace(/\r\n?/g, '\n').split('\n');
}

/** Words plus the whitespace that follows them, so joining the segments rebuilds the line. */
function splitWords(line: string): string[] {
  return line.match(/\s+|[^\s]+/g) ?? [];
}

/** Words in a stretch of text — whitespace-only segments contribute nothing. */
function countWords(text: string): number {
  const match = text.match(/[^\s]+/g);
  return match === null ? 0 : match.length;
}

function segmentText(segments: readonly DiffSegment[], op: DiffOp): string {
  return segments
    .filter((segment) => segment.op === op)
    .map((segment) => segment.text)
    .join(' ');
}

// ── public API ───────────────────────────────────────────────

/** Word-level diff of a single line. */
export function diffWords(before: string, after: string): DiffSegment[] {
  const aTokens = splitWords(before);
  const bTokens = splitWords(after);
  const { a, b } = intern(aTokens, bTokens);

  const pairs: Array<[number, number]> = [];
  lcsPairs(a, 0, a.length, b, 0, b.length, pairs);
  const blocks = alignBlocks(a.length, b.length, pairs);

  const segments: DiffSegment[] = [];
  const push = (op: DiffOp, text: string): void => {
    if (text.length === 0) return;
    const last = segments[segments.length - 1];
    if (last && last.op === op) {
      last.text += text;
      return;
    }
    segments.push({ op, text });
  };

  for (const block of blocks) {
    if (block.equal) {
      push('equal', aTokens.slice(block.aStart, block.aEnd).join(''));
      continue;
    }
    push('delete', aTokens.slice(block.aStart, block.aEnd).join(''));
    push('insert', bTokens.slice(block.bStart, block.bEnd).join(''));
  }
  return segments;
}

/**
 * Side-by-side diff of two documents.
 *
 * Lines inside a changed block are paired positionally and diffed word by word; the leftover
 * lines on either side become pure removals or additions.
 */
export function diffText(before: string, after: string): TextDiff {
  const aLines = splitLines(before);
  const bLines = splitLines(after);
  const { a, b } = intern(aLines, bLines);

  const pairs: Array<[number, number]> = [];
  lcsPairs(a, 0, a.length, b, 0, b.length, pairs);
  const blocks = alignBlocks(a.length, b.length, pairs);

  const rows: DiffRow[] = [];
  let addedWords = 0;
  let removedWords = 0;
  let changedRows = 0;

  for (const block of blocks) {
    if (block.equal) {
      for (let i = 0; i < block.aEnd - block.aStart; i++) {
        const text = aLines[block.aStart + i] ?? '';
        rows.push({
          kind: 'equal',
          left: [{ op: 'equal', text }],
          right: [{ op: 'equal', text }],
          leftNumber: block.aStart + i + 1,
          rightNumber: block.bStart + i + 1,
        });
      }
      continue;
    }

    const aCount = block.aEnd - block.aStart;
    const bCount = block.bEnd - block.bStart;
    const paired = Math.min(aCount, bCount);

    for (let i = 0; i < paired; i++) {
      const leftText = aLines[block.aStart + i] ?? '';
      const rightText = bLines[block.bStart + i] ?? '';
      const segments = diffWords(leftText, rightText);
      addedWords += countWords(segmentText(segments, 'insert'));
      removedWords += countWords(segmentText(segments, 'delete'));
      changedRows++;
      rows.push({
        kind: 'changed',
        left: segments.filter((segment) => segment.op !== 'insert'),
        right: segments.filter((segment) => segment.op !== 'delete'),
        leftNumber: block.aStart + i + 1,
        rightNumber: block.bStart + i + 1,
      });
    }

    for (let i = paired; i < aCount; i++) {
      const text = aLines[block.aStart + i] ?? '';
      removedWords += countWords(text);
      changedRows++;
      rows.push({
        kind: 'removed',
        left: [{ op: 'delete', text }],
        right: null,
        leftNumber: block.aStart + i + 1,
        rightNumber: null,
      });
    }

    for (let i = paired; i < bCount; i++) {
      const text = bLines[block.bStart + i] ?? '';
      addedWords += countWords(text);
      changedRows++;
      rows.push({
        kind: 'added',
        left: null,
        right: [{ op: 'insert', text }],
        leftNumber: null,
        rightNumber: block.bStart + i + 1,
      });
    }
  }

  return { rows, addedWords, removedWords, changedRows };
}

/**
 * Drops long runs of unchanged lines, keeping `context` of them either side of each edit —
 * the same trick `diff -u` uses, so a one-word change in a 2,000-word page is findable.
 */
export function collapseUnchanged(rows: readonly DiffRow[], context = 2): Array<DiffRow | { kind: 'gap'; hidden: number }> {
  const keep = new Array<boolean>(rows.length).fill(false);
  rows.forEach((row, index) => {
    if (row.kind === 'equal') return;
    for (let i = Math.max(0, index - context); i <= Math.min(rows.length - 1, index + context); i++) {
      keep[i] = true;
    }
  });

  const out: Array<DiffRow | { kind: 'gap'; hidden: number }> = [];
  let hidden = 0;
  rows.forEach((row, index) => {
    if (keep[index]) {
      if (hidden > 0) {
        out.push({ kind: 'gap', hidden });
        hidden = 0;
      }
      out.push(row);
      return;
    }
    hidden++;
  });
  if (hidden > 0) out.push({ kind: 'gap', hidden });
  return out;
}
