import test from 'node:test';
import assert from 'node:assert/strict';
import { computeHunks, revertHunkRaw, revertHunksRaw, splitRaw, splitLines } from '../server/diff';

const rel = 'src/a.ts';
const A = 'one\ntwo\nthree\n';
const B = 'one\nTWO\nthree\nfour\n';

test('computeHunks produces an exact reversible region', () => {
  const { hunks } = computeHunks(A, B, rel, 'a', 'b');
  assert.ok(hunks.length >= 1);
  // Reverting every hunk must reproduce A byte-exactly.
  const reverted = revertHunksRaw(Buffer.from(B), hunks, Buffer.from(A));
  assert.equal(reverted.toString('utf8'), A);
  // Reverting only the first hunk leaves the second edit in place.
  const partial = revertHunkRaw(Buffer.from(B), hunks[0], Buffer.from(A));
  assert.equal(partial.toString('utf8'), 'one\ntwo\nthree\nfour\n');
});

test('hunk ids are content-derived and stable across recomputation', () => {
  const first = computeHunks(A, B, rel, 'a', 'b').hunks.map((h) => h.id);
  const second = computeHunks(A, B, rel, 'a', 'b').hunks.map((h) => h.id);
  assert.deepEqual(first, second);
});

test('revert is byte-exact with BOM and CRLF (C09)', () => {
  const a = Buffer.from('\ufeffone\r\ntwo\r\n', 'utf8');
  const b = Buffer.from('\ufeffone\r\nTWO\r\n', 'utf8');
  const { hunks } = computeHunks(a.toString('utf8'), b.toString('utf8'), rel, 'a', 'b');
  const reverted = revertHunkRaw(b, hunks[0], a);
  assert.deepEqual(reverted, a);
});

test('revert preserves mixed line endings and missing final newline', () => {
  // A: CRLF lines, no trailing newline on last line; B: same lines modified.
  const a = Buffer.from('aa\r\nbb\r\ncc', 'utf8');
  const b = Buffer.from('aa\r\nBB\r\ncc', 'utf8');
  const { hunks } = computeHunks(a.toString('utf8'), b.toString('utf8'), rel, 'a', 'b');
  const reverted = revertHunkRaw(b, hunks[0], a);
  assert.deepEqual(reverted, a);
});

test('revertHunksRaw reconstructs pending baseline after partial keeps', () => {
  // A = "1\n2\n3\n4\n5\n", B = "1\nX\n3\nY\n5\n" (two hunks).
  const a = Buffer.from('1\n2\n3\n4\n5\n', 'utf8');
  const b = Buffer.from('1\nX\n3\nY\n5\n', 'utf8');
  const { hunks } = computeHunks(a.toString('utf8'), b.toString('utf8'), rel, 'a', 'b');
  assert.equal(hunks.length, 2);
  // Keep the first hunk (X); pending baseline should revert only the second.
  const kept = [hunks[0].id];
  const nonKept = hunks.filter((h) => !kept.includes(h.id));
  const pending = revertHunksRaw(b, nonKept, a);
  // Expected: 1\nX\n3\n4\n5\n (Y reverted to 4)
  assert.equal(pending.toString('utf8'), '1\nX\n3\n4\n5\n');
});

test('revert refuses a range that no longer fits', () => {
  const { hunks } = computeHunks(A, B, rel, 'a', 'b');
  // A file with zero lines cannot accept any hunk (each hunk has newCount >= 1).
  const foreign = Buffer.alloc(0);
  assert.throws(() => revertHunkRaw(foreign, hunks[0], Buffer.from(A)), /mismatch/);
});

test('empty body splits to zero lines and reverts', () => {
  assert.deepEqual(splitLines(''), []);
  const a = Buffer.alloc(0);
  const b = Buffer.from('new\n');
  const { hunks } = computeHunks('', 'new\n', rel, 'a', 'b');
  // created-style: hunk inserts lines
  const reverted = revertHunkRaw(b, hunks[0], a);
  assert.deepEqual(reverted, a);
});
