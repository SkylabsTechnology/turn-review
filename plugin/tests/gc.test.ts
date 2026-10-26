import test from 'node:test';
import assert from 'node:assert/strict';
import { makeRepo, makeHarness, writeFile, readFile, git, fixtureSettings } from './helpers';
import { trackerOpId } from '../shared/op-id';
import type { ReviewEngine } from '../server/review-engine';

/** Proven-barrier turn: capture before, apply edits, capture after. */
async function runTurn(engine: ReviewEngine, root: string, edits: () => void) {
  const barrier = 'proven';
  const captureId = await engine.startTurn({ agentId: 'a1', workspaceId: 'ws-1', cwd: root, turnId: `t-${Math.random()}`, barrier });
  edits();
  const review = await engine.endTurn({ occurrenceId: captureId, agentId: 'a1', workspaceId: 'ws-1', cwd: root, outcome: 'completed', barrier });
  return { captureId, review: review! };
}

const WS = 'ws-1';

test('G1: retention prunes old resolved (accepted) reviews but never touches the working tree', async () => {
  const { root, cleanup } = makeRepo();
  writeFile(root, 'a.txt', 'A0\n');
  git(root, ['add', 'a.txt']);
  git(root, ['commit', '-m', 'add a']);
  const settings = fixtureSettings([root]);
  const harness = makeHarness(root, settings);
  try {
    const { review } = await runTurn(harness.engine, root, () => writeFile(root, 'a.txt', 'A1\n'));
    const file = review.files.find((f) => f.relativePath === 'a.txt')!;
    const beforeBlob = file.beforeHash!;
    const afterBlob = file.afterHash!;
    assert.ok(harness.storage.blobs.get(beforeBlob), 'before blob stored');
    assert.ok(harness.storage.blobs.get(afterBlob), 'after blob stored');

    // Accept -> resolved (metadata only; file stays A1).
    const accept = await harness.engine.trackerAccept(WS, 'a.txt', trackerOpId(WS, 'accept', 'a.txt'));
    assert.equal(accept.ok, true);
    assert.deepEqual(readFile(root, 'a.txt'), Buffer.from('A1\n'));
    assert.ok(await harness.engine.timelineCard(review.id), 'review still present before GC');

    // Force everything resolved to be older than the cutoff.
    settings.retentionDays = 0;
    const report = await harness.engine.gc();
    assert.ok(report.reviewsRemoved >= 1);
    assert.equal(await harness.engine.timelineCard(review.id), null, 'resolved review pruned');
    // Its blobs are now orphaned and were swept.
    assert.equal(harness.storage.blobs.get(beforeBlob), null, 'orphan before blob swept');
    assert.equal(harness.storage.blobs.get(afterBlob), null, 'orphan after blob swept');
    // The working tree is never touched by GC.
    assert.deepEqual(readFile(root, 'a.txt'), Buffer.from('A1\n'));
  } finally {
    cleanup();
    harness.cleanup();
  }
});

test('G2: a pending (unresolved) review is never pruned, even when old', async () => {
  const { root, cleanup } = makeRepo();
  writeFile(root, 'a.txt', 'A0\n');
  git(root, ['add', 'a.txt']);
  git(root, ['commit', '-m', 'add a']);
  const settings = fixtureSettings([root]);
  const harness = makeHarness(root, settings);
  try {
    const { review } = await runTurn(harness.engine, root, () => writeFile(root, 'a.txt', 'A1\n'));
    settings.retentionDays = 0;
    const report = await harness.engine.gc();
    assert.equal(report.reviewsRemoved, 0, 'no resolved reviews to prune');
    // Still pending -> still listed, still denyable, blobs intact.
    const files = await harness.engine.trackerList(WS);
    assert.equal(files.length, 1);
    assert.equal(files[0].deniable, true);
    assert.ok(await harness.engine.timelineCard(review.id));
    const file = review.files.find((f) => f.relativePath === 'a.txt')!;
    assert.ok(harness.storage.blobs.get(file.beforeHash!), 'pending baseline blob kept');
  } finally {
    cleanup();
    harness.cleanup();
  }
});

test('G3: a resolved review that is resolved-history for a newer pending file is kept', async () => {
  const { root, cleanup } = makeRepo();
  writeFile(root, 'a.txt', 'A0\n');
  git(root, ['add', 'a.txt']);
  git(root, ['commit', '-m', 'add a']);
  const settings = fixtureSettings([root]);
  const harness = makeHarness(root, settings);
  try {
    // Turn 1: A0 -> A1, accepted (resolved).
    const turn1 = await runTurn(harness.engine, root, () => writeFile(root, 'a.txt', 'A1\n'));
    await harness.engine.trackerAccept(WS, 'a.txt', trackerOpId(WS, 'accept', 'a.txt'));
    // Turn 2: A1 -> A2, left pending.
    await runTurn(harness.engine, root, () => writeFile(root, 'a.txt', 'A2\n'));

    settings.retentionDays = 0;
    const report = await harness.engine.gc();
    assert.equal(report.reviewsRemoved, 0, 'turn-1 is history for the pending turn-2 and must be kept');

    // Turn-2 stays denyable because turn-1 (resolved history) was kept.
    const files = await harness.engine.trackerList(WS);
    assert.equal(files.length, 1);
    assert.equal(files[0].path, 'a.txt');
    assert.equal(files[0].deniable, true);
    assert.ok(await harness.engine.timelineCard(turn1.review.id), 'turn-1 review still present');
  } finally {
    cleanup();
    harness.cleanup();
  }
});

test('G4: per-project cap prunes the oldest resolved reviews first, never pending', async () => {
  const { root, cleanup } = makeRepo();
  writeFile(root, 'x.txt', 'X0\n');
  writeFile(root, 'y.txt', 'Y0\n');
  git(root, ['add', 'x.txt', 'y.txt']);
  git(root, ['commit', '-m', 'base']);
  const settings = fixtureSettings([root], { maxProjectBytes: 1 });
  const harness = makeHarness(root, settings);
  try {
    const turnX = await runTurn(harness.engine, root, () => writeFile(root, 'x.txt', 'X1\n'));
    await harness.engine.trackerAccept(WS, 'x.txt', trackerOpId(WS, 'accept', 'x.txt'));
    const turnY = await runTurn(harness.engine, root, () => writeFile(root, 'y.txt', 'Y1\n'));
    await harness.engine.trackerAccept(WS, 'y.txt', trackerOpId(WS, 'accept', 'y.txt'));
    // Pending review stays untouched by the cap.
    await runTurn(harness.engine, root, () => writeFile(root, 'z.txt', 'Z1\n'));

    const report = await harness.engine.gc();
    assert.ok(report.reviewsRemoved >= 2, 'both resolved reviews pruned to fit the cap');
    assert.equal(await harness.engine.timelineCard(turnX.review.id), null);
    assert.equal(await harness.engine.timelineCard(turnY.review.id), null);

    // Pending z.txt is still listed and still denyable.
    const files = await harness.engine.trackerList(WS);
    const z = files.find((f) => f.path === 'z.txt');
    assert.ok(z);
    assert.equal(z.deniable, true);
  } finally {
    cleanup();
    harness.cleanup();
  }
});

test('G5: an op whose review is gone and is older than retention is pruned', async () => {
  const { root, cleanup } = makeRepo();
  writeFile(root, 'a.txt', 'A0\n');
  writeFile(root, 'b.txt', 'B0\n');
  git(root, ['add', 'a.txt', 'b.txt']);
  git(root, ['commit', '-m', 'base']);
  const settings = fixtureSettings([root]);
  const harness = makeHarness(root, settings);
  try {
    // Deny -> applied op referencing the review.
    await runTurn(harness.engine, root, () => writeFile(root, 'a.txt', 'A1\n'));
    const files = await harness.engine.trackerList(WS);
    await harness.engine.trackerDeny(WS, 'a.txt', trackerOpId(WS, 'deny', 'a.txt', files[0].currentHash));

    const denyOps = harness.storage.ops.list().filter((o) => o.kind === 'deny');
    assert.equal(denyOps.length, 1);
    // Window still open -> review pinned by recovery, not pruned.
    settings.retentionDays = 0;
    let report = await harness.engine.gc();
    assert.equal(report.reviewsRemoved, 0, 'deny review pinned while its restore window is open');

    // A newer turn on a DIFFERENT file closes the recovery window without
    // making the denied file pending (so the history guard does not pin it).
    await runTurn(harness.engine, root, () => writeFile(root, 'b.txt', 'B1\n'));
    report = await harness.engine.gc();
    assert.ok(report.reviewsRemoved >= 1, 'deny review pruned once the window is closed');
    assert.ok(report.opsRemoved >= 1);
    assert.equal(harness.storage.ops.read(denyOps[0].operationId), null, 'orphaned deny op pruned');
  } finally {
    cleanup();
    harness.cleanup();
  }
});
