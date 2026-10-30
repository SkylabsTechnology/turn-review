import fs from 'node:fs';
import path from 'node:path';
import { BlobStore } from './storage';
import {
  repoIdentity,
  runGit,
} from './git-adapter';
import { isSensitivePath, isNestedGitBoundary, realPath } from './path-safety';
import { digest, looksBinary, toPosix, nowIso, openReadNoFollow } from './util';
import type { FileKind, FileSupport } from '../shared/types';

/** True when `file` (absolute) resolves to a path strictly inside `rootReal`. */
function isWithinRoot(rootReal: string, file: string): boolean {
  try {
    const real = realPath(file);
    const foldedReal = real.toLowerCase();
    const foldedRoot = rootReal.toLowerCase();
    return foldedReal === foldedRoot || foldedReal.startsWith(foldedRoot + path.sep);
  } catch {
    return false;
  }
}

export interface CapturePolicy {
  maxFileBytes: number;
  denyPaths: string[];
  maxFiles: number;
}

export interface SnapshotFile {
  relativePath: string;
  hash: string | null; // sha-256 of raw bytes; null when not stored
  size: number | null;
  kind: FileKind;
  support: FileSupport;
  tracked: boolean;
  ignored: boolean;
  preTurnDirty: boolean;
  existsOnDisk: boolean;
  /** mtimeMs observed at capture; used to detect writes during the scan. */
  mtimeMs?: number;
  /** Permission bits (stat.mode) observed at capture; preserved on restore. */
  mode?: number | null;
}

export interface Snapshot {
  root: string;
  capturedAt: string;
  headOid: string | null;
  branch: string | null;
  files: Map<string, SnapshotFile>;
  /** Paths downgraded to keep-only because they changed during the scan. */
  unstablePaths: string[];
}

export interface CaptureResult {
  ok: boolean;
  error: string | null;
  snapshot: Snapshot | null;
}

/**
 * Read at most `limit` bytes of a file without following symlinks. Opens with
 * O_NOFOLLOW where available (a symlink at the path fails the open), verifies
 * the opened handle is a regular file, and on platforms without O_NOFOLLOW
 * (Windows) confirms the resolved path stays inside the authorized root —
 * closing the snapshot symlink race between classification and read (F4).
 */
function readBounded(rootReal: string, file: string, limit: number): { bytes: Buffer; tooLarge: boolean } | null {
  let fd: number;
  try {
    fd = openReadNoFollow(file);
  } catch {
    return null;
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return null; // symlink/dir/socket: never read
    // Containment check on every platform: O_NOFOLLOW (POSIX) only protects the
    // FINAL component, so an intermediate directory swapped for a symlink could
    // otherwise resolve outside the authorized root. realpath reflects the
    // current resolution and catches a planted symlink/junction redirect (F4).
    if (!isWithinRoot(rootReal, file)) return null;
    const size = st.size;
    const length = Math.min(size, limit + 1);
    const buf = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const n = fs.readSync(fd, buf, offset, length - offset, offset);
      if (n <= 0) break;
      offset += n;
    }
    const bytes = buf.subarray(0, offset);
    return { bytes, tooLarge: size > limit };
  } finally {
    fs.closeSync(fd);
  }
}

function classify(relativePath: string, bytes: Buffer | null, isSymlink: boolean, exists: boolean, tooLarge: boolean): { kind: FileKind; support: FileSupport } {
  if (!exists) return { kind: 'other', support: 'unsupported' };
  if (isSymlink) return { kind: 'symlink', support: 'unsupported' };
  if (tooLarge) return { kind: looksBinary(bytes ?? Buffer.alloc(0)) ? 'binary' : 'text', support: 'keep-only' };
  if (bytes === null) return { kind: 'other', support: 'unsupported' };
  if (looksBinary(bytes)) return { kind: 'binary', support: 'keep-only' };
  return { kind: 'text', support: 'undo-exact' };
}

/**
 * Re-verify a just-captured before-snapshot for stability. Any file classified
 * `undo-exact` that was modified WHILE the capture scan was running (size or
 * mtime changed and the bytes differ) cannot be trusted as the true pre-turn
 * state, so it is downgraded to `keep-only` (hash dropped) and can never be
 * rolled back. The stale blob is NOT deleted here: the blob store is
 * content-addressed, so another stable file may reference the same hash;
 * GC's orphan sweep removes blobs no remaining review/op/active capture
 * references. Cost: one cheap `stat` per captured file; only files whose stat
 * changed are re-read. Returns the relative paths that were downgraded
 * (evidence the agent may already have been writing during capture).
 */
export async function verifyBaselineStability(root: string, blobs: BlobStore, snapshot: Snapshot, maxFileBytes: number): Promise<string[]> {
  const unstable: string[] = [];
  for (const file of snapshot.files.values()) {
    if (file.support !== 'undo-exact' || !file.hash) continue;
    const abs = path.join(root, ...file.relativePath.split('/'));
    let stat: fs.Stats | null = null;
    try {
      stat = fs.lstatSync(abs);
    } catch {
      stat = null;
    }
    if (!stat) {
      // Disappeared during capture: the baseline is unreliable.
      file.support = 'keep-only';
      file.hash = null;
      unstable.push(file.relativePath);
      continue;
    }
    if (stat.size === file.size && stat.mtimeMs === file.mtimeMs) continue; // stable
    const read = readBounded(root, abs, maxFileBytes);
    const stable = read !== null && !read.tooLarge && digest(read.bytes) === file.hash;
    if (!stable) {
      file.support = 'keep-only';
      file.hash = null;
      unstable.push(file.relativePath);
    }
  }
  return unstable;
}

/**
 * Capture the full eligible work-tree state as raw bytes. Read-only: never
 * touches the real git index, staging area, refs, or HEAD. Files are listed by
 * git (tracked + untracked non-ignored), so ignore semantics are git's own.
 */
export async function captureWorktree(root: string, blobs: BlobStore, policy: CapturePolicy): Promise<CaptureResult> {
  let canonicalRoot: string;
  try {
    canonicalRoot = realPath(root);
  } catch {
    return { ok: false, error: 'root-not-resolvable', snapshot: null };
  }
  const identity = await repoIdentity(canonicalRoot);
  if (identity.isBare) return { ok: false, error: 'bare-repository', snapshot: null };

  const list = await runGit(['ls-files', '-z', '--cached', '--others', '--exclude-standard'], canonicalRoot, 20000, 64 * 1024 * 1024);
  if (list.code !== 0) return { ok: false, error: 'ls-files-failed', snapshot: null };
  const paths = list.stdout.split('\0').filter(Boolean);

  const dirtyRes = await runGit(['status', '--porcelain=v1', '-z'], canonicalRoot, 20000, 64 * 1024 * 1024);
  const dirtyPaths = new Set<string>();
  if (dirtyRes.code === 0) {
    // With -z each NUL-separated record is "XY path" (no quoting). Renames
    // emit two records (new then old). The path starts at offset 3.
    const parts = dirtyRes.stdout.split('\0').filter(Boolean);
    for (const entry of parts) {
      const p = entry.slice(3);
      if (p) dirtyPaths.add(toPosix(p));
    }
  }

  // Batch tracked/HEAD membership into two calls instead of spawning a git
  // subprocess per file (which caused lifecycle-hook timeouts on large repos).
  const [indexRes, headRes] = await Promise.all([
    runGit(['ls-files', '-z', '--cached'], canonicalRoot, 20000, 64 * 1024 * 1024),
    runGit(['ls-tree', '-r', '-z', '--name-only', 'HEAD'], canonicalRoot, 20000, 64 * 1024 * 1024),
  ]);
  const trackedSet = new Set<string>(indexRes.code === 0 ? indexRes.stdout.split('\0').filter(Boolean) : []);
  const headSet = new Set<string>(headRes.code === 0 ? headRes.stdout.split('\0').filter(Boolean) : []);

  const files = new Map<string, SnapshotFile>();
  let tooMany = false;

  for (const raw of paths) {
    const relativePath = toPosix(raw);
    if (files.size >= policy.maxFiles) {
      tooMany = true;
      break;
    }
    if (isSensitivePath(relativePath, policy.denyPaths)) {
      files.set(relativePath, {
        relativePath, hash: null, size: null, kind: 'other', support: 'excluded',
        tracked: false, ignored: true, preTurnDirty: false, existsOnDisk: false, mode: null,
      });
      continue;
    }
    const abs = path.join(canonicalRoot, ...relativePath.split('/'));
    let stat: fs.Stats | null = null;
    try {
      stat = fs.lstatSync(abs);
    } catch {
      stat = null;
    }
    const existsOnDisk = stat !== null;
    const isSymlink = stat?.isSymbolicLink() ?? false;
    const isDir = stat?.isDirectory() ?? false;
    if (isDir) {
      // Submodule / gitlink (mode 160000) or a directory entry: read-only.
      files.set(relativePath, {
        relativePath, hash: null, size: null, kind: 'submodule', support: 'unsupported',
        tracked: true, ignored: false, preTurnDirty: false, existsOnDisk: true, mode: stat?.mode ?? null,
      });
      continue;
    }
    const tracked = trackedSet.has(relativePath);
    const inHead = headSet.has(relativePath);
    const dirty = dirtyPaths.has(relativePath);
    const preTurnDirty = tracked ? dirty || !inHead : !inHead; // untracked always counts dirty vs HEAD

    if (isNestedGitBoundary(canonicalRoot, relativePath)) {
      files.set(relativePath, {
        relativePath, hash: null, size: null, kind: 'submodule', support: 'unsupported',
        tracked, ignored: false, preTurnDirty, existsOnDisk, mode: stat?.mode ?? null,
      });
      continue;
    }

    if (!existsOnDisk) {
      files.set(relativePath, {
        relativePath, hash: null, size: null, kind: 'other', support: 'unsupported',
        tracked, ignored: false, preTurnDirty, existsOnDisk: false, mode: null,
      });
      continue;
    }

    if (isSymlink) {
      files.set(relativePath, {
        relativePath, hash: null, size: null, kind: 'symlink', support: 'unsupported',
        tracked, ignored: false, preTurnDirty, existsOnDisk: true, mode: stat!.mode,
      });
      continue;
    }

    // Untracked files over the cap are not stored at all (turn-diff convention).
    const overCapUntracked = !tracked && stat!.size > policy.maxFileBytes;
    if (overCapUntracked) {
      files.set(relativePath, {
        relativePath, hash: null, size: stat!.size, kind: looksBinary(Buffer.alloc(0)) ? 'binary' : 'text',
        support: 'excluded', tracked, ignored: false, preTurnDirty, existsOnDisk: true, mode: stat!.mode,
      });
      continue;
    }

    const read = readBounded(canonicalRoot, abs, policy.maxFileBytes);
    if (read === null) {
      files.set(relativePath, {
        relativePath, hash: null, size: null, kind: 'other', support: 'unsupported',
        tracked, ignored: false, preTurnDirty, existsOnDisk: true, mode: stat!.mode,
      });
      continue;
    }
    const { kind, support } = classify(relativePath, read.bytes, false, true, read.tooLarge);
    let hash: string | null = null;
    if (support === 'undo-exact') {
      hash = blobs.put(read.bytes);
    }
    files.set(relativePath, {
      relativePath, hash, size: read.tooLarge ? read.bytes.length : stat!.size, kind, support,
      tracked, ignored: false, preTurnDirty, existsOnDisk: true, mtimeMs: stat!.mtimeMs, mode: stat!.mode,
    });
  }

  // Downgrade any file that changed while we were scanning (untrusted baseline).
  const unstablePaths = await verifyBaselineStability(canonicalRoot, blobs, { root: canonicalRoot, capturedAt: nowIso(), headOid: identity.headOid, branch: identity.branch, files, unstablePaths: [] }, policy.maxFileBytes);

  return {
    ok: true,
    error: tooMany ? 'capture-limit' : null,
    snapshot: {
      root: canonicalRoot,
      capturedAt: nowIso(),
      headOid: identity.headOid,
      branch: identity.branch,
      files,
      unstablePaths,
    },
  };
}
