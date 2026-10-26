import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { digest } from './util';

/**
 * Minimal, read-only git adapter. Git is always invoked with a fixed argv and
 * a fixed cwd; no shell string is ever built from repository content, so
 * malicious filenames or branch names cannot reach a shell (C30).
 */

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
  /** true when the binary itself was not found. */
  enoent: boolean;
}

const GIT_ENV = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_ASKPASS: 'echo',
  GCM_INTERACTIVE: 'Never',
};

export function runGit(args: string[], cwd: string, timeout = 8000, maxBuffer = 4 * 1024 * 1024): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      {
        cwd,
        timeout,
        killSignal: 'SIGKILL',
        maxBuffer,
        windowsHide: true,
        env: { ...process.env, ...GIT_ENV },
      },
      (error, stdout, stderr) => {
        const failed = error as NodeJS.ErrnoException & { code?: unknown; killed?: boolean } | null;
        if (!failed) {
          resolve({ code: 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), enoent: false });
          return;
        }
        const enoent = (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
        const code = typeof failed.code === 'number' ? failed.code : failed.killed ? -1 : -1;
        resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), enoent });
      },
    );
  });
}

export interface RepoIdentity {
  root: string;
  branch: string | null;
  headOid: string | null;
  isBare: boolean;
}

export async function repoIdentity(root: string): Promise<RepoIdentity> {
  const [branch, head, bare] = await Promise.all([
    runGit(['rev-parse', '--abbrev-ref', 'HEAD'], root),
    runGit(['rev-parse', 'HEAD'], root),
    runGit(['rev-parse', '--is-inside-work-tree'], root),
  ]);
  return {
    root,
    branch: branch.code === 0 ? branch.stdout.trim() || null : null,
    headOid: head.code === 0 ? head.stdout.trim() || null : null,
    isBare: bare.code !== 0 || bare.stdout.trim() !== 'true',
  };
}

/**
 * Work-tree status of one relative path (porcelain v1, first two letters).
 * Empty string means clean vs HEAD. `??` means untracked.
 */
export async function worktreeStatus(root: string, relPath: string): Promise<string> {
  const res = await runGit(['status', '--porcelain=v1', '-z', '--', relPath], root, 8000, 4 * 1024 * 1024);
  if (res.code !== 0) return '';
  const out = res.stdout;
  if (out.length < 3) return '';
  // porcelain -z format: "XY PATH\0"
  return out.slice(0, 2);
}

/** Whether the path is tracked in the index. */
export async function isTracked(root: string, relPath: string): Promise<boolean> {
  const res = await runGit(['ls-files', '-z', '--error-unmatch', '--', relPath], root, 8000);
  return res.code === 0;
}

/** Whether the path exists in HEAD. */
export async function isInHead(root: string, relPath: string): Promise<boolean> {
  const res = await runGit(['cat-file', '-e', `HEAD:${relPath}`], root, 8000);
  return res.code === 0;
}

/** Whether the path is ignored by git ignore rules. */
export async function isIgnored(root: string, relPath: string): Promise<boolean> {
  const res = await runGit(['check-ignore', '-q', '--', relPath], root, 8000);
  return res.code === 0;
}

/** Blob oid of the path in HEAD, or null. */
export async function headBlobOid(root: string, relPath: string): Promise<string | null> {
  const res = await runGit(['rev-parse', `HEAD:${relPath}`], root, 8000);
  if (res.code !== 0) return null;
  const oid = res.stdout.trim();
  return oid || null;
}

/**
 * Hash of the real `.git/index` file (raw bytes). Used by tests to prove that
 * no review operation ever touches the staging area.
 */
export function indexHash(root: string): string | null {
  const indexPath = path.join(root, '.git', 'index');
  try {
    return digest(fs.readFileSync(indexPath));
  } catch {
    return null;
  }
}

/** Read-only check that the work-tree root is a valid repo at call time. */
export async function isRepo(root: string): Promise<boolean> {
  const res = await runGit(['rev-parse', '--is-inside-work-tree'], root, 8000);
  return res.code === 0 && res.stdout.trim() === 'true';
}
