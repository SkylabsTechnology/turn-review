import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { makeRepo, makeHarness, writeFile, readFile, git, fixtureSettings, sha } from './helpers';
import { openStorage } from '../server/storage';
import { captureWorktree } from '../server/capture';
import { safeRelativePath } from '../server/path-safety';
import { openExclusiveNoFollow } from '../server/util';
import { trackerOpId } from '../shared/op-id';
import { ReviewEngine } from '../server/review-engine';

const WS = 'ws-1';
const isWindows = process.platform === 'win32';

async function runTurn(engine: ReviewEngine, root: string, edits: () => void) {
  const captureId = await engine.startTurn({ agentId: 'a1', workspaceId: WS, cwd: root, turnId: `t-${Math.random()}`, barrier: 'proven' });
  edits();
  const review = await engine.endTurn({ occurrenceId: captureId, agentId: 'a1', workspaceId: WS, cwd: root, outcome: 'completed', barrier: 'proven' });
  return { captureId, review: review! };
}

/** Redirect the tracked directory `relDir` (within root) to the outside dir. */
function pointOutside(root: string, relDir: string, outsideDir: string): boolean {
  const p = path.join(root, ...relDir.split('/'));
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  try {
    if (isWindows) fs.symlinkSync(outsideDir, p, 'junction');
    else fs.symlinkSync(outsideDir, p, 'dir');
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// F1: the simulated production fixture writer is test-only authorized
// ---------------------------------------------------------------------------

test('F1: fixtureRun refuses when the engine was not authorized (allowFixtureRun unset)', async () => {
  const { root, cleanup } = makeRepo();
  writeFile(root, 'a.txt', 'A0\n');
  git(root, ['add', 'a.txt']);
  git(root, ['commit', '-m', 'add a']);
  const storage = openStorage(path.join(os.tmpdir(), `tr-f1-${Date.now()}-${Math.random().toString(36).slice(2)}`));
  const engine = new ReviewEngine({
    storage,
    getSettings: async () => fixtureSettings([root]),
    isAgentRunning: async () => false,
    findIdleAgent: async () => 'fixture-agent',
    allowFixtureRun: false, // production default (rpc.ts wires env opt-in)
  });
  engine.load();
  try {
    // Seed a review so the fixture writer has something to simulate.
    await runTurn(engine, root, () => writeFile(root, 'a.txt', 'A1\n'));
    const r = await engine.fixtureRun({ workspaceId: WS, path: 'a.txt' });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'fixture-disabled');
    // And nothing was written to disk by the refused writer.
    assert.deepEqual(readFile(root, 'a.txt'), Buffer.from('A1\n'));
  } finally {
    engine.dispose?.();
    try { fs.rmSync(storage.root, { recursive: true, force: true }); } catch { /* ignore */ }
    cleanup();
  }
});

test('F1: fixtureRun works when explicitly authorized (test harness / opt-in env)', async () => {
  const { root, cleanup } = makeRepo();
  writeFile(root, 'a.txt', 'A0\n');
  git(root, ['add', 'a.txt']);
  git(root, ['commit', '-m', 'add a']);
  const harness = makeHarness(root); // harness sets allowFixtureRun: true
  try {
    await runTurn(harness.engine, root, () => writeFile(root, 'a.txt', 'A1\n'));
    const r = await harness.engine.fixtureRun({ workspaceId: WS, path: 'a.txt', content: 'SIMULATED\n' });
    assert.equal(r.ok, true);
    // The simulated writer produced a new after-state (a real agent-style edit),
    // which is then captured and tracked like any other turn.
    assert.deepEqual(readFile(root, 'a.txt'), Buffer.from('SIMULATED\n'));
    const files = await harness.engine.trackerList(WS);
    assert.equal(files.some((f) => f.path === 'a.txt'), true);
  } finally {
    harness.cleanup();
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// F2: git metadata / worktree / traversal / unsafe symlink paths are rejected
// ---------------------------------------------------------------------------

test('F2: safeRelativePath rejects git metadata paths at any depth', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-f2-'));
  try {
    fs.mkdirSync(path.join(root, '.git', 'objects'), { recursive: true });
    fs.mkdirSync(path.join(root, 'sub', '.git'), { recursive: true });
    fs.mkdirSync(path.join(root, 'a', 'b', '.git', 'worktrees'), { recursive: true });
    for (const bad of ['.git', '.git/config', 'sub/.git/HEAD', 'a/b/.git/worktrees/x', '.git/modules/foo']) {
      const r = safeRelativePath(root, root, bad);
      assert.equal(r.ok, false, `expected ${bad} to be rejected`);
      assert.equal(r.reason, 'git-boundary', `expected git-boundary for ${bad}`);
    }
    // Traversal escapes are still rejected (unchanged behavior).
    for (const bad of ['../outside.txt', 'a/../../escape']) {
      const r = safeRelativePath(root, root, bad);
      assert.equal(r.ok, false, `expected ${bad} to be rejected`);
      assert.notEqual(r.reason, null);
    }
    // Non-git paths remain allowed (unchanged behavior).
    for (const good of ['a.txt', 'sub/file.ts', 'a/b/c.js']) {
      const r = safeRelativePath(root, root, good);
      assert.equal(r.ok, true, `expected ${good} to be allowed`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('F2: fixtureRun refuses a git-metadata target end to end', async () => {
  const { root, cleanup } = makeRepo();
  writeFile(root, 'a.txt', 'A0\n');
  git(root, ['add', 'a.txt']);
  git(root, ['commit', '-m', 'add a']);
  const harness = makeHarness(root);
  try {
    await runTurn(harness.engine, root, () => writeFile(root, 'a.txt', 'A1\n'));
    const r = await harness.engine.fixtureRun({ workspaceId: WS, path: '.git/config' });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'unauthorized-path');
  } finally {
    harness.cleanup();
    cleanup();
  }
});

test('F2: undoFile refuses a traversal-looking path (not a captured review file) end to end', async () => {
  const { root, cleanup } = makeRepo();
  writeFile(root, 'a.txt', 'A0\n');
  git(root, ['add', 'a.txt']);
  git(root, ['commit', '-m', 'add a']);
  const harness = makeHarness(root);
  try {
    const { captureId, review } = await runTurn(harness.engine, root, () => writeFile(root, 'a.txt', 'A1\n'));
    const op = `op-${captureId}-${review.revision}-undo-file-foo`;
    // A path that escapes the root is never a captured file; Undo must refuse
    // (fail-closed) rather than treat it as a valid target.
    const r = await harness.engine.undoFile(captureId, WS, review.revision, op, '..\\..\\etc\\passwd', null, false);
    assert.equal(r.result.status, 'refused');
    assert.ok(['missing-file', 'unauthorized-path'].includes(r.result.reason), `unexpected reason: ${r.result.reason}`);
  } finally {
    harness.cleanup();
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// F3: rollback temp files are unpredictable, exclusive, and no-follow
// ---------------------------------------------------------------------------

test('F3: openExclusiveNoFollow refuses existing entries and never follows a planted link', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-f3-'));
  try {
    const existing = path.join(dir, 'existing');
    fs.writeFileSync(existing, 'x');
    assert.throws(() => openExclusiveNoFollow(existing), (e) => (e as NodeJS.ErrnoException).code === 'EEXIST');
    // A symlink at the target is an existing directory entry: O_EXCL must
    // refuse it without ever following it.
    const target = path.join(dir, 'target');
    fs.writeFileSync(target, 't');
    const link = path.join(dir, 'link');
    let linked = false;
    try {
      fs.symlinkSync(target, link, 'file');
      linked = true;
    } catch {
      /* Windows without dev mode cannot create file symlinks */
    }
    if (linked) {
      assert.throws(() => openExclusiveNoFollow(link), (e) => (e as NodeJS.ErrnoException).code === 'EEXIST');
      // The symlink was never followed: its target is intact.
      assert.deepEqual(fs.readFileSync(target), Buffer.from('t'));
    }
    // Fresh name is created exclusively with the expected mode.
    const fresh = path.join(dir, 'fresh');
    const fd = openExclusiveNoFollow(fresh, 0o640);
    fs.closeSync(fd);
    assert.ok(fs.existsSync(fresh));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('F3: a symlink planted at the legacy predictable temp name is never followed during Deny', async () => {
  const { root, cleanup } = makeRepo();
  writeFile(root, 'a.txt', 'A0\n');
  git(root, ['add', 'a.txt']);
  git(root, ['commit', '-m', 'add a']);
  const harness = makeHarness(root);
  const canary = path.join(os.tmpdir(), `tr-f3-canary-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  fs.writeFileSync(canary, 'CANARY-SECRET\n');
  try {
    await runTurn(harness.engine, root, () => writeFile(root, 'a.txt', 'A1\n'));
    const files = await harness.engine.trackerList(WS);
    const opId = trackerOpId(WS, 'deny', 'a.txt', files[0].currentHash);
    // An attacker who can guess the OLD predictable name tries to pre-place a
    // symlink at it pointing at a canary outside the repo.
    const legacyTemp = path.join(root, `.a.txt.tr-${opId}.tmp`);
    let planted = false;
    try {
      fs.symlinkSync(canary, legacyTemp, 'file');
      planted = true;
    } catch {
      /* Windows file symlinks may need admin; fall back to a regular file */
      fs.writeFileSync(legacyTemp, 'PLANTED-PLACEHOLDER');
    }
    const deny = await harness.engine.trackerDeny(WS, 'a.txt', opId);
    assert.equal(deny.result.status, 'ok');
    assert.deepEqual(readFile(root, 'a.txt'), Buffer.from('A0\n'));
    if (planted) {
      // The planted symlink was never used: the canary is byte-for-byte intact.
      assert.deepEqual(fs.readFileSync(canary), Buffer.from('CANARY-SECRET\n'), 'canary must be untouched');
    }
  } finally {
    harness.cleanup();
    try { fs.unlinkSync(canary); } catch { /* ignore */ }
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// F4: snapshot open/read is safe against symlink/junction redirects outside root
// ---------------------------------------------------------------------------

test('F4: a tracked path redirected to a symlink/junction outside the root is never read or stored', async () => {
  const { root, cleanup } = makeRepo();
  writeFile(root, 'sub/a.txt', 'AAA\n');
  git(root, ['add', 'sub/a.txt']);
  git(root, ['commit', '-m', 'add sub/a']);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-f4-out-'));
  fs.writeFileSync(path.join(outside, 'a.txt'), 'TOP-SECRET-OUTSIDE\n');
  const storage = openStorage(path.join(os.tmpdir(), `tr-f4-${Date.now()}-${Math.random().toString(36).slice(2)}`));
  try {
    if (!pointOutside(root, 'sub', outside)) {
      // Neither file symlink nor junction is creatable on this host: skip.
      return;
    }
    const res = await captureWorktree(root, storage.blobs, {
      maxFiles: 1000, maxFileBytes: 1024 * 1024, denyPaths: [],
    });
    assert.equal(res.ok, true, JSON.stringify(res));
    const snap = res.snapshot!;
    const f = snap.files.get('sub/a.txt')!;
    assert.equal(f.hash, null, 'redirected path must not be stored as undo-exact');
    assert.equal(f.support, 'unsupported', 'redirected path must be classified unsupported');
    // The outside secret must not exist as a blob (hash of its bytes absent).
    assert.equal(storage.blobs.exists(sha(Buffer.from('TOP-SECRET-OUTSIDE\n'))), false, 'outside bytes leaked into the blob store');
  } finally {
    try { fs.rmSync(storage.root, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(outside, { recursive: true, force: true }); } catch { /* ignore */ }
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// F5: permissions / executable flags survive Deny, Restore and recovery
// ---------------------------------------------------------------------------

test('F5: Deny of a modified file restores its original executable mode', { skip: isWindows && 'mode bits are not meaningful on Windows' }, async () => {
  const { root, cleanup } = makeRepo();
  writeFile(root, 'run.sh', '#!/bin/sh\necho hi\n');
  fs.chmodSync(path.join(root, 'run.sh'), 0o755);
  git(root, ['add', 'run.sh']);
  git(root, ['commit', '-m', 'add run.sh']);
  const harness = makeHarness(root);
  try {
    // The turn rewrites the file AND loses the executable bit (the classic bug).
    await runTurn(harness.engine, root, () => {
      writeFile(root, 'run.sh', '#!/bin/sh\necho bye\n');
      fs.chmodSync(path.join(root, 'run.sh'), 0o644);
    });
    const files = await harness.engine.trackerList(WS);
    const deny = await harness.engine.trackerDeny(WS, 'run.sh', trackerOpId(WS, 'deny', 'run.sh', files[0].currentHash));
    assert.equal(deny.result.status, 'ok');
    assert.deepEqual(readFile(root, 'run.sh'), Buffer.from('#!/bin/sh\necho hi\n'));
    assert.equal(fs.statSync(path.join(root, 'run.sh')).mode & 0o777, 0o755, 'executable bit preserved after Deny');
  } finally {
    harness.cleanup();
    cleanup();
  }
});

test('F5: Deny of a deleted file recreates it with its original executable mode', { skip: isWindows && 'mode bits are not meaningful on Windows' }, async () => {
  const { root, cleanup } = makeRepo();
  writeFile(root, 'run.sh', '#!/bin/sh\necho hi\n');
  fs.chmodSync(path.join(root, 'run.sh'), 0o755);
  git(root, ['add', 'run.sh']);
  git(root, ['commit', '-m', 'add run.sh']);
  const harness = makeHarness(root);
  try {
    await runTurn(harness.engine, root, () => fs.unlinkSync(path.join(root, 'run.sh')));
    const files = await harness.engine.trackerList(WS);
    assert.equal(files[0].kind, 'deleted');
    const deny = await harness.engine.trackerDeny(WS, 'run.sh', trackerOpId(WS, 'deny', 'run.sh', files[0].currentHash));
    assert.equal(deny.result.status, 'ok');
    assert.deepEqual(readFile(root, 'run.sh'), Buffer.from('#!/bin/sh\necho hi\n'));
    assert.equal(fs.statSync(path.join(root, 'run.sh')).mode & 0o777, 0o755, 'recreated file keeps the original mode');
  } finally {
    harness.cleanup();
    cleanup();
  }
});

test('F5: Restore of a created file recreates it with its recorded mode', { skip: isWindows && 'mode bits are not meaningful on Windows' }, async () => {
  const { root, cleanup } = makeRepo();
  const harness = makeHarness(root);
  try {
    await runTurn(harness.engine, root, () => {
      writeFile(root, 'new.sh', '#!/bin/sh\necho new\n');
      fs.chmodSync(path.join(root, 'new.sh'), 0o755);
    });
    const files = await harness.engine.trackerList(WS);
    const deny = await harness.engine.trackerDeny(WS, 'new.sh', trackerOpId(WS, 'deny', 'new.sh', files[0].currentHash));
    assert.equal(deny.result.status, 'ok');
    assert.equal(fs.existsSync(path.join(root, 'new.sh')), false);
    const rec = await harness.engine.trackerRecoverable(WS);
    assert.equal(rec.length, 1);
    const restore = await harness.engine.trackerRecover(WS, 'new.sh', rec[0].operationId);
    assert.equal(restore.result.status, 'ok');
    assert.deepEqual(readFile(root, 'new.sh'), Buffer.from('#!/bin/sh\necho new\n'));
    assert.equal(fs.statSync(path.join(root, 'new.sh')).mode & 0o777, 0o755, 'restored file keeps the created mode');
  } finally {
    harness.cleanup();
    cleanup();
  }
});
