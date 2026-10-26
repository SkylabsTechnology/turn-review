import test from 'node:test';
import assert from 'node:assert/strict';
import { rowLabel, countColor } from '../client/row-label';

test('rowLabel splits a nested path into fileName + dirPath', () => {
  assert.deepEqual(rowLabel('src/deep/nested.file.ts'), { fileName: 'nested.file.ts', dirPath: 'src/deep/' });
});

test('rowLabel leaves top-level files with no dirPath', () => {
  assert.deepEqual(rowLabel('index.html'), { fileName: 'index.html', dirPath: '' });
});

test('rowLabel handles forward slashes regardless of platform', () => {
  assert.deepEqual(rowLabel('a/b/c.txt'), { fileName: 'c.txt', dirPath: 'a/b/' });
});

test('countColor uses the positive color when > 0 and muted when 0', () => {
  assert.equal(countColor(3, 'green', 'grey'), 'green');
  assert.equal(countColor(1, 'red', 'grey'), 'red');
  assert.equal(countColor(0, 'green', 'grey'), 'grey');
  assert.equal(countColor(0, 'red', 'grey'), 'grey');
});
