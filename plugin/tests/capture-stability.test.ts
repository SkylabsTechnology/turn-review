import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openStorage } from '../server/storage';
import { verifyBaselineStability, type Snapshot } from '../server/capture';
import { sha } from './helpers';

/** Deterministic snapshot in a real temp dir. */
function makeSnapshot(root: string): Snapshot {
  return {
    root,
    capturedAt: new Date().toISOString(),
    headOid: null,
    branch: null,
    files: new Map(),
    unstablePaths: [],
  };
}

function undoExactFile(rel: string, bytes: Buffer, mtimeMs: number) {
  return {
    relativePath: rel,
    hash: sha(bytes),
    size: bytes.length,
    kind: 'text' as const,
    support: 'undo-exact' as const,
    tracked: true,
    ignored: false,
    preTurnDirty: false,
    existsOnDisk: true,
    mtimeMs,
  };
}

test('B1: a file that changed while the before-capture scan ran is downgraded to keep-only (blob cleanup deferred to GC)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-stability-'));
  const storage = openStorage(path.join(root, 'store'));
  try {
    // Stable file: written once, snapshot matches disk.
    const aAbs = path.join(root, 'a.txt');
    fs.writeFileSync(aAbs, 'AAA\n');
    const aMtime = fs.lstatSync(aAbs).mtimeMs;
    const blobA = sha(Buffer.from('AAA\n'));
    storage.blobs.put(Buffer.from('AAA\n'));

    // Unstable file: the snapshot captured the OLD bytes, then the file was
    // rewritten before verification (the write that raced the scan).
    const bAbs = path.join(root, 'b.txt');
    fs.writeFileSync(bAbs, 'BBB\n');
    const bMtime = fs.lstatSync(bAbs).mtimeMs;
    const blobB = sha(Buffer.from('BBB\n'));
    storage.blobs.put(Buffer.from('BBB\n'));

    const snap = makeSnapshot(root);
    snap.files.set('a.txt', undoExactFile('a.txt', Buffer.from('AAA\n'), aMtime));
    snap.files.set('b.txt', undoExactFile('b.txt', Buffer.from('BBB\n'), bMtime));
    // The racing write lands after the snapshot was built.
    fs.writeFileSync(bAbs, 'BBB-CHANGED\n');

    const unstable = await verifyBaselineStability(root, storage.blobs, snap, 1024 * 1024);
    assert.deepEqual(unstable, ['b.txt'], 'only the racing file is reported unstable');

    // a.txt: unchanged -> still undo-exact, blob kept.
    const a = snap.files.get('a.txt')!;
    assert.equal(a.support, 'undo-exact');
    assert.equal(a.hash, blobA);
    assert.ok(storage.blobs.get(blobA));

    // b.txt: changed during scan -> downgraded, never rollback-able. The blob
    // is NOT deleted here (GC sweeps orphans; another file may share the hash).
    const b = snap.files.get('b.txt')!;
    assert.equal(b.support, 'keep-only');
    assert.equal(b.hash, null);
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test('B2: a file that disappears during the scan is downgraded (blob cleanup deferred to GC)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-stability-'));
  const storage = openStorage(path.join(root, 'store'));
  try {
    const aAbs = path.join(root, 'a.txt');
    fs.writeFileSync(aAbs, 'AAA\n');
    const aMtime = fs.lstatSync(aAbs).mtimeMs;
    const blobA = sha(Buffer.from('AAA\n'));
    storage.blobs.put(Buffer.from('AAA\n'));

    const snap = makeSnapshot(root);
    snap.files.set('a.txt', undoExactFile('a.txt', Buffer.from('AAA\n'), aMtime));
    fs.unlinkSync(aAbs); // vanished between capture and verify

    const unstable = await verifyBaselineStability(root, storage.blobs, snap, 1024 * 1024);
    assert.deepEqual(unstable, ['a.txt']);
    const a = snap.files.get('a.txt')!;
    assert.equal(a.support, 'keep-only');
    assert.equal(a.hash, null);
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test('B4: an unstable file never deletes a blob still shared by a stable file (content-addressed)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-stability-'));
  const storage = openStorage(path.join(root, 'store'));
  try {
    // a.txt and b.txt are byte-identical (same content hash -> one blob).
    const aAbs = path.join(root, 'a.txt');
    const bAbs = path.join(root, 'b.txt');
    fs.writeFileSync(aAbs, 'SAME\n');
    fs.writeFileSync(bAbs, 'SAME\n');
    const sharedHash = sha(Buffer.from('SAME\n'));
    const aMtime = fs.lstatSync(aAbs).mtimeMs;
    const bMtime = fs.lstatSync(bAbs).mtimeMs;
    storage.blobs.put(Buffer.from('SAME\n'));

    const snap = makeSnapshot(root);
    snap.files.set('a.txt', undoExactFile('a.txt', Buffer.from('SAME\n'), aMtime));
    snap.files.set('b.txt', undoExactFile('b.txt', Buffer.from('SAME\n'), bMtime));
    // b.txt changes mid-scan; a.txt stays stable.
    fs.writeFileSync(bAbs, 'DIFFERENT\n');

    const unstable = await verifyBaselineStability(root, storage.blobs, snap, 1024 * 1024);
    assert.deepEqual(unstable, ['b.txt']);
    assert.equal(snap.files.get('b.txt')!.support, 'keep-only');
    assert.equal(snap.files.get('b.txt')!.hash, null);
    // The shared blob survives: a.txt still has an exact baseline.
    assert.equal(snap.files.get('a.txt')!.support, 'undo-exact');
    assert.equal(snap.files.get('a.txt')!.hash, sharedHash);
    assert.ok(storage.blobs.get(sharedHash), 'shared blob kept for the stable file');
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test('B3: an untouched, stable file is not re-read (its mtime/size match)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-stability-'));
  const storage = openStorage(path.join(root, 'store'));
  try {
    const aAbs = path.join(root, 'a.txt');
    fs.writeFileSync(aAbs, 'AAA\n');
    const aMtime = fs.lstatSync(aAbs).mtimeMs;
    const blobA = sha(Buffer.from('AAA\n'));
    storage.blobs.put(Buffer.from('AAA\n'));

    const snap = makeSnapshot(root);
    snap.files.set('a.txt', undoExactFile('a.txt', Buffer.from('AAA\n'), aMtime));

    await verifyBaselineStability(root, storage.blobs, snap, 1024 * 1024);
    assert.equal(snap.files.get('a.txt')!.support, 'undo-exact');
    assert.equal(snap.files.get('a.txt')!.hash, blobA);
    assert.ok(storage.blobs.get(blobA));
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});
