import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeRepo, makeHarness, writeFile, git, fixtureSettings } from './helpers';
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

test('F01: modified file returns full before (baseline) and after (newest) text', async () => {
  const { root, cleanup } = makeRepo();
  writeFile(root, 'src/app.ts', 'const x = 1;\nfunction add(a: number, b: number) { return a + b; }\nexport default add;\n');
  gitCommit(root);
  const harness = makeHarness(root);
  try {
    await runTurn(harness.engine, root, () => writeFile(root, 'src/app.ts', 'const x = 2;\nfunction add(a: number, b: number) { return a + b; }\nexport default add;\n'));
    const out = await harness.engine.trackerFullFile(WS, 'src/app.ts');
    assert.equal(out.error, null);
    assert.equal(out.kind, 'modified');
    assert.equal(out.truncated, false);
    assert.equal(out.before, 'const x = 1;\nfunction add(a: number, b: number) { return a + b; }\nexport default add;\n');
    assert.equal(out.after, 'const x = 2;\nfunction add(a: number, b: number) { return a + b; }\nexport default add;\n');
    // Line-level hunks are included so the client can render VS Code-style rows.
    assert.ok(out.hunks.length >= 1);
    assert.equal(out.fullReplace, false);
    assert.ok(out.hunks.every((h) => h.oldCount === h.removed.length && h.newCount === h.added.length));
    // Matches what the row diff shows (trackerDiff baseline -> newest).
    const diff = await harness.engine.trackerDiff(WS, 'src/app.ts');
    assert.ok(!('error' in diff));
  } finally {
    cleanup();
    harness.cleanup();
  }
});

test('F02: created file has null before and the full new text as after', async () => {
  const { root, cleanup } = makeRepo();
  const harness = makeHarness(root);
  try {
    await runTurn(harness.engine, root, () => writeFile(root, 'new.txt', 'hello\nworld\n'));
    const out = await harness.engine.trackerFullFile(WS, 'new.txt');
    assert.equal(out.error, null);
    assert.equal(out.kind, 'created');
    assert.equal(out.before, null);
    assert.equal(out.after, 'hello\nworld\n');
    assert.equal(out.hunks.length, 0);
  } finally {
    cleanup();
    harness.cleanup();
  }
});

test('F03: deleted file has full before text and null after', async () => {
  const { root, cleanup } = makeRepo();
  writeFile(root, 'gone.txt', 'alpha\nbeta\n');
  gitCommit(root);
  const harness = makeHarness(root);
  try {
    await runTurn(harness.engine, root, () => fs.unlinkSync(path.join(root, 'gone.txt')));
    const out = await harness.engine.trackerFullFile(WS, 'gone.txt');
    assert.equal(out.error, null);
    assert.equal(out.kind, 'deleted');
    assert.equal(out.before, 'alpha\nbeta\n');
    assert.equal(out.after, null);
    assert.equal(out.hunks.length, 0);
  } finally {
    cleanup();
    harness.cleanup();
  }
});

test('F04: not-tracked path returns error not-tracked', async () => {
  const { root, cleanup } = makeRepo();
  const harness = makeHarness(root);
  try {
    await runTurn(harness.engine, root, () => writeFile(root, 'a.txt', 'x\n'));
    const out = await harness.engine.trackerFullFile(WS, 'other.txt');
    assert.equal(out.error, 'not-tracked');
    assert.equal(out.before, null);
    assert.equal(out.after, null);
  } finally {
    cleanup();
    harness.cleanup();
  }
});

test('F05: non-text (binary) file is refused with unsupported', async () => {
  const { root, cleanup } = makeRepo();
  writeFile(root, 'blob.bin', Buffer.from([0, 1, 2, 3, 4, 255]));
  gitCommit(root);
  const harness = makeHarness(root);
  try {
    // After-state must stay binary too (the merged record inherits the after
    // snapshot's fileKind; a text-after edit would surface missing-blob instead).
    await runTurn(harness.engine, root, () => writeFile(root, 'blob.bin', Buffer.from([9, 0, 9, 9])));
    const out = await harness.engine.trackerFullFile(WS, 'blob.bin');
    assert.equal(out.error, 'unsupported');
    assert.equal(out.before, null);
    assert.equal(out.after, null);
  } finally {
    cleanup();
    harness.cleanup();
  }
});

test('F07: created-then-deleted (net no-change) is not-tracked like trackerDiff', async () => {
  const { root, cleanup } = makeRepo();
  const harness = makeHarness(root);
  try {
    await runTurn(harness.engine, root, () => writeFile(root, 'x.txt', 'hi\n'));
    await runTurn(harness.engine, root, () => fs.unlinkSync(path.join(root, 'x.txt')));
    const out = await harness.engine.trackerFullFile(WS, 'x.txt');
    assert.equal(out.error, 'not-tracked');
    assert.equal(out.before, null);
    assert.equal(out.after, null);
    const diff = await harness.engine.trackerDiff(WS, 'x.txt');
    assert.equal('error' in diff && diff.error, 'not-tracked');
  } finally {
    cleanup();
    harness.cleanup();
  }
});

test('F06: oversized file is truncated to the first 2000 lines per side', async () => {
  const { root, cleanup } = makeRepo();
  const big = Array.from({ length: 2500 }, (_, i) => `line ${i}`).join('\n') + '\n';
  writeFile(root, 'big.txt', big);
  gitCommit(root);
  const harness = makeHarness(root);
  try {
    await runTurn(harness.engine, root, () => writeFile(root, 'big.txt', big.replace('line 0', 'LINE 0')));
    const out = await harness.engine.trackerFullFile(WS, 'big.txt');
    assert.equal(out.error, null);
    assert.equal(out.kind, 'modified');
    assert.equal(out.truncated, true);
    assert.ok(out.before!.split('\n').length <= 2000);
    assert.ok(out.after!.split('\n').length <= 2000);
    assert.ok(out.before!.startsWith('line 0\n'));
  } finally {
    cleanup();
    harness.cleanup();
  }
});

function gitCommit(root: string): void {
  git(root, ['add', '-A']);
  git(root, ['commit', '-m', 'base']);
}
