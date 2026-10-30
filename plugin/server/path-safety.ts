import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { toPosix } from './util';

/**
 * Path safety: canonical repo identity, symlink/junction defense and Windows
 * case handling. Every write path in the engine passes through these checks;
 * a refusal here stops the operation before any filesystem mutation.
 */

export const isWindows = process.platform === 'win32';

/** Canonical (symlink-resolved, absolute) form of a path. */
export function realPath(p: string): string {
  return fs.realpathSync.native(path.resolve(p));
}

export function caseFold(p: string): string {
  return isWindows ? p.toLowerCase() : p;
}

/**
 * Return the canonical git work-tree root for `cwd`, or null when it is not
 * inside a git work tree (bare repos and non-git directories return null).
 */
export function repoRootFor(cwd: string): string | null {
  try {
    // We never touch the real index: --show-toplevel is read-only.
    const out = execFileSync(
      'git',
      ['rev-parse', '--show-toplevel'],
      { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 8000 },
    );
    const root = out.trim();
    if (!root) return null;
    return realPath(root);
  } catch {
    return null;
  }
}

export interface PathClassification {
  ok: boolean;
  /** Null when not inside root. */
  relativePath: string | null;
  reason: string | null;
}

/**
 * Validate that `candidate` (absolute or relative to `cwd`) is a real,
 * non-symlinked path strictly inside `rootReal` and that no component of the
 * relative portion is a symlink/junction pointing outside the root.
 * Returns the safe relative (posix) path on success.
 */
export function safeRelativePath(rootReal: string, cwd: string, candidate: string): PathClassification {
  const root = caseFold(realPath(rootReal));
  const abs = path.resolve(cwd, candidate);
  // Split into the longest existing ancestor and the remaining (possibly
  // absent) suffix so Undo of a deleted file can still be validated.
  let prefix = abs;
  const suffix: string[] = [];
  for (;;) {
    try {
      fs.statSync(prefix);
      break;
    } catch {
      const base = path.basename(prefix);
      const parent = path.dirname(prefix);
      if (base === '' || parent === prefix) break;
      suffix.unshift(base);
      prefix = parent;
    }
  }
  let realPrefix: string;
  try {
    realPrefix = realPath(prefix);
  } catch {
    return { ok: false, relativePath: null, reason: 'path-not-resolvable' };
  }
  const folded = caseFold(realPrefix);
  if (folded !== root && !folded.startsWith(root + path.sep) && !folded.startsWith(root + '/')) {
    return { ok: false, relativePath: null, reason: 'outside-root' };
  }
  // Suffix segments must not traverse or hit a git boundary. `.git` is
  // handled on the final relative path below (it may also be an existing
  // prefix, e.g. `<root>/.git/config`).
  if (suffix.some((s) => s === '..' || s === '.')) {
    return { ok: false, relativePath: null, reason: 'traversal' };
  }
  const finalReal = path.join(realPrefix, ...suffix);
  const rel = toPosix(path.relative(rootReal, finalReal));
  if (rel === '' || rel.split('/').some((s) => s === '..')) {
    return { ok: false, relativePath: null, reason: 'outside-root' };
  }
  // Git metadata (`.git` at any depth — an existing `.git` directory, the
  // worktree gitdir pointer file, or a nested `.git` file) must never be a
  // read/write target, even though it resolves inside the root (F2 security).
  if (rel.split('/').includes('.git')) {
    return { ok: false, relativePath: null, reason: 'git-boundary' };
  }
  // Walk existing ancestors from the root and refuse if any is a symlink or
  // junction redirecting outside the root.
  let walk = rootReal;
  for (const seg of rel.split('/').slice(0, -1)) {
    walk = path.join(walk, seg);
    let resolved: string;
    try {
      resolved = realPath(walk);
    } catch {
      return { ok: false, relativePath: null, reason: 'unresolvable-component' };
    }
    if (!caseFold(resolved).startsWith(root)) {
      return { ok: false, relativePath: null, reason: 'symlink-escape' };
    }
  }
  return { ok: true, relativePath: rel, reason: null };
}

const SENSITIVE_NAMES = [
  '.env', '.env.*',
  '*.pem', '*.key', '*.pfx', '*.p12', '*.p8', '*.keystore',
  'id_rsa', 'id_rsa.*', 'id_ed25519', 'id_ed25519.*', 'id_dsa',
  '.npmrc', '.netrc', '.pypirc', '.pgpass', '.git-credentials', '.my.cnf',
  'credentials', 'credentials.*', 'client_secret', 'client_secret.*',
  'secret', 'secret.*', 'api_key', 'api_key.*', 'apikey', 'apikey.*',
  'token', '*.token', 'auth_token*',
];

/**
 * True when a path (relative to repo root) is on the sensitive denylist.
 * Matching is case-insensitive. Bare names match the exact basename; `name*`
 * is a basename prefix; `*.ext` matches any basename ending in `.ext`;
 * `dir/*` would match a directory, but secrets here are file names. The rule
 * is deliberately fail-closed: a false positive only excludes a file from the
 * review (it is never captured); a false negative would store a secret blob.
 */
export function isSensitivePath(relPath: string, extra: string[] = []): boolean {
  const base = path.posix.basename(relPath);
  const lower = base.toLowerCase();
  const segs = relPath.split('/').map((s) => s.toLowerCase());
  for (const pattern of [...SENSITIVE_NAMES, ...extra]) {
    const p = pattern.toLowerCase();
    if (p.startsWith('*.')) {
      // e.g. *.pem -> any file whose basename ends in .pem
      if (lower.endsWith(p.slice(1))) return true;
      continue;
    }
    if (p.endsWith('*')) {
      // e.g. .env.* -> basename starts with '.env.'; token* -> basename starts with 'token'
      if (lower.startsWith(p.slice(0, -1))) return true;
      continue;
    }
    if (p.endsWith('/')) {
      // e.g. .ssh/ -> any path segment equals '.ssh' (directory name)
      if (segs.includes(p.slice(0, -1))) return true;
      continue;
    }
    if (p === lower) return true;
  }
  // Secret files nested anywhere, incl. under node_modules.
  if (segs.includes('node_modules') && /\.(pem|key|p12|pfx|p8|keystore)$/i.test(relPath)) return true;
  return false;
}

/**
 * Windows case-collision guard: for a candidate relative path, ensure no other
 * existing file in the same directory differs only by case. On case-insensitive
 * filesystems two such names cannot coexist; on case-sensitive ones the caller
 * must prove identity before writing.
 */
export function hasCaseCollision(rootReal: string, relPath: string): boolean {
  const dir = path.posix.dirname(relPath);
  const name = path.posix.basename(relPath);
  let entries: string[];
  try {
    entries = fs.readdirSync(path.join(rootReal, dir));
  } catch {
    return false;
  }
  const matches = entries.filter((e) => e.toLowerCase() === name.toLowerCase());
  return matches.length > 1 || (matches.length === 1 && matches[0] !== name);
}

/** True when `dir` under `rootReal` is a nested git boundary (submodule/repo). */
export function isNestedGitBoundary(rootReal: string, dirRel: string): boolean {
  const gitPath = path.join(rootReal, dirRel, '.git');
  try {
    return fs.existsSync(gitPath);
  } catch {
    return false;
  }
}

export function isWithinFixtureRoot(rootReal: string, fixtureRoots: string[]): boolean {
  const foldedRoot = caseFold(rootReal);
  return fixtureRoots.some((f) => {
    let foldedFixture: string;
    try {
      foldedFixture = caseFold(fs.realpathSync.native(path.resolve(f)));
    } catch {
      foldedFixture = caseFold(path.resolve(f));
    }
    return foldedRoot === foldedFixture || foldedRoot.startsWith(foldedFixture + path.sep);
  });
}
