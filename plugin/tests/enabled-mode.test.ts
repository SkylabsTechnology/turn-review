import test from 'node:test';
import assert from 'node:assert/strict';
import { makeRepo, makeHarness, writeFile, readFile, git, fixtureSettings } from './helpers';
import { trackerOpId } from '../shared/op-id';
import { turnReviewSettings } from '../shared/settings';
import type { ReviewEngine } from '../server/review-engine';

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

/** Real-project mode: undoMode 'enabled', empty allowlist, allow-all off. */
function enabledSettings() {
  return fixtureSettings([], { undoMode: 'enabled', allowAllProjects: false });
}

test('E1: enabled (real-project) mode allows Deny on a repository that is NOT on any allowlist', async () => {
  const { root, cleanup } = makeRepo();
  writeFile(root, 'a.txt', 'A0\n');
  git(root, ['add', 'a.txt']);
  git(root, ['commit', '-m', 'add a']);
  const harness = makeHarness(root, enabledSettings());
  try {
    await runTurn(harness.engine, root, () => writeFile(root, 'a.txt', 'A1\n'));
    const files = await harness.engine.trackerList(WS);
    assert.equal(files.length, 1);
    assert.equal(files[0].deniable, true);
    assert.equal(files[0].reason, null);
    const deny = await harness.engine.trackerDeny(WS, 'a.txt', trackerOpId(WS, 'deny', 'a.txt', files[0].currentHash));
    assert.equal(deny.result.status, 'ok');
    assert.deepEqual(readFile(root, 'a.txt'), Buffer.from('A0\n'));
  } finally {
    cleanup();
    harness.cleanup();
  }
});

test('E2: enabled mode still refuses a file the user edited after the turn (CAS never weakened)', async () => {
  const { root, cleanup } = makeRepo();
  writeFile(root, 'a.txt', 'A0\n');
  git(root, ['add', 'a.txt']);
  git(root, ['commit', '-m', 'add a']);
  const harness = makeHarness(root, enabledSettings());
  try {
    await runTurn(harness.engine, root, () => writeFile(root, 'a.txt', 'A1\n'));
    writeFile(root, 'a.txt', 'A1-user\n'); // user edit = implicit accept
    const files = await harness.engine.trackerList(WS);
    assert.equal(files[0].deniable, false);
    assert.equal(files[0].reason, 'live-changed');
    const deny = await harness.engine.trackerDeny(WS, 'a.txt', trackerOpId(WS, 'deny', 'a.txt', files[0].currentHash));
    assert.equal(deny.result.status, 'conflict');
    assert.equal(deny.result.reason, 'file-changed');
    assert.deepEqual(readFile(root, 'a.txt'), Buffer.from('A1-user\n'));
  } finally {
    cleanup();
    harness.cleanup();
  }
});

test('E3: enabled mode still refuses overlapping agents on the same repo (multi-agent -> unsafe-capture)', async () => {
  const { root, cleanup } = makeRepo();
  writeFile(root, 'a.txt', 'A0\n');
  git(root, ['add', 'a.txt']);
  git(root, ['commit', '-m', 'add a']);
  const harness = makeHarness(root, enabledSettings());
  try {
    const cap1 = await harness.engine.startTurn({ agentId: 'a1', workspaceId: WS, cwd: root, turnId: 't1', barrier: 'proven' });
    const cap2 = await harness.engine.startTurn({ agentId: 'a2', workspaceId: WS, cwd: root, turnId: 't2', barrier: 'proven' });
    writeFile(root, 'a.txt', 'A1\n');
    await harness.engine.endTurn({ occurrenceId: cap2, agentId: 'a2', workspaceId: WS, cwd: root, outcome: 'completed', barrier: 'proven' });
    await harness.engine.endTurn({ occurrenceId: cap1, agentId: 'a1', workspaceId: WS, cwd: root, outcome: 'completed', barrier: 'proven' });
    const files = await harness.engine.trackerList(WS);
    assert.equal(files[0].deniable, false);
    assert.equal(files[0].reason, 'multi-agent');
    const deny = await harness.engine.trackerDeny(WS, 'a.txt', trackerOpId(WS, 'deny', 'a.txt', files[0].currentHash));
    assert.equal(deny.result.status, 'refused');
    assert.equal(deny.result.reason, 'unsafe-capture');
  } finally {
    cleanup();
    harness.cleanup();
  }
});

test('E4: enabled mode recovery works within the window and is gated by the next turn', async () => {
  const { root, cleanup } = makeRepo();
  writeFile(root, 'a.txt', 'A0\n');
  git(root, ['add', 'a.txt']);
  git(root, ['commit', '-m', 'add a']);
  const harness = makeHarness(root, enabledSettings());
  try {
    await runTurn(harness.engine, root, () => writeFile(root, 'a.txt', 'A1\n'));
    const files = await harness.engine.trackerList(WS);
    const deny = await harness.engine.trackerDeny(WS, 'a.txt', trackerOpId(WS, 'deny', 'a.txt', files[0].currentHash));
    assert.equal(deny.result.status, 'ok');
    assert.equal((await harness.engine.trackerRecoverable(WS)).length, 1);

    // A newer turn on the same repo closes the recovery window even in enabled mode.
    await runTurn(harness.engine, root, () => writeFile(root, 'a.txt', 'A2\n'));
    assert.equal((await harness.engine.trackerRecoverable(WS)).length, 0);
  } finally {
    cleanup();
    harness.cleanup();
  }
});

test('E5: write mode must be enabled for a real project — a repo outside the allowlist is never deniable in disabled mode', async () => {
  const { root, cleanup } = makeRepo();
  writeFile(root, 'a.txt', 'A0\n');
  git(root, ['add', 'a.txt']);
  git(root, ['commit', '-m', 'add a']);
  const harness = makeHarness(root, fixtureSettings([], { undoMode: 'disabled', allowAllProjects: true }));
  try {
    await runTurn(harness.engine, root, () => writeFile(root, 'a.txt', 'A1\n'));
    const files = await harness.engine.trackerList(WS);
    assert.equal(files[0].deniable, false);
    assert.equal(files[0].reason, 'write-disabled');
    const deny = await harness.engine.trackerDeny(WS, 'a.txt', trackerOpId(WS, 'deny', 'a.txt', files[0].currentHash));
    assert.equal(deny.result.status, 'refused');
    assert.equal(deny.result.reason, 'write-disabled');
    assert.deepEqual(readFile(root, 'a.txt'), Buffer.from('A1\n')); // untouched
  } finally {
    cleanup();
    harness.cleanup();
  }
});

test('E6: the settings schema accepts "enabled" and rejects an unknown write mode', () => {
  const ok = turnReviewSettings.schema.parse({ undoMode: 'enabled' });
  assert.equal(ok.undoMode, 'enabled');
  assert.equal(turnReviewSettings.schema.parse({}).undoMode, 'disabled'); // default unchanged
  assert.throws(() => turnReviewSettings.schema.parse({ undoMode: 'live' }));
});
