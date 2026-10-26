import type { Hunk } from '../shared/types';

/**
 * Split text into lines the same way the server does (server/diff.ts
 * `splitLines`), so client line arrays always match the hunk line model:
 * CRLF stripped, and a trailing-newline terminator is not a real line.
 */
export function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split('\n').map((l) => l.replace(/\r$/, ''));
  if (text.endsWith('\n')) lines.pop();
  return lines;
}

/**
 * Builds the line-level alignment the VS Code diff editor uses, from the full
 * before/after line arrays and the server's hunks.
 *
 * VS Code pairs removed lines with added lines inside each hunk (interleaving
 * them row-by-row so the two columns stay roughly in sync) and shows unchanged
 * context lines paired by index. `context`/`change` rows carry both sides;
 * `remove`/`add` rows carry a single side (the shorter block in a hunk is
 * padded). Rows carry 1-based original line numbers for each side.
 */

export type AlignedRow =
  | { type: 'context'; region: number | null; beforeLine: number; afterLine: number; before: string; after: string }
  | { type: 'remove'; region: number; beforeLine: number; afterLine: null; before: string; after: null }
  | { type: 'add'; region: number; beforeLine: null; afterLine: number; before: null; after: string }
  | { type: 'change'; region: number; beforeLine: number; afterLine: number; before: string; after: string };

export interface DiffAlignment {
  rows: AlignedRow[];
  additions: number;
  deletions: number;
  /** Region count of contiguous changed blocks (for dividers/labels). */
  regions: number;
}

const EMPTY = '';

export function buildAlignment(beforeLines: string[], afterLines: string[], hunks: Hunk[], kind: 'modified' | 'created' | 'deleted'): DiffAlignment {
  // Created/deleted: every line on the single present side is a change.
  if (kind === 'created') {
    return {
      rows: afterLines.map((line, i) => ({ type: 'add', region: 1, beforeLine: null, afterLine: i + 1, before: null, after: line })),
      additions: afterLines.length,
      deletions: 0,
      regions: afterLines.length > 0 ? 1 : 0,
    };
  }
  if (kind === 'deleted') {
    return {
      rows: beforeLines.map((line, i) => ({ type: 'remove', region: 1, beforeLine: i + 1, afterLine: null, before: line, after: null })),
      additions: 0,
      deletions: beforeLines.length,
      regions: beforeLines.length > 0 ? 1 : 0,
    };
  }

  const rows: AlignedRow[] = [];
  let additions = 0;
  let deletions = 0;
  let aIdx = 0;
  let bIdx = 0;
  let region = 0;

  const pushContext = () => {
    rows.push({ type: 'context', region: null, beforeLine: aIdx + 1, afterLine: bIdx + 1, before: beforeLines[aIdx] ?? EMPTY, after: afterLines[bIdx] ?? EMPTY });
  };

  for (const hunk of hunks) {
    const hA0 = hunk.oldStart - 1;
    const hB0 = hunk.newStart - 1;
    // Context lines between the previous region and this hunk.
    while (aIdx < hA0 || bIdx < hB0) {
      pushContext();
      aIdx += 1;
      bIdx += 1;
    }
    additions += hunk.added.length;
    deletions += hunk.removed.length;
    region += 1;
    const pairCount = Math.max(hunk.removed.length, hunk.added.length);
    for (let i = 0; i < pairCount; i += 1) {
      const hasBefore = i < hunk.removed.length;
      const hasAfter = i < hunk.added.length;
      if (hasBefore && hasAfter) {
        rows.push({ type: 'change', region, beforeLine: hunk.oldStart + i, afterLine: hunk.newStart + i, before: hunk.removed[i], after: hunk.added[i] });
      } else if (hasBefore) {
        rows.push({ type: 'remove', region, beforeLine: hunk.oldStart + i, afterLine: null, before: hunk.removed[i], after: null });
      } else {
        rows.push({ type: 'add', region, beforeLine: null, afterLine: hunk.newStart + i, before: null, after: hunk.added[i] });
      }
    }
    aIdx += hunk.removed.length;
    bIdx += hunk.added.length;
  }
  // Trailing context.
  while (aIdx < beforeLines.length || bIdx < afterLines.length) {
    pushContext();
    aIdx += 1;
    bIdx += 1;
  }

  return { rows, additions, deletions, regions: region };
}

// ---------------------------------------------------------------------------
// Intra-line (word-level) diff — the changed character ranges on each side of
// a modified line, so the viewer can highlight them like VS Code does.
// ---------------------------------------------------------------------------

function tokenizeWords(s: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < s.length) {
    if (/[A-Za-z0-9_]/.test(s[i])) {
      let j = i;
      while (j < s.length && /[A-Za-z0-9_]/.test(s[j])) j += 1;
      out.push(s.slice(i, j));
      i = j;
    } else {
      out.push(s[i]);
      i += 1;
    }
  }
  return out;
}

function toRanges(tokens: string[], keep: Uint8Array): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let pos = 0;
  let runStart = -1;
  for (let k = 0; k < tokens.length; k += 1) {
    const len = tokens[k].length;
    if (!keep[k]) {
      if (runStart === -1) runStart = pos;
    } else if (runStart !== -1) {
      ranges.push([runStart, pos]);
      runStart = -1;
    }
    pos += len;
  }
  if (runStart !== -1) ranges.push([runStart, pos]);
  return ranges;
}

/** Cheap common-prefix/suffix fallback (used when LCS would be too large). */
function charDiffRanges(a: string, b: string): { a: Array<[number, number]>; b: Array<[number, number]> } {
  const n = a.length;
  const m = b.length;
  let p = 0;
  while (p < n && p < m && a[p] === b[p]) p += 1;
  let s = 0;
  while (s < n - p && s < m - p && a[n - 1 - s] === b[m - 1 - s]) s += 1;
  return {
    a: p < n - s ? [[p, n - s]] : [],
    b: p < m - s ? [[p, m - s]] : [],
  };
}

/**
 * Character ranges (start, end] exclusive) that differ between two lines of a
 * modified pair. Uses a token-level LCS (word diff) with a size cap; falls
 * back to common-prefix/suffix. Empty when the lines are identical.
 */
export function wordDiffRanges(a: string, b: string): { a: Array<[number, number]>; b: Array<[number, number]> } {
  if (a === b) return { a: [], b: [] };
  const ta = tokenizeWords(a);
  const tb = tokenizeWords(b);
  if (ta.length * tb.length > 40_000) return charDiffRanges(a, b);

  const n = ta.length;
  const m = tb.length;
  const width = m + 1;
  const dp = new Uint16Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i * width + j] = ta[i] === tb[j] ? dp[(i + 1) * width + (j + 1)] + 1 : Math.max(dp[(i + 1) * width + j], dp[i * width + (j + 1)]);
    }
  }
  const keepA = new Uint8Array(n);
  const keepB = new Uint8Array(m);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (ta[i] === tb[j]) {
      keepA[i] = 1;
      keepB[j] = 1;
      i += 1;
      j += 1;
    } else if (dp[(i + 1) * width + j] >= dp[i * width + (j + 1)]) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return { a: toRanges(ta, keepA), b: toRanges(tb, keepB) };
}
