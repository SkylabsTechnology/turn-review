import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAlignment, splitLines, wordDiffRanges } from '../client/diff-align';
import type { Hunk } from '../shared/types';

const hunk = (partial: Partial<Hunk>): Hunk => ({ id: 'h', oldStart: 1, oldCount: 0, newStart: 1, newCount: 0, removed: [], added: [], ...partial });

test('D01: insertion hunk interleaves an add row between context rows', () => {
  const before = ['a', 'b', 'c', 'd', 'e'];
  const after = ['a', 'b', 'x', 'c', 'd', 'e'];
  const al = buildAlignment(before, after, [hunk({ oldStart: 3, oldCount: 0, newStart: 3, newCount: 1, added: ['x'] })], 'modified');
  assert.equal(al.additions, 1);
  assert.equal(al.deletions, 0);
  assert.equal(al.regions, 1);
  assert.deepEqual(
    al.rows.map((r) => [r.type, r.beforeLine, r.afterLine, 'before' in r && r.before, 'after' in r && r.after]),
    [
      ['context', 1, 1, 'a', 'a'],
      ['context', 2, 2, 'b', 'b'],
      ['add', null, 3, null, 'x'],
      ['context', 3, 4, 'c', 'c'],
      ['context', 4, 5, 'd', 'd'],
      ['context', 5, 6, 'e', 'e'],
    ],
  );
});

test('D02: deletion and mixed blocks produce remove/change rows', () => {
  const before = ['a', 'b', 'c', 'd'];
  const after = ['a', 'b', 'd'];
  const al = buildAlignment(before, after, [hunk({ oldStart: 3, oldCount: 1, newStart: 3, newCount: 0, removed: ['c'] })], 'modified');
  assert.equal(al.deletions, 1);
  const removeRow = al.rows.find((r) => r.type === 'remove')!;
  assert.equal(removeRow.beforeLine, 3);
  assert.equal(removeRow.afterLine, null);

  // Mixed: two removed, one added -> remove + change rows.
  const before2 = ['a', 'b', 'c', 'd'];
  const after2 = ['a', 'x', 'd'];
  const al2 = buildAlignment(before2, after2, [hunk({ oldStart: 2, oldCount: 2, newStart: 2, newCount: 1, removed: ['b', 'c'], added: ['x'] })], 'modified');
  const types2 = al2.rows.map((r) => r.type);
  assert.deepEqual(types2, ['context', 'change', 'remove', 'context']);
  assert.equal(al2.additions, 1);
  assert.equal(al2.deletions, 2);
});

test('D03: created/deleted produce all-add / all-remove rows', () => {
  const created = buildAlignment([], ['x', 'y'], [], 'created');
  assert.deepEqual(created.rows.map((r) => r.type), ['add', 'add']);
  assert.equal(created.additions, 2);
  assert.equal(created.regions, 1);

  const deleted = buildAlignment(['x', 'y'], [], [], 'deleted');
  assert.deepEqual(deleted.rows.map((r) => r.type), ['remove', 'remove']);
  assert.equal(deleted.deletions, 2);
});

test('D04: multiple hunks keep independent regions and trailing context', () => {
  const before = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
  const after = ['A', 'b', 'c', 'D', 'e', 'f', 'G'];
  const al = buildAlignment(
    before,
    after,
    [
      hunk({ oldStart: 1, oldCount: 1, newStart: 1, newCount: 1, removed: ['a'], added: ['A'] }),
      hunk({ oldStart: 4, oldCount: 1, newStart: 4, newCount: 1, removed: ['d'], added: ['D'] }),
      hunk({ oldStart: 7, oldCount: 1, newStart: 7, newCount: 1, removed: ['g'], added: ['G'] }),
    ],
    'modified',
  );
  assert.equal(al.regions, 3);
  assert.equal(al.additions, 3);
  assert.equal(al.deletions, 3);
  assert.equal(al.rows.filter((r) => r.type === 'context').length, 4);
});

test('D05: word diff highlights changed words within a line', () => {
  const ins = wordDiffRanges('function add(a) { return a; }', 'function add(a) { return a + 1; }');
  assert.equal(ins.a.length, 0); // nothing removed
  assert.ok(ins.b.length >= 1);
  const joinedB = ins.b.map(([s, e]) => 'function add(a) { return a + 1; }'.slice(s, e)).join('');
  assert.ok(joinedB.includes('+') || joinedB.includes('1'));

  // A single word in the middle changes: only that word is highlighted.
  const mid = wordDiffRanges('hello world foo', 'hello there foo');
  assert.equal('hello world foo'.slice(...mid.a[0]), 'world');
  assert.equal('hello there foo'.slice(...mid.b[0]), 'there');

  // Digits are part of the same word, so 'line2' vs 'LINE2' is a whole-word change.
  const caseChange = wordDiffRanges('line2', 'LINE2');
  assert.equal('line2'.slice(...caseChange.a[0]), 'line2');
  assert.equal('LINE2'.slice(...caseChange.b[0]), 'LINE2');
});

test('D06: identical lines yield no intra-line ranges', () => {
  assert.deepEqual(wordDiffRanges('same text', 'same text'), { a: [], b: [] });
});

test('D07: word diff is total for a full replacement', () => {
  const r = wordDiffRanges('abcdef', 'xyz');
  assert.equal(r.a[0][0], 0);
  assert.equal(r.a[0][1], 6);
  assert.equal(r.b[0][0], 0);
  assert.equal(r.b[0][1], 3);
});

test('D08: splitLines matches the server line model (no phantom trailing line, CRLF stripped)', () => {
  assert.deepEqual(splitLines('a\nb\n'), ['a', 'b']);
  assert.deepEqual(splitLines('a\nb'), ['a', 'b']);
  assert.deepEqual(splitLines('a\r\nb\r\n'), ['a', 'b']);
  assert.deepEqual(splitLines(''), []);

  // Newline-terminated 3-line file must not render a phantom 4th row.
  const before = splitLines('x\nY\nz\n');
  const after = splitLines('X\nY\nz\n');
  const al = buildAlignment(before, after, [hunk({ oldStart: 1, oldCount: 1, newStart: 1, newCount: 1, removed: ['x'], added: ['X'] })], 'modified');
  assert.deepEqual(al.rows.map((r) => r.type), ['change', 'context', 'context']);
  assert.equal(al.rows.length, 3);
});
