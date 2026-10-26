import test from 'node:test';
import assert from 'node:assert/strict';
import { makeRepo, makeHarness, writeFile, readFile, git, fixtureSettings, sha } from './helpers';
import { trackerOpId } from '../shared/op-id';
import type { ReviewEngine } from '../server/review-engine';

/** Proven-barrier turn: capture before, apply edits, capture after. */
async function runTurn(engine: ReviewEngine, root: string, edits: () => void, opts: { agent?: string; workspace?: string } = {}) {
  const agent = opts.agent ?? 'a1';
  const workspace = opts.workspace ?? 'ws-1';
  const barrier = 'proven';
  const captureId = await engine.startTurn({ agentId: agent, workspaceId: workspace, cwd: root, turnId: `t-${Math.random()}`, barrier });
  edits();
  const review = await engine.endTurn({ occurrenceId: captureId, agentId: agent, workspaceId: workspace, cwd: root, outcome: 'completed', barrier });
  return { captureId, review: review! };
}

const WS = 'ws-1';

test('R1: after Deny, the change is recoverable and Restore brings back the denied after-state', async () => {
  const { root, cleanup } = makeRepo();
  writeFile(root, 'a.txt', 'A0\n');
  git(root, ['add', 'a.txt']);
  git(root, ['commit', '-m', 'add a']);
  const harness = makeHarness(root);
  try {
    await runTurn(harness.engine, root, () => writeFile(root, 'a.txt', 'A1\n'));
    const files = await harness.engine.trackerList(WS);
    assert.equal(files[0].deniable, true);
    const deny = await harness.engine.trackerDeny(WS, 'a.txt', trackerOpId(WS, 'deny', 'a.txt', files[0].currentHash));
    assert.equal(deny.result.status, 'ok');
    assert.deepEqual(readFile(root, 'a.txt'), Buffer.from('A0\n'));

    // Window still open: the change appears as recoverable.
    const rec = await harness.engine.trackerRecoverable(WS);
    assert.equal(rec.length, 1);
    assert.equal(rec[0].path, 'a.txt');

    // Restore re-applies the denied state (A1) over the rolled-back baseline.
    const restore = await harness.engine.trackerRecover(WS, 'a.txt', rec[0].operationId);
    assert.equal(restore.result.status, 'ok');
    assert.deepEqual(readFile(root, 'a.txt'), Buffer.from('A1\n'));
    // Nothing recoverable remains.
    assert.equal((await harness.engine.trackerRecoverable(WS)).length, 0);
    // REWIND (DECISIONS §21): the file is re-opened as a pending deniable row.
    const after = await harness.engine.trackerList(WS);
    assert.equal(after.length, 1);
    assert.equal(after[0].path, 'a.txt');
    assert.equal(after[0].deniable, true, 'restored file is deniable again');
    assert.equal(after[0].currentHash, sha(readFile(root, 'a.txt')));
  } finally {
    cleanup();
    harness.cleanup();
  }
});

test('R7: after restore, Deny again rewinds to the original before-state; Accept sanctions the restored content', async () => {
  const { root, cleanup } = makeRepo();
  writeFile(root, 'a.txt', 'A0\n');
  git(root, ['add', 'a.txt']);
  git(root, ['commit', '-m', 'add a']);
  const harness = makeHarness(root);
  try {
    await runTurn(harness.engine, root, () => writeFile(root, 'a.txt', 'A1\n'));
    const files = await harness.engine.trackerList(WS);
    const deny = await harness.engine.trackerDeny(WS, 'a.txt', trackerOpId(WS, 'deny', 'a.txt', files[0].currentHash));
    assert.equal(deny.result.status, 'ok');
    assert.deepEqual(readFile(root, 'a.txt'), Buffer.from('A0\n'));
    const rec = await harness.engine.trackerRecoverable(WS);
    const restore = await harness.engine.trackerRecover(WS, 'a.txt', rec[0].operationId);
    assert.equal(restore.result.status, 'ok');
    assert.deepEqual(readFile(root, 'a.txt'), Buffer.from('A1\n'));

    // The row is pending again: Deny rewinds to the original before-state.
    const after = await harness.engine.trackerList(WS);
    assert.equal(after.length, 1);
    assert.equal(after[0].deniable, true);
    const deny2 = await harness.engine.trackerDeny(WS, 'a.txt', trackerOpId(WS, 'deny', 'a.txt', after[0].currentHash));
    assert.equal(deny2.result.status, 'ok');
    assert.deepEqual(readFile(root, 'a.txt'), Buffer.from('A0\n'), 'rewind restores the original pre-turn state');

    // Cycle again: restore then Accept sanctions the restored content.
    const rec2 = await harness.engine.trackerRecoverable(WS);
    const restore2 = await harness.engine.trackerRecover(WS, 'a.txt', rec2[0].operationId);
    assert.equal(restore2.result.status, 'ok');
    assert.deepEqual(readFile(root, 'a.txt'), Buffer.from('A1\n'));
    const after2 = await harness.engine.trackerList(WS);
    assert.equal(after2.length, 1);
    const accept = await harness.engine.trackerAccept(WS, 'a.txt', trackerOpId(WS, 'accept', 'a.txt'));
    assert.equal(accept.ok, true);
    assert.deepEqual(readFile(root, 'a.txt'), Buffer.from('A1\n'), 'accept keeps the restored content');
    assert.equal((await harness.engine.trackerList(WS)).length, 0);
  } finally {
    cleanup();
    harness.cleanup();
  }
});

test('R8: restore is idempotent — a repeat restore returns already-restored, never file-changed', async () => {
  const { root, cleanup } = makeRepo();
  writeFile(root, 'a.txt', 'A0\n');
  git(root, ['add', 'a.txt']);
  git(root, ['commit', '-m', 'add a']);
  const harness = makeHarness(root);
  try {
    await runTurn(harness.engine, root, () => writeFile(root, 'a.txt', 'A1\n'));
    const files = await harness.engine.trackerList(WS);
    const deny = await harness.engine.trackerDeny(WS, 'a.txt', trackerOpId(WS, 'deny', 'a.txt', files[0].currentHash));
    assert.equal(deny.result.status, 'ok');
    const rec = await harness.engine.trackerRecoverable(WS);
    const opId = rec[0].operationId;
    assert.equal((await harness.engine.trackerRecover(WS, 'a.txt', opId)).result.status, 'ok');
    // Second click (stale chat card button): friendly no-op, not a conflict.
    const again = await harness.engine.trackerRecover(WS, 'a.txt', opId);
    assert.equal(again.result.status, 'ok');
    assert.equal(again.result.reason, 'already-restored');
    assert.deepEqual(readFile(root, 'a.txt'), Buffer.from('A1\n'), 'file content untouched by the repeat restore');
    // Still exactly one re-opened row (no duplicate restore review).
    const list = await harness.engine.trackerList(WS);
    assert.equal(list.length, 1);
  } finally {
    cleanup();
    harness.cleanup();
  }
});

test('R9: a restore (rewind) row does not close another file\'s recovery window', async () => {
  const { root, cleanup } = makeRepo();
  writeFile(root, 'a.txt', 'A0\n');
  writeFile(root, 'b.txt', 'B0\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'add a and b']);
  const harness = makeHarness(root);
  try {
    await runTurn(harness.engine, root, () => {
      writeFile(root, 'a.txt', 'A1\n');
      writeFile(root, 'b.txt', 'B1\n');
    });
    const files = await harness.engine.trackerList(WS);
    const denyA = await harness.engine.trackerDeny(WS, 'a.txt', trackerOpId(WS, 'deny', 'a.txt', files.find((f) => f.path === 'a.txt')!.currentHash));
    const denyB = await harness.engine.trackerDeny(WS, 'b.txt', trackerOpId(WS, 'deny', 'b.txt', files.find((f) => f.path === 'b.txt')!.currentHash));
    assert.equal(denyA.result.status, 'ok');
    assert.equal(denyB.result.status, 'ok');
    const rec = await harness.engine.trackerRecoverable(WS);
    assert.equal(rec.length, 2);
    // Restore a.txt: creates a restore (rewind) row for a.txt.
    const opA = rec.find((r) => r.path === 'a.txt')!;
    assert.equal((await harness.engine.trackerRecover(WS, 'a.txt', opA.operationId)).result.status, 'ok');
    // b.txt must still be recoverable (the a.txt restore row is not a new turn).
    const rec2 = await harness.engine.trackerRecoverable(WS);
    assert.equal(rec2.length, 1);
    assert.equal(rec2[0].path, 'b.txt');
    assert.equal((await harness.engine.trackerRecover(WS, 'b.txt', rec2[0].operationId)).result.status, 'ok');
  } finally {
    cleanup();
    harness.cleanup();
  }
});

test('R2: the restore window closes once a newer turn starts on the same repo', async () => {
  const { root, cleanup } = makeRepo();
  writeFile(root, 'a.txt', 'A0\n');
  git(root, ['add', 'a.txt']);
  git(root, ['commit', '-m', 'add a']);
  const harness = makeHarness(root);
  try {
    await runTurn(harness.engine, root, () => writeFile(root, 'a.txt', 'A1\n'));
    const files = await harness.engine.trackerList(WS);
    const deny = await harness.engine.trackerDeny(WS, 'a.txt', trackerOpId(WS, 'deny', 'a.txt', files[0].currentHash));
    assert.equal(deny.result.status, 'ok');
    assert.equal((await harness.engine.trackerRecoverable(WS)).length, 1);

    // A newer turn on the same repository closes the recovery window.
    await runTurn(harness.engine, root, () => writeFile(root, 'a.txt', 'A2\n'));
    assert.equal((await harness.engine.trackerRecoverable(WS)).length, 0);

    const rec = await harness.engine.trackerRecoverable(WS);
    assert.equal(rec.length, 0);
    // Direct recover is refused with window-closed even with a valid op id.
    const ops = harness.storage.ops.list().filter((o) => o.kind === 'deny');
    assert.ok(ops.length >= 1);
    const op = ops[ops.length - 1];
    const restore = await harness.engine.trackerRecover(WS, 'a.txt', op.operationId);
    assert.equal(restore.result.status, 'refused');
    assert.equal(restore.result.reason, 'window-closed');
  } finally {
    cleanup();
    harness.cleanup();
  }
});

test('R3: editing the file after the rollback removes it from recoverable and refuses restore (CAS)', async () => {
  const { root, cleanup } = makeRepo();
  writeFile(root, 'a.txt', 'A0\n');
  git(root, ['add', 'a.txt']);
  git(root, ['commit', '-m', 'add a']);
  const harness = makeHarness(root);
  try {
    await runTurn(harness.engine, root, () => writeFile(root, 'a.txt', 'A1\n'));
    const files = await harness.engine.trackerList(WS);
    const deny = await harness.engine.trackerDeny(WS, 'a.txt', trackerOpId(WS, 'deny', 'a.txt', files[0].currentHash));
    assert.equal(deny.result.status, 'ok');
    assert.equal((await harness.engine.trackerRecoverable(WS)).length, 1);

    // The user edits the rolled-back file: recovery must not overwrite it.
    writeFile(root, 'a.txt', 'A0-user\n');
    assert.equal((await harness.engine.trackerRecoverable(WS)).length, 0);
    const ops = harness.storage.ops.list().filter((o) => o.kind === 'deny');
    const op = ops[ops.length - 1];
    const restore = await harness.engine.trackerRecover(WS, 'a.txt', op.operationId);
    assert.equal(restore.result.status, 'conflict');
    assert.equal(restore.result.reason, 'file-changed');
    assert.deepEqual(readFile(root, 'a.txt'), Buffer.from('A0-user\n')); // untouched by the plugin
  } finally {
    cleanup();
    harness.cleanup();
  }
});

test('R4: recovery of a created file (rollback deleted it) recreates the file with its denied bytes', async () => {
  const { root, cleanup } = makeRepo();
  const harness = makeHarness(root);
  try {
    // Turn creates a brand-new file.
    await runTurn(harness.engine, root, () => writeFile(root, 'new.txt', 'NEW\n'));
    const files = await harness.engine.trackerList(WS);
    assert.equal(files[0].kind, 'created');
    assert.equal(files[0].deniable, true);
    const deny = await harness.engine.trackerDeny(WS, 'new.txt', trackerOpId(WS, 'deny', 'new.txt', files[0].currentHash));
    assert.equal(deny.result.status, 'ok');
    // Rollback removed the created file.
    assert.throws(() => readFile(root, 'new.txt'));

    const rec = await harness.engine.trackerRecoverable(WS);
    assert.equal(rec.length, 1);
    const restore = await harness.engine.trackerRecover(WS, 'new.txt', rec[0].operationId);
    assert.equal(restore.result.status, 'ok');
    assert.deepEqual(readFile(root, 'new.txt'), Buffer.from('NEW\n'));
  } finally {
    cleanup();
    harness.cleanup();
  }
});

test('R5: a successful Deny fires the chat-notice callback with the right path; a refused deny does not', async () => {
  const { root, cleanup } = makeRepo();
  writeFile(root, 'a.txt', 'A0\n');
  git(root, ['add', 'a.txt']);
  git(root, ['commit', '-m', 'add a']);
  const fired: Array<{ agentId: string; workspaceId: string; path: string }> = [];
  const settings = fixtureSettings([root]);
  const harness = makeHarness(root, settings, undefined, {
    onDenyApplied: (info) => fired.push(info),
  });
  try {
    // Refused deny (write-disabled) must NOT fire the notice.
    settings.undoMode = 'disabled';
    await runTurn(harness.engine, root, () => writeFile(root, 'a.txt', 'A1\n'));
    const refusedFiles = await harness.engine.trackerList(WS);
    const refused = await harness.engine.trackerDeny(WS, 'a.txt', trackerOpId(WS, 'deny', 'a.txt', refusedFiles[0].currentHash));
    assert.equal(refused.result.status, 'refused');
    assert.equal(fired.length, 0);

    // Successful deny fires once with the reviewed path.
    settings.undoMode = 'fixture';
    await runTurn(harness.engine, root, () => writeFile(root, 'a.txt', 'A1\n'));
    const files = await harness.engine.trackerList(WS);
    const deny = await harness.engine.trackerDeny(WS, 'a.txt', trackerOpId(WS, 'deny', 'a.txt', files[0].currentHash));
    assert.equal(deny.result.status, 'ok');
    assert.equal(fired.length, 1);
    assert.equal(fired[0].path, 'a.txt');
    assert.equal(fired[0].workspaceId, WS);

    // Blind retry of the same deny is idempotent and does not fire twice.
    const again = await harness.engine.trackerDeny(WS, 'a.txt', trackerOpId(WS, 'deny', 'a.txt', files[0].currentHash));
    assert.equal(again.result.status, 'ok');
    assert.equal(fired.length, 1);
  } finally {
    cleanup();
    harness.cleanup();
  }
});

test('R6: recovery re-checks the write gate — disabling fixture mode (or removing the allowlist) refuses Restore', async () => {
  const { root, cleanup } = makeRepo();
  writeFile(root, 'a.txt', 'A0\n');
  git(root, ['add', 'a.txt']);
  git(root, ['commit', '-m', 'add a']);
  const settings = fixtureSettings([root]);
  const harness = makeHarness(root, settings);
  try {
    await runTurn(harness.engine, root, () => writeFile(root, 'a.txt', 'A1\n'));
    const files = await harness.engine.trackerList(WS);
    const deny = await harness.engine.trackerDeny(WS, 'a.txt', trackerOpId(WS, 'deny', 'a.txt', files[0].currentHash));
    assert.equal(deny.result.status, 'ok');
    const rec = await harness.engine.trackerRecoverable(WS);
    assert.equal(rec.length, 1);

    // Write mode turned off between Deny and Restore -> refused, file untouched.
    settings.undoMode = 'disabled';
    const disabled = await harness.engine.trackerRecover(WS, 'a.txt', rec[0].operationId);
    assert.equal(disabled.result.status, 'refused');
    assert.equal(disabled.result.reason, 'write-disabled');
    assert.deepEqual(readFile(root, 'a.txt'), Buffer.from('A0\n'));

    // Allowlist removed -> refused with not-fixture.
    settings.undoMode = 'fixture';
    settings.fixtureRoots = [];
    settings.allowAllProjects = false;
    const unlisted = await harness.engine.trackerRecover(WS, 'a.txt', rec[0].operationId);
    assert.equal(unlisted.result.status, 'refused');
    assert.equal(unlisted.result.reason, 'not-fixture');
    assert.deepEqual(readFile(root, 'a.txt'), Buffer.from('A0\n'));

    // Restoring the allowlist (window still open) allows the Restore again.
    settings.fixtureRoots = [root];
    const ok = await harness.engine.trackerRecover(WS, 'a.txt', rec[0].operationId);
    assert.equal(ok.result.status, 'ok');
    assert.deepEqual(readFile(root, 'a.txt'), Buffer.from('A1\n'));
  } finally {
    cleanup();
    harness.cleanup();
  }
});
