import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { makeRepo, makeHarness, writeFile, readFile, git, sha } from './helpers';
import { opId, sha256Hex } from '../shared/op-id';
import { isValidOperationId } from '../server/review-engine';

/** Standard flow: capture before (proven barrier), apply turn edits, capture after. */
async function runTurn(engine: import('../server/review-engine').ReviewEngine, root: string, edits: () => void, opts: { agent?: string; workspace?: string } = {}) {
  const agent = opts.agent ?? 'a1';
  const workspace = opts.workspace ?? 'ws-1';
  const captureId = await engine.startTurn({ agentId: agent, workspaceId: workspace, cwd: root, turnId: `t-${Math.random()}`, barrier: 'proven' });
  edits();
  const review = await engine.endTurn({ occurrenceId: captureId, agentId: agent, workspaceId: workspace, cwd: root, outcome: 'completed', barrier: 'proven' });
  return { captureId, review: review! };
}

test('C01: clean tracked file changed in one turn; undo restores bytes and index is untouched', async () => {
  const { root, cleanup } = makeRepo();
  writeFile(root, 'a.txt', 'one\ntwo\nthree\n');
  git(root, ['add', 'a.txt']);
  git(root, ['commit', '-m', 'add a']);
  const original = readFile(root, 'a.txt');
  const harness = makeHarness(root);
  try {
    const indexBefore = git(root, ['hash-object', path.join(root, '.git', 'index')]);
    const { captureId, review } = await runTurn(harness.engine, root, () => {
      writeFile(root, 'a.txt', 'one\nTWO\nthree\n');
    });
    const file = review!.files.find((f) => f.relativePath === 'a.txt');
    assert.ok(file);
    assert.equal(file.kind, 'modified');
    assert.equal(file.support, 'undo-exact');
    assert.equal(file.preTurnDirty, false);

    const undo = await harness.engine.undoFile(captureId, 'ws-1', review!.revision, 'op-1', 'a.txt', file.afterHash, false);
    assert.equal(undo.result.status, 'ok');
    assert.deepEqual(readFile(root, 'a.txt'), original);
    assert.equal(git(root, ['hash-object', path.join(root, '.git', 'index')]), indexBefore);
    const after = harness.engine.get(captureId)!;
    assert.equal(after.files.find((f) => f.relativePath === 'a.txt')!.status, 'kept');
  } finally {
    cleanup();
    harness.cleanup();
  }
});

test('C02: file dirty before turn preserves pre-existing dirty bytes on Undo', async () => {
  const { root, cleanup } = makeRepo();
  writeFile(root, 'dirty.txt', 'd1\nd2\n');
  git(root, ['add', 'dirty.txt']);
  git(root, ['commit', '-m', 'add dirty']);
  writeFile(root, 'dirty.txt', 'd1\nD2-before\n'); // dirty before turn
  const harness = makeHarness(root);
  try {
    const { captureId, review } = await runTurn(harness.engine, root, () => {
      writeFile(root, 'dirty.txt', 'd1\nD2-after\nD3\n');
    });
    const file = review!.files.find((f) => f.relativePath === 'dirty.txt')!;
    assert.equal(file.preTurnDirty, true);
    assert.equal(file.support, 'undo-exact');
    const undo = await harness.engine.undoFile(captureId, 'ws-1', review!.revision, 'op-2', 'dirty.txt', file.afterHash, false);
    assert.equal(undo.result.status, 'ok');
    assert.equal(readFile(root, 'dirty.txt').toString('utf8'), 'd1\nD2-before\n');
  } finally {
    cleanup();
    harness.cleanup();
  }
});

test('C03: staged file keeps its staged bytes and index hash under Keep/Undo', async () => {
  const { root, cleanup } = makeRepo();
  writeFile(root, 'staged.txt', 's1\n');
  git(root, ['add', 'staged.txt']);
  git(root, ['commit', '-m', 'add staged']);
  writeFile(root, 'staged.txt', 'staged-v2\n');
  git(root, ['add', 'staged.txt']); // stage v2
  const stagedBlobBefore = git(root, ['rev-parse', 'staged.txt']);
  void stagedBlobBefore;
  const harness = makeHarness(root);
  try {
    const indexBefore = git(root, ['hash-object', path.join(root, '.git', 'index')]);
    const { captureId, review } = await runTurn(harness.engine, root, () => {
      writeFile(root, 'staged.txt', 'staged-v3\n'); // worktree only
    });
    const file = review!.files.find((f) => f.relativePath === 'staged.txt')!;
    assert.equal(file.preTurnDirty, true); // staged differs from HEAD
    const stagedAfterCapture = git(root, ['show', ':staged.txt']);
    assert.equal(stagedAfterCapture, 'staged-v2'); // helper trims trailing newline

    // Keep all: no fs write, index unchanged.
    await harness.engine.keep(captureId, 'ws-1', review!.revision, 'keep-op', { kind: 'all' });
    assert.equal(git(root, ['show', ':staged.txt']), 'staged-v2'); // helper trims
    assert.equal(git(root, ['hash-object', path.join(root, '.git', 'index')]), indexBefore);
  } finally {
    cleanup();
    harness.cleanup();
  }
});

test('C04: newly created untracked text file is captured and removed exactly on Undo', async () => {
  const { root, cleanup } = makeRepo();
  const harness = makeHarness(root);
  try {
    const { captureId, review } = await runTurn(harness.engine, root, () => {
      writeFile(root, 'new.txt', 'brand new\n');
    });
    const file = review!.files.find((f) => f.relativePath === 'new.txt')!;
    assert.equal(file.kind, 'created');
    assert.equal(file.support, 'undo-exact');
    const undo = await harness.engine.undoFile(captureId, 'ws-1', review!.revision, 'op-new', 'new.txt', file.afterHash, false);
    assert.equal(undo.result.status, 'ok');
    assert.equal(fs.existsSync(path.join(root, 'new.txt')), false);
  } finally {
    cleanup();
    harness.cleanup();
  }
});

test('C05: existing untracked dirty file edited by agent restores original untracked content', async () => {
  const { root, cleanup } = makeRepo();
  writeFile(root, 'untracked.txt', 'u1\n');
  const harness = makeHarness(root);
  try {
    const { captureId, review } = await runTurn(harness.engine, root, () => {
      writeFile(root, 'untracked.txt', 'u1\nu2\n');
    });
    const file = review!.files.find((f) => f.relativePath === 'untracked.txt')!;
    assert.equal(file.preTurnDirty, true);
    const undo = await harness.engine.undoFile(captureId, 'ws-1', review!.revision, 'op-untracked', 'untracked.txt', file.afterHash, false);
    assert.equal(undo.result.status, 'ok');
    assert.equal(readFile(root, 'untracked.txt').toString('utf8'), 'u1\n');
  } finally {
    cleanup();
    harness.cleanup();
  }
});

test('C06: ignored/secret file is excluded and never undo-able', async () => {
  const { root, cleanup } = makeRepo();
  writeFile(root, '.env', 'SECRET=old\n');
  git(root, ['add', '-f', '.env']);
  git(root, ['commit', '-m', 'add env']);
  const harness = makeHarness(root);
  try {
    const { captureId, review } = await runTurn(harness.engine, root, () => {
      writeFile(root, '.env', 'SECRET=new\n');
    });
    const file = review!.files.find((f) => f.relativePath === '.env');
    // .env is on the sensitive deny list -> excluded, no capture.
    assert.ok(file, 'expected an excluded marker for .env');
    assert.equal(file.support, 'excluded');
    const undo = await harness.engine.undoFile(captureId, 'ws-1', review!.revision, 'op-env', '.env', null, false);
    assert.equal(undo.result.status, 'refused');
    assert.equal(undo.result.reason, 'unsupported-undo');
  } finally {
    cleanup();
    harness.cleanup();
  }
});

test('C08: deleted tracked file is recreated byte-exactly on Undo', async () => {
  const { root, cleanup } = makeRepo();
  writeFile(root, 'gone.txt', 'g1\ng2\n');
  git(root, ['add', 'gone.txt']);
  git(root, ['commit', '-m', 'add gone']);
  const original = readFile(root, 'gone.txt');
  const harness = makeHarness(root);
  try {
    const { captureId, review } = await runTurn(harness.engine, root, () => {
      fs.unlinkSync(path.join(root, 'gone.txt'));
    });
    const file = review!.files.find((f) => f.relativePath === 'gone.txt')!;
    assert.equal(file.kind, 'deleted');
    assert.equal(file.support, 'undo-exact');
    const undo = await harness.engine.undoFile(captureId, 'ws-1', review!.revision, 'op-gone', 'gone.txt', null, true);
    assert.equal(undo.result.status, 'ok');
    assert.deepEqual(readFile(root, 'gone.txt'), original);
  } finally {
    cleanup();
    harness.cleanup();
  }
});

test('C15/C16: later manual edit refuses Undo and survives', async () => {
  const { root, cleanup } = makeRepo();
  writeFile(root, 'a.txt', 'one\ntwo\n');
  git(root, ['add', 'a.txt']);
  git(root, ['commit', '-m', 'add a']);
  const harness = makeHarness(root);
  try {
    const { captureId, review } = await runTurn(harness.engine, root, () => {
      writeFile(root, 'a.txt', 'one\nTWO\n');
    });
    const file = review!.files.find((f) => f.relativePath === 'a.txt')!;
    // Simulate a later user edit after the turn.
    writeFile(root, 'a.txt', 'one\nTWO\nuser-edit\n');
    const undo = await harness.engine.undoFile(captureId, 'ws-1', review!.revision, 'op-late', 'a.txt', file.afterHash, false);
    assert.equal(undo.result.status, 'conflict');
    assert.equal(undo.result.reason, 'file-changed');
    assert.equal(readFile(root, 'a.txt').toString('utf8'), 'one\nTWO\nuser-edit\n');
  } finally {
    cleanup();
    harness.cleanup();
  }
});

test('op-id builder: sha256 matches a known vector and ids always pass the allowlist', () => {
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  const reviewId = 'cap-12345678-1234-1234-1234-123456789abc';
  const tricky = [
    'a.txt',
    'src/features/foo.ts',
    'a b.ts',
    'dir/a-b_c.txt',
    `${'x'.repeat(90)}/y.ts`,
    'space dir/ünïcode.txt',
  ];
  for (const p of tricky) {
    const id = opId(reviewId, 3, 'keep', p);
    assert.ok(isValidOperationId(id), `op id must be valid for ${p}: ${id}`);
    assert.ok(id.length <= 128, `op id length must be <= 128 for ${p}`);
    const undoId = opId(reviewId, 3, 'undo', p, 'h-0123456789abcdef');
    assert.ok(isValidOperationId(undoId), `hunk op id must be valid for ${p}`);
  }
  // Stable across surfaces: card and panel hash the same path to the same id.
  assert.equal(opId(reviewId, 3, 'keep', 'src/features/foo.ts'), opId(reviewId, 3, 'keep', 'src/features/foo.ts'));
  assert.ok(isValidOperationId(opId(reviewId, 3, 'keep-all')));
  assert.ok(isValidOperationId(opId(reviewId, 3, 'undo-all')));
});

test('per-file Keep works end-to-end with a path-hashed operation id (op-id regression)', async () => {
  const { root, cleanup } = makeRepo();
  writeFile(root, 'src/sub/a.txt', 'AAA\n');
  git(root, ['add', 'src/sub/a.txt']);
  git(root, ['commit', '-m', 'add a']);
  const harness = makeHarness(root);
  try {
    const { captureId, review } = await runTurn(harness.engine, root, () => {
      writeFile(root, 'src/sub/a.txt', 'BBB\n');
    });
    const file = review!.files.find((f) => f.relativePath === 'src/sub/a.txt')!;
    const keepId = opId(captureId, review!.revision, 'keep', 'src/sub/a.txt');
    assert.ok(isValidOperationId(keepId));
    const kept = await harness.engine.keep(captureId, 'ws-1', review!.revision, keepId, { kind: 'file', path: 'src/sub/a.txt' });
    assert.equal(kept.ok, true, JSON.stringify(kept));
    assert.equal(harness.engine.get(captureId)!.files.find((f) => f.relativePath === 'src/sub/a.txt')!.status, 'kept');
  } finally {
    cleanup();
    harness.cleanup();
  }
});

test('invalid operationId is refused (F2 path traversal guard)', async () => {
  const { root, cleanup } = makeRepo();
  writeFile(root, 'a.txt', 'AAA\n');
  git(root, ['add', 'a.txt']);
  git(root, ['commit', '-m', 'add a']);
  const harness = makeHarness(root);
  try {
    const { captureId, review } = await runTurn(harness.engine, root, () => {
      writeFile(root, 'a.txt', 'BBB\n');
    });
    const file = review!.files.find((f) => f.relativePath === 'a.txt')!;
    const undo = await harness.engine.undoFile(captureId, 'ws-1', review!.revision, '../escape', 'a.txt', file.afterHash, false);
    assert.equal(undo.result.reason, 'invalid-idempotency-key');
    assert.equal(readFile(root, 'a.txt').toString('utf8'), 'BBB\n'); // untouched
    // No op file was created outside the ops directory.
    assert.equal(fs.existsSync(path.join(harness.storage.root, '..', 'escape.json')), false);
  } finally {
    cleanup();
    harness.cleanup();
  }
});

test('C19b: blind retry with a stale revision but an already-applied op is idempotent (F4)', async () => {
  const { root, cleanup } = makeRepo();
  writeFile(root, 'a.txt', 'AAA\n');
  git(root, ['add', 'a.txt']);
  git(root, ['commit', '-m', 'add a']);
  const original = readFile(root, 'a.txt');
  const harness = makeHarness(root);
  try {
    const { captureId, review } = await runTurn(harness.engine, root, () => {
      writeFile(root, 'a.txt', 'BBB\n');
    });
    const file = review!.files.find((f) => f.relativePath === 'a.txt')!;
    const first = await harness.engine.undoFile(captureId, 'ws-1', review!.revision, 'op-blind', 'a.txt', file.afterHash, false);
    assert.equal(first.result.status, 'ok');
    // Blind retry: SAME revision (now stale) and same op id must be idempotent.
    const retry = await harness.engine.undoFile(captureId, 'ws-1', review!.revision, 'op-blind', 'a.txt', file.afterHash, false);
    assert.equal(retry.result.status, 'ok');
    assert.equal(retry.result.reason, 'already-applied');
    assert.deepEqual(readFile(root, 'a.txt'), original);
  } finally {
    cleanup();
    harness.cleanup();
  }
});

test('C19: duplicate Undo with same operationId is idempotent (exactly-once)', async () => {
  const { root, cleanup } = makeRepo();
  writeFile(root, 'a.txt', 'AAA\n');
  git(root, ['add', 'a.txt']);
  git(root, ['commit', '-m', 'add a']);
  const original = readFile(root, 'a.txt');
  const harness = makeHarness(root);
  try {
    const { captureId, review } = await runTurn(harness.engine, root, () => {
      writeFile(root, 'a.txt', 'BBB\n');
    });
    const file = review!.files.find((f) => f.relativePath === 'a.txt')!;
    const first = await harness.engine.undoFile(captureId, 'ws-1', review!.revision, 'op-dupe', 'a.txt', file.afterHash, false);
    assert.equal(first.result.status, 'ok');
    // Client re-reads state after the first op: revision has advanced.
    const afterFirst = harness.engine.get(captureId)!;
    const second = await harness.engine.undoFile(captureId, 'ws-1', afterFirst.revision, 'op-dupe', 'a.txt', file.afterHash, false);
    assert.equal(second.result.status, 'ok');
    assert.equal(second.result.reason, 'already-applied');
    assert.deepEqual(readFile(root, 'a.txt'), original);
  } finally {
    cleanup();
    harness.cleanup();
  }
});

test('C20: stale revision and wrong workspace refuse Undo', async () => {
  const { root, cleanup } = makeRepo();
  writeFile(root, 'a.txt', 'AAA\n');
  git(root, ['add', 'a.txt']);
  git(root, ['commit', '-m', 'add a']);
  const harness = makeHarness(root);
  try {
    const { captureId, review } = await runTurn(harness.engine, root, () => {
      writeFile(root, 'a.txt', 'BBB\n');
    });
    const file = review!.files.find((f) => f.relativePath === 'a.txt')!;
    const stale = await harness.engine.undoFile(captureId, 'ws-1', review!.revision - 1, 'op-stale', 'a.txt', file.afterHash, false);
    assert.equal(stale.result.reason, 'stale-review');
    const wrongWs = await harness.engine.undoFile(captureId, 'other-ws', review!.revision, 'op-ws', 'a.txt', file.afterHash, false);
    assert.equal(wrongWs.result.reason, 'workspace-mismatch');
  } finally {
    cleanup();
    harness.cleanup();
  }
});

test('C28: HEAD/branch change since capture refuses Undo', async () => {
  const { root, cleanup } = makeRepo();
  writeFile(root, 'a.txt', 'AAA\n');
  git(root, ['add', 'a.txt']);
  git(root, ['commit', '-m', 'add a']);
  const harness = makeHarness(root);
  try {
    const { captureId, review } = await runTurn(harness.engine, root, () => {
      writeFile(root, 'a.txt', 'BBB\n');
    });
    const file = review!.files.find((f) => f.relativePath === 'a.txt')!;
    // A commit moves HEAD after capture.
    writeFile(root, 'other.txt', 'x\n');
    git(root, ['add', 'other.txt']);
    git(root, ['commit', '-m', 'post-capture commit']);
    const undo = await harness.engine.undoFile(captureId, 'ws-1', review!.revision, 'op-head', 'a.txt', file.afterHash, false);
    assert.equal(undo.result.reason, 'repository-changed');
  } finally {
    cleanup();
    harness.cleanup();
  }
});

test('C17: Keep hunk then Undo All pending reverses only non-kept hunks', async () => {
  const { root, cleanup } = makeRepo();
  writeFile(root, 'a.txt', '1\n2\n3\n4\n5\n');
  git(root, ['add', 'a.txt']);
  git(root, ['commit', '-m', 'add a']);
  const harness = makeHarness(root);
  try {
    const { captureId, review } = await runTurn(harness.engine, root, () => {
      writeFile(root, 'a.txt', '1\nX\n3\nY\n5\n');
    });
    const file = review!.files.find((f) => f.relativePath === 'a.txt')!;
    const diff = await harness.engine.fileDiff(captureId, 'a.txt');
    if ('error' in diff) throw new Error(diff.error);
    assert.equal(diff.hunks.length, 2);
    const kept = await harness.engine.keep(captureId, 'ws-1', review!.revision, 'keep-h1', { kind: 'hunk', path: 'a.txt', hunkId: diff.hunks[0].id });
    assert.ok(kept.ok);
    const afterKeep = harness.engine.get(captureId)!;
    assert.deepEqual(afterKeep.files.find((f) => f.relativePath === 'a.txt')!.keptHunks, [diff.hunks[0].id]);
    const hashes = { 'a.txt': file.afterHash! };
    const undoAll = await harness.engine.undoAll(captureId, 'ws-1', afterKeep.revision, 'undo-all-1', hashes);
    assert.equal(undoAll.results['a.txt']!.status, 'ok');
    // Kept hunk X stays; Y reverts to 4.
    assert.equal(readFile(root, 'a.txt').toString('utf8'), '1\nX\n3\n4\n5\n');
  } finally {
    cleanup();
    harness.cleanup();
  }
});

test('Keep All is metadata-only: working bytes and git index unchanged', async () => {
  const { root, cleanup } = makeRepo();
  writeFile(root, 'a.txt', 'AAA\n');
  git(root, ['add', 'a.txt']);
  git(root, ['commit', '-m', 'add a']);
  const original = readFile(root, 'a.txt');
  const harness = makeHarness(root);
  try {
    const indexBefore = git(root, ['hash-object', path.join(root, '.git', 'index')]);
    const { captureId, review } = await runTurn(harness.engine, root, () => {
      writeFile(root, 'a.txt', 'BBB\n');
    });
    const kept = await harness.engine.keep(captureId, 'ws-1', review!.revision, 'keep-all-1', { kind: 'all' });
    assert.ok(kept.ok);
    // Keep is metadata-only: the agent's edit (BBB) stays in the worktree and
    // the git index is untouched.
    assert.deepEqual(readFile(root, 'a.txt'), Buffer.from('BBB\n'));
    assert.equal(git(root, ['hash-object', path.join(root, '.git', 'index')]), indexBefore);
    const after = harness.engine.get(captureId)!;
    assert.equal(after.status, 'kept');
  } finally {
    cleanup();
    harness.cleanup();
  }
});

test('write-disabled (default settings) refuses Undo', async () => {
  const { root, cleanup } = makeRepo();
  writeFile(root, 'a.txt', 'AAA\n');
  git(root, ['add', 'a.txt']);
  git(root, ['commit', '-m', 'add a']);
  const harness = makeHarness(root, { undoMode: 'disabled', fixtureRoots: [], maxFileBytes: 1024 * 1024, retentionDays: 30, denyPaths: [] });
  try {
    const { captureId, review } = await runTurn(harness.engine, root, () => {
      writeFile(root, 'a.txt', 'BBB\n');
    });
    const file = review!.files.find((f) => f.relativePath === 'a.txt')!;
    const undo = await harness.engine.undoFile(captureId, 'ws-1', review!.revision, 'op-wd', 'a.txt', file.afterHash, false);
    assert.equal(undo.result.reason, 'write-disabled');
    assert.equal(readFile(root, 'a.txt').toString('utf8'), 'BBB\n'); // untouched
  } finally {
    cleanup();
    harness.cleanup();
  }
});

test('fixture mode but root outside allowlist refuses Undo', async () => {
  const { root, cleanup } = makeRepo();
  writeFile(root, 'a.txt', 'AAA\n');
  git(root, ['add', 'a.txt']);
  git(root, ['commit', '-m', 'add a']);
  // Allowlist points at a DIFFERENT path, not this repo.
  const harness = makeHarness(root, { undoMode: 'fixture', fixtureRoots: [path.join(root, '..', 'elsewhere')], maxFileBytes: 1024 * 1024, retentionDays: 30, denyPaths: [] });
  try {
    const { captureId, review } = await runTurn(harness.engine, root, () => {
      writeFile(root, 'a.txt', 'BBB\n');
    });
    const file = review!.files.find((f) => f.relativePath === 'a.txt')!;
    const undo = await harness.engine.undoFile(captureId, 'ws-1', review!.revision, 'op-nf', 'a.txt', file.afterHash, false);
    assert.equal(undo.result.reason, 'not-fixture');
  } finally {
    cleanup();
    harness.cleanup();
  }
});

test('event-best-effort capture is denyable in fixture mode when the file is untouched (before->write->after is the gate)', async () => {
  const { root, cleanup } = makeRepo();
  writeFile(root, 'a.txt', 'AAA\n');
  git(root, ['add', 'a.txt']);
  git(root, ['commit', '-m', 'add a']);
  const harness = makeHarness(root, { undoMode: 'fixture', fixtureRoots: [root], maxFileBytes: 1024 * 1024, retentionDays: 30, denyPaths: [] });
  try {
    const agent = 'a1';
    const workspace = 'ws-1';
    // Real-turn (event-best-effort) capture: before -> agent write -> after.
    const captureId = await harness.engine.startTurn({ agentId: agent, workspaceId: workspace, cwd: root, turnId: 't', barrier: 'event-best-effort' });
    writeFile(root, 'a.txt', 'BBB\n');
    const review = await harness.engine.endTurn({ occurrenceId: captureId, agentId: agent, workspaceId: workspace, cwd: root, outcome: 'completed', barrier: 'event-best-effort' });
    const file = review!.files.find((f) => f.relativePath === 'a.txt')!;
    // Untouched since the turn -> the before/after workflow is the gate: Undo succeeds.
    const undo = await harness.engine.undoFile(captureId, 'ws-1', review!.revision, 'op-barrier', 'a.txt', file.afterHash, false);
    assert.equal(undo.result.status, 'ok');
    assert.equal(readFile(root, 'a.txt').toString('utf8'), 'AAA\n'); // rolled back to pre-turn state

    // A file the user edited after the turn is implicitly accepted -> refuse.
    const captureId2 = await harness.engine.startTurn({ agentId: agent, workspaceId: workspace, cwd: root, turnId: 't2', barrier: 'event-best-effort' });
    writeFile(root, 'a.txt', 'CCC\n');
    const review2 = await harness.engine.endTurn({ occurrenceId: captureId2, agentId: agent, workspaceId: workspace, cwd: root, outcome: 'completed', barrier: 'event-best-effort' });
    const file2 = review2!.files.find((f) => f.relativePath === 'a.txt')!;
    writeFile(root, 'a.txt', 'CCC-user\n'); // user edit outside the turn = implicit accept
    const undo2 = await harness.engine.undoFile(captureId2, 'ws-1', review2!.revision, 'op-barrier-2', 'a.txt', file2.afterHash, false);
    assert.equal(undo2.result.status, 'conflict');
    assert.equal(undo2.result.reason, 'file-changed');
    assert.equal(readFile(root, 'a.txt').toString('utf8'), 'CCC-user\n'); // untouched by the plugin
  } finally {
    cleanup();
    harness.cleanup();
  }
});

test('ambiguous overlapping agents disable Undo (C13)', async () => {
  const { root, cleanup } = makeRepo();
  writeFile(root, 'a.txt', 'AAA\n');
  git(root, ['add', 'a.txt']);
  git(root, ['commit', '-m', 'add a']);
  const harness = makeHarness(root, { undoMode: 'fixture', fixtureRoots: [root], maxFileBytes: 1024 * 1024, retentionDays: 30, denyPaths: [] });
  try {
    const cap1 = await harness.engine.startTurn({ agentId: 'a1', workspaceId: 'ws-1', cwd: root, turnId: 't1', barrier: 'proven' });
    const cap2 = await harness.engine.startTurn({ agentId: 'a2', workspaceId: 'ws-1', cwd: root, turnId: 't2', barrier: 'proven' });
    writeFile(root, 'a.txt', 'BBB\n');
    await harness.engine.endTurn({ occurrenceId: cap2, agentId: 'a2', workspaceId: 'ws-1', cwd: root, outcome: 'completed', barrier: 'proven' });
    const review = await harness.engine.endTurn({ occurrenceId: cap1, agentId: 'a1', workspaceId: 'ws-1', cwd: root, outcome: 'completed', barrier: 'proven' });
    assert.equal(review!.ambiguous, true);
    const file = review!.files.find((f) => f.relativePath === 'a.txt')!;
    const undo = await harness.engine.undoFile(cap1, 'ws-1', review!.revision, 'op-amb', 'a.txt', file.afterHash, false);
    assert.equal(undo.result.reason, 'unsafe-capture');
  } finally {
    cleanup();
    harness.cleanup();
  }
});

test('non-git directory yields a read-only review marked not-git-repository (no Undo)', async () => {
  const harness = makeHarness();
  const root = path.join(os.tmpdir(), 'turn-review-nongit-' + Date.now());
  fs.mkdirSync(root, { recursive: true });
  try {
    const captureId = await harness.engine.startTurn({ agentId: 'a1', workspaceId: 'ws-1', cwd: root, turnId: 't', barrier: 'proven' });
    writeFile(root, 'x.txt', 'hi\n');
    const review = await harness.engine.endTurn({ occurrenceId: captureId, agentId: 'a1', workspaceId: 'ws-1', cwd: root, outcome: 'completed', barrier: 'proven' });
    // Capture stays fail-closed: read-only, never undo-able.
    assert.equal(review!.captureState, 'incomplete');
    assert.equal(review!.status, 'unsupported');
    assert.equal(review!.captureError, 'not-git-repository');
    assert.equal(review!.files.length, 0);
    const undo = await harness.engine.undoFile(captureId, 'ws-1', review!.revision, 'op-nogit', 'x.txt', null, false);
    assert.equal(undo.result.status, 'refused');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    harness.cleanup();
  }
});

test('non-git turn still yields a chat card explaining that Git is required', async () => {
  const harness = makeHarness();
  const root = path.join(os.tmpdir(), 'turn-review-nogit-card-' + Date.now());
  fs.mkdirSync(root, { recursive: true });
  try {
    const captureId = await harness.engine.startTurn({ agentId: 'a1', workspaceId: 'ws-1', cwd: root, turnId: 't', barrier: 'event-best-effort' });
    await harness.engine.endTurn({ occurrenceId: captureId, agentId: 'a1', workspaceId: 'ws-1', cwd: root, outcome: 'completed', barrier: 'event-best-effort' });
    const card = await harness.engine.timelineCard(captureId);
    assert.ok(card, 'a notice card is appended even though nothing was captured');
    assert.equal(card!.captureError, 'not-git-repository');
    assert.equal(card!.fileCount, 0);
    assert.equal(card!.files.length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    harness.cleanup();
  }
});

test('missing workspace directory is marked missing-directory (read-only, no card)', async () => {
  const harness = makeHarness();
  const root = path.join(os.tmpdir(), 'turn-review-missing-' + Date.now() + '-does-not-exist');
  try {
    const captureId = await harness.engine.startTurn({ agentId: 'a1', workspaceId: 'ws-1', cwd: root, turnId: 't', barrier: 'proven' });
    const review = await harness.engine.endTurn({ occurrenceId: captureId, agentId: 'a1', workspaceId: 'ws-1', cwd: root, outcome: 'completed', barrier: 'proven' });
    assert.equal(review!.captureState, 'incomplete');
    assert.equal(review!.captureError, 'missing-directory');
    assert.equal(await harness.engine.timelineCard(captureId), null, 'no notice card for a missing directory');
  } finally {
    harness.cleanup();
  }
});

test('hash assertion helper sanity', () => {
  assert.equal(sha('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('timelineCard: modified file turn yields a chat card with +/− counts', async () => {
  const { root, cleanup } = makeRepo();
  writeFile(root, 'a.txt', 'one\ntwo\nthree\n');
  git(root, ['add', 'a.txt']);
  git(root, ['commit', '-m', 'add a']);
  const harness = makeHarness(root);
  try {
    const { captureId, review } = await runTurn(harness.engine, root, () => {
      writeFile(root, 'a.txt', 'one\nTWO\nthree\nFOUR\n');
    });
    const card = await harness.engine.timelineCard(captureId);
    assert.ok(card);
    assert.equal(card.reviewId, captureId);
    assert.equal(card.workspaceId, 'ws-1');
    assert.equal(card.agentId, 'a1');
    assert.ok(card.endedAt);
    assert.equal(card.fileCount, 1);
    // One line replaced + one line added => +2/−1 (matches git numstat and the
    // engine's own totals).
    assert.equal(card.added, 2);
    assert.equal(card.deleted, 1);
    assert.equal(card.files.length, 1);
    const row = card.files[0];
    assert.equal(row.path, 'a.txt');
    assert.equal(row.kind, 'modified');
    assert.equal(row.added, 2);
    assert.equal(row.deleted, 1);
    assert.equal(row.undoExact, true);
    assert.equal(row.status, 'pending');
  } finally {
    cleanup();
    harness.cleanup();
  }
});

test('timelineCard: created and deleted files are counted; no-change turns yield no card', async () => {
  const { root, cleanup } = makeRepo();
  writeFile(root, 'keep.txt', 'keep\n');
  git(root, ['add', 'keep.txt']);
  git(root, ['commit', '-m', 'add keep']);
  const harness = makeHarness(root);
  try {
    // Turn 1: create new.txt (3 lines) and delete gone.txt (tracked, 2 lines).
    writeFile(root, 'gone.txt', 'g1\ng2\n');
    git(root, ['add', 'gone.txt']);
    git(root, ['commit', '-m', 'add gone']);
    const { captureId } = await runTurn(harness.engine, root, () => {
      writeFile(root, 'new.txt', 'n1\nn2\nn3\n');
      fs.unlinkSync(path.join(root, 'gone.txt'));
    });
    const card = await harness.engine.timelineCard(captureId);
    assert.ok(card);
    assert.equal(card.fileCount, 2);
    const created = card.files.find((f) => f.path === 'new.txt')!;
    const deleted = card.files.find((f) => f.path === 'gone.txt')!;
    assert.equal(created.kind, 'created');
    assert.equal(created.added, 3);
    assert.equal(created.deleted, 0);
    assert.equal(deleted.kind, 'deleted');
    assert.equal(deleted.deleted, 2);
    assert.equal(deleted.added, 0);

    // Turn 2: no edits -> no actionable files -> no card.
    const noopId = await harness.engine.startTurn({ agentId: 'a1', workspaceId: 'ws-1', cwd: root, turnId: 't2', barrier: 'proven' });
    await harness.engine.endTurn({ occurrenceId: noopId, agentId: 'a1', workspaceId: 'ws-1', cwd: root, outcome: 'completed', barrier: 'proven' });
    assert.equal(await harness.engine.timelineCard(noopId), null);
  } finally {
    cleanup();
    harness.cleanup();
  }
});

test('timelineCard: excluded (sensitive/deny-listed) files are omitted from the card', async () => {
  const { root, cleanup } = makeRepo();
  writeFile(root, '.env', 'SECRET=old\n');
  git(root, ['add', '-f', '.env']);
  git(root, ['commit', '-m', 'add env']);
  const harness = makeHarness(root);
  try {
    const { captureId, review } = await runTurn(harness.engine, root, () => {
      writeFile(root, '.env', 'SECRET=new\n');
    });
    assert.ok(review!.files.some((f) => f.relativePath === '.env' && f.support === 'excluded'));
    assert.equal(await harness.engine.timelineCard(captureId), null);
  } finally {
    cleanup();
    harness.cleanup();
  }
});
