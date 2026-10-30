import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { makeRepo, makeHarness, writeFile, readFile, git, sha } from './helpers';
import { Journal } from '../server/storage';
import { digest } from '../server/util';
import { trackerOpId } from '../shared/op-id';

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

test('F7: Journal detects corruption and rewrite refuses (no silent compaction over bad data)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-f7-'));
  const journal = new Journal(root);
  try {
    journal.append({ type: 'review', id: 'rev-1', ts: new Date().toISOString(), data: { ok: true } });
    // A partial write / torn line lands in the journal.
    fs.appendFileSync(path.join(root, 'journal.jsonl'), '{"type":"review","id":"rev-2","ts":"2024', 'utf8');
    fs.appendFileSync(path.join(root, 'journal.jsonl'), '\nnot-json-at-all\n', 'utf8');

    const state = journal.readState();
    assert.equal(state.corrupt, true);
    assert.equal(state.corruptLines, 2);
    assert.equal(state.records.length, 1, 'the valid record still parses');
    assert.equal(journal.hasCorruption(), true);

    // Compaction/rewrite must refuse rather than silently drop the corrupt line.
    assert.throws(() => journal.rewrite(state.records), /journal-corrupt/);
    // The raw journal on disk is untouched (no destructive rewrite happened).
    const raw = fs.readFileSync(path.join(root, 'journal.jsonl'), 'utf8');
    assert.ok(raw.includes('not-json-at-all'), 'corrupt line preserved on disk');
    assert.ok(raw.includes('rev-1'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('F7: a corrupted journal blocks Undo (journal-corrupt) while readable reviews still load', async () => {
  const { root, cleanup } = makeRepo();
  const harness = makeHarness(root, { undoMode: 'fixture', fixtureRoots: [root], maxFileBytes: 1024 * 1024, retentionDays: 30, denyPaths: [] });
  try {
    const { captureId, review } = await buildReview(harness, root, Buffer.from('AAA\n'), Buffer.from('BBB\n'));
    // Corrupt the journal AFTER a complete, readable review record.
    fs.appendFileSync(path.join(harness.storage.root, 'journal.jsonl'), 'not-json-garbage\n', 'utf8');

    // A new engine over the same storage still loads the valid review but the
    // corruption flag is set, so any write is refused fail-closed.
    const harness2 = makeHarness(root, { undoMode: 'fixture', fixtureRoots: [root], maxFileBytes: 1024 * 1024, retentionDays: 30, denyPaths: [] }, harness.storage);
    try {
      const review2 = harness2.engine.get(captureId)!;
      assert.ok(review2, 'valid review records still load');
      const undo = await harness2.engine.undoFile(captureId, 'ws-1', review2.revision, 'op-f7', 'f.txt', null, false);
      assert.equal(undo.result.status, 'refused');
      assert.equal(undo.result.reason, 'journal-corrupt');
    } finally {
      harness2.cleanup();
    }
  } finally {
    cleanup();
    harness.cleanup();
  }
});

test('F8: a lock file whose owner PID is dead is reaped immediately (no stale-lock wedge)', async () => {
  const { root, cleanup } = makeRepo();
  writeFile(root, 'a.txt', 'A0\n');
  git(root, ['add', 'a.txt']);
  git(root, ['commit', '-m', 'add a']);
  const harness = makeHarness(root);
  try {
    // Simulate a crashed holder: the lock exists, its mtime is RECENT (so the
    // old age-based heuristic would keep waiting) but the owner PID is dead.
    const lockDir = path.join(harness.storage.root, 'locks');
    fs.mkdirSync(lockDir, { recursive: true });
    const key = digest(root).slice(0, 16);
    const lockFile = path.join(lockDir, `${key}.lock`);
    fs.writeFileSync(lockFile, JSON.stringify({ pid: 2147483647, ts: Date.now() }), 'utf8');

    const { captureId } = await buildReview(harness, root, Buffer.from('AAA\n'), Buffer.from('BBB\n'));
    void captureId;
    const files = await harness.engine.trackerList('ws-1');
    const start = Date.now();
    const deny = await harness.engine.trackerDeny('ws-1', 'f.txt', trackerOpId('ws-1', 'deny', 'f.txt', files[0].currentHash));
    const elapsed = Date.now() - start;
    assert.equal(deny.result.status, 'ok');
    assert.deepEqual(readFile(root, 'f.txt'), Buffer.from('AAA\n'));
    assert.ok(elapsed < 5_000, `dead-owner lock must be reaped immediately; took ${elapsed}ms (would be 20s under the old age heuristic)`);
  } finally {
    cleanup();
    harness.cleanup();
  }
});

test('F8: a lock whose owner is ALIVE is never reaped even when old; dead/unknown owners are handled', async () => {
  const { root, cleanup } = makeRepo();
  const harness = makeHarness(root);
  try {
    const lockDir = path.join(harness.storage.root, 'locks');
    fs.mkdirSync(lockDir, { recursive: true });
    const isStale = (engine: typeof harness.engine, f: string): boolean =>
      (engine as unknown as { isStaleLock(f: string): boolean }).isStaleLock(f);
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const mk = (name: string, body: string, old = false): string => {
      const p = path.join(lockDir, name);
      fs.writeFileSync(p, body, 'utf8');
      if (old) fs.utimesSync(p, twoHoursAgo, twoHoursAgo);
      return p;
    };

    // LIVE owner (this process) with a very old mtime -> NEVER reaped.
    // Regression: the old code reaped any lock older than the 1h backstop
    // even when its owner was alive, risking a double writer.
    const liveOld = mk('live-old.lock', JSON.stringify({ pid: process.pid, ts: Date.now() - 2 * 60 * 60 * 1000 }), true);
    assert.equal(isStale(harness.engine, liveOld), false, 'a live-owner lock must never be reaped');

    // LIVE owner with a fresh mtime -> never reaped.
    const liveFresh = mk('live-fresh.lock', JSON.stringify({ pid: process.pid, ts: Date.now() }));
    assert.equal(isStale(harness.engine, liveFresh), false);

    // DEAD owner (impossible PID) -> stale immediately regardless of age.
    const deadFresh = mk('dead-fresh.lock', JSON.stringify({ pid: 2147483647, ts: Date.now() }));
    assert.equal(isStale(harness.engine, deadFresh), true, 'a dead-owner lock must be reaped immediately');

    // UNKNOWN owner (unreadable/absent info) + old mtime -> reaped by the age backstop.
    const unknownOld = mk('unknown-old.lock', 'not-json', true);
    assert.equal(isStale(harness.engine, unknownOld), true, 'an unknown-owner old lock must be reaped');

    // UNKNOWN owner + fresh mtime -> not reaped.
    const unknownFresh = mk('unknown-fresh.lock', 'not-json');
    assert.equal(isStale(harness.engine, unknownFresh), false);
  } finally {
    cleanup();
    harness.cleanup();
  }
});
