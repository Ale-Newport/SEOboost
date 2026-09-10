/**
 * A word-level diff, small enough to own.
 *
 * The approvals queue has to show exactly what a change does to live copy, which means a real
 * diff rather than "before" and "after" side by side. This is a classic LCS over whitespace
 * tokens with two guards that matter in practice: the common head and tail are stripped first
 * (edits are almost always local, so the quadratic part usually collapses to a handful of
 * tokens), and a hard cell budget falls back to a whole-block replace rather than freezing the
 * browser on a pathological pair of documents.
 *
 * No dependency: a diff library is ~30kB in the client bundle for behaviour that is 80 lines.
 */

export type DiffOp = 'equal' | 'insert' | 'delete';

export interface DiffPiece {
  op: DiffOp;
  text: string;
}

/** Words and the whitespace between them, so re-joining the pieces reproduces the input exactly. */
function tokenize(text: string): string[] {
  return text.length === 0 ? [] : text.split(/(\s+)/).filter((token) => token.length > 0);
}

/** Above this many DP cells we stop diffing and report the block as replaced. */
const MAX_CELLS = 400_000;

function push(pieces: DiffPiece[], op: DiffOp, text: string): void {
  if (text.length === 0) return;
  const last = pieces[pieces.length - 1];
  // Merge runs so the renderer emits one <ins>/<del> per edit rather than one per token.
  if (last && last.op === op) last.text += text;
  else pieces.push({ op, text });
}

/**
 * Longest-common-subsequence table over two token arrays.
 * `Uint32Array` rather than nested arrays: a 600×600 diff is 360k cells, and the flat typed
 * array keeps that a single allocation.
 */
function lcsTable(a: readonly string[], b: readonly string[]): Uint32Array {
  const width = b.length + 1;
  const table = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i * width + j] =
        a[i] === b[j]
          ? table[(i + 1) * width + (j + 1)] + 1
          : Math.max(table[(i + 1) * width + j], table[i * width + (j + 1)]);
    }
  }
  return table;
}

/**
 * Diff two strings into a flat list of equal/inserted/deleted runs.
 * `diffWords(x, x)` is a single `equal` piece; diffing against an empty string is a single
 * `insert` or `delete`.
 */
export function diffWords(before: string, after: string): DiffPiece[] {
  if (before === after) {
    return before.length === 0 ? [] : [{ op: 'equal', text: before }];
  }
  if (before.length === 0) return [{ op: 'insert', text: after }];
  if (after.length === 0) return [{ op: 'delete', text: before }];

  const a = tokenize(before);
  const b = tokenize(after);

  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;

  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) {
    tail += 1;
  }

  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);

  const pieces: DiffPiece[] = [];
  push(pieces, 'equal', a.slice(0, head).join(''));

  if (midA.length === 0) {
    push(pieces, 'insert', midB.join(''));
  } else if (midB.length === 0) {
    push(pieces, 'delete', midA.join(''));
  } else if (midA.length * midB.length > MAX_CELLS) {
    // Too large to align word by word — say "this block was replaced" instead of guessing.
    push(pieces, 'delete', midA.join(''));
    push(pieces, 'insert', midB.join(''));
  } else {
    const width = midB.length + 1;
    const table = lcsTable(midA, midB);
    let i = 0;
    let j = 0;
    while (i < midA.length && j < midB.length) {
      if (midA[i] === midB[j]) {
        push(pieces, 'equal', midA[i]);
        i += 1;
        j += 1;
      } else if (table[(i + 1) * width + j] >= table[i * width + (j + 1)]) {
        push(pieces, 'delete', midA[i]);
        i += 1;
      } else {
        push(pieces, 'insert', midB[j]);
        j += 1;
      }
    }
    push(pieces, 'delete', midA.slice(i).join(''));
    push(pieces, 'insert', midB.slice(j).join(''));
  }

  push(pieces, 'equal', tail === 0 ? '' : a.slice(a.length - tail).join(''));
  return pieces;
}

export interface DiffStats {
  added: number;
  removed: number;
  /** True when the two sides are identical — the caller should say "no change", not show a diff. */
  identical: boolean;
}

/** Word counts on each side of the change, for the "+12 / −4 words" summary line. */
export function diffStats(pieces: readonly DiffPiece[]): DiffStats {
  let added = 0;
  let removed = 0;
  for (const piece of pieces) {
    if (piece.op === 'equal') continue;
    const words = piece.text.trim().length === 0 ? 0 : piece.text.trim().split(/\s+/).length;
    if (piece.op === 'insert') added += words;
    else removed += words;
  }
  return { added, removed, identical: added === 0 && removed === 0 };
}
