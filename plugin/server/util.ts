import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';

/**
 * POSIX-only no-follow flag for `open`. `undefined` on Windows, where the
 * equivalent protection is a realpath containment check after open.
 */
const O_NOFOLLOW: number | undefined = (fs.constants as Record<string, number | undefined>).O_NOFOLLOW;

/**
 * Open an existing file read-only, refusing to follow a symlink where the
 * platform supports it (O_NOFOLLOW). On Windows the caller must still verify
 * containment via realpath after open.
 */
export function openReadNoFollow(file: string): number {
  let flags = fs.constants.O_RDONLY;
  if (O_NOFOLLOW !== undefined) flags |= O_NOFOLLOW;
  return fs.openSync(file, flags);
}

/**
 * Open for exclusive write (create-new). O_EXCL fails if the path exists, and
 * O_NOFOLLOW (POSIX) refuses a symlink at the path; combined with an
 * unpredictable name this defeats symlink pre-placement attacks on staging
 * files. On Windows the exclusive create is the primary defense.
 */
export function openExclusiveNoFollow(file: string, mode = 0o600): number {
  let flags = fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY;
  if (O_NOFOLLOW !== undefined) flags |= O_NOFOLLOW;
  return fs.openSync(file, flags, mode);
}

export const digest = (bytes: Buffer | string): string =>
  createHash('sha256').update(bytes).digest('hex');

export const newId = (prefix: string): string => `${prefix}-${randomUUID()}`;

export const nowIso = (): string => new Date().toISOString();

export const isBuffer = (value: unknown): value is Buffer => Buffer.isBuffer(value);

/**
 * True when the byte sequence plausibly contains binary content. Conservative:
 * a NUL byte within the first 8192 bytes marks the file binary.
 */
export function looksBinary(bytes: Buffer): boolean {
  const limit = Math.min(bytes.length, 8192);
  for (let i = 0; i < limit; i += 1) {
    if (bytes[i] === 0) return true;
  }
  return false;
}

/** Normalize any path to forward slashes for stable storage keys. */
export const toPosix = (p: string): string => p.replaceAll('\\', '/');

/** Collapse and normalize a path for journal keys without resolving symlinks. */
export const normalizeKey = (p: string): string => toPosix(p).replace(/\/+/g, '/').replace(/\/$/, '');

/** Format bytes for display. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
}

/** Redact anything that looks like a secret from a free-form string. */
export function redact(value: string): string {
  return value
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[redacted]')
    .replace(/(sk-[A-Za-z0-9]{8,})/g, '[redacted]')
    .replace(/(ghp_[A-Za-z0-9]{8,})/g, '[redacted]')
    .replace(/(-----BEGIN [A-Z ]+-----)[\s\S]*?(-----END [A-Z ]+-----)/g, '$1[redacted]$2');
}

/** Deterministic 64-bit-ish hash of a string, used for stable ordering keys. */
export function stableKey(...parts: string[]): string {
  return digest(parts.join('\u0000')).slice(0, 16);
}
