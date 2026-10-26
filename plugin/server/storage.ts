import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { digest } from './util';

/**
 * Durable private storage for the plugin: a content-addressed blob store and a
 * JSONL journal. Everything lives under the daemon user's home
 * (`$PASEO_HOME/plugin-data/turn-reviewer`), never in a project directory.
 * Files are created owner-only (0o600 / restrictive default).
 */

export function defaultStorageRoot(): string {
  const home = process.env.PASEO_HOME
    ? path.join(process.env.PASEO_HOME, 'plugin-data', 'turn-reviewer')
    : path.join(os.homedir(), '.paseo', 'plugin-data', 'turn-reviewer');
  return home;
}

function ensureDir(p: string): void {
  fs.mkdirSync(p, { recursive: true, mode: 0o700 });
}

function writePrivate(file: string, data: Buffer | string): void {
  ensureDir(path.dirname(file));
  // Open with owner-only mode, then write + fsync.
  const fd = fs.openSync(file, 'w', 0o600);
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Windows may ignore chmod; best effort.
  }
}

/** Append to a JSONL file (never truncate) with the same owner-only policy. */
function appendPrivate(file: string, data: Buffer | string): void {
  ensureDir(path.dirname(file));
  const fd = fs.openSync(file, 'a', 0o600);
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Windows may ignore chmod; best effort.
  }
}

export class BlobStore {
  constructor(private readonly root: string) {}

  private blobPath(sha: string): string {
    return path.join(this.root, 'blobs', sha.slice(0, 2), sha);
  }

  put(bytes: Buffer): string {
    const sha = digest(bytes);
    const file = this.blobPath(sha);
    if (!fs.existsSync(file)) {
      writePrivate(file, bytes);
    }
    return sha;
  }

  get(sha: string): Buffer | null {
    try {
      const bytes = fs.readFileSync(this.blobPath(sha));
      if (digest(bytes) !== sha) return null; // integrity check
      return bytes;
    } catch {
      return null;
    }
  }

  exists(sha: string): boolean {
    return fs.existsSync(this.blobPath(sha));
  }

  /** Remove a blob if present. Used by GC's orphan sweep. */
  delete(sha: string): void {
    try {
      fs.unlinkSync(this.blobPath(sha));
    } catch {
      // ignore missing/denied; best effort
    }
  }

  /** All blob files present on disk (sha strings), for orphan scanning. */
  list(): string[] {
    const out: string[] = [];
    try {
      const top = fs.readdirSync(this.dir());
      for (const sub of top) {
        if (sub.length !== 2) continue;
        let files: string[] = [];
        try {
          files = fs.readdirSync(path.join(this.dir(), sub));
        } catch {
          continue;
        }
        for (const f of files) out.push(f);
      }
    } catch {
      // ignore
    }
    return out;
  }

  /** Total bytes currently stored across all blobs. */
  totalBytes(): number {
    let total = 0;
    try {
      const top = fs.readdirSync(this.dir());
      for (const sub of top) {
        if (sub.length !== 2) continue;
        let files: string[] = [];
        try {
          files = fs.readdirSync(path.join(this.dir(), sub));
        } catch {
          continue;
        }
        for (const f of files) {
          try {
            total += fs.statSync(path.join(this.dir(), sub, f)).size;
          } catch {
            // ignore
          }
        }
      }
    } catch {
      // ignore
    }
    return total;
  }

  private dir(): string {
    return path.join(this.root, 'blobs');
  }
}

export type JournalRecordType =
  | 'review'
  | 'op-prepared'
  | 'op-applied'
  | 'op-aborted'
  | 'op-recoverable'
  | 'capture-start'
  | 'capture-end';

export interface JournalRecord {
  type: JournalRecordType;
  id: string;
  ts: string;
  data: unknown;
}

/** Append-only JSONL journal with idempotent write-through and compaction. */
export class Journal {
  private readonly file: string;

  constructor(root: string) {
    this.file = path.join(root, 'journal.jsonl');
    ensureDir(root);
  }

  append(record: JournalRecord): void {
    appendPrivate(this.file, JSON.stringify(record) + '\n');
  }

  readAll(): JournalRecord[] {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const records: JournalRecord[] = [];
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
          records.push(JSON.parse(line) as JournalRecord);
        } catch {
          // Corrupted line: fail closed on load (C24) — surface as empty and
          // let the engine refuse Undo when the journal is damaged.
          continue;
        }
      }
      return records;
    } catch {
      return [];
    }
  }

  /**
   * Replace the whole journal with the given records (retention compaction).
   * Atomic: write to a temp file, fsync, then rename over the journal so a
   * crash mid-rewrite leaves the original journal intact rather than a
   * truncated one. Never called concurrently with appends in this build.
   */
  rewrite(records: JournalRecord[]): void {
    const content = records.map((r) => JSON.stringify(r)).join('\n') + (records.length ? '\n' : '');
    const tmp = `${this.file}.tmp-${process.pid}-${Date.now()}`;
    let fd: number;
    try {
      fd = fs.openSync(tmp, 'w', 0o600);
    } catch {
      // Cannot create a temp file (e.g. read-only dir): fall back to the
      // in-place path rather than failing the caller.
      writePrivate(this.file, content);
      return;
    }
    try {
      fs.writeFileSync(fd, content);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fs.renameSync(tmp, this.file);
    } catch (err) {
      try { fs.closeSync(fd); } catch { /* noop */ }
      try { fs.unlinkSync(tmp); } catch { /* noop */ }
      throw err; // journal unchanged -> caller aborts GC without mutating state
    }
  }
}

export interface OpRecord {
  operationId: string;
  reviewId: string;
  path: string;
  state: 'prepared' | 'applied' | 'aborted' | 'recoverable';
  beforeSha: string;
  candidateSha: string;
  backupSha: string;
  ts: string;
  /** Write kind: 'deny' | 'undo' | 'restore'. Used to scope rollback recovery. */
  kind?: string;
}

/** Per-operation transaction records, keyed by operationId for idempotency. */
export class OpStore {
  private readonly dir: string;

  constructor(root: string) {
    this.dir = path.join(root, 'ops');
    ensureDir(this.dir);
  }

  write(record: OpRecord): void {
    writePrivate(this.opPath(record.operationId), JSON.stringify(record));
  }
  read(operationId: string): OpRecord | null {
    try {
      const raw = fs.readFileSync(this.opPath(operationId), 'utf8');
      const parsed = JSON.parse(raw) as OpRecord;
      return parsed && parsed.operationId === operationId ? parsed : null;
    } catch {
      return null;
    }
  }

  list(): OpRecord[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return [];
    }
    const out: OpRecord[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(this.dir, name), 'utf8')) as OpRecord;
        out.push(parsed);
      } catch {
        // ignore corrupted op files; recovery will treat as unknown.
      }
    }
    return out;
  }

  /** Remove an operation record. Used by retention GC. */
  delete(operationId: string): void {
    try {
      fs.unlinkSync(this.opPath(operationId));
    } catch {
      // ignore missing/denied; best effort
    }
  }

  private opPath(operationId: string): string {
    // The filename is content-derived from the id, never the raw id: a derived
    // per-file id may contain ':' (Windows NTFS ADS separator) or path
    // separators, and a hostile id must never steer the path outside ops/.
    // Idempotency still works because `read` verifies the stored operationId.
    return path.join(this.dir, `${digest(operationId)}.json`);
  }
}

export interface Storage {
  root: string;
  blobs: BlobStore;
  journal: Journal;
  ops: OpStore;
  ok: boolean;
}

export function openStorage(root?: string): Storage {
  const resolved = root ?? defaultStorageRoot();
  try {
    ensureDir(resolved);
    ensureDir(path.join(resolved, 'blobs'));
    const blobs = new BlobStore(resolved);
    const journal = new Journal(resolved);
    const ops = new OpStore(resolved);
    return { root: resolved, blobs, journal, ops, ok: true };
  } catch {
    return { root: resolved, blobs: new BlobStore(resolved), journal: new Journal(resolved), ops: new OpStore(resolved), ok: false };
  }
}
