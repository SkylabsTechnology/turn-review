import { digest, stableKey } from './util';
import type { Hunk } from '../shared/types';

/**
 * Line diff (Myers) that yields exact, context-free edit regions. Each region
 * can be reversed against B with a single splice, which is what the safe Undo
 * engine relies on. Stable hunk IDs are content-derived, never line numbers.
 */

export interface EditOp {
  type: 'equal' | 'delete' | 'insert';
  /** 1-based line index in A for deletes/equals, 0 for inserts. */
  a: number;
  /** 1-based line index in B for inserts/equals, 0 for deletes. */
  b: number;
}

/** Split text into lines, preserving an empty body as a zero-length array. */
export function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split('\n').map((l) => l.replace(/\r$/, ''));
  // A trailing newline yields a final empty element; it is the terminator of
  // the last real line, not a real line.
  if (text.endsWith('\n')) lines.pop();
  return lines;
}

/** Rebuild text from lines using the original EOL style. */
export function joinLines(lines: string[], original: string): string {
  if (lines.length === 0) return '';
  const crlf = original.includes('\r\n');
  const sep = crlf ? '\r\n' : '\n';
  return lines.join(sep) + (original.endsWith('\n') || original.endsWith('\r\n') ? sep : '');
}

const MAX_DIFF_LINES = 12_000;

/**
 * Raw-bytes line model for byte-exact reconstruction (mixed CRLF/LF and
 * missing final newline must round-trip, C09). A line keeps its terminator as
 * raw bytes so splicing never normalizes EOL style.
 */
export interface RawLine {
  /** Line content without its terminator. */
  bytes: Buffer;
  /** Terminator bytes (`\n`, `\r\n`) or null when the final line has none. */
  terminator: Buffer | null;
}

/** Split a raw buffer into lines, preserving terminators. */
export function splitRaw(buf: Buffer): RawLine[] {
  const lines: RawLine[] = [];
  let start = 0;
  for (let i = 0; i < buf.length; i += 1) {
    if (buf[i] === 0x0a) {
      const hasCR = i > start && buf[i - 1] === 0x0d;
      const contentEnd = hasCR ? i - 1 : i;
      lines.push({
        bytes: buf.subarray(start, contentEnd),
        terminator: hasCR ? Buffer.from('\r\n') : Buffer.from('\n'),
      });
      start = i + 1;
    }
  }
  if (start < buf.length) {
    lines.push({ bytes: buf.subarray(start), terminator: null });
  } else if (start === buf.length && buf.length > 0) {
    // Trailing newline: no dangling final line.
  }
  return lines;
}

/** Rebuild a buffer from line spans, byte-exact. */
function joinRaw(lines: RawLine[]): Buffer {
  const parts: Buffer[] = [];
  let size = 0;
  for (const line of lines) {
    parts.push(line.bytes);
    size += line.bytes.length;
    if (line.terminator) {
      parts.push(line.terminator);
      size += line.terminator.length;
    }
  }
  return Buffer.concat(parts, size);
}

/**
 * Byte-exact revert of a single hunk against the after buffer: delete the
 * added lines (from B) and insert the removed lines (from A). Throws on range
 * mismatch (caller must have verified current bytes == B first).
 */
export function revertHunkRaw(current: Buffer, hunk: Hunk, beforeBuffer: Buffer): Buffer {
  const currentLines = splitRaw(current);
  const beforeLines = splitRaw(beforeBuffer);
  const start = hunk.newStart - 1;
  if (start < 0 || start + hunk.newCount > currentLines.length) {
    throw new Error('hunk-range-mismatch');
  }
  const beforeStart = hunk.oldStart - 1;
  if (beforeStart < 0 || beforeStart + hunk.oldCount > beforeLines.length) {
    throw new Error('before-range-mismatch');
  }
  const removed = beforeLines.slice(beforeStart, beforeStart + hunk.oldCount);
  const out = currentLines.slice();
  out.splice(start, hunk.newCount, ...removed);
  return joinRaw(out);
}

/**
 * Byte-exact revert of several hunks (only the non-kept ones) against B to get
 * the pending baseline. Descending newStart order keeps earlier anchors valid.
 */
export function revertHunksRaw(current: Buffer, hunks: Hunk[], beforeBuffer: Buffer): Buffer {
  const sorted = [...hunks].sort((x, y) => y.newStart - x.newStart);
  let out = current;
  for (const hunk of sorted) {
    out = revertHunkRaw(out, hunk, beforeBuffer);
  }
  return out;
}

/**
 * Myers O(ND) diff. Returns an edit script ordered by position in B; each
 * delete references its A line, each insert references its B line.
 */
export function diffLines(a: string[], b: string[]): EditOp[] {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  if (max === 0) return [];
  if (max > MAX_DIFF_LINES) {
    // Too large to diff safely in memory: emit a single whole-file replace.
    const ops: EditOp[] = [];
    for (let i = 0; i < n; i += 1) ops.push({ type: 'delete', a: i + 1, b: 0 });
    for (let j = 0; j < m; j += 1) ops.push({ type: 'insert', a: 0, b: j + 1 });
    return ops;
  }
  const v = new Int32Array(2 * max + 1);
  const trace: Int32Array[] = [];
  let found = false;
  for (let d = 0; d <= max && !found; d += 1) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[k - 1 + max] < v[k + 1 + max])) {
        x = v[k + 1 + max];
      } else {
        x = v[k - 1 + max] + 1;
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      v[k + max] = x;
      if (x >= n && y >= m) {
        found = true;
        break;
      }
    }
  }
  // Backtrack.
  const ops: EditOp[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d > 0; d -= 1) {
    const vd = trace[d];
    const k = x - y;
    let prevK: number;
    if (k === -d || (k !== d && vd[k - 1 + max] < vd[k + 1 + max])) {
      prevK = k + 1;
    } else {
      prevK = k - 1;
    }
    const prevX = vd[prevK + max];
    const prevY = prevX - prevK;
    // Diagonal (equal) run before this edit step.
    while (x > prevX && y > prevY) {
      ops.unshift({ type: 'equal', a: x, b: y });
      x -= 1;
      y -= 1;
    }
    if (x === prevX) {
      if (y > prevY) ops.unshift({ type: 'insert', a: 0, b: y });
    } else if (y === prevY) {
      if (x > prevX) ops.unshift({ type: 'delete', a: x, b: 0 });
    }
    x = prevX;
    y = prevY;
  }
  // The backtrack emits equals between edits but drops the leading common
  // prefix (it lives on the d=0 diagonal we intentionally skip). Prepend it.
  let lead = 0;
  while (lead < n && lead < m && a[lead] === b[lead]) lead += 1;
  for (let i = lead; i >= 1; i -= 1) {
    ops.unshift({ type: 'equal', a: i, b: i });
  }
  return ops;
}

export interface HunkResult {
  hunks: Hunk[];
  fullReplace: boolean;
}

/**
 * Compute hunks between two texts (A before, B after). Both strings must be
 * the exact raw bytes decoded as utf8 for supported text files.
 */
export function computeHunks(beforeText: string, afterText: string, relPath: string, beforeHash: string | null, afterHash: string | null): HunkResult {
  const a = splitLines(beforeText);
  const b = splitLines(afterText);
  const ops = diffLines(a, b);
  // Reconstruct removed/added line content and anchors.
  const hunks: Hunk[] = [];
  let aIdx = 0;
  let bIdx = 0;
  let pending: { oldStart: number; newStart: number; removed: string[]; added: string[] } | null = null;

  const flush = () => {
    if (!pending) return;
    const oldCount = pending.removed.length;
    const newCount = pending.added.length;
    const id = `h-${stableKey(relPath, beforeHash ?? '', afterHash ?? '', String(pending.oldStart), String(oldCount), String(pending.newStart), String(newCount), digest(pending.removed.join('\u0000')), digest(pending.added.join('\u0000'))).slice(0, 16)}`;
    hunks.push({ id, oldStart: pending.oldStart, oldCount, newStart: pending.newStart, newCount, removed: pending.removed, added: pending.added });
    pending = null;
  };

  for (const op of ops) {
    if (op.type === 'equal') {
      // A run of common lines separates two edit regions into two hunks.
      flush();
      aIdx += 1;
      bIdx += 1;
    } else if (op.type === 'delete') {
      if (!pending) pending = { oldStart: aIdx + 1, newStart: bIdx + 1, removed: [], added: [] };
      pending.removed.push(a[aIdx]);
      aIdx += 1;
    } else {
      if (!pending) pending = { oldStart: aIdx + 1, newStart: bIdx + 1, removed: [], added: [] };
      pending.added.push(b[bIdx]);
      bIdx += 1;
    }
  }
  flush();
  return { hunks, fullReplace: ops.length > MAX_DIFF_LINES };
}

/**
 * Reverse a single hunk against the after (B) lines. Exact by construction.
 * Throws when the hunk does not fit the current line array (caller must have
 * verified current bytes == B first). Kept for unit-test coverage of the
 * line-level semantics; the engine uses the byte-exact raw variants.
 */
export function revertSingleHunk(bLines: string[], hunk: Hunk): string[] {
  const start = hunk.newStart - 1;
  if (start < 0 || start + hunk.newCount > bLines.length) {
    throw new Error('hunk-range-mismatch');
  }
  const out = bLines.slice();
  out.splice(start, hunk.newCount, ...hunk.removed);
  return out;
}

/**
 * Reverse the given hunks (only the non-kept ones) against B lines to obtain
 * the pending baseline. Hunks are processed in descending newStart order so
 * earlier anchors remain valid.
 */
export function revertHunks(bLines: string[], hunks: Hunk[]): string[] {
  const sorted = [...hunks].sort((x, y) => y.newStart - x.newStart);
  let out = bLines;
  for (const hunk of sorted) {
    out = revertSingleHunk(out, hunk);
  }
  return out;
}
