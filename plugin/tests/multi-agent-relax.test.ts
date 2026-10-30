import test from 'node:test';
import assert from 'node:assert/strict';
import { makeRepo, makeHarness, writeFile, readFile, git } from './helpers';

/**
 * User-authorized relaxation (multi-agent rollback) + lifecycle fix.
 *
 * Context: ContextOrchestratorDotNet is worked on by several concurrent
 * agents, so every capture is `ambiguous` and ALL rollback is refused (C13
 * fail-closed). The user asked for agent-made changes to be rollback-able
 * while user-made changes stay the dismiss/implicit-accept workflow.
 * Resolution: a host setting `allowMultiAgentDeny` (default off) skips ONLY
 * the multi-agent gate on Deny; every other gate — above all live-match/CAS —
 * still applies, so a file the user edits after the turn is never rolled back.
 */

/** Two agents capture the same repo root in overlapping windows (C13). */
async function overlapCapture(harness: ReturnType<typeof makeHarness>, root: string) {
  const cap1 = await harness.engine.startTurn({ agentId: 'a1', workspaceId: 'ws-1', cwd: root, turnId: 't1', barrier: 'proven' });
  const cap2 = await harness.engine.startTurn({ agentId: 'a2', workspaceId: 'ws-1', cwd: root, turnId: 't2', barrier: 'proven' });
  writeFile(root, 'a.txt', 'BBB\n');
  await harness.engine.endTurn({ occurrenceId: cap2, agentId: 'a2', workspaceId: 'ws-1', cwd: root, outcome: 'completed', barrier: 'proven' });
  const review = await harness.engine.endTurn({ occurrenceId: cap1, agentId: 'a1', workspaceId: 'ws-1', cwd: root, outcome: 'completed', barrier: 'proven' });
  return { cap1, cap2, review: review! };
}

test('multi-agent rollback stays disabled by default when allowMultiAgentDeny is unset (C13)', async () => {
  const { root, cleanup } = makeRepo();
  writeFile(root, 'a.txt', 'AAA\n');
  git(root, ['add', 'a.txt']);
  git(root, ['commit', '-m', 'add a']);
  const harness = makeHarness(root);
  try {
    const { review } = await overlapCapture(harness, root);
    assert.equal(review.ambiguous, true);
    const list = await harness.engine.trackerList('ws-1');
    const row = list.find((f) => f.path === 'a.txt');
    assert.ok(row);
    assert.equal(row!.deniable, false);
    assert.equal(row!.reason, 'multi-agent');
    const file = review.files.find((f) => f.relativePath === 'a.txt')!;
    const undo = await harness.engine.undoFile(review.id, 'ws-1', review.revision, 'op-amb', 'a.txt', file.afterHash, false);
    assert.equal(undo.result.reason, 'unsafe-capture');
  } finally {
    cleanup();
    harness.cleanup();
  }
});

test('allowMultiAgentDeny=true makes overlapping-agent changes rollback-able (CAS intact)', async () => {
  const { root, cleanup } = makeRepo();
  writeFile(root, 'a.txt', 'AAA\n');
  git(root, ['add', 'a.txt']);
  git(root, ['commit', '-m', 'add a']);
  const harness = makeHarness(root, { undoMode: 'fixture', fixtureRoots: [root], allowMultiAgentDeny: true, maxFileBytes: 1024 * 1024, retentionDays: 30, denyPaths: [] });
  try {
    const { review } = await overlapCapture(harness, root);
    assert.equal(review.ambiguous, true);
    const list = await harness.engine.trackerList('ws-1');
    const row = list.find((f) => f.path === 'a.txt');
    assert.ok(row);
    assert.equal(row!.deniable, true, 'row should be deniable when the relaxation is enabled');
    const denied = await harness.engine.trackerDeny('ws-1', 'a.txt', 'op-relax-deny');
    assert.equal(denied.result.status, 'ok', JSON.stringify(denied.result));
    assert.equal(readFile(root, 'a.txt').toString(), 'AAA\n');
  } finally {
    cleanup();
    harness.cleanup();
  }
});

test('allowMultiAgentDeny=true still refuses rollback for a file the user edits after the turn (implicit accept)', async () => {
  const { root, cleanup } = makeRepo();
  writeFile(root, 'a.txt', 'AAA\n');
  git(root, ['add', 'a.txt']);
  git(root, ['commit', '-m', 'add a']);
  const harness = makeHarness(root, { undoMode: 'fixture', fixtureRoots: [root], allowMultiAgentDeny: true, maxFileBytes: 1024 * 1024, retentionDays: 30, denyPaths: [] });
  try {
    await overlapCapture(harness, root);
    // A human edits the file after the turns completed.
    writeFile(root, 'a.txt', 'CCC\n');
    const list = await harness.engine.trackerList('ws-1');
    const row = list.find((f) => f.path === 'a.txt');
    assert.ok(row);
    assert.equal(row!.deniable, false);
    assert.equal(row!.reason, 'live-changed');
    const denied = await harness.engine.trackerDeny('ws-1', 'a.txt', 'op-user-edit');
    assert.equal(denied.result.status, 'conflict');
    assert.equal(denied.result.reason, 'file-changed');
  } finally {
    cleanup();
    harness.cleanup();
  }
});

test('same-agent overlapping start is an orphaned lost end event, not concurrency (lifecycle gap fix)', async () => {
  const { root, cleanup } = makeRepo();
  writeFile(root, 'a.txt', 'AAA\n');
  git(root, ['add', 'a.txt']);
  git(root, ['commit', '-m', 'add a']);
  const harness = makeHarness(root);
  try {
    const cap1 = await harness.engine.startTurn({ agentId: 'a1', workspaceId: 'ws-1', cwd: root, turnId: 't1', barrier: 'proven' });
    // Second start for the same agent while the first is still active: the
    // first turn's end event was lost (or the start was duplicated). It must
    // be closed as interrupted/unsupported — never treated as concurrency.
    const cap2 = await harness.engine.startTurn({ agentId: 'a1', workspaceId: 'ws-1', cwd: root, turnId: 't2', barrier: 'proven' });
    writeFile(root, 'a.txt', 'BBB\n');
    const review = await harness.engine.endTurn({ occurrenceId: cap2, agentId: 'a1', workspaceId: 'ws-1', cwd: root, outcome: 'completed', barrier: 'proven' });
    assert.ok(review);
    assert.equal(review!.ambiguous, false, 'same-agent orphan must not mark the new capture ambiguous');
    // The orphan (cap1) must never offer Undo: its capture never completed.
    const undo1 = await harness.engine.undoFile(cap1, 'ws-1', 0, 'op-orphan', 'a.txt', null, false);
    assert.equal(undo1.result.status, 'refused');
    assert.equal(undo1.result.reason, 'unsafe-capture');
    // The live turn is unambiguous, so its file is deniable and rollback works.
    const list = await harness.engine.trackerList('ws-1');
    const row = list.find((f) => f.path === 'a.txt');
    assert.ok(row);
    assert.equal(row!.deniable, true);
    const denied = await harness.engine.trackerDeny('ws-1', 'a.txt', 'op-lifecycle-deny');
    assert.equal(denied.result.status, 'ok', JSON.stringify(denied.result));
    assert.equal(readFile(root, 'a.txt').toString(), 'AAA\n');
  } finally {
    cleanup();
    harness.cleanup();
  }
});

test('cross-agent overlap still marks both reviews ambiguous (unchanged) even after same-agent orphan close', async () => {
  const { root, cleanup } = makeRepo();
  writeFile(root, 'a.txt', 'AAA\n');
  git(root, ['add', 'a.txt']);
  git(root, ['commit', '-m', 'add a']);
  const harness = makeHarness(root);
  try {
    // a1 starts twice (second closes first as orphan), then a2 starts — a2
    // overlaps the live a1 capture, so both live captures are ambiguous.
    const cap1 = await harness.engine.startTurn({ agentId: 'a1', workspaceId: 'ws-1', cwd: root, turnId: 't1', barrier: 'proven' });
    const cap2 = await harness.engine.startTurn({ agentId: 'a1', workspaceId: 'ws-1', cwd: root, turnId: 't2', barrier: 'proven' });
    const cap3 = await harness.engine.startTurn({ agentId: 'a2', workspaceId: 'ws-1', cwd: root, turnId: 't3', barrier: 'proven' });
    writeFile(root, 'a.txt', 'BBB\n');
    await harness.engine.endTurn({ occurrenceId: cap3, agentId: 'a2', workspaceId: 'ws-1', cwd: root, outcome: 'completed', barrier: 'proven' });
    const r2 = await harness.engine.endTurn({ occurrenceId: cap2, agentId: 'a1', workspaceId: 'ws-1', cwd: root, outcome: 'completed', barrier: 'proven' });
    assert.equal(r2!.ambiguous, true, 'a2 overlapped a1 → cap2 is ambiguous');
    // cap1 was orphaned and must stay interrupted/unsupported + not deniable.
    const undo1 = await harness.engine.undoFile(cap1, 'ws-1', 0, 'op-x', 'a.txt', null, false);
    assert.equal(undo1.result.reason, 'unsafe-capture');
  } finally {
    cleanup();
    harness.cleanup();
  }
});
