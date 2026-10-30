import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { ReviewEngine, type SettingsSnapshot, type EngineDeps } from '../server/review-engine';
import { openStorage, type Storage } from '../server/storage';

export const WORKSPACE_ROOT = path.resolve(import.meta.dirname, '..', '..');

let counter = 0;

export function git(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export function writeFile(root: string, rel: string, content: Buffer | string): void {
  const abs = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

export function readFile(root: string, rel: string): Buffer {
  return fs.readFileSync(path.join(root, ...rel.split('/')));
}

/** Create a fresh disposable git repo with a base commit. */
export function makeRepo(): { root: string; cleanup(): void } {
  counter += 1;
  const root = path.join(WORKSPACE_ROOT, '_scratch', 'fixtures', `repo-${Date.now()}-${process.pid}-${counter}`);
  fs.mkdirSync(root, { recursive: true });
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.email', 'test@example.com']);
  git(root, ['config', 'user.name', 'Test']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  git(root, ['config', 'core.autocrlf', 'false']);
  // .gitignore with a secret-style entry.
  writeFile(root, '.gitignore', '.env\nsecret.txt\n*.log\n');
  git(root, ['add', '.gitignore']);
  git(root, ['commit', '-m', 'base']);
  const cleanup = () => {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch { /* ignore */ }
  };
  return { root, cleanup };
}

export function fixtureSettings(fixtureRoots: string[], overrides: Partial<SettingsSnapshot> = {}): SettingsSnapshot {
  return {
    undoMode: 'fixture',
    fixtureRoots,
    maxFileBytes: 1024 * 1024,
    retentionDays: 30,
    denyPaths: [],
    ...overrides,
  };
}

export interface Harness {
  engine: ReviewEngine;
  storage: Storage;
  root: string;
  cleanup(): void;
  settings: SettingsSnapshot;
}

export function makeHarness(fixtureRoot?: string, settings: SettingsSnapshot = fixtureSettings(fixtureRoot ? [fixtureRoot] : []), storage?: Storage, deps: Pick<EngineDeps, 'onDenyApplied'> = {}): Harness {
  const storageRoot = storage ? storage.root : path.join(os.tmpdir(), `turn-review-store-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const shared = storage ?? openStorage(storageRoot);
  const engine = new ReviewEngine({
    storage: shared,
    getSettings: async () => settings,
    isAgentRunning: async () => false,
    findIdleAgent: async () => 'fixture-agent',
    onDenyApplied: deps.onDenyApplied,
    // F1: the harness authorizes the simulated fixture writer explicitly.
    allowFixtureRun: true,
  });
  engine.load();
  return {
    engine,
    storage: shared,
    root: fixtureRoot ?? '',
    settings,
    cleanup: () => {
      if (storage) return; // caller owns the shared storage
      try {
        fs.rmSync(storageRoot, { recursive: true, force: true });
      } catch { /* ignore */ }
    },
  };
}

/** Hash of a file's bytes. */
export function sha(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}
