import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeRepo, makeHarness, writeFile, readFile, git, sha } from './helpers';

/** Build a complete review for repo `root` with a single modified file. */
async function buildReview(harness: ReturnType<typeof makeHarness>, root: string, before: Buffer, after: Buffer) {
  writeFile(root, 'f.txt', before);
  git(root, ['add', 'f.txt']);
  git(root, ['commit', '-m', 'add f']);
  const captureId = await harness.engine.startTurn({ agentId: 'a1', workspaceId: 'ws-1', cwd: root, turnId: 't', barrier: 'proven' });
  writeFile(root, 'f.txt', after);
  const review = await harness.engine.endTurn({ occurrenceId: captureId, agentId: 'a1', workspaceId: 'ws-1', cwd: root, outcome: 'completed', barrier: 'proven' });
  return { captureId, review: review! };
}

test('C21: crash after backup, before replacement -> reconcile marks aborted, file unchanged', async () => {
  const { root, cleanup } = makeRepo();
  const before = Buffer.from('AAA\n');
  const after = Buffer.from('BBB\n');
  const harness = makeHarness(root, { undoMode: 'fixture', fixtureRoots: [root], maxFileBytes: 1024 * 1024, retentionDays: 30, denyPaths: [] });
  try {
    const { captureId, review } = await buildReview(harness, root, before, after);
    const file = review!.files.find((f) => f.relativePath === 'f.txt')!;
    // Simulate: backup written + journal prepared, then crash before replace.
    harness.storage.ops.write({
      operationId: 'crash21', reviewId: captureId, path: 'f.txt', state: 'prepared',
      beforeSha: sha(after), candidateSha: sha(before), backupSha: sha(after), ts: new Date().toISOString(),
    });
    harness.storage.journal.append({ type: 'op-prepared', id: 'crash21', ts: new Date().toISOString(), data: { reviewId: captureId, path: 'f.txt' } });

    // New engine instance over the same storage triggers recovery on load.
    const harness2 = makeHarness(root, { undoMode: 'fixture', fixtureRoots: [root], maxFileBytes: 1024 * 1024, retentionDays: 30, denyPaths: [] }, harness.storage);
    try {
      const op = harness2.storage.ops.read('crash21')!;
      assert.equal(op.state, 'aborted');
      // File must be unchanged (original B preserved; no destructive replay).
      assert.deepEqual(readFile(root, 'f.txt'), after);
    } finally {
      harness2.cleanup();
    }
    void file;
  } finally {
    cleanup();
    harness.cleanup();
  }
});

test('C22: crash after replacement, before journal commit -> reconcile marks applied', async () => {
  const { root, cleanup } = makeRepo();
  const before = Buffer.from('AAA\n');
  const after = Buffer.from('BBB\n');
  const harness = makeHarness(root, { undoMode: 'fixture', fixtureRoots: [root], maxFileBytes: 1024 * 1024, retentionDays: 30, denyPaths: [] });
  try {
    const { captureId, review } = await buildReview(harness, root, before, after);
    // Simulate: replace already happened (file == candidate A) but journal was
    // not committed.
    writeFile(root, 'f.txt', before);
    harness.storage.ops.write({
      operationId: 'crash22', reviewId: captureId, path: 'f.txt', state: 'prepared',
      beforeSha: sha(after), candidateSha: sha(before), backupSha: sha(after), ts: new Date().toISOString(),
    });
    harness.storage.journal.append({ type: 'op-prepared', id: 'crash22', ts: new Date().toISOString(), data: { reviewId: captureId, path: 'f.txt' } });

    const harness2 = makeHarness(root, { undoMode: 'fixture', fixtureRoots: [root], maxFileBytes: 1024 * 1024, retentionDays: 30, denyPaths: [] }, harness.storage);
    try {
      const op = harness2.storage.ops.read('crash22')!;
      assert.equal(op.state, 'applied');
      assert.deepEqual(readFile(root, 'f.txt'), before);
      const recoveredReview = harness2.engine.get(captureId)!;
      assert.equal(recoveredReview.files.find((f) => f.relativePath === 'f.txt')!.status, 'kept');
    } finally {
      harness2.cleanup();
    }
  } finally {
    cleanup();
    harness.cleanup();
  }
});

test('C24: unexpected contents after a prepared op -> recoverable conflict, backup preserved', async () => {
  const { root, cleanup } = makeRepo();
  const before = Buffer.from('AAA\n');
  const after = Buffer.from('BBB\n');
  const harness = makeHarness(root, { undoMode: 'fixture', fixtureRoots: [root], maxFileBytes: 1024 * 1024, retentionDays: 30, denyPaths: [] });
  try {
    const { captureId, review } = await buildReview(harness, root, before, after);
    // File has unexpected content (neither before nor candidate).
    const unexpected = Buffer.from('ZZZ\n');
    writeFile(root, 'f.txt', unexpected);
    harness.storage.ops.write({
      operationId: 'crash24', reviewId: captureId, path: 'f.txt', state: 'prepared',
      beforeSha: sha(after), candidateSha: sha(before), backupSha: sha(after), ts: new Date().toISOString(),
    });

    const harness2 = makeHarness(root, { undoMode: 'fixture', fixtureRoots: [root], maxFileBytes: 1024 * 1024, retentionDays: 30, denyPaths: [] }, harness.storage);
    try {
      const op = harness2.storage.ops.read('crash24')!;
      assert.equal(op.state, 'recoverable');
      // Unexpected user content must be preserved, not overwritten.
      assert.deepEqual(readFile(root, 'f.txt'), unexpected);
      // Backup blob is available for guided recovery.
      assert.ok(harness2.storage.blobs.exists(op.backupSha));
      const recoveredReview = harness2.engine.get(captureId)!;
      const file = recoveredReview.files.find((f) => f.relativePath === 'f.txt')!;
      assert.equal(file.status, 'conflict');
    } finally {
      harness2.cleanup();
    }
  } finally {
    cleanup();
    harness.cleanup();
  }
});

test('F3: crash after unlink of a created file settles to applied (absent sentinel)', async () => {
  const { root, cleanup } = makeRepo();
  const content = Buffer.from('brand new\n');
  const harness = makeHarness(root, { undoMode: 'fixture', fixtureRoots: [root], maxFileBytes: 1024 * 1024, retentionDays: 30, denyPaths: [] });
  try {
    // Turn creates the file (kind 'created').
    const captureId = await harness.engine.startTurn({ agentId: 'a1', workspaceId: 'ws-1', cwd: root, turnId: 't', barrier: 'proven' });
    writeFile(root, 'new.txt', content);
    const review = await harness.engine.endTurn({ occurrenceId: captureId, agentId: 'a1', workspaceId: 'ws-1', cwd: root, outcome: 'completed', barrier: 'proven' });
    const file = review!.files.find((f) => f.relativePath === 'new.txt')!;
    assert.equal(file.kind, 'created');
    // Simulate an undo that crashed right after unlink (file now absent).
    fs.unlinkSync(path.join(root, 'new.txt'));
    harness.storage.ops.write({
      operationId: 'crash-unlink', reviewId: captureId, path: 'new.txt', state: 'prepared',
      beforeSha: sha(content), candidateSha: 'absent', backupSha: sha(content), ts: new Date().toISOString(),
    });
    harness.storage.journal.append({ type: 'op-prepared', id: 'crash-unlink', ts: new Date().toISOString(), data: { reviewId: captureId, path: 'new.txt' } });

    const harness2 = makeHarness(root, { undoMode: 'fixture', fixtureRoots: [root], maxFileBytes: 1024 * 1024, retentionDays: 30, denyPaths: [] }, harness.storage);
    try {
      const op = harness2.storage.ops.read('crash-unlink')!;
      assert.equal(op.state, 'applied');
      assert.equal(fs.existsSync(path.join(root, 'new.txt')), false);
    } finally {
      harness2.cleanup();
    }
  } finally {
    cleanup();
    harness.cleanup();
  }
});

test('restoreBackup writes the preserved backup only when current bytes match expectation', async () => {
  const { root, cleanup } = makeRepo();
  const before = Buffer.from('AAA\n');
  const after = Buffer.from('BBB\n');
  const harness = makeHarness(root, { undoMode: 'fixture', fixtureRoots: [root], maxFileBytes: 1024 * 1024, retentionDays: 30, denyPaths: [] });
  try {
    const { captureId, review } = await buildReview(harness, root, before, after);
    // Simulate a failed op whose backup is the after-state.
    const opId = 'backup-restore';
    harness.storage.ops.write({
      operationId: opId, reviewId: captureId, path: 'f.txt', state: 'prepared',
      beforeSha: sha(after), candidateSha: sha(before), backupSha: sha(after), ts: new Date().toISOString(),
    });
    // Current file still matches the post-failure expectation (B).
    const res = await harness.engine.restoreBackup(captureId, 'ws-1', opId, 'f.txt', sha(after));
    assert.equal(res.result.status, 'ok');
    assert.deepEqual(readFile(root, 'f.txt'), after);
  } finally {
    cleanup();
    harness.cleanup();
  }
});

test('corrupted journal -> reviews unavailable -> Undo fails closed', async () => {
  const { root, cleanup } = makeRepo();
  const before = Buffer.from('AAA\n');
  const after = Buffer.from('BBB\n');
  const harness = makeHarness(root, { undoMode: 'fixture', fixtureRoots: [root], maxFileBytes: 1024 * 1024, retentionDays: 30, denyPaths: [] });
  let storageRoot = '';
  try {
    const { captureId } = await buildReview(harness, root, before, after);
    storageRoot = harness.storage.root;
    // Corrupt the journal (simulate partial write / disk corruption).
    fs.writeFileSync(path.join(storageRoot, 'journal.jsonl'), 'garbage\nmore garbage\n');
    const harness2 = makeHarness(root, { undoMode: 'fixture', fixtureRoots: [root], maxFileBytes: 1024 * 1024, retentionDays: 30, denyPaths: [] }, harness.storage);
    try {
      const review = harness2.engine.get(captureId);
      assert.equal(review, null);
      const undo = await harness2.engine.undoFile(captureId, 'ws-1', 0, 'op-x', 'f.txt', null, false);
      assert.equal(undo.result.status, 'refused');
      assert.equal(undo.result.reason, 'missing-review');
    } finally {
      harness2.cleanup();
    }
  } finally {
    cleanup();
    harness.cleanup();
  }
});

test('interrupted capture on restart is not fabricated as safe (C25)', async () => {
  const { root, cleanup } = makeRepo();
  writeFile(root, 'a.txt', 'AAA\n');
  git(root, ['add', 'a.txt']);
  git(root, ['commit', '-m', 'add a']);
  const harness = makeHarness(root, { undoMode: 'fixture', fixtureRoots: [root], maxFileBytes: 1024 * 1024, retentionDays: 30, denyPaths: [] });
  let storageRoot = '';
  try {
    storageRoot = harness.storage.root;
    // Start a capture, then simulate a plugin reload before the end event.
    const captureId = await harness.engine.startTurn({ agentId: 'a1', workspaceId: 'ws-1', cwd: root, turnId: 't', barrier: 'proven' });
    const harness2 = makeHarness(root, { undoMode: 'fixture', fixtureRoots: [root], maxFileBytes: 1024 * 1024, retentionDays: 30, denyPaths: [] }, harness.storage);
    try {
      const review = harness2.engine.get(captureId)!;
      assert.equal(review.captureState, 'interrupted');
      assert.equal(review.status, 'unsupported');
      const undo = await harness2.engine.undoFile(captureId, 'ws-1', review.revision, 'op-int', 'a.txt', null, false);
      assert.equal(undo.result.reason, 'unsafe-capture');
    } finally {
      harness2.cleanup();
    }
  } finally {
    cleanup();
    harness.cleanup();
  }
});
