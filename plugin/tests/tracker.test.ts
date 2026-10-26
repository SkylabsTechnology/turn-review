import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeRepo, makeHarness, writeFile, readFile, git, fixtureSettings } from './helpers';
import { trackerOpId, sha256Hex } from '../shared/op-id';
import type { ReviewEngine } from '../server/review-engine';

/** Proven-barrier turn: capture before, apply edits, capture after. */
async function runTurn(engine: ReviewEngine, root: string, edits: () => void, opts: { agent?: string; workspace?: string; barrier?: 'proven' | 'event-best-effort' } = {}) {
  const agent = opts.agent ?? 'a1';
  const workspace = opts.workspace ?? 'ws-1';
  const barrier = opts.barrier ?? 'proven';
  const captureId = await engine.startTurn({ agentId: agent, workspaceId: workspace, cwd: root, turnId: `t-${Math.random()}`, barrier });
  edits();
  const review = await engine.endTurn({ occurrenceId: captureId, agentId: agent, workspaceId: workspace, cwd: root, outcome: 'completed', barrier });
  return { captureId, review: review! };
}

const WS = 'ws-1';

test('T01: two turns on the same file accumulate into one row, baseline -> newest', async () => {
  const { root, cleanup } = makeRepo();
  writeFile(root, 'a.txt', 'line1\nline2\nline3\n');
  git(root, ['add', 'a.txt']);
  git(root, ['commit', '-m', 'add a']);
  const harness = makeHarness(root);
  try {
    await runTurn(harness.engine, root, () => writeFile(root, 'a.txt', 'line1\nLINE2\nline3\n'));
    await runTurn(harness.engine, root, () => writeFile(root, 'a.txt', 'line1\nLINE2\nLINE3\n'));
    const files = await harness.engine.trackerList(WS);
    assert.equal(files.length, 1);
    const row = files[0];
    assert.equal(row.path, 'a.txt');
    assert.equal(row.kind, 'modified');
    assert.equal(row.turns, 2);
    assert.equal(row.deniable, true);
    // Two single-line changes across two turns -> two hunks total.
    assert.equal(row.added, 2);
    assert.equal(row.deleted, 2);

    const diff = await harness.engine.trackerDiff(WS, 'a.txt');
    assert.ok(!('error' in diff));
    const beforeText = 'line1\nline2\nline3\n';
    const afterText = 'line1\nLINE2\nLINE3\n';
    const joined = (diff as { hunks: { removed: string[]; added: string[] }[] }).hunks
      .flatMap((h) => [...h.removed.map(() => '-'), ...h.added.map(() => '+')])
      .join('');
    assert.ok(joined.includes('-'));
    assert.ok(joined.includes('+'));
    // Accumulated diff must represent baseline -> newest (both edits present).
    const removedLines = (diff as { hunks: { removed: string[] }[] }).hunks.flatMap((h) => h.removed);
    const addedLines = (diff as { hunks: { added: string[] }[] }).hunks.flatMap((h) => h.added);
    assert.deepEqual(removedLines, ['line2', 'line3']);
    assert.deepEqual(addedLines, ['LINE2', 'LINE3']);
    assert.notEqual(beforeText, afterText);
  } finally {
    cleanup();
    harness.cleanup();
  }
});

test('T02: accept advances the baseline and removes the row; next turn tracks from there', async () => {
  const { root, cleanup } = makeRepo();
  writeFile(root, 'a.txt', 'A0\n');
  git(root, ['add', 'a.txt']);
  git(root, ['commit', '-m', 'add a']);
  const harness = makeHarness(root);
  try {
    await runTurn(harness.engine, root, () => writeFile(root, 'a.txt', 'A1\n'));
    const files1 = await harness.engine.trackerList(WS);
    assert.equal(files1.length, 1);
    const accept = await harness.engine.trackerAccept(WS, 'a.txt', trackerOpId(WS, 'accept', 'a.txt'));
    assert.equal(accept.ok, true);
    assert.equal((await harness.engine.trackerList(WS)).length, 0);

    // Third turn changes it again -> new row whose baseline is A1 (the accepted state).
    await runTurn(harness.engine, root, () => writeFile(root, 'a.txt', 'A2\n'));
    const files2 = await harness.engine.trackerList(WS);
    assert.equal(files2.length, 1);
    assert.equal(files2[0].turns, 1);
    // Deny now restores A1, not the original A0.
    const deny = await harness.engine.trackerDeny(WS, 'a.txt', trackerOpId(WS, 'deny', 'a.txt', files2[0].currentHash));
    assert.equal(deny.result.status, 'ok');
    assert.deepEqual(readFile(root, 'a.txt'), Buffer.from('A1\n'));
  } finally {
    cleanup();
    harness.cleanup();
  }
});

test('T03: deny rolls the working tree back to the accumulated baseline across turns', async () => {
  const { root, cleanup } = makeRepo();
  writeFile(root, 'a.txt', 'A0\n');
  git(root, ['add', 'a.txt']);
  git(root, ['commit', '-m', 'add a']);
  const original = readFile(root, 'a.txt');
  const harness = makeHarness(root);
  try {
    const r1 = await runTurn(harness.engine, root, () => writeFile(root, 'a.txt', 'A1\n'));
    const r2 = await runTurn(harness.engine, root, () => writeFile(root, 'a.txt', 'A2\n'));
    const files = await harness.engine.trackerList(WS);
    assert.equal(files.length, 1);
    const deny = await harness.engine.trackerDeny(WS, 'a.txt', trackerOpId(WS, 'deny', 'a.txt', files[0].currentHash));
    assert.equal(deny.result.status, 'ok');
    assert.equal(deny.resolved, true);
    assert.deepEqual(readFile(root, 'a.txt'), original);
    // Both reviews now treat the file as resolved.
    for (const review of [r1.review, r2.review]) {
      const file = review.files.find((f) => f.relativePath === 'a.txt')!;
      assert.equal(file.status, 'kept');
    }
    assert.equal((await harness.engine.trackerList(WS)).length, 0);
  } finally {
    cleanup();
    harness.cleanup();
  }
});

test('T04: deny is exactly-once; a blind retry reports already-applied', async () => {
  const { root, cleanup } = makeRepo();
  writeFile(root, 'a.txt', 'A0\n');
  git(root, ['add', 'a.txt']);
  git(root, ['commit', '-m', 'add a']);
  const harness = makeHarness(root);
  try {
    await runTurn(harness.engine, root, () => writeFile(root, 'a.txt', 'A1\n'));
    await runTurn(harness.engine, root, () => writeFile(root, 'a.txt', 'A2\n'));
    const files = await harness.engine.trackerList(WS);
    const op = trackerOpId(WS, 'deny', 'a.txt', files[0].currentHash);
    const first = await harness.engine.trackerDeny(WS, 'a.txt', op);
    assert.equal(first.result.status, 'ok');
    const second = await harness.engine.trackerDeny(WS, 'a.txt', op);
    assert.equal(second.result.status, 'ok');
    assert.equal(second.result.reason, 'already-applied');
    assert.deepEqual(readFile(root, 'a.txt'), Buffer.from('A0\n'));
  } finally {
    cleanup();
    harness.cleanup();
  }
});

test('T05: a new turn after a deny gets a NEW deny op id (fresh generation)', async () => {
  const { root, cleanup } = makeRepo();
  writeFile(root, 'a.txt', 'A0\n');
  git(root, ['add', 'a.txt']);
  git(root, ['commit', '-m', 'add a']);
  const harness = makeHarness(root);
  try {
    await runTurn(harness.engine, root, () => writeFile(root, 'a.txt', 'A1\n'));
    await runTurn(harness.engine, root, () => writeFile(root, 'a.txt', 'A2\n'));
    let files = await harness.engine.trackerList(WS);
    const firstOp = trackerOpId(WS, 'deny', 'a.txt', files[0].currentHash);
    const first = await harness.engine.trackerDeny(WS, 'a.txt', firstOp);
    assert.equal(first.result.status, 'ok');

    // A new turn changes the file again; deny must NOT be short-circuited by
    // the old op id because currentHash differs.
    await runTurn(harness.engine, root, () => writeFile(root, 'a.txt', 'A3\n'));
    files = await harness.engine.trackerList(WS);
    assert.equal(files.length, 1);
    assert.equal(files[0].turns, 1);
    const secondOp = trackerOpId(WS, 'deny', 'a.txt', files[0].currentHash);
    assert.notEqual(secondOp, firstOp);
    const second = await harness.engine.trackerDeny(WS, 'a.txt', secondOp);
    assert.equal(second.result.status, 'ok');
    // The turn-3 baseline is the state left by the previous deny (A0).
    assert.deepEqual(readFile(root, 'a.txt'), Buffer.from('A0\n'));
  } finally {
    cleanup();
    harness.cleanup();
  }
});

test('T06: externally edited (live-changed) file is not deniable and shows Dismiss semantics', async () => {
  const { root, cleanup } = makeRepo();
  writeFile(root, 'a.txt', 'A0\n');
  git(root, ['add', 'a.txt']);
  git(root, ['commit', '-m', 'add a']);
  const harness = makeHarness(root);
  try {
    await runTurn(harness.engine, root, () => writeFile(root, 'a.txt', 'A1\n'));
    // External edit after the turn: working tree no longer matches newest after.
    writeFile(root, 'a.txt', 'EXTERNAL\n');
    const files = await harness.engine.trackerList(WS);
    assert.equal(files.length, 1);
    assert.equal(files[0].deniable, false);
    assert.equal(files[0].reason, 'live-changed');
    const deny = await harness.engine.trackerDeny(WS, 'a.txt', trackerOpId(WS, 'deny', 'a.txt', files[0].currentHash));
    assert.equal(deny.result.status, 'conflict');
    assert.equal(deny.result.reason, 'file-changed');
    assert.deepEqual(readFile(root, 'a.txt'), Buffer.from('EXTERNAL\n'));
    // Dismiss == accept: stops tracking without touching disk.
    const dismiss = await harness.engine.trackerAccept(WS, 'a.txt', trackerOpId(WS, 'accept', 'a.txt'));
    assert.equal(dismiss.ok, true);
    assert.deepEqual(readFile(root, 'a.txt'), Buffer.from('EXTERNAL\n'));
    assert.equal((await harness.engine.trackerList(WS)).length, 0);
  } finally {
    cleanup();
    harness.cleanup();
  }
});

test('T07: pre-turn-dirty file IS deniable; deny restores the pre-turn on-disk state byte-for-byte', async () => {
  const { root, cleanup } = makeRepo();
  writeFile(root, 'a.txt', 'A0\n');
  git(root, ['add', 'a.txt']);
  git(root, ['commit', '-m', 'add a']);
  const harness = makeHarness(root);
  try {
    // Dirty the working tree BEFORE the turn (the user's own uncommitted work).
    writeFile(root, 'a.txt', 'A1\n');
    await runTurn(harness.engine, root, () => writeFile(root, 'a.txt', 'A2\n'));
    const files = await harness.engine.trackerList(WS);
    assert.equal(files.length, 1);
    // User-authorized relaxation (DECISIONS §20): a verified-stable baseline is
    // deniable even when the file was already dirty at turn start.
    assert.equal(files[0].deniable, true, 'verified-stable baseline is deniable even when pre-turn dirty');
    assert.equal(files[0].reason, null);
    const deny = await harness.engine.trackerDeny(WS, 'a.txt', trackerOpId(WS, 'deny', 'a.txt', files[0].currentHash));
    assert.equal(deny.result.status, 'ok');
    // Deny restores the recorded before-state (the user's pre-turn A1), NOT
    // git HEAD (A0): the user's uncommitted work is preserved byte-for-byte.
    assert.deepEqual(readFile(root, 'a.txt'), Buffer.from('A1\n'));
    assert.equal((await harness.engine.trackerList(WS)).length, 0);
  } finally {
    cleanup();
    harness.cleanup();
  }
});

test('T07b: untracked file modified by the agent is deniable (user scenario)', async () => {
  const { root, cleanup } = makeRepo();
  const harness = makeHarness(root);
  try {
    // A file that is NOT tracked in git at all (never committed, untracked on
    // disk before the turn) — the learning-path dialog scenario.
    writeFile(root, 'dialog.ts', 'v0\n'); // user/agent-created untracked file
    await runTurn(harness.engine, root, () => writeFile(root, 'dialog.ts', 'v1\n'));
    const files = await harness.engine.trackerList(WS);
    assert.equal(files.length, 1);
    assert.equal(files[0].path, 'dialog.ts');
    assert.equal(files[0].deniable, true, 'untracked file with stable baseline is deniable');
    assert.equal(files[0].reason, null);
    const deny = await harness.engine.trackerDeny(WS, 'dialog.ts', trackerOpId(WS, 'deny', 'dialog.ts', files[0].currentHash));
    assert.equal(deny.result.status, 'ok');
    // Restores the pre-turn untracked state, not nothing.
    assert.deepEqual(readFile(root, 'dialog.ts'), Buffer.from('v0\n'));
    assert.equal((await harness.engine.trackerList(WS)).length, 0);
  } finally {
    cleanup();
    harness.cleanup();
  }
});

test('T08: created file accumulated across turns; deny removes it', async () => {
  const { root, cleanup } = makeRepo();
  const harness = makeHarness(root);
  try {
    await runTurn(harness.engine, root, () => writeFile(root, 'c.txt', 'v1\n'));
    await runTurn(harness.engine, root, () => writeFile(root, 'c.txt', 'v1\nv2\n'));
    const files = await harness.engine.trackerList(WS);
    assert.equal(files.length, 1);
    assert.equal(files[0].path, 'c.txt');
    assert.equal(files[0].kind, 'created');
    assert.equal(files[0].turns, 2);
    const deny = await harness.engine.trackerDeny(WS, 'c.txt', trackerOpId(WS, 'deny', 'c.txt', files[0].currentHash));
    assert.equal(deny.result.status, 'ok');
    assert.equal(fs.existsSync(`${root}/c.txt`), false);
  } finally {
    cleanup();
    harness.cleanup();
  }
});

test('T09: deleted file accumulated; deny recreates the baseline bytes', async () => {
  const { root, cleanup } = makeRepo();
  writeFile(root, 'd.txt', 'D0\nD1\n');
  git(root, ['add', 'd.txt']);
  git(root, ['commit', '-m', 'add d']);
  const original = readFile(root, 'd.txt');
  const harness = makeHarness(root);
  try {
    await runTurn(harness.engine, root, () => writeFile(root, 'd.txt', 'D0\nD1\nD2\n'));
    await runTurn(harness.engine, root, () => fs.rmSync(`${root}/d.txt`));
    const files = await harness.engine.trackerList(WS);
    assert.equal(files.length, 1);
    assert.equal(files[0].path, 'd.txt');
    assert.equal(files[0].kind, 'deleted');
    assert.equal(files[0].turns, 2);
    const deny = await harness.engine.trackerDeny(WS, 'd.txt', trackerOpId(WS, 'deny', 'd.txt', files[0].currentHash));
    assert.equal(deny.result.status, 'ok');
    assert.deepEqual(readFile(root, 'd.txt'), original);
  } finally {
    cleanup();
    harness.cleanup();
  }
});

test('T10: created-then-deleted leaves no net row', async () => {
  const { root, cleanup } = makeRepo();
  const harness = makeHarness(root);
  try {
    await runTurn(harness.engine, root, () => writeFile(root, 'e.txt', 'v1\n'));
    await runTurn(harness.engine, root, () => fs.rmSync(`${root}/e.txt`));
    assert.equal((await harness.engine.trackerList(WS)).length, 0);
  } finally {
    cleanup();
    harness.cleanup();
  }
});

test('T11: accept-all resolves every row; deny-all restores baselines', async () => {
  const { root, cleanup } = makeRepo();
  writeFile(root, 'x.txt', 'X0\n');
  writeFile(root, 'y.txt', 'Y0\n');
  git(root, ['add', 'x.txt', 'y.txt']);
  git(root, ['commit', '-m', 'add x y']);
  const harness = makeHarness(root);
  try {
    await runTurn(harness.engine, root, () => {
      writeFile(root, 'x.txt', 'X1\n');
      writeFile(root, 'y.txt', 'Y1\n');
    });
    // Scenario A: deny-all.
    const denied = await harness.engine.trackerDenyAll(WS);
    assert.equal(denied.results['x.txt']?.status, 'ok');
    assert.equal(denied.results['y.txt']?.status, 'ok');
    assert.deepEqual(readFile(root, 'x.txt'), Buffer.from('X0\n'));
    assert.deepEqual(readFile(root, 'y.txt'), Buffer.from('Y0\n'));
    assert.equal((await harness.engine.trackerList(WS)).length, 0);

    // Scenario B: a new turn, then accept-all.
    await runTurn(harness.engine, root, () => {
      writeFile(root, 'x.txt', 'X2\n');
      writeFile(root, 'y.txt', 'Y2\n');
    });
    assert.equal((await harness.engine.trackerList(WS)).length, 2);
    const accepted = await harness.engine.trackerAcceptAll(WS);
    assert.equal(accepted.results['x.txt'], 'ok');
    assert.equal(accepted.results['y.txt'], 'ok');
    assert.equal((await harness.engine.trackerList(WS)).length, 0);
  } finally {
    cleanup();
    harness.cleanup();
  }
});

test('T12: write-disabled mode makes every row not deniable and deny refused', async () => {
  const { root, cleanup } = makeRepo();
  writeFile(root, 'a.txt', 'A0\n');
  git(root, ['add', 'a.txt']);
  git(root, ['commit', '-m', 'add a']);
  const harness = makeHarness(root, fixtureSettings([root], { undoMode: 'disabled' }));
  try {
    await runTurn(harness.engine, root, () => writeFile(root, 'a.txt', 'A1\n'));
    const files = await harness.engine.trackerList(WS);
    assert.equal(files.length, 1);
    assert.equal(files[0].deniable, false);
    assert.equal(files[0].reason, 'write-disabled');
    const deny = await harness.engine.trackerDeny(WS, 'a.txt', trackerOpId(WS, 'deny', 'a.txt', files[0].currentHash));
    assert.equal(deny.result.status, 'refused');
    assert.equal(deny.result.reason, 'write-disabled');
    // Accept still works (metadata only).
    const accept = await harness.engine.trackerAccept(WS, 'a.txt', trackerOpId(WS, 'accept', 'a.txt'));
    assert.equal(accept.ok, true);
  } finally {
    cleanup();
    harness.cleanup();
  }
});

test('T13: trackerDiff reports full-replace for created/deleted and empty for nothing tracked', async () => {
  const { root, cleanup } = makeRepo();
  const harness = makeHarness(root);
  try {
    const none = await harness.engine.trackerDiff(WS, 'missing.txt');
    assert.ok('error' in none);
    assert.equal((none as { error: string }).error, 'not-tracked');

    await runTurn(harness.engine, root, () => writeFile(root, 'n.txt', 'hello\n'));
    const created = await harness.engine.trackerDiff(WS, 'n.txt');
    assert.ok(!('error' in created));
    assert.equal((created as { fullReplace: boolean }).fullReplace, true);
    assert.equal((created as { kind: string }).kind, 'created');
  } finally {
    cleanup();
    harness.cleanup();
  }
});

test('T14: event-best-effort real turns are deniable in fixture mode when untouched (before->write->after is the gate)', async () => {
  const { root, cleanup } = makeRepo();
  writeFile(root, 'a.txt', 'A0\n');
  git(root, ['add', 'a.txt']);
  git(root, ['commit', '-m', 'add a']);
  const harness = makeHarness(root);
  try {
    await runTurn(harness.engine, root, () => writeFile(root, 'a.txt', 'A1\n'), { barrier: 'event-best-effort' });
    const files = await harness.engine.trackerList(WS);
    assert.equal(files.length, 1);
    assert.equal(files[0].deniable, true);
    // Deny rolls the untouched file back to its pre-turn state.
    const deny = await harness.engine.trackerDeny(WS, 'a.txt', trackerOpId(WS, 'deny', 'a.txt', files[0].currentHash));
    assert.equal(deny.result.status, 'ok');
    assert.deepEqual(readFile(root, 'a.txt'), Buffer.from('A0\n'));
  } finally {
    cleanup();
    harness.cleanup();
  }
});

test('T14b: a file the user edits after the turn is an implicit accept -> live-changed, not deniable', async () => {
  const { root, cleanup } = makeRepo();
  writeFile(root, 'a.txt', 'A0\n');
  git(root, ['add', 'a.txt']);
  git(root, ['commit', '-m', 'add a']);
  const harness = makeHarness(root);
  try {
    await runTurn(harness.engine, root, () => writeFile(root, 'a.txt', 'A1\n'), { barrier: 'event-best-effort' });
    // The user edits the file themselves after the turn (implicit accept).
    writeFile(root, 'a.txt', 'A1-user\n');
    const files = await harness.engine.trackerList(WS);
    assert.equal(files.length, 1);
    assert.equal(files[0].deniable, false);
    assert.equal(files[0].reason, 'live-changed');
    const deny = await harness.engine.trackerDeny(WS, 'a.txt', trackerOpId(WS, 'deny', 'a.txt', files[0].currentHash));
    assert.equal(deny.result.status, 'conflict');
    assert.equal(deny.result.reason, 'file-changed');
    assert.deepEqual(readFile(root, 'a.txt'), Buffer.from('A1-user\n')); // untouched by the plugin
  } finally {
    cleanup();
    harness.cleanup();
  }
});

test('T14c: fixture mode with a root outside the allowlist -> not-fixture, not deniable', async () => {
  const { root, cleanup } = makeRepo();
  writeFile(root, 'a.txt', 'A0\n');
  git(root, ['add', 'a.txt']);
  git(root, ['commit', '-m', 'add a']);
  // Allowlist a different directory, not this repo's root.
  const otherRoot = path.join(os.tmpdir(), `turn-review-nonfixture-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const harness = makeHarness(otherRoot);
  try {
    await runTurn(harness.engine, root, () => writeFile(root, 'a.txt', 'A1\n'), { barrier: 'event-best-effort' });
    const files = await harness.engine.trackerList(WS);
    assert.equal(files.length, 1);
    assert.equal(files[0].deniable, false);
    assert.equal(files[0].reason, 'not-fixture');
    const deny = await harness.engine.trackerDeny(WS, 'a.txt', trackerOpId(WS, 'deny', 'a.txt', files[0].currentHash));
    assert.equal(deny.result.status, 'refused');
    assert.equal(deny.result.reason, 'not-fixture');
    assert.deepEqual(readFile(root, 'a.txt'), Buffer.from('A1\n')); // untouched by the plugin
  } finally {
    cleanup();
    harness.cleanup();
  }
});

test('T14d: allowAllProjects permits rollback for a root outside the allowlist (fixture mode)', async () => {
  const { root, cleanup } = makeRepo();
  writeFile(root, 'a.txt', 'A0\n');
  git(root, ['add', 'a.txt']);
  git(root, ['commit', '-m', 'add a']);
  // Empty allowlist + allowAllProjects -> every repo qualifies in fixture mode.
  const harness = makeHarness(root, fixtureSettings([], { allowAllProjects: true }));
  try {
    await runTurn(harness.engine, root, () => writeFile(root, 'a.txt', 'A1\n'), { barrier: 'event-best-effort' });
    const files = await harness.engine.trackerList(WS);
    assert.equal(files.length, 1);
    assert.equal(files[0].deniable, true);
    const deny = await harness.engine.trackerDeny(WS, 'a.txt', trackerOpId(WS, 'deny', 'a.txt', files[0].currentHash));
    assert.equal(deny.result.status, 'ok');
    assert.deepEqual(readFile(root, 'a.txt'), Buffer.from('A0\n'));
  } finally {
    cleanup();
    harness.cleanup();
  }
});

test('T14e: allowAllProjects never bypasses write-disabled mode', async () => {
  const { root, cleanup } = makeRepo();
  writeFile(root, 'a.txt', 'A0\n');
  git(root, ['add', 'a.txt']);
  git(root, ['commit', '-m', 'add a']);
  const harness = makeHarness(root, { undoMode: 'disabled', fixtureRoots: [], allowAllProjects: true, maxFileBytes: 1024 * 1024, retentionDays: 30, denyPaths: [] });
  try {
    await runTurn(harness.engine, root, () => writeFile(root, 'a.txt', 'A1\n'), { barrier: 'event-best-effort' });
    const files = await harness.engine.trackerList(WS);
    assert.equal(files.length, 1);
    assert.equal(files[0].deniable, false);
    assert.equal(files[0].reason, 'write-disabled');
  } finally {
    cleanup();
    harness.cleanup();
  }
});

test('T15: tracker op ids are allowlist-safe and content-stable', () => {
  const path = 'src/deep dir/nested.file.ts';
  const accept = trackerOpId('wks_1', 'accept', path);
  const deny = trackerOpId('wks_1', 'deny', path, 'ab'.repeat(32));
  assert.match(accept, /^[A-Za-z0-9_-]{1,128}$/);
  assert.match(deny, /^[A-Za-z0-9_-]{1,128}$/);
  // Deterministic across calls.
  assert.equal(accept, trackerOpId('wks_1', 'accept', path));
  // Different path -> different id.
  assert.notEqual(accept, trackerOpId('wks_1', 'accept', 'other.ts'));
  // Deny id embeds the currentHash so a new turn yields a new op id.
  assert.notEqual(
    trackerOpId('wks_1', 'deny', path, 'ab'.repeat(32)),
    trackerOpId('wks_1', 'deny', path, 'cd'.repeat(32)),
  );
  // The embedded hash is a real sha256 prefix of the path.
  assert.ok(accept.includes(sha256Hex(path).slice(0, 16)));
});

test('T16: tracker op ids stay allowlist-safe for any workspace id length', () => {
  const longWs = 'wks_' + 'a'.repeat(80);
  const accept = trackerOpId(longWs, 'accept', 'a.txt');
  const deny = trackerOpId(longWs, 'deny', 'a.txt', 'ab'.repeat(32));
  assert.ok(accept.length <= 128, `accept id ${accept.length}`);
  assert.ok(deny.length <= 128, `deny id ${deny.length}`);
  assert.match(accept, /^[A-Za-z0-9_-]{1,128}$/);
  assert.match(deny, /^[A-Za-z0-9_-]{1,128}$/);
  // Deterministic regardless of workspace id length.
  assert.equal(accept, trackerOpId(longWs, 'accept', 'a.txt'));
  // Different workspace ids still produce different op ids.
  assert.notEqual(trackerOpId(longWs, 'accept', 'a.txt'), trackerOpId('wks_1', 'accept', 'a.txt'));
});

test('T17: overlapping-agent (ambiguous) review makes the row not deniable', async () => {
  const { root, cleanup } = makeRepo();
  writeFile(root, 'a.txt', 'A0\n');
  git(root, ['add', 'a.txt']);
  git(root, ['commit', '-m', 'add a']);
  const harness = makeHarness(root);
  try {
    // Overlapping captures (two agents in the same root) mark the review ambiguous.
    const cap1 = await harness.engine.startTurn({ agentId: 'a1', workspaceId: WS, cwd: root, turnId: 't1', barrier: 'proven' });
    const cap2 = await harness.engine.startTurn({ agentId: 'a2', workspaceId: WS, cwd: root, turnId: 't2', barrier: 'proven' });
    writeFile(root, 'a.txt', 'A1\n');
    await harness.engine.endTurn({ occurrenceId: cap2, agentId: 'a2', workspaceId: WS, cwd: root, outcome: 'completed', barrier: 'proven' });
    await harness.engine.endTurn({ occurrenceId: cap1, agentId: 'a1', workspaceId: WS, cwd: root, outcome: 'completed', barrier: 'proven' });
    const files = await harness.engine.trackerList(WS);
    assert.equal(files.length, 1);
    assert.equal(files[0].deniable, false);
    assert.equal(files[0].reason, 'multi-agent');
    const deny = await harness.engine.trackerDeny(WS, 'a.txt', trackerOpId(WS, 'deny', 'a.txt', files[0].currentHash));
    assert.equal(deny.result.status, 'refused');
    assert.equal(deny.result.reason, 'unsafe-capture');
    // Dismiss (accept) still resolves the row without touching disk.
    const accept = await harness.engine.trackerAccept(WS, 'a.txt', trackerOpId(WS, 'accept', 'a.txt'));
    assert.equal(accept.ok, true);
    assert.deepEqual(readFile(root, 'a.txt'), Buffer.from('A1\n'));
  } finally {
    cleanup();
    harness.cleanup();
  }
});
