import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { makeRepo, makeHarness, writeFile, readFile, git, fixtureSettings } from './helpers';
import { trackerOpId } from '../shared/op-id';
import { ReviewEngine } from '../server/review-engine';
import { openStorage } from '../server/storage';

const WS = 'ws-fixture';

/** Proven-barrier turn helper (mirrors tracker tests). */
async function runTurn(engine: ReviewEngine, root: string, edits: () => void, opts: { agent?: string; workspace?: string; barrier?: 'proven' | 'event-best-effort' } = {}) {
  const agent = opts.agent ?? 'a1';
  const workspace = opts.workspace ?? WS;
  const barrier = opts.barrier ?? 'proven';
  const captureId = await engine.startTurn({ agentId: agent, workspaceId: workspace, cwd: root, turnId: `t-${Math.random()}`, barrier });
  edits();
  const review = await engine.endTurn({ occurrenceId: captureId, agentId: agent, workspaceId: workspace, cwd: root, outcome: 'completed', barrier });
  return { captureId, review: review! };
}

function makeRepoWithIndex(): { root: string; original: Buffer; cleanup(): void } {
  const { root, cleanup } = makeRepo();
  const original = Buffer.from('<!doctype html>\n<title>demo</title>\n<p>hello</p>\n');
  writeFile(root, 'index.html', original);
  git(root, ['add', 'index.html']);
  git(root, ['commit', '-m', 'add index']);
  return { root, original, cleanup };
}

test('F-R1: fixture-run refuses when write mode is disabled', async () => {
  const { root, cleanup } = makeRepoWithIndex();
  const harness = makeHarness(root, fixtureSettings([root], { undoMode: 'disabled' }));
  try {
    const r = await harness.engine.fixtureRun({ workspaceId: WS, path: 'index.html' });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, 'write-disabled');
  } finally {
    cleanup();
    harness.cleanup();
  }
});

test('F-R2: fixture-run refuses when the root is not on the fixture allowlist', async () => {
  const { root, cleanup } = makeRepoWithIndex();
  const harness = makeHarness(root, fixtureSettings([], { undoMode: 'fixture' }));
  try {
    // Seed a review so the root can be resolved.
    await runTurn(harness.engine, root, () => writeFile(root, 'notes.txt', 'seed\n'));
    const r = await harness.engine.fixtureRun({ workspaceId: WS, path: 'index.html' });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, 'not-fixture');
  } finally {
    cleanup();
    harness.cleanup();
  }
});

test('F-R3: fixture-run refuses when no idle agent exists for the workspace', async () => {
  const { root, cleanup } = makeRepoWithIndex();
  const harness = makeHarness(root, fixtureSettings([root]));
  try {
    await runTurn(harness.engine, root, () => writeFile(root, 'notes.txt', 'seed\n'));
    // Rebuild engine with findIdleAgent -> null.
    const storageRoot = path.join(os.tmpdir(), `fixture-run-store-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const storage = openStorage(storageRoot);
    const engine2 = new ReviewEngine({
      storage,
      getSettings: async () => fixtureSettings([root]),
      isAgentRunning: async () => false,
      findIdleAgent: async () => null,
      allowFixtureRun: true,
    });
    engine2.load();
    try {
      await runTurn(engine2, root, () => writeFile(root, 'notes.txt', 'seed\n'));
      const r = await engine2.fixtureRun({ workspaceId: WS, path: 'index.html' });
      assert.equal(r.ok, false);
      if (!r.ok) assert.equal(r.reason, 'no-idle-agent');
    } finally {
      fs.rmSync(storageRoot, { recursive: true, force: true });
    }
  } finally {
    cleanup();
    harness.cleanup();
  }
});

test('F-R4: fixture-run refuses for a workspace with no captured turn', async () => {
  const { root, cleanup } = makeRepoWithIndex();
  const harness = makeHarness(root, fixtureSettings([root]));
  try {
    const r = await harness.engine.fixtureRun({ workspaceId: 'ws-unknown', path: 'index.html' });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, 'no-reviews');
  } finally {
    cleanup();
    harness.cleanup();
  }
});

test('F-R5: fixture-run appends a marker, tracks a deniable row, and Deny rolls back', async () => {
  const { root, original, cleanup } = makeRepoWithIndex();
  const harness = makeHarness(root, fixtureSettings([root]));
  try {
    // Seed a review (editing a different file) so the root is known.
    await runTurn(harness.engine, root, () => writeFile(root, 'notes.txt', 'seed\n'));
    await harness.engine.trackerAccept(WS, 'notes.txt', trackerOpId(WS, 'accept', 'notes.txt'));

    const before = readFile(root, 'index.html');
    const r = await harness.engine.fixtureRun({ workspaceId: WS, path: 'index.html' });
    assert.equal(r.ok, true);
    if (!r.ok) throw new Error('unreachable');
    assert.equal(r.path, 'index.html');

    // Marker was appended to the real working tree.
    const after = readFile(root, 'index.html');
    assert.ok(after.length > before.length);
    assert.ok(after.toString('utf8').includes('turn-review fixture marker'));

    const files = await harness.engine.trackerList(WS);
    const row = files.find((f) => f.path === 'index.html');
    assert.ok(row, 'index.html should be tracked');
    assert.equal(row?.kind, 'modified');
    assert.equal(row?.deniable, true);
    assert.equal(row?.turns, 1);

    // Deny must restore the exact pre-fixture bytes.
    const deny = await harness.engine.trackerDeny(WS, 'index.html', trackerOpId(WS, 'deny', 'index.html', row?.currentHash ?? null));
    assert.equal(deny.result.status, 'ok');
    assert.deepEqual(readFile(root, 'index.html'), original);

    // Row resolved -> tracker empty.
    assert.equal((await harness.engine.trackerList(WS)).length, 0);
  } finally {
    cleanup();
    harness.cleanup();
  }
});

test('F-R6: fixture-run writes provided content verbatim', async () => {
  const { root, cleanup } = makeRepoWithIndex();
  const harness = makeHarness(root, fixtureSettings([root]));
  try {
    await runTurn(harness.engine, root, () => writeFile(root, 'notes.txt', 'seed\n'));
    const r = await harness.engine.fixtureRun({ workspaceId: WS, path: 'index.html', content: 'EXACT\n' });
    assert.equal(r.ok, true);
    assert.deepEqual(readFile(root, 'index.html'), Buffer.from('EXACT\n'));
  } finally {
    cleanup();
    harness.cleanup();
  }
});

test('F-R7: fixture-run refuses a sensitive path (.env)', async () => {
  const { root, cleanup } = makeRepoWithIndex();
  const harness = makeHarness(root, fixtureSettings([root]));
  try {
    await runTurn(harness.engine, root, () => writeFile(root, 'notes.txt', 'seed\n'));
    const r = await harness.engine.fixtureRun({ workspaceId: WS, path: '.env' });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, 'denied-path');
  } finally {
    cleanup();
    harness.cleanup();
  }
});

test('F-R8: fixture-run refuses a path escaping the root', async () => {
  const { root, cleanup } = makeRepoWithIndex();
  const harness = makeHarness(root, fixtureSettings([root]));
  try {
    await runTurn(harness.engine, root, () => writeFile(root, 'notes.txt', 'seed\n'));
    const r = await harness.engine.fixtureRun({ workspaceId: WS, path: '../escape.txt' });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, 'unauthorized-path');
  } finally {
    cleanup();
    harness.cleanup();
  }
});

test('F-R9: a Deny on a fixture row is refused while the agent is running (writer-active)', async () => {
  const { root, cleanup } = makeRepoWithIndex();
  const storageRoot = path.join(os.tmpdir(), `fixture-run-store-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const storage = openStorage(storageRoot);
  const engine = new ReviewEngine({
    storage,
    getSettings: async () => fixtureSettings([root]),
    isAgentRunning: async () => true, // agent busy -> writer-active must refuse
    findIdleAgent: async () => 'a1',
    allowFixtureRun: true,
  });
  engine.load();
  try {
    await runTurn(engine, root, () => writeFile(root, 'notes.txt', 'seed\n'));
    const r = await engine.fixtureRun({ workspaceId: WS, path: 'index.html' });
    assert.equal(r.ok, true);
    const files = await engine.trackerList(WS);
    const row = files.find((f) => f.path === 'index.html');
    assert.equal(row?.deniable, true);
    const deny = await engine.trackerDeny(WS, 'index.html', trackerOpId(WS, 'deny', 'index.html', row?.currentHash ?? null));
    assert.equal(deny.result.status, 'refused');
    assert.equal(deny.result.reason, 'writer-active');
    // The working tree must be untouched.
    assert.ok(readFile(root, 'index.html').toString('utf8').includes('turn-review fixture marker'));
  } finally {
    cleanup();
    fs.rmSync(storageRoot, { recursive: true, force: true });
  }
});

test('F-R10: fixture-run refuses while a capture is already active on the root (capture-active)', async () => {
  const { root, cleanup } = makeRepoWithIndex();
  const harness = makeHarness(root, fixtureSettings([root]));
  try {
    // End one review so the root is resolvable.
    await runTurn(harness.engine, root, () => writeFile(root, 'notes.txt', 'seed\n'));
    // Start a capture and DO NOT end it -> active on the root.
    await harness.engine.startTurn({ agentId: 'busy', workspaceId: WS, cwd: root, turnId: 'open-1', barrier: 'proven' });
    const r = await harness.engine.fixtureRun({ workspaceId: WS, path: 'index.html' });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, 'capture-active');
  } finally {
    cleanup();
    harness.cleanup();
  }
});

test('F-R12: fixture-run proceeds past the allowlist gate when allowAllProjects is set', async () => {
  const { root, original, cleanup } = makeRepoWithIndex();
  // Empty allowlist + allowAllProjects -> the fixture gate is satisfied.
  const harness = makeHarness(root, fixtureSettings([], { undoMode: 'fixture', allowAllProjects: true }));
  try {
    await runTurn(harness.engine, root, () => writeFile(root, 'notes.txt', 'seed\n'));
    const r = await harness.engine.fixtureRun({ workspaceId: WS, path: 'index.html' });
    assert.equal(r.ok, true);
    if (!r.ok) throw new Error('unreachable');
    const marker = readFile(root, 'index.html').toString('utf8');
    assert.notEqual(marker, original.toString('utf8'));
    assert.ok(marker.includes('turn-review fixture marker'));
    // And the resulting row is deniable through the allowAll gate.
    const row = (await harness.engine.trackerList(WS)).find((f) => f.path === 'index.html');
    assert.ok(row, 'index.html should be tracked');
    assert.equal(row?.deniable, true);
  } finally {
    cleanup();
    harness.cleanup();
  }
});

test('F-R11: fixture-run refuses a non-git workspace root before writing (unsupported-root)', async () => {
  const dir = path.join(os.tmpdir(), `fixture-nongit-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), '<p>hi</p>\n');
  const harness = makeHarness(dir, fixtureSettings([dir]));
  try {
    // A non-git cwd produces an ended review whose rootRealPath is the dir.
    const captureId = await harness.engine.startTurn({ agentId: 'a1', workspaceId: WS, cwd: dir, turnId: 't-1', barrier: 'proven' });
    await harness.engine.endTurn({ occurrenceId: captureId, agentId: 'a1', workspaceId: WS, cwd: dir, outcome: 'completed', barrier: 'proven' });
    const r = await harness.engine.fixtureRun({ workspaceId: WS, path: 'index.html' });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, 'unsupported-root');
    // No marker must have been written.
    assert.equal(readFile(dir, 'index.html').toString('utf8'), '<p>hi</p>\n');
  } finally {
    harness.cleanup();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});
