import fs from 'node:fs';
import path from 'node:path';
import type { Storage, OpRecord } from './storage';
import { captureWorktree, type CapturePolicy, type Snapshot, type SnapshotFile } from './capture';
import { computeHunks, splitLines, splitRaw, revertHunksRaw, revertHunkRaw } from './diff';
import { TURN_REVIEW_MAX_CARD_FILES, type TurnReviewCard } from '../shared/timeline';
import { trackerOpId } from '../shared/op-id';
import {
  repoIdentity,
} from './git-adapter';
import {
  repoRootFor,
  safeRelativePath,
  isWithinFixtureRoot,
  isSensitivePath,
  isWindows,
} from './path-safety';
import { digest, newId, nowIso, redact } from './util';

/** Side-by-side viewer renders at most this many lines per side. */
const FULL_FILE_MAX_LINES = 2000;
import type {
  Review,
  FileChange,
  FileSupport,
  FileKind,
  Hunk,
  CaptureState,
  OperationResult,
  PluginInfo,
  TrackerFile,
} from '../shared/types';

export interface SettingsSnapshot {
  /** 'disabled' | 'fixture' (allowlist-scoped) | 'enabled' (real projects). */
  undoMode: 'disabled' | 'fixture' | 'enabled';
  fixtureRoots: string[];
  /** When true, fixture write mode applies to every project (no allowlist). */
  allowAllProjects?: boolean;
  maxFileBytes: number;
  retentionDays: number;
  /** Per-project storage cap in bytes (0 = unlimited). */
  maxProjectBytes?: number;
  denyPaths: string[];
}

export interface GcReport {
  reviewsRemoved: number;
  opsRemoved: number;
  blobsRemoved: number;
  bytesReclaimed: number;
}

/**
 * Write root gate. `enabled` (real-project) mode authorizes every repository
 * — the mode itself is the authorization. Otherwise `allowAllProjects` widens
 * the fixture allowlist to every repo, or the root must be inside one of the
 * listed fixture roots. Write mode itself is still gated separately (never
 * `disabled`), so this never enables writes in disabled mode.
 */
function isAllowedRoot(rootReal: string, settings: SettingsSnapshot): boolean {
  if (settings.undoMode === 'enabled') return true;
  if (settings.allowAllProjects === true) return true;
  return isWithinFixtureRoot(rootReal, settings.fixtureRoots);
}

export interface EngineDeps {
  storage: Storage;
  getSettings: () => Promise<SettingsSnapshot>;
  isAgentRunning: (agentId: string) => Promise<boolean>;
  /**
   * Optional: find an idle agent for a workspace, used by the fixture-only
   * "simulate a proven turn" path so the resulting review passes the
   * writer-active gate on Deny. Returns null when no idle agent exists.
   */
  findIdleAgent?: (workspaceId: string | null) => Promise<string | null>;
  onReviewChanged?: (review: Review) => void;
  /** Optional: fired once a Deny rollback succeeds (used for a chat notice). */
  onDenyApplied?: (info: { agentId: string; workspaceId: string; path: string; operationId: string }) => void;
  now?: () => string;
}

export interface TurnStartInput {
  agentId: string;
  workspaceId: string | null;
  cwd: string;
  turnId: string | null;
  barrier: 'proven' | 'event-best-effort';
}

export interface TurnEndInput {
  occurrenceId: string;
  agentId: string;
  workspaceId: string | null;
  cwd: string;
  outcome: 'completed' | 'failed' | 'canceled' | 'unknown';
  barrier: 'proven' | 'event-best-effort';
}

interface ActiveCapture {
  occurrenceId: string;
  agentId: string;
  root: string;
  startedAt: string;
  barrier: 'proven' | 'event-best-effort';
  before: Snapshot | null;
}

const CAPTURE_VERSION = '0.12.0-capture-v1';

/** Number of files at which a capture is marked incomplete rather than huge. */
const MAX_CAPTURE_FILES = 100_000;

const LOCK_STALE_MS = 10 * 60 * 1000;
const LOCK_TIMEOUT_MS = 20_000;
const LOCK_RETRY_MS = 150;

/**
 * Operation ids are client-supplied and must not be able to steer the op-file
 * path (F2): allow only URL-safe characters, no separators or traversal.
 */
const OP_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export function isValidOperationId(id: string): boolean {
  return OP_ID_RE.test(id);
}

function refusal(reason: string, message: string, backupOperationId: string | null = null): OperationResult {
  return { status: 'refused', reason, message, backupOperationId };
}

function conflictResult(reason: string, message: string, backupOperationId: string | null = null): OperationResult {
  return { status: 'conflict', reason, message, backupOperationId };
}

function errorResult(reason: string, message: string, backupOperationId: string | null = null): OperationResult {
  return { status: 'error', reason, message, backupOperationId };
}

export class ReviewEngine {
  private reviews = new Map<string, Review>();
  private active = new Map<string, ActiveCapture>();
  private readonly storage: Storage;
  private readonly deps: EngineDeps;

  constructor(deps: EngineDeps) {
    this.deps = deps;
    this.storage = deps.storage;
  }

  private now(): string {
    return this.deps.now ? this.deps.now() : nowIso();
  }

  private async policy(): Promise<CapturePolicy> {
    // Settings resolve before the policy is returned so configured denyPaths /
    // maxFileBytes actually reach capture (previously a `.then` on the
    // returned object made them dead settings — verifier F1).
    const s = await this.deps.getSettings();
    return { maxFileBytes: s.maxFileBytes, denyPaths: s.denyPaths, maxFiles: MAX_CAPTURE_FILES };
  }

  // ------------------------------------------------------------------
  // Persistence
  // ------------------------------------------------------------------

  private persistReview(review: Review): void {
    review.updatedAt = this.now();
    this.storage.journal.append({ type: 'review', id: review.id, ts: this.now(), data: review });
    this.deps.onReviewChanged?.(review);
  }

  /** Load journal + reconcile interrupted operations. */
  load(): void {
    const records = this.storage.journal.readAll();
    for (const record of records) {
      if (record.type === 'review') {
        const review = record.data as Review;
        this.reviews.set(review.id, review);
      }
    }
    this.reconcileOps();
    this.reconcileInterruptedCaptures();
    // A capture whose end event never arrived is torn: after a reload we
    // cannot know what the agent wrote, so it must never offer Undo (C25).
    for (const review of this.reviews.values()) {
      if (!review.endedAt) {
        review.captureState = 'interrupted';
        review.status = 'unsupported';
      }
    }
  }

  /**
   * Retention + per-project cap garbage collection.
   *
   * Only fully resolved, ended reviews are ever removed. A resolved review is
   * kept when (a) a newer review in the same workspace still has a pending file
   * for a path it resolved (that pending row may rely on it as resolved
   * history), or (b) an operation record still references it (rollback
   * recovery may need the review). Pending/active captures and the working tree
   * are never touched. After pruning, orphaned blobs are swept.
   *
   * The whole computation + journal rewrite runs in one synchronous block so no
   * append can be lost between reading and rewriting the journal.
   */
  async gc(): Promise<GcReport> {
    const settings = await this.deps.getSettings();
    const retentionMs = settings.retentionDays * 86_400_000;
    const cap = settings.maxProjectBytes ?? 0;
    const cutoff = Date.now() - retentionMs;

    // ---- synchronous critical section (no awaits below) ----
    const ops = this.storage.ops.list();
    const reviews = [...this.reviews.values()];

    // Pending (unresolved) path keys: a resolved review is history for any
    // newer pending occurrence of the same path in the same workspace.
    const pendingKeys = new Set<string>();
    for (const r of reviews) {
      if (r.endedAt == null) continue;
      for (const f of r.files) if (f.status === 'pending') pendingKeys.add(this.pathKey(r, f.relativePath));
    }

    const removeSet = new Set<Review>();
    for (const r of reviews) {
      if (r.endedAt == null) continue;
      if (r.files.some((f) => f.status === 'pending')) continue; // never prune pending
      // Recovery may still need the review only while a deny op referencing it
      // is applied, has a backup, and its restore window is still open. Once
      // the window closes, recovery is refused (window-closed) and the review
      // is prunable like any other resolved review.
      const hasLiveRecovery = ops.some(
        (o) => o.reviewId === r.id && o.kind === 'deny' && o.state === 'applied' && o.backupSha !== 'absent' && !this.recoveryWindowClosed(r, o.ts),
      );
      if (hasLiveRecovery) continue;
      if (r.files.some((f) => pendingKeys.has(this.pathKey(r, f.relativePath)))) continue; // history guard
      removeSet.add(r);
    }

    // Retention: resolved reviews older than the cutoff are removed. Kept in
    // a separate set so the per-project cap can also prune recent ones.
    const doomed = new Set<Review>();
    for (const r of removeSet) {
      if (Date.parse(r.endedAt ?? '') < cutoff) doomed.add(r);
    }

    // Cap: per root, drop the oldest removable resolved reviews until under the
    // cap (accounts for every review's bytes for the root, pending included).
    if (cap > 0) {
      const byRoot = new Map<string, Review[]>();
      for (const r of removeSet) {
        const arr = byRoot.get(r.rootRealPath) ?? [];
        arr.push(r);
        byRoot.set(r.rootRealPath, arr);
      }
      for (const list of byRoot.values()) {
        list.sort((a, b) => ((a.endedAt ?? '') < (b.endedAt ?? '') ? -1 : 1));
        let bytes = 0;
        for (const r of reviews) if (r.rootRealPath === list[0]?.rootRealPath) bytes += this.reviewBytes(r);
        for (const r of list) {
          if (bytes <= cap) break;
          doomed.add(r);
          bytes -= this.reviewBytes(r);
        }
      }
    }

    const removeIds = new Set<string>();
    let bytesReclaimed = 0;
    for (const r of doomed) {
      removeIds.add(r.id);
      bytesReclaimed += this.reviewBytes(r);
    }

    // Journal rewrite (atomic) FIRST: persist the removals. If this fails the
    // whole GC is aborted — memory and the working state are left untouched so
    // a crash cannot orphan in-memory state from the on-disk journal.
    if (removeIds.size > 0) {
      const records = this.storage.journal.readAll();
      try {
        this.storage.journal.rewrite(records.filter((rec) => !(rec.type === 'review' && removeIds.has((rec.data as Review).id))));
      } catch (err) {
        console.error('[turn-review] GC journal rewrite failed; GC aborted (state unchanged)', err);
        return { reviewsRemoved: 0, opsRemoved: 0, blobsRemoved: 0, bytesReclaimed: 0 };
      }
    }

    // Only after the journal is durably rewritten do we mutate in-memory state.
    for (const id of removeIds) {
      this.reviews.delete(id);
    }

    // Ops: drop applied/aborted ops older than retention whose review is gone.
    let opsRemoved = 0;
    for (const op of ops) {
      if (op.state === 'prepared') continue; // never drop an in-flight op
      if (this.reviews.has(op.reviewId)) continue;
      if (Date.parse(op.ts) >= cutoff) continue;
      this.storage.ops.delete(op.operationId);
      opsRemoved += 1;
    }

    // Orphan blobs: anything not referenced by a remaining review, op, or active capture.
    const referenced = new Set<string>();
    for (const r of this.reviews.values()) {
      for (const f of r.files) {
        if (f.beforeHash) referenced.add(f.beforeHash);
        if (f.afterHash) referenced.add(f.afterHash);
      }
    }
    for (const op of this.storage.ops.list()) {
      if (op.beforeSha !== 'absent') referenced.add(op.beforeSha);
      if (op.candidateSha !== 'absent') referenced.add(op.candidateSha);
      if (op.backupSha !== 'absent') referenced.add(op.backupSha);
    }
    for (const a of this.active.values()) {
      if (!a.before?.files) continue;
      for (const f of a.before.files.values()) if (f.hash) referenced.add(f.hash);
    }
    let blobsRemoved = 0;
    for (const sha of this.storage.blobs.list()) {
      if (!referenced.has(sha)) {
        this.storage.blobs.delete(sha);
        blobsRemoved += 1;
      }
    }

    return { reviewsRemoved: removeIds.size, opsRemoved, blobsRemoved, bytesReclaimed };
  }

  private pathKey(r: Review, relPath: string): string {
    return `${r.workspaceId}\u0000${r.rootRealPath}\u0000${relPath}`;
  }

  /** Approximate stored bytes for a review (undo-exact before + after sizes). */
  private reviewBytes(r: Review): number {
    let total = 0;
    for (const f of r.files) {
      if (f.support !== 'undo-exact') continue;
      total += (f.beforeSize ?? 0) + (f.afterSize ?? 0);
    }
    return total;
  }

  private reconcileOps(): void {
    const ops = this.storage.ops.list();
    for (const op of ops) {
      if (op.state === 'prepared') {
        const review = this.reviews.get(op.reviewId);
        if (!review) continue;
        const file = review.files.find((f) => f.relativePath === op.path);
        if (!file) continue;
        const abs = this.resolveAbs(review.rootRealPath, op.path);
        if (!abs) continue;
        let currentSha: string | null = null;
        try {
          const bytes = fs.readFileSync(abs);
          currentSha = digest(bytes);
        } catch {
          currentSha = null; // file absent
        }
        // Absence is stored as the string 'absent' on ops; treat a missing
        // file as that sentinel so a crash after unlink (undo of a created
        // file) settles to 'applied' rather than a spurious conflict (F3).
        const current = currentSha ?? 'absent';
        if (current === op.beforeSha) {
          // Original intact: the crash happened before the replace. Do not
          // replay blindly (V.7) — mark aborted, keep backup.
          this.storage.ops.write({ ...op, state: 'aborted' });
          this.storage.journal.append({ type: 'op-aborted', id: op.operationId, ts: this.now(), data: { reviewId: op.reviewId, path: op.path } });
        } else if (current === op.candidateSha) {
          // Replace completed but the journal was not committed (V.8).
          this.storage.ops.write({ ...op, state: 'applied' });
          this.storage.journal.append({ type: 'op-applied', id: op.operationId, ts: this.now(), data: { reviewId: op.reviewId, path: op.path } });
          this.markFileResolved(review, op.path);
        } else {
          // Unexpected content: preserve backup, surface recoverable conflict.
          this.storage.ops.write({ ...op, state: 'recoverable' });
          this.storage.journal.append({ type: 'op-recoverable', id: op.operationId, ts: this.now(), data: { reviewId: op.reviewId, path: op.path } });
          this.markFileConflict(review, op.path, 'crash-recovered-unexpected');
        }
      }
    }
  }

  private reconcileInterruptedCaptures(): void {
    const records = this.storage.journal.readAll();
    const starts = new Map<string, { agentId: string; root: string; ts: string }>();
    for (const record of records) {
      if (record.type === 'capture-start') {
        const data = record.data as { occurrenceId: string; agentId: string; root: string };
        starts.set(data.occurrenceId, { agentId: data.agentId, root: data.root, ts: record.ts });
      }
    }
    for (const [occurrenceId, start] of starts) {
      if (this.reviews.has(occurrenceId)) continue;
      // A start with no review record means the plugin reloaded mid-turn (C25)
      // or the end event never arrived. Never fabricate a safe snapshot.
      const review: Review = {
        id: occurrenceId,
        agentId: start.agentId,
        workspaceId: null,
        rootRealPath: start.root,
        branchAtStart: null,
        headOidAtStart: null,
        startedAt: start.ts,
        endedAt: null,
        outcome: 'unknown',
        captureState: 'interrupted',
        ambiguous: true,
        captureBarrier: 'event-best-effort',
        status: 'unsupported',
        revision: 0,
        files: [],
        totalAdditions: 0,
        totalDeletions: 0,
        createdAt: start.ts,
        updatedAt: start.ts,
      };
      this.reviews.set(occurrenceId, review);
      this.persistReview(review);
    }
  }

  // ------------------------------------------------------------------
  // Lifecycle capture
  // ------------------------------------------------------------------

  /** Occurrence id currently active for an agent (for lifecycle correlation). */
  activeOccurrenceId(agentId: string): string | null {
    for (const [id, a] of this.active) {
      if (a.agentId === agentId) return id;
    }
    return null;
  }

  /**
   * Record a turn that ended with no usable start snapshot (C26/C37). Read-only
   * review card, never undo-able. Used when the start event was missed or the
   * correlation could not be established.
   */
  recordUncapturedEnd(input: TurnEndInput): Review {
    const occurrenceId = newId('cap');
    const endedAt = this.now();
    const review: Review = {
      id: occurrenceId,
      agentId: input.agentId,
      workspaceId: input.workspaceId,
      rootRealPath: input.cwd,
      branchAtStart: null,
      headOidAtStart: null,
      startedAt: null,
      endedAt,
      outcome: input.outcome,
      captureState: 'not-captured',
      ambiguous: true,
      captureBarrier: input.barrier,
      status: 'unsupported',
      revision: 0,
      files: [],
      totalAdditions: 0,
      totalDeletions: 0,
      createdAt: endedAt,
      updatedAt: endedAt,
    };
    this.reviews.set(occurrenceId, review);
    this.persistReview(review);
    return review;
  }

  async startTurn(input: TurnStartInput): Promise<string> {
    const root = repoRootFor(input.cwd);
    const occurrenceId = newId('cap');
    const startedAt = this.now();
    if (!root) {
      // Non-git directory: record a read-only capture marker with no undo.
      const review = this.emptyReview(occurrenceId, input, startedAt, null);
      review.captureState = 'incomplete';
      review.status = 'unsupported';
      this.reviews.set(occurrenceId, review);
      this.persistReview(review);
      return occurrenceId;
    }

    // Overlap detection: another capture already active in the same root (C13).
    const overlaps = [...this.active.values()].filter((a) => a.root === root);
    const ambiguous = overlaps.length > 0;
    for (const other of overlaps) {
      const otherReview = this.reviews.get(other.occurrenceId);
      if (otherReview && !otherReview.ambiguous) {
        otherReview.ambiguous = true;
        this.persistReview(otherReview);
      }
    }

    this.storage.journal.append({
      type: 'capture-start',
      id: occurrenceId,
      ts: startedAt,
      data: { occurrenceId, agentId: input.agentId, root },
    });

    const before = await captureWorktree(root, this.storage.blobs, await this.policy());
    const active: ActiveCapture = {
      occurrenceId,
      agentId: input.agentId,
      root,
      startedAt,
      barrier: input.barrier,
      before: before.ok ? before.snapshot : null,
    };
    this.active.set(occurrenceId, active);

    const review = this.emptyReview(occurrenceId, input, startedAt, root);
    review.ambiguous = ambiguous;
    review.captureBarrier = input.barrier;
    if (before.ok && before.snapshot) {
      review.captureState = 'complete';
      review.branchAtStart = before.snapshot.branch;
      review.headOidAtStart = before.snapshot.headOid;
      // Hardening: any file that changed while the before scan ran is evidence
      // the agent may already have been writing. Those files were downgraded to
      // keep-only (never rollback-able); the flag surfaces the reduced
      // confidence for the rest of the review.
      review.unstablePaths = before.snapshot.unstablePaths ?? [];
      review.captureStable = review.unstablePaths.length === 0;
    } else {
      review.captureState = 'failed';
      review.status = 'unsupported';
    }
    this.reviews.set(occurrenceId, review);
    this.persistReview(review);
    return occurrenceId;
  }

  private emptyReview(occurrenceId: string, input: TurnStartInput, startedAt: string, root: string | null): Review {
    return {
      id: occurrenceId,
      agentId: input.agentId,
      workspaceId: input.workspaceId,
      rootRealPath: root ?? input.cwd,
      branchAtStart: null,
      headOidAtStart: null,
      startedAt,
      endedAt: null,
      outcome: 'unknown',
      captureState: 'not-captured',
      ambiguous: false,
      captureBarrier: input.barrier,
      status: 'unsupported',
      revision: 0,
      files: [],
      totalAdditions: 0,
      totalDeletions: 0,
      createdAt: startedAt,
      updatedAt: startedAt,
    };
  }

  async endTurn(input: TurnEndInput): Promise<Review | null> {
    const active = this.active.get(input.occurrenceId);
    this.active.delete(input.occurrenceId);
    const existing = this.reviews.get(input.occurrenceId);
    if (!existing) return null;

    // Mark any capture still active on the same root as ambiguous (concurrent
    // agent finished later) — C13.
    for (const other of this.active.values()) {
      if (other.root === existing.rootRealPath) {
        const otherReview = this.reviews.get(other.occurrenceId);
        if (otherReview && !otherReview.ambiguous) {
          otherReview.ambiguous = true;
          this.persistReview(otherReview);
        }
      }
    }

    existing.outcome = input.outcome;
    existing.endedAt = this.now();
    this.storage.journal.append({
      type: 'capture-end',
      id: input.occurrenceId,
      ts: existing.endedAt,
      data: { occurrenceId: input.occurrenceId, agentId: input.agentId },
    });

    if (existing.captureState !== 'complete' || !active || !active.before) {
      // Missing/incomplete before snapshot (C26/C37): stay read-only.
      existing.captureState = existing.captureState === 'complete' ? 'incomplete' : existing.captureState;
      existing.status = 'unsupported';
      this.persistReview(existing);
      return existing;
    }

    const after = await captureWorktree(existing.rootRealPath, this.storage.blobs, await this.policy());
    if (!after.ok || !after.snapshot) {
      existing.captureState = 'incomplete';
      existing.status = 'unsupported';
      this.persistReview(existing);
      return existing;
    }
    this.buildReviewFiles(existing, active.before, after.snapshot);
    existing.status = existing.files.some((f) => f.status === 'pending') ? 'pending' : 'unsupported';
    this.persistReview(existing);
    return existing;
  }

  private buildReviewFiles(review: Review, before: Snapshot, after: Snapshot): void {
    const files = new Map<string, FileChange>();
    const paths = new Set<string>([...before.files.keys(), ...after.files.keys()]);
    let additions = 0;
    let deletions = 0;
    for (const relPath of paths) {
      const bf = before.files.get(relPath) ?? null;
      const af = after.files.get(relPath) ?? null;
      const beforeHash = bf?.hash ?? null;
      const afterHash = af?.hash ?? null;
      if (bf && af && beforeHash === afterHash && beforeHash !== null) continue; // unchanged
      if (bf && af && beforeHash === null && afterHash === null) {
        // Both un-stored (unsupported/excluded). Surface excluded paths so
        // users see they were not reviewed (transparency); skip genuinely
        // unchanged unsupported entries to reduce noise.
        if (bf.support !== 'excluded' && af.support !== 'excluded' && bf.support === af.support && bf.size === af.size) continue;
      }
      const change = this.buildFileChange(relPath, bf, af);
      files.set(relPath, change);
      if (change.fileKind === 'text' && change.support === 'undo-exact') {
        const counts = this.lineStats(change);
        additions += counts.additions;
        deletions += counts.deletions;
      }
    }
    review.files = [...files.values()];
    review.totalAdditions = additions;
    review.totalDeletions = deletions;
  }

  private buildFileChange(relPath: string, bf: SnapshotFile | null, af: SnapshotFile | null): FileChange {
    const beforeHash = bf?.hash ?? null;
    const afterHash = af?.hash ?? null;
    // Kind is decided by on-disk presence, not by whether a snapshot record
    // exists (deleted files still produce an after record with existsOnDisk=false).
    const bExists = bf?.existsOnDisk ?? false;
    const aExists = af?.existsOnDisk ?? false;
    const kind: FileChange['kind'] = !bExists ? 'created' : !aExists ? 'deleted' : 'modified';
    const bSupport = bf?.support ?? 'unsupported';
    const aSupport = af?.support ?? 'unsupported';
    let support: FileSupport;
    if (kind === 'created') {
      support = aSupport === 'undo-exact' ? 'undo-exact' : aSupport === 'excluded' ? 'excluded' : 'keep-only';
    } else if (kind === 'deleted') {
      support = bSupport === 'undo-exact' ? 'undo-exact' : bSupport === 'excluded' ? 'excluded' : 'keep-only';
    } else {
      support = beforeHash !== null && afterHash !== null && bSupport === 'undo-exact' && aSupport === 'undo-exact'
        ? 'undo-exact'
        : (bSupport === 'excluded' || aSupport === 'excluded') ? 'excluded' : 'keep-only';
    }
    const fileKind: FileKind = kind === 'deleted' ? (bf?.kind ?? 'other') : (af?.kind ?? bf?.kind ?? 'other');
    const preTurnDirty = (bf?.preTurnDirty ?? false);
    const conflictReason = support === 'excluded' ? 'excluded-secret-or-ignored'
      : support === 'keep-only' ? (kind === 'modified' ? 'no-exact-baseline' : 'unsupported-kind')
      : null;
    const status = support === 'undo-exact' || support === 'keep-only' ? 'pending' : 'unsupported';
    return {
      relativePath: relPath,
      kind,
      beforeHash,
      afterHash,
      beforeSize: bf?.size ?? null,
      afterSize: af?.size ?? null,
      fileKind,
      support,
      preTurnDirty,
      trackedBefore: bf?.tracked ?? false,
      trackedAfter: af?.tracked ?? false,
      ignored: bf?.ignored ?? af?.ignored ?? false,
      status,
      keptHunks: [],
      conflictReason,
    };
  }

  private lineStats(change: FileChange): { additions: number; deletions: number } {
    const bBytes = change.beforeHash ? this.storage.blobs.get(change.beforeHash) : null;
    const aBytes = change.afterHash ? this.storage.blobs.get(change.afterHash) : null;
    if (change.kind === 'created') {
      return { additions: aBytes ? splitLines(aBytes.toString('utf8')).length : 0, deletions: 0 };
    }
    if (change.kind === 'deleted') {
      return { additions: 0, deletions: bBytes ? splitLines(bBytes.toString('utf8')).length : 0 };
    }
    if (!bBytes || !aBytes) return { additions: 0, deletions: 0 };
    const { hunks } = computeHunks(bBytes.toString('utf8'), aBytes.toString('utf8'), change.relativePath, change.beforeHash, change.afterHash);
    let add = 0;
    let del = 0;
    for (const h of hunks) {
      add += h.added.length;
      del += h.removed.length;
    }
    return { additions: add, deletions: del };
  }

  // ------------------------------------------------------------------
  // Queries
  // ------------------------------------------------------------------

  list(workspaceId: string, limit: number): Review[] {
    return [...this.reviews.values()]
      .filter((r) => r.workspaceId === workspaceId || r.workspaceId === null)
      .sort((a, b) => (b.createdAt < a.createdAt ? -1 : 1))
      .slice(0, limit);
  }

  get(reviewId: string): Review | null {
    return this.reviews.get(reviewId) ?? null;
  }

  async fileDiff(reviewId: string, path: string): Promise<{ review: Review; hunks: Hunk[]; beforeLines: number; afterLines: number; fullReplace: boolean } | { error: string }> {
    const review = this.reviews.get(reviewId);
    if (!review) return { error: 'missing-review' };
    const rel = this.resolveSafe(review.rootRealPath, path);
    if (!rel) return { error: 'unauthorized-path' };
    const file = review.files.find((f) => f.relativePath === rel);
    if (!file) return { error: 'unknown-path' };
    if (file.fileKind !== 'text' || file.kind === 'created' || file.kind === 'deleted') {
      return { review, hunks: [], beforeLines: file.beforeSize ?? 0, afterLines: file.afterSize ?? 0, fullReplace: true };
    }
    const beforeBytes = file.beforeHash ? this.storage.blobs.get(file.beforeHash) : null;
    const afterBytes = file.afterHash ? this.storage.blobs.get(file.afterHash) : null;
    if (!beforeBytes || !afterBytes) return { error: 'missing-blob' };
    const beforeText = beforeBytes.toString('utf8');
    const afterText = afterBytes.toString('utf8');
    const { hunks, fullReplace } = computeHunks(beforeText, afterText, rel, file.beforeHash, file.afterHash);
    return {
      review,
      hunks,
      beforeLines: splitLines(beforeText).length,
      afterLines: splitLines(afterText).length,
      fullReplace,
    };
  }

  async pluginInfo(): Promise<PluginInfo> {
    const settings = await this.deps.getSettings();
    const writeEnabled = settings.undoMode !== 'disabled';
    return {
      undoMode: settings.undoMode,
      writeEnabled,
      fixtureRoots: settings.fixtureRoots,
      allowAllProjects: settings.allowAllProjects === true,
      maxFileBytes: settings.maxFileBytes,
      retentionDays: settings.retentionDays,
      maxProjectBytes: settings.maxProjectBytes ?? 1024 * 1024 * 1024,
      captureVersion: CAPTURE_VERSION,
      storageRoot: this.storage.ok ? this.storage.root : null,
      storageOk: this.storage.ok,
      captureBarrier: 'none',
    };
  }

  // ------------------------------------------------------------------
  // Keep (metadata-only)
  // ------------------------------------------------------------------

  async keep(reviewId: string, workspaceId: string, expectedRevision: number, operationId: string, scope: { kind: 'all' } | { kind: 'file'; path: string } | { kind: 'hunk'; path: string; hunkId: string }): Promise<{ ok: boolean; reason?: string; review?: Review }> {
    const review = this.reviews.get(reviewId);
    if (!review) return { ok: false, reason: 'missing-review' };
    if (review.workspaceId !== null && review.workspaceId !== workspaceId) return { ok: false, reason: 'workspace-mismatch' };
    if (review.revision !== expectedRevision) return { ok: false, reason: 'stale-review' };
    if (!operationId) return { ok: false, reason: 'missing-idempotency-key' };
    if (!isValidOperationId(operationId)) return { ok: false, reason: 'invalid-idempotency-key' };
    if (review.captureState === 'interrupted' || review.captureState === 'in-progress') return { ok: false, reason: 'unsafe-capture' };

    let targetFiles: FileChange[] = [];
    if (scope.kind === 'all') {
      targetFiles = review.files.filter((f) => f.status === 'pending');
    } else {
      const rel = this.resolveSafe(review.rootRealPath, scope.path);
      if (!rel) return { ok: false, reason: 'unauthorized-path' };
      const file = review.files.find((f) => f.relativePath === rel);
      if (!file) return { ok: false, reason: 'unknown-path' };
      if (file.status !== 'pending') return { ok: false, reason: 'not-pending' };
      targetFiles = [file];
    }
    if (targetFiles.length === 0) return { ok: false, reason: 'nothing-pending' };

    if (scope.kind === 'hunk') {
      const file = targetFiles[0];
      if (file.preTurnDirty) return { ok: false, reason: 'ambiguous-attribution' };
      if (file.keptHunks.includes(scope.hunkId)) return { ok: false, reason: 'already-kept' };
      const hunks = await this.fileHunks(review, file);
      if (!hunks.some((h) => h.id === scope.hunkId)) return { ok: false, reason: 'unknown-hunk' };
      file.keptHunks = [...file.keptHunks, scope.hunkId];
      if (file.keptHunks.length === hunks.length && hunks.length > 0) {
        file.status = 'kept';
      }
    } else {
      for (const file of targetFiles) {
        if (file.support !== 'undo-exact' && file.support !== 'keep-only') continue;
        file.status = 'kept';
      }
    }

    review.revision += 1;
    review.status = review.files.some((f) => f.status === 'pending') ? 'pending' : 'kept';
    this.persistReview(review);
    return { ok: true, review };
  }

  private async fileHunks(review: Review, file: FileChange): Promise<Hunk[]> {
    if (file.fileKind !== 'text' || file.kind !== 'modified') return [];
    const beforeBytes = file.beforeHash ? this.storage.blobs.get(file.beforeHash) : null;
    const afterBytes = file.afterHash ? this.storage.blobs.get(file.afterHash) : null;
    if (!beforeBytes || !afterBytes) return [];
    const { hunks } = computeHunks(beforeBytes.toString('utf8'), afterBytes.toString('utf8'), file.relativePath, file.beforeHash, file.afterHash);
    return hunks;
  }

  // ------------------------------------------------------------------
  // Timeline card
  // ------------------------------------------------------------------

  /**
   * Compact per-turn summary for the chat timeline card. Only files that
   * actually changed during the turn (and are not excluded) are listed, capped
   * so the appended item stays small and the turn_ended hook stays fast.
   */
  async timelineCard(reviewId: string): Promise<TurnReviewCard | null> {
    const review = this.reviews.get(reviewId);
    if (!review || !review.workspaceId || !review.endedAt) return null;
    const actionable = review.files.filter((f) =>
      f.support !== 'excluded' && (f.kind === 'modified' || f.kind === 'created' || f.kind === 'deleted'),
    );
    if (actionable.length === 0) return null;
    const files = actionable.slice(0, TURN_REVIEW_MAX_CARD_FILES);
    const rows: TurnReviewCard['files'] = [];
    for (const f of files) {
      let added: number | null = null;
      let deleted: number | null = null;
      if (f.fileKind === 'text') {
        const counts = this.lineStats(f);
        added = counts.additions;
        deleted = counts.deletions;
      }
      rows.push({ path: f.relativePath, kind: f.kind, added, deleted, undoExact: f.support === 'undo-exact', status: f.status });
    }
    return {
      reviewId,
      workspaceId: review.workspaceId,
      agentId: review.agentId,
      endedAt: review.endedAt,
      captureStable: review.captureStable !== false,
      fileCount: actionable.length,
      added: review.totalAdditions,
      deleted: review.totalDeletions,
      files: rows,
    };
  }

  // ------------------------------------------------------------------
  // Undo
  // ------------------------------------------------------------------

  async undoFile(reviewId: string, workspaceId: string, expectedRevision: number, operationId: string, path: string, expectedCurrentHash: string | null, expectedCurrentAbsent: boolean): Promise<{ result: OperationResult; review: Review }> {
    const review = this.reviews.get(reviewId);
    if (!review) return { result: refusal('missing-review', 'Review record not found'), review: this.reviews.get(reviewId) ?? reviewStub(reviewId) };
    // Exactly-once (C19): a terminal applied op short-circuits even a stale
    // revision, so a blind retry is idempotent rather than misreported (F4).
    const applied = this.storage.ops.read(operationId);
    if (applied && applied.state === 'applied' && applied.reviewId === reviewId) {
      return { result: { status: 'ok', reason: 'already-applied', message: 'Already applied.', backupOperationId: operationId }, review };
    }
    const gate = await this.undoGate(review, workspaceId, expectedRevision, operationId);
    if (!gate.ok) return { result: refusal(gate.reason, gate.message), review };
    const file = review.files.find((f) => f.relativePath === path) ?? null;
    if (!file) return { result: refusal('missing-file', 'File is not part of this review.'), review };
    if (file.support !== 'undo-exact') {
      return { result: refusal('unsupported-undo', 'This file has no exact byte baseline for Undo.'), review };
    }
    if (file.status !== 'pending') return { result: refusal('not-pending', 'This file is not pending review.'), review };

    const outcome = await this.executeFileUndo(review, file, operationId, expectedCurrentHash, expectedCurrentAbsent, gate.currentBytes);
    return { result: outcome.result, review: outcome.review };
  }

  async undoHunk(reviewId: string, workspaceId: string, expectedRevision: number, operationId: string, path: string, hunkId: string, expectedCurrentHash: string | null, expectedCurrentAbsent: boolean): Promise<{ result: OperationResult; review: Review }> {
    const review = this.reviews.get(reviewId);
    if (!review) return { result: refusal('missing-review', 'Review record not found'), review: reviewStub(reviewId) };
    // Exactly-once (C19): terminal applied op short-circuits stale revisions.
    const applied = this.storage.ops.read(operationId);
    if (applied && applied.state === 'applied' && applied.reviewId === reviewId) {
      return { result: { status: 'ok', reason: 'already-applied', message: 'Already applied.', backupOperationId: operationId }, review };
    }
    const gate = await this.undoGate(review, workspaceId, expectedRevision, operationId);
    if (!gate.ok) return { result: refusal(gate.reason, gate.message), review };
    const file = review.files.find((f) => f.relativePath === path) ?? null;
    if (!file) return { result: refusal('missing-file', 'File is not part of this review.'), review };
    if (file.support !== 'undo-exact') return { result: refusal('unsupported-undo', 'This file has no exact byte baseline for Undo.'), review };
    if (file.status !== 'pending') return { result: refusal('not-pending', 'This file is not pending review.'), review };
    if (file.preTurnDirty) return { result: refusal('ambiguous-attribution', 'Hunk attribution is ambiguous because the file was already modified before this turn.'), review };
    if (file.keptHunks.includes(hunkId)) return { result: refusal('already-kept', 'This hunk was already kept and cannot be undone.'), review };
    const hunks = await this.fileHunks(review, file);
    const hunk = hunks.find((h) => h.id === hunkId);
    if (!hunk) return { result: refusal('unknown-hunk', 'Unknown hunk id.'), review };

    const currentBytes = gate.currentBytes;
    if (!currentBytes) return { result: conflictResult('file-changed', 'The file no longer exists on disk.'), review };
    if (digest(currentBytes) !== file.afterHash) {
      return { result: conflictResult('file-changed', 'The current file differs from the reviewed after-state; Undo refused.'), review };
    }
    if (expectedCurrentHash && expectedCurrentHash !== file.afterHash) {
      return { result: refusal('stale-client', 'Client baseline hash is stale.'), review };
    }
    const beforeBytes = file.beforeHash ? this.storage.blobs.get(file.beforeHash) : null;
    if (!beforeBytes) return { result: refusal('missing-blob', 'Before snapshot missing.'), review };
    let candidate: Buffer;
    try {
      candidate = revertHunkRaw(currentBytes, hunk, beforeBytes);
    } catch {
      return { result: conflictResult('file-changed', 'Hunk no longer fits the current file; Undo refused.'), review };
    }
    const outcome = await this.executeWrite(review, file, operationId, candidate, currentBytes);
    return { result: outcome.result, review: outcome.review };
  }

  async undoAll(reviewId: string, workspaceId: string, expectedRevision: number, operationId: string, expectedCurrentHashes: Record<string, string>): Promise<{ results: Record<string, OperationResult>; review: Review }> {
    const review = this.reviews.get(reviewId);
    if (!review) return { results: {}, review: reviewStub(reviewId) };
    const gate = await this.undoGate(review, workspaceId, expectedRevision, operationId);
    if (!gate.ok) {
      const results: Record<string, OperationResult> = {};
      for (const file of review.files.filter((f) => f.status === 'pending')) {
        results[file.relativePath] = refusal(gate.reason, gate.message);
      }
      return { results, review };
    }
    const pending = review.files.filter((f) => f.status === 'pending');
    const results: Record<string, OperationResult> = {};
    for (const file of pending) {
      if (file.support !== 'undo-exact') {
        results[file.relativePath] = refusal('unsupported-undo', 'No exact byte baseline for Undo.');
        continue;
      }
      const expectedHash = expectedCurrentHashes[file.relativePath] ?? null;
      const expectedAbsent = expectedHash === '__absent__';
      const fileGate = await this.undoFilePreflight(review, file, operationId + ':' + file.relativePath, file.afterHash ?? null, expectedAbsent);
      if (!fileGate.ok) {
        results[file.relativePath] = refusal(fileGate.reason, fileGate.message);
        continue;
      }
      const outcome = await this.executeFileUndo(review, file, operationId + ':' + file.relativePath, file.afterHash ?? null, expectedAbsent, fileGate.currentBytes);
      results[file.relativePath] = outcome.result;
    }
    return { results, review };
  }

  async restoreBackup(reviewId: string, workspaceId: string, operationId: string, path: string, expectedCurrentHash: string): Promise<{ result: OperationResult; review: Review }> {
    const review = this.reviews.get(reviewId);
    if (!review) return { result: refusal('missing-review', 'Review record not found'), review: reviewStub(reviewId) };
    if (review.workspaceId !== null && review.workspaceId !== workspaceId) return { result: refusal('workspace-mismatch', 'Workspace mismatch.'), review };
    const op = this.storage.ops.read(operationId);
    if (!op) return { result: refusal('missing-operation', 'No such operation.'), review };
    if (op.reviewId !== reviewId) return { result: refusal('operation-mismatch', 'Operation belongs to a different review.'), review };
    const backup = this.storage.blobs.get(op.backupSha);
    if (!backup) return { result: conflictResult('missing-backup', 'Backup blob missing.'), review };
    const file = review.files.find((f) => f.relativePath === path);
    if (!file) return { result: refusal('unknown-path', 'Unknown path.'), review };
    // Restore only when the current bytes still match what the failed op left.
    const rel = this.resolveSafe(review.rootRealPath, path);
    if (!rel) return { result: refusal('unauthorized-path', 'Path outside root.'), review };
    const abs = this.resolveAbs(review.rootRealPath, rel);
    let current: Buffer | null = null;
    try {
      current = fs.readFileSync(abs!);
    } catch {
      current = null;
    }
    if (current !== null && digest(current) !== expectedCurrentHash) {
      return { result: conflictResult('file-changed', 'Current file differs from the expected post-failure state; refusing automatic restore.'), review };
    }
    if (current === null && expectedCurrentHash !== '__absent__') {
      return { result: conflictResult('file-changed', 'Current file is missing.'), review };
    }
    const outcome = await this.executeWrite(review, file, operationId + ':restore', backup, current ?? Buffer.alloc(0), false);
    if (outcome.result.status === 'ok') {
      this.storage.ops.write({ ...op, state: 'applied' });
    }
    return { result: outcome.result, review: outcome.review };
  }

  // ------------------------------------------------------------------
  // Rolling cross-turn tracker
  // ------------------------------------------------------------------

  /**
   * Pending (unresolved) occurrences of `path` across all reviews of a
   * workspace, oldest first. Only fully captured, ended reviews count.
   */
  private pendingOccurrences(workspaceId: string, path: string): Array<{ review: Review; file: FileChange }> {
    const out: Array<{ review: Review; file: FileChange }> = [];
    for (const review of this.reviews.values()) {
      if (review.workspaceId !== workspaceId || review.endedAt == null) continue;
      const file = review.files.find((f) => f.relativePath === path);
      if (file && file.status === 'pending' && file.support !== 'excluded') out.push({ review, file });
    }
    out.sort((a, b) => ((a.review.startedAt ?? '') < (b.review.startedAt ?? '') ? -1 : 1));
    return out;
  }

  /**
   * Build the rolling tracker: one row per path with a pending change since its
   * last accept/deny/dismiss. The baseline is the oldest pending occurrence's
   * before-state; the current state is the newest pending occurrence's
   * after-state. Deny is reported as available only when the structural safety
   * gates hold AND the live working tree still equals the newest recorded state
   * (the full gate is re-run at deny time).
   */
  async trackerList(workspaceId: string): Promise<TrackerFile[]> {
    const settings = await this.deps.getSettings();
    const writeEnabled = settings.undoMode !== 'disabled';

    const byPath = new Map<string, Array<{ review: Review; file: FileChange }>>();
    for (const review of this.reviews.values()) {
      if (review.workspaceId !== workspaceId || review.endedAt == null) continue;
      for (const file of review.files) {
        if (file.status !== 'pending' || file.support === 'excluded') continue;
        const list = byPath.get(file.relativePath) ?? [];
        list.push({ review, file });
        byPath.set(file.relativePath, list);
      }
    }

    const out: TrackerFile[] = [];
    for (const [relPath, occurrences] of byPath) {
      occurrences.sort((a, b) => ((a.review.startedAt ?? '') < (b.review.startedAt ?? '') ? -1 : 1));
      const baseline = occurrences[0];
      const current = occurrences[occurrences.length - 1];
      const baselinePresent = baseline.file.kind !== 'created';
      const currentPresent = current.file.kind !== 'deleted';
      // No net change (e.g. created then deleted) -> nothing to show or deny.
      if (!baselinePresent && !currentPresent) continue;

      const baselineBytes = baseline.file.beforeHash ? this.storage.blobs.get(baseline.file.beforeHash) : null;
      const currentBytes = current.file.afterHash ? this.storage.blobs.get(current.file.afterHash) : null;
      // Net no-op (e.g. created then deleted) -> nothing to show or deny.
      if (!baselinePresent && !currentPresent) continue;

      let kind: 'modified' | 'created' | 'deleted';
      let added = 0;
      let deleted = 0;
      // Deny restores the baseline bytes except for a net-created file (whose
      // baseline is absence); a missing baseline blob makes rollback impossible.
      const baselineRestorable = !baselinePresent || baselineBytes !== null;
      if (!baselinePresent) {
        kind = 'created';
        if (currentBytes) added = splitLines(currentBytes.toString('utf8')).length;
      } else if (!currentPresent) {
        kind = 'deleted';
        if (baselineBytes) deleted = splitLines(baselineBytes.toString('utf8')).length;
      } else {
        kind = 'modified';
        if (baselineBytes && currentBytes) {
          const { hunks, fullReplace } = computeHunks(
            baselineBytes.toString('utf8'),
            currentBytes.toString('utf8'),
            relPath,
            baseline.file.beforeHash,
            current.file.afterHash,
          );
          if (fullReplace && hunks.length === 0) continue; // no net textual change
          for (const h of hunks) {
            added += h.added.length;
            deleted += h.removed.length;
          }
        }
      }

      // Live-match: does the working tree still equal the newest after-state?
      let liveMatch = false;
      const rel = this.resolveSafe(baseline.review.rootRealPath, relPath);
      const abs = rel ? this.resolveAbs(baseline.review.rootRealPath, rel) : null;
      if (abs) {
        let live: Buffer | null = null;
        try {
          live = fs.readFileSync(abs);
        } catch {
          live = null;
        }
        const livePresent = live !== null;
        liveMatch = livePresent === currentPresent && (livePresent ? digest(live!) === current.file.afterHash : true);
      }

      let deniable = true;
      let reason: string | null = null;
      // Attribution is trusted when the baseline capture was verified stable
      // (`support === 'undo-exact'` below: before-blob stored, no mid-scan
      // change) and no overlapping agent shared the repo. A dirty or untracked
      // file no longer blocks whole-file Deny: Deny is a byte-exact restore to
      // the recorded before-state, which preserves any pre-turn uncommitted
      // work (see DECISIONS §20 — user-authorized relaxation). Multi-agent
      // overlap is still refused below.
      if (!liveMatch) {
        deniable = false;
        reason = 'live-changed';
      } else if (baseline.review.ambiguous) {
        deniable = false;
        reason = 'multi-agent';
      } else if (!baselineRestorable) {
        deniable = false;
        reason = 'missing-blob';
      } else if (baseline.file.support !== 'undo-exact') {
        deniable = false;
        reason = 'unsupported';
      } else if (!writeEnabled) {
        deniable = false;
        reason = 'write-disabled';
      } else if (!isAllowedRoot(baseline.review.rootRealPath, settings)) {
        deniable = false;
        reason = 'not-fixture';
      }

      out.push({
        path: relPath,
        kind,
        added,
        deleted,
        deniable,
        reason,
        turns: occurrences.length,
        baselineAt: baseline.review.startedAt ?? baseline.review.createdAt,
        currentHash: currentPresent ? current.file.afterHash : null,
        fileKind: baseline.file.fileKind,
      });
    }

    out.sort((a, b) => (a.path < b.path ? -1 : 1));
    return out;
  }

  /** Accumulated diff of `path` from its baseline to its newest recorded state. */
  async trackerDiff(workspaceId: string, path: string): Promise<{ hunks: Hunk[]; beforeLines: number; afterLines: number; fullReplace: boolean; kind: 'modified' | 'created' | 'deleted' } | { error: string }> {
    const occ = this.pendingOccurrences(workspaceId, path);
    if (occ.length === 0) return { error: 'not-tracked' };
    const baseline = occ[0];
    const current = occ[occ.length - 1];
    const baselinePresent = baseline.file.kind !== 'created';
    const currentPresent = current.file.kind !== 'deleted';
    const baselineBytes = baseline.file.beforeHash ? this.storage.blobs.get(baseline.file.beforeHash) : null;
    const currentBytes = current.file.afterHash ? this.storage.blobs.get(current.file.afterHash) : null;
    if (!baselinePresent && !currentPresent) return { error: 'not-tracked' };
    if (baselinePresent && !baselineBytes) return { error: 'missing-blob' };
    if (currentPresent && !currentBytes) return { error: 'missing-blob' };
    if (!baselinePresent || !currentPresent || baseline.file.fileKind !== 'text') {
      return {
        hunks: [],
        beforeLines: baselineBytes ? splitLines(baselineBytes.toString('utf8')).length : 0,
        afterLines: currentBytes ? splitLines(currentBytes.toString('utf8')).length : 0,
        fullReplace: true,
        kind: !baselinePresent ? 'created' : 'deleted',
      };
    }
    const beforeText = baselineBytes!.toString('utf8');
    const afterText = currentBytes!.toString('utf8');
    const { hunks, fullReplace } = computeHunks(beforeText, afterText, path, baseline.file.beforeHash, current.file.afterHash);
    return { hunks, beforeLines: splitLines(beforeText).length, afterLines: splitLines(afterText).length, fullReplace, kind: 'modified' };
  }

  /**
   * Full before/after text for the side-by-side file viewer. Mirrors
   * `trackerDiff`'s baseline/current selection so the full view always matches
   * what the row's diff shows: oldest pending before-state on the left, newest
   * captured after-state on the right. Created/deleted rows return a single
   * populated side. Non-text files are refused ('unsupported').
   */
  async trackerFullFile(workspaceId: string, path: string): Promise<
    | { error: string; before: null; after: null; kind: null; truncated: false; hunks: []; fullReplace: false }
    | {
        error: null;
        before: string | null;
        after: string | null;
        kind: 'modified' | 'created' | 'deleted';
        truncated: boolean;
        hunks: Hunk[];
        fullReplace: boolean;
      }
  > {
    const occ = this.pendingOccurrences(workspaceId, path);
    if (occ.length === 0) return { error: 'not-tracked', before: null, after: null, kind: null, truncated: false, hunks: [], fullReplace: false };
    const baseline = occ[0];
    const current = occ[occ.length - 1];
    const baselinePresent = baseline.file.kind !== 'created';
    const currentPresent = current.file.kind !== 'deleted';
    // Created-then-deleted net-no-change: no tracker row exists, so nothing to view.
    if (!baselinePresent && !currentPresent) return { error: 'not-tracked', before: null, after: null, kind: null, truncated: false, hunks: [], fullReplace: false };
    if (baseline.file.fileKind !== 'text' || current.file.fileKind !== 'text') {
      return { error: 'unsupported', before: null, after: null, kind: null, truncated: false, hunks: [], fullReplace: false };
    }
    const baselineBytes = baseline.file.beforeHash ? this.storage.blobs.get(baseline.file.beforeHash) : null;
    const currentBytes = current.file.afterHash ? this.storage.blobs.get(current.file.afterHash) : null;
    if (baselinePresent && !baselineBytes) return { error: 'missing-blob', before: null, after: null, kind: null, truncated: false, hunks: [], fullReplace: false };
    if (currentPresent && !currentBytes) return { error: 'missing-blob', before: null, after: null, kind: null, truncated: false, hunks: [], fullReplace: false };

    let before = baselinePresent && baselineBytes ? baselineBytes.toString('utf8') : null;
    let after = currentPresent && currentBytes ? currentBytes.toString('utf8') : null;
    // Bound the rendered surface: keep the first FULL_FILE_MAX_LINES of each side.
    let truncated = false;
    if (before != null && splitLines(before).length > FULL_FILE_MAX_LINES) {
      before = splitLines(before).slice(0, FULL_FILE_MAX_LINES).join('\n');
      truncated = true;
    }
    if (after != null && splitLines(after).length > FULL_FILE_MAX_LINES) {
      after = splitLines(after).slice(0, FULL_FILE_MAX_LINES).join('\n');
      truncated = true;
    }
    const kind: 'modified' | 'created' | 'deleted' = !baselinePresent ? 'created' : !currentPresent ? 'deleted' : 'modified';
    let hunks: Hunk[] = [];
    let fullReplace = false;
    if (kind === 'modified' && before != null && after != null) {
      const result = computeHunks(before, after, path, baseline.file.beforeHash, current.file.afterHash);
      hunks = result.hunks;
      fullReplace = result.fullReplace;
    }
    return { error: null, before, after, kind, truncated, hunks, fullReplace };
  }

  /** Metadata-only accept: advance the baseline to the current state everywhere. */
  async trackerAccept(workspaceId: string, path: string, operationId: string): Promise<{ ok: boolean; reason?: string; message?: string }> {
    if (!operationId) return { ok: false, reason: 'missing-idempotency-key', message: 'Missing idempotency key.' };
    if (!isValidOperationId(operationId)) return { ok: false, reason: 'invalid-idempotency-key', message: 'Idempotency key contains invalid characters.' };
    const occ = this.pendingOccurrences(workspaceId, path);
    if (occ.length === 0) return { ok: true, reason: 'not-tracked', message: 'Nothing to accept.' };
    this.resolveFileAcrossWorkspace(occ, true);
    return { ok: true, message: 'Accepted.' };
  }

  /**
   * Deny: roll the working tree back to the accumulated baseline (oldest
   * pending before-state), compare-and-swap against the newest recorded
   * after-state, then resolve the file everywhere. Gated exactly like a
   * per-review Undo (revision is not part of the tracker contract -> null).
   */
  async trackerDeny(workspaceId: string, path: string, operationId: string): Promise<{ result: OperationResult; resolved: boolean }> {
    // Exactly-once BEFORE any state lookup: a blind retry of an already-applied
    // deny is idempotent (F4 pattern) — but ONLY while its result is still on
    // disk. If the rollback result is gone (e.g. a Restore re-applied the
    // denied change, DECISIONS §21), the same content-scoped op id is a NEW
    // deny intent (a rewind), not a retry, and must run the full write.
    const applied = this.storage.ops.read(operationId);
    if (applied && applied.state === 'applied' && applied.path === path && this.appliedOpStillInEffect(applied)) {
      return { result: { status: 'ok', reason: 'already-applied', message: 'Already applied.', backupOperationId: operationId }, resolved: true };
    }

    const occ = this.pendingOccurrences(workspaceId, path);
    if (occ.length === 0) return { result: refusal('not-tracked', 'Nothing to deny.'), resolved: false };
    const baseline = occ[0];
    const current = occ[occ.length - 1];
    const review = baseline.review;

    const gate = await this.undoGate(review, workspaceId, null, operationId);
    if (!gate.ok) return { result: refusal(gate.reason, gate.message), resolved: false };
    if (baseline.file.support !== 'undo-exact') return { result: refusal('unsupported-undo', 'No exact byte baseline for Undo.'), resolved: false };
    // Attribution is trusted when the baseline capture was verified stable
    // (`support === 'undo-exact'`) and the review was not flagged for
    // overlapping agents (undoGate refuses those with `unsafe-capture`). A
    // dirty/untracked file no longer refuses whole-file Deny: it restores the
    // recorded before-state byte-for-byte, preserving any pre-turn work
    // (DECISIONS §20 — user-authorized relaxation).

    const baselinePresent = baseline.file.kind !== 'created';
    const currentPresent = current.file.kind !== 'deleted';
    const rel = this.resolveSafe(review.rootRealPath, path);
    if (!rel) return { result: refusal('unauthorized-path', 'Path outside root.'), resolved: false };
    const abs = this.resolveAbs(review.rootRealPath, rel);
    let live: Buffer | null = null;
    try {
      live = fs.readFileSync(abs!);
    } catch {
      live = null;
    }
    const livePresent = live !== null;
    if (livePresent !== currentPresent || (livePresent && digest(live!) !== current.file.afterHash)) {
      return { result: conflictResult('file-changed', 'The working tree no longer matches the reviewed state; Deny refused.'), resolved: false };
    }

    // Restore the baseline through the same write transaction. For a net-created
    // file the baseline is absence (delete); for net-deleted it is the original
    // bytes (recreate). CAS target is the newest after-state.
    const targetAbsent = !baselinePresent;
    let candidate: Buffer;
    if (baselinePresent) {
      if (!baseline.file.beforeHash) return { result: refusal('missing-blob', 'Before snapshot missing.'), resolved: false };
      const bytes = this.storage.blobs.get(baseline.file.beforeHash);
      if (!bytes) return { result: refusal('missing-blob', 'Before snapshot missing.'), resolved: false };
      candidate = bytes;
    } else {
      candidate = Buffer.alloc(0);
    }
    const synthetic: FileChange = {
      relativePath: path,
      kind: targetAbsent ? 'created' : currentPresent ? 'modified' : 'deleted',
      beforeHash: baseline.file.beforeHash,
      afterHash: currentPresent ? current.file.afterHash : null,
      beforeSize: baseline.file.beforeSize,
      afterSize: current.file.afterSize,
      fileKind: baseline.file.fileKind,
      support: 'undo-exact',
      preTurnDirty: baseline.file.preTurnDirty,
      trackedBefore: baseline.file.trackedBefore,
      trackedAfter: baseline.file.trackedAfter,
      ignored: baseline.file.ignored,
      status: 'pending',
      keptHunks: [],
      conflictReason: null,
    };
    const outcome = await this.executeWrite(review, synthetic, operationId, candidate, live, targetAbsent, 'deny');
    if (outcome.result.status === 'ok') {
      // Baseline review was resolved inside executeWrite; resolve the rest.
      this.resolveFileAcrossWorkspace(occ.slice(1), true);
      // Human-visible chat notice so the user knows a rollback happened.
      try {
        this.deps.onDenyApplied?.({
          agentId: review.agentId,
          workspaceId: review.workspaceId ?? workspaceId,
          path,
          operationId,
        });
      } catch {
        // Notice failure must not break the already-successful rollback.
      }
      return { result: outcome.result, resolved: true };
    }
    return { result: outcome.result, resolved: false };
  }

  async trackerAcceptAll(workspaceId: string): Promise<{ results: Record<string, string> }> {
    const files = await this.trackerList(workspaceId);
    const results: Record<string, string> = {};
    for (const f of files) {
      const r = await this.trackerAccept(workspaceId, f.path, trackerOpId(workspaceId, 'accept', f.path));
      results[f.path] = r.ok ? 'ok' : r.reason ?? 'error';
    }
    return { results };
  }

  async trackerDenyAll(workspaceId: string): Promise<{ results: Record<string, OperationResult> }> {
    const files = await this.trackerList(workspaceId);
    const results: Record<string, OperationResult> = {};
    for (const f of files) {
      if (!f.deniable) {
        // Leave unresolvable files for Dismiss (accept) instead of failing.
        results[f.path] = refusal(f.reason ?? 'not-deniable', 'Cannot be denied; use Dismiss.');
        continue;
      }
      const r = await this.trackerDeny(workspaceId, f.path, trackerOpId(workspaceId, 'deny', f.path, f.currentHash));
      results[f.path] = r.result;
    }
    return { results };
  }

  /**
   * Completed deny operations whose restore window is still open for this
   * workspace. The window closes once a newer turn starts on the same repo;
   * the current working-tree state must still equal the rolled-back baseline
   * (the file was not edited since).
   */
  async trackerRecoverable(workspaceId: string): Promise<Array<{ path: string; reviewId: string; operationId: string; deniedAt: string }>> {
    const out: Array<{ path: string; reviewId: string; operationId: string; deniedAt: string }> = [];
    for (const op of this.storage.ops.list()) {
      if (op.kind !== 'deny' || op.state !== 'applied' || op.backupSha === 'absent') continue;
      const review = this.reviews.get(op.reviewId);
      if (!review || review.workspaceId !== workspaceId) continue;
      if (this.recoveryWindowClosed(review, op.ts)) continue;
      const abs = this.resolveAbs(review.rootRealPath, op.path);
      if (!abs) continue;
      let live: Buffer | null = null;
      try { live = fs.readFileSync(abs); } catch { live = null; }
      if ((live === null ? 'absent' : digest(live)) !== op.candidateSha) continue; // edited since rollback
      out.push({ path: op.path, reviewId: op.reviewId, operationId: op.operationId, deniedAt: op.ts });
    }
    out.sort((a, b) => (a.deniedAt < b.deniedAt ? 1 : -1));
    return out;
  }

  /**
   * Rollback recovery: re-apply a previously denied change, gated to before
   * the next turn on the same repo. Restores the exact denied after-state via
   * the same write transaction (durable backup, CAS, atomic replace).
   */
  async trackerRecover(workspaceId: string, path: string, operationId: string): Promise<{ result: OperationResult; resolved: boolean }> {
    // Idempotent: a restore that already succeeded for this deny is a friendly
    // no-op, never a confusing `file-changed` conflict (the file is now at the
    // after-state, not the rolled-back baseline the original CAS expects). The
    // check is state-aware: if the restored content was later denied again
    // (rewind), the restore runs again for the new deny.
    const recoverOp = this.storage.ops.read(`${operationId}:recover`);
    if (recoverOp && recoverOp.state === 'applied' && this.appliedOpStillInEffect(recoverOp)) {
      return { result: { status: 'ok', reason: 'already-restored', message: 'Already restored.', backupOperationId: null }, resolved: false };
    }
    const op = this.storage.ops.read(operationId);
    if (!op) return { result: refusal('missing-operation', 'No such operation.'), resolved: false };
    if (op.kind !== 'deny' || op.state !== 'applied' || op.backupSha === 'absent') {
      return { result: refusal('not-recoverable', 'This change is not recoverable.'), resolved: false };
    }
    const review = this.reviews.get(op.reviewId);
    if (!review) return { result: refusal('missing-review', 'Review record not found.'), resolved: false };
    if (review.workspaceId !== workspaceId) return { result: refusal('workspace-mismatch', 'Workspace mismatch.'), resolved: false };
    // Recovery is a write, so it must pass the same mode + allowlist gate as
    // the original Deny (write-disabled checked first; enabled/fixture modes
    // then authorize the write). A user who disabled write mode between the
    // Deny and the Restore is therefore protected.
    const settings = await this.deps.getSettings();
    if (settings.undoMode === 'disabled') {
      return { result: refusal('write-disabled', 'Write mode is disabled; restore refused.'), resolved: false };
    }
    if (!isAllowedRoot(review.rootRealPath, settings)) {
      return { result: refusal('not-fixture', 'This repository is not on the rollback allowlist; restore refused.'), resolved: false };
    }
    if (this.recoveryWindowClosed(review, op.ts)) {
      return { result: refusal('window-closed', 'A newer turn has started; rollback recovery is no longer available.'), resolved: false };
    }
    const rel = this.resolveSafe(review.rootRealPath, op.path);
    if (!rel || rel !== path) return { result: refusal('unauthorized-path', 'Path mismatch or outside root.'), resolved: false };
    const abs = this.resolveAbs(review.rootRealPath, rel);
    if (!abs) return { result: refusal('unauthorized-path', 'Path outside root.'), resolved: false };
    let live: Buffer | null = null;
    try { live = fs.readFileSync(abs); } catch { live = null; }
    if ((live === null ? 'absent' : digest(live)) !== op.candidateSha) {
      return { result: conflictResult('file-changed', 'The file changed since the rollback; recovery refused.'), resolved: false };
    }
    const backup = this.storage.blobs.get(op.backupSha);
    if (!backup) return { result: refusal('missing-blob', 'Recovery data missing.'), resolved: false };

    // Recreate the denied after-state over the current (rolled-back) baseline.
    const targetAbsent = op.backupSha === 'absent';
    const targetCreated = op.candidateSha === 'absent';
    const synthetic: FileChange = {
      relativePath: rel,
      kind: targetAbsent ? 'deleted' : targetCreated ? 'created' : 'modified',
      beforeHash: op.candidateSha === 'absent' ? null : op.candidateSha,
      // afterHash is the CAS target: the current state must still equal the
      // rolled-back baseline before we restore the denied bytes.
      afterHash: op.candidateSha === 'absent' ? null : op.candidateSha,
      beforeSize: null,
      afterSize: null,
      fileKind: 'text',
      support: 'undo-exact',
      preTurnDirty: false,
      trackedBefore: true,
      trackedAfter: true,
      ignored: false,
      status: 'pending',
      keptHunks: [],
      conflictReason: null,
    };
    const outcome = await this.executeWrite(review, synthetic, `${operationId}:recover`, targetAbsent ? Buffer.alloc(0) : backup, live, targetAbsent, 'restore', targetCreated);
    if (outcome.result.status !== 'ok') return { result: outcome.result, resolved: false };

    // REWIND (user-authorized, DECISIONS §21): re-open the path as a pending
    // accept/deny row so the user can Deny it again (full rewind to the
    // original before-state) or Accept it. The row's baseline is the original
    // pre-turn before-state and its after-state is the denied content now on
    // disk, so the next Deny's CAS (live == afterHash) matches exactly — no
    // false file-change detection. The next Deny still passes every gate
    // (undoGate: write mode, allowlist, repo identity, writer-active, capture
    // complete, not ambiguous; plus live-match/CAS and undo-exact support).
    try {
      await this.reopenAfterRestore(review, rel, op, this.now());
    } catch (err) {
      // The restore write already succeeded; a re-open failure only means the
      // row won't reappear (fail-safe: nothing is half-written).
      console.error('[turn-review] restore re-open failed', err);
    }
    return { result: outcome.result, resolved: true };
  }

  /**
   * True when an applied op's result is still present on disk (the current
   * working tree still equals the op's candidate state, or both are absent).
   * Used to keep blind retries idempotent without mistaking a rewind (Restore
   * re-applied the change) for a retry.
   */
  private appliedOpStillInEffect(op: OpRecord): boolean {
    const review = this.reviews.get(op.reviewId);
    if (!review) return true; // cannot verify -> keep idempotency conservative
    const abs = this.resolveAbs(review.rootRealPath, op.path);
    if (!abs) return op.candidateSha === 'absent';
    try {
      return digest(fs.readFileSync(abs)) === op.candidateSha;
    } catch {
      return op.candidateSha === 'absent';
    }
  }

  /**
   * Create the synthetic `source: 'restore'` review that re-opens `relPath` as
   * a pending tracker row after a successful recovery. Baseline = the original
   * before-state; after = the denied after-state (the bytes now on disk).
   */
  private async reopenAfterRestore(review: Review, relPath: string, op: OpRecord, ts: string): Promise<void> {
    const identity = await repoIdentity(review.rootRealPath);
    const orig = review.files.find((f) => f.relativePath === relPath);
    const afterPresent = op.backupSha !== 'absent';
    const beforeHash = op.candidateSha === 'absent' ? null : op.candidateSha;
    const afterHash = afterPresent ? op.backupSha : null;
    const restoredFile: FileChange = {
      relativePath: relPath,
      kind: beforeHash === null && afterHash !== null ? 'created' : 'modified',
      beforeHash,
      afterHash,
      beforeSize: null,
      afterSize: null,
      fileKind: orig?.fileKind ?? 'text',
      support: 'undo-exact',
      preTurnDirty: orig?.preTurnDirty ?? false,
      trackedBefore: orig?.trackedBefore ?? true,
      trackedAfter: orig?.trackedAfter ?? true,
      ignored: false,
      status: 'pending',
      keptHunks: [],
      conflictReason: null,
    };
    const restoreReview: Review = {
      id: newId('rest'),
      agentId: review.agentId,
      workspaceId: review.workspaceId ?? null,
      rootRealPath: review.rootRealPath,
      branchAtStart: identity.branch,
      headOidAtStart: identity.headOid,
      startedAt: ts,
      endedAt: ts,
      outcome: 'completed',
      captureState: 'complete',
      ambiguous: false,
      captureBarrier: 'event-best-effort',
      captureStable: true,
      unstablePaths: [],
      status: 'pending',
      revision: 0,
      files: [restoredFile],
      totalAdditions: 0,
      totalDeletions: 0,
      createdAt: ts,
      updatedAt: ts,
      source: 'restore',
    };
    this.reviews.set(restoreReview.id, restoreReview);
    this.persistReview(restoreReview);
  }

  /** The recovery window closes once any newer real turn has started on the same repo. */
  private recoveryWindowClosed(review: Review, opTs: string): boolean {
    for (const r of this.reviews.values()) {
      if (r.source === 'restore') continue; // rewind rows are not new turns
      if (r.rootRealPath !== review.rootRealPath || r.id === review.id) continue;
      const started = r.startedAt ?? r.createdAt;
      if (started > opTs) return true;
    }
    return false;
  }

  /**
   * "Simulate a proven turn" development tool: capture the current tree with a
   * PROVEN barrier, apply one real working-tree edit, then capture the after
   * state — exactly like the test harness but reachable in a live install.
   * This is the only path that can produce a proven-barrier review outside the
   * harness, which makes the red "Deny" (rollback) action demoable end-to-end.
   *
   * Hard-gated (no weaker than the existing write gates): write mode must be
   * `fixture` or `enabled` (never `disabled`), the workspace root must pass
   * `isAllowedRoot`, the edit path must resolve safely inside the root
   * (sensitive names refused), the simulated agent must be an idle real agent
   * for the workspace (so the writer-active gate passes), and no capture may
   * already be active on the root. A content value is written verbatim;
   * otherwise a timestamped marker line is appended to the target file.
   */
  async fixtureRun(input: { workspaceId: string; path: string; content?: string }):
    Promise<{ ok: true; reviewId: string; path: string } | { ok: false; reason: string; message: string }> {
    const settings = await this.deps.getSettings();
    if (settings.undoMode === 'disabled') {
      return { ok: false, reason: 'write-disabled', message: 'Write mode is disabled; enable Fixture or Enabled mode in settings.' };
    }

    // Resolve the workspace root from its most recent ended review.
    let root: string | null = null;
    let latest = 0;
    for (const review of this.reviews.values()) {
      if (review.workspaceId !== input.workspaceId || review.endedAt == null) continue;
      const at = Date.parse(review.startedAt ?? review.createdAt) || 0;
      if (at >= latest) { latest = at; root = review.rootRealPath; }
    }
    if (!root) {
      return { ok: false, reason: 'no-reviews', message: 'No captured turn for this workspace yet; run a real turn first.' };
    }
    if (!isAllowedRoot(root, settings)) {
      return { ok: false, reason: 'not-fixture', message: 'This workspace root is not on the fixture allowlist; simulated turns refused.' };
    }
    // The root must be a real git work tree so the capture can be complete
    // (verifier: a non-git root must not silently return ok after writing).
    if (!repoRootFor(root)) {
      return { ok: false, reason: 'unsupported-root', message: 'The workspace root is not a git work tree; simulated turns refused.' };
    }

    const classified = safeRelativePath(root, root, input.path);
    if (!classified.ok || !classified.relativePath) {
      return { ok: false, reason: 'unauthorized-path', message: 'Path is outside the workspace root.' };
    }
    const rel = classified.relativePath;
    if (isSensitivePath(rel, settings.denyPaths)) {
      return { ok: false, reason: 'denied-path', message: 'Path is on the sensitive denylist.' };
    }
    const abs = this.resolveAbs(root, rel);
    if (!abs) return { ok: false, reason: 'unauthorized-path', message: 'Path is outside the workspace root.' };

    // The simulated agent must be idle so the writer-active gate passes on Deny.
    const agentId = this.deps.findIdleAgent ? await this.deps.findIdleAgent(input.workspaceId) : null;
    if (!agentId) {
      return { ok: false, reason: 'no-idle-agent', message: 'No idle agent for this workspace; start one and try again.' };
    }

    // Refuse while a real capture is already active on the same root (C13 overlap).
    for (const active of this.active.values()) {
      if (active.root === root) {
        return { ok: false, reason: 'capture-active', message: 'A capture is already active in this root; try again after it finishes.' };
      }
    }

    const turnId = `fixture-${newId('run')}`;
    const captureId = await this.startTurn({ agentId, workspaceId: input.workspaceId, cwd: root, turnId, barrier: 'proven' });
    try {
      const current = (() => { try { return fs.readFileSync(abs); } catch { return null; } })();
      const write = input.content !== undefined
        ? Buffer.from(input.content, 'utf8')
        : Buffer.concat([current ?? Buffer.alloc(0), Buffer.from(`\n<!-- turn-review fixture marker ${nowIso()} -->\n`, 'utf8')]);
      fs.writeFileSync(abs, write);
    } catch (error) {
      await this.endTurn({ occurrenceId: captureId, agentId, workspaceId: input.workspaceId, cwd: root, outcome: 'failed', barrier: 'proven' });
      return { ok: false, reason: 'write-failed', message: `Could not apply the simulated edit: ${redact(error instanceof Error ? error.message : String(error))}` };
    }
    const review = await this.endTurn({ occurrenceId: captureId, agentId, workspaceId: input.workspaceId, cwd: root, outcome: 'completed', barrier: 'proven' });
    if (!review) return { ok: false, reason: 'capture-failed', message: 'Capture did not complete.' };
    if (review.captureState !== 'complete' || review.status === 'unsupported') {
      return { ok: false, reason: 'capture-incomplete', message: 'The capture could not complete; the marker was not tracked. Simulated turns refused.' };
    }
    return { ok: true, reviewId: review.id, path: rel };
  }

  /** Mark a file resolved (kept) in every pending occurrence, persisting each. */
  private resolveFileAcrossWorkspace(occurrences: Array<{ review: Review; file: FileChange }>, bumpRevision: boolean): void {
    for (const { review, file } of occurrences) {
      this.markFileResolved(review, file.relativePath);
      review.status = review.files.some((f) => f.status === 'pending') ? 'pending' : 'kept';
      if (bumpRevision) review.revision += 1;
      this.persistReview(review);
    }
  }

  /**
   * Write gate for a rollback. User-authorized policy (see DECISIONS): the
   * capture `before -> agent write -> after` workflow IS the gate — a complete
   * before/after capture qualifies, regardless of the `captureBarrier` label
   * (which is now informational only). The hard boundaries stay: write mode
   * must be `fixture` (allowlist-scoped) or `enabled` (every repository; the
   * allowlist is bypassed by design in that mode), the capture must be
   * complete and unambiguous, repo identity must be unchanged, the agent must
   * be idle, and (in the callers) the working tree must still match the
   * reviewed after-state (live-match / CAS). A file the user edited after the
   * turn is implicitly accepted and therefore never denyable (live-changed).
   */
  private async undoGate(review: Review, workspaceId: string, expectedRevision: number | null, operationId: string):
    Promise<{ ok: boolean; reason: string; message: string; file?: FileChange; currentBytes?: Buffer | null }> {
    if (!review) return { ok: false, reason: 'missing-review', message: 'Review not found.' };
    if (review.workspaceId !== null && review.workspaceId !== workspaceId) return { ok: false, reason: 'workspace-mismatch', message: 'Workspace mismatch.' };
    if (expectedRevision !== null && review.revision !== expectedRevision) return { ok: false, reason: 'stale-review', message: 'Review revision is stale; refresh the panel.' };
    if (!operationId) return { ok: false, reason: 'missing-idempotency-key', message: 'Missing idempotency key.' };
    if (!isValidOperationId(operationId)) return { ok: false, reason: 'invalid-idempotency-key', message: 'Idempotency key contains invalid characters.' };
    if (review.captureState !== 'complete') return { ok: false, reason: 'unsafe-capture', message: 'Capture is not complete; Undo unavailable.' };
    if (review.ambiguous) return { ok: false, reason: 'unsafe-capture', message: 'Another agent may share this repository; Undo disabled.' };

    // Write gate: never in disabled mode; fixture is allowlist-scoped, enabled
    // (real-project) mode authorizes every repository. All other gates below
    // (capture completeness, ambiguity, repo identity, writer-active, CAS)
    // apply identically in both write modes.
    const settings = await this.deps.getSettings();
    if (settings.undoMode === 'disabled') return { ok: false, reason: 'write-disabled', message: 'Write mode is disabled.' };
    if (!isAllowedRoot(review.rootRealPath, settings)) {
      return { ok: false, reason: 'not-fixture', message: 'This repository is not on the fixture allowlist; Undo refused.' };
    }

    // Repo identity must not have changed incompatibly (C28).
    const identity = await repoIdentity(review.rootRealPath);
    if (identity.branch !== review.branchAtStart || identity.headOid !== review.headOidAtStart) {
      return { ok: false, reason: 'repository-changed', message: 'Repository branch or HEAD changed since capture; Undo refused.' };
    }
    if (await this.deps.isAgentRunning(review.agentId)) {
      return { ok: false, reason: 'writer-active', message: 'The agent is still running; Undo refused.' };
    }
    return { ok: true, reason: '', message: '' };
  }

  private async undoFilePreflight(review: Review, file: FileChange, operationId: string, expectedCurrentHash: string | null, expectedCurrentAbsent: boolean):
    Promise<{ ok: boolean; reason: string; message: string; currentBytes?: Buffer | null }> {
    if (file.support !== 'undo-exact') return { ok: false, reason: 'unsupported-undo', message: 'No exact baseline.' };
    if (file.status !== 'pending') return { ok: false, reason: 'not-pending', message: 'Not pending.' };
    const abs = this.resolveAbs(review.rootRealPath, file.relativePath);
    if (!abs) return { ok: false, reason: 'unauthorized-path', message: 'Path outside root.' };
    let current: Buffer | null = null;
    try {
      current = fs.readFileSync(abs);
    } catch {
      current = null;
    }
    const exists = current !== null;
    if (file.kind === 'deleted') {
      if (exists) return { ok: false, reason: 'file-changed', message: 'File was recreated; Undo refused.' };
    } else {
      if (!exists) return { ok: false, reason: 'file-changed', message: 'File is missing from disk; Undo refused.' };
      if (digest(current!) !== (expectedCurrentHash ?? file.afterHash)) {
        return { ok: false, reason: 'file-changed', message: 'Current file differs from the reviewed after-state; Undo refused.' };
      }
    }
    void expectedCurrentAbsent;
    return { ok: true, reason: '', message: '', currentBytes: current };
  }

  private async executeFileUndo(review: Review, file: FileChange, operationId: string, expectedCurrentHash: string | null, expectedCurrentAbsent: boolean, _preflightBytes: Buffer | null | undefined): Promise<{ result: OperationResult; review: Review }> {
    const abs = this.resolveAbs(review.rootRealPath, file.relativePath);
    if (!abs) return { result: refusal('unauthorized-path', 'Path outside root.'), review };

    // Exactly-once: an applied operation is idempotent (C19).
    const existing = this.storage.ops.read(operationId);
    if (existing && existing.state === 'applied') {
      return { result: { status: 'ok', reason: 'already-applied', message: 'Already applied.', backupOperationId: operationId }, review };
    }

    // Re-verify current bytes (Compare-and-swap right before writing).
    let current: Buffer | null = null;
    try {
      current = fs.readFileSync(abs);
    } catch {
      current = null;
    }
    const exists = current !== null;
    if (file.kind === 'deleted') {
      if (exists) return { result: conflictResult('file-changed', 'File recreated since preflight.'), review };
    } else {
      if (!exists) return { result: conflictResult('file-changed', 'File missing since preflight.'), review };
      const expected = expectedCurrentHash ?? file.afterHash;
      if (digest(current!) !== expected) return { result: conflictResult('file-changed', 'File changed during operation.'), review };
    }
    void expectedCurrentAbsent;

    // Determine candidate from the verified current (B) bytes.
    let candidate: Buffer;
    let targetAbsent = false;
    if (file.kind === 'created') {
      targetAbsent = true;
      candidate = Buffer.alloc(0);
    } else {
      const beforeBytes = file.beforeHash ? this.storage.blobs.get(file.beforeHash) : null;
      if (!beforeBytes) return { result: refusal('missing-blob', 'Before snapshot missing.'), review };
      const nonKept = await this.nonKeptHunks(review, file);
      candidate = nonKept.length === 0
        ? beforeBytes
        : revertHunksRaw(current ?? Buffer.alloc(0), nonKept, beforeBytes);
    }

    return this.executeWrite(review, file, operationId, candidate, current, targetAbsent);
  }

  private async nonKeptHunks(review: Review, file: FileChange): Promise<Hunk[]> {
    if (file.keptHunks.length === 0) return [];
    const hunks = await this.fileHunks(review, file);
    return hunks.filter((h) => !file.keptHunks.includes(h.id));
  }

  /**
   * The write transaction (V): backup, prepared journal, verify, atomic
   * replace/delete, readback, applied journal. On any failure the original
   * file is untouched and the backup is preserved.
   */
  private async executeWrite(review: Review, file: FileChange, operationId: string, candidate: Buffer, current: Buffer | null, targetAbsent = false, kind: 'deny' | 'undo' | 'restore' = 'undo', targetCreated = false): Promise<{ result: OperationResult; review: Review }> {
    const abs = this.resolveAbs(review.rootRealPath, file.relativePath);
    if (!abs) return { result: refusal('unauthorized-path', 'Path outside root.'), review };

    // Per-repository cross-process lock.
    const lockOk = await this.withRepoLock(review.rootRealPath, async () => {
      // 1. Re-read + verify current bytes under the lock (CAS).
      let currentBytes: Buffer | null = null;
      try {
        currentBytes = fs.readFileSync(abs);
      } catch {
        currentBytes = null;
      }
      const exists = currentBytes !== null;
      if (file.kind === 'deleted') {
        if (exists) return conflictResult('file-changed', 'File was recreated; refusing to delete.');
      } else if (targetCreated) {
        // Recovery of a file the rollback deleted: expect absence.
        if (exists) return conflictResult('file-changed', 'File exists; refusing to overwrite.');
      } else {
        if (!exists) return conflictResult('file-changed', 'File disappeared; refusing to write.');
        if (currentBytes && digest(currentBytes) !== file.afterHash) {
          return conflictResult('file-changed', 'File changed since review; Undo refused.');
        }
      }
      void exists;

      // 2. Durable backup before any write.
      const backupSha = currentBytes ? this.storage.blobs.put(currentBytes) : 'absent';
      const candidateSha = targetAbsent ? 'absent' : digest(candidate);
      const opRecord = {
        operationId,
        reviewId: review.id,
        path: file.relativePath,
        state: 'prepared' as const,
        beforeSha: currentBytes ? digest(currentBytes) : 'absent',
        candidateSha,
        backupSha,
        ts: this.now(),
        kind,
      };
      this.storage.ops.write(opRecord);
      this.storage.journal.append({ type: 'op-prepared', id: operationId, ts: this.now(), data: { reviewId: review.id, path: file.relativePath } });

      // 3. Verify expected hash immediately before the replacement.
      try {
        const nowBytes = fs.readFileSync(abs);
        if (file.kind !== 'deleted' && !targetCreated && digest(nowBytes) !== file.afterHash) {
          this.storage.ops.write({ ...opRecord, state: 'aborted' });
          return conflictResult('file-changed', 'File changed immediately before write; Undo aborted.', operationId);
        }
      } catch {
        if (file.kind === 'deleted' || targetCreated) {
          // fine, file absent as expected
        } else {
          this.storage.ops.write({ ...opRecord, state: 'aborted' });
          return conflictResult('file-changed', 'File disappeared before write; Undo aborted.', operationId);
        }
      }

      // 4. Perform the write.
      if (targetAbsent) {
        // Delete (created file undo). Only after backup + verify above.
        try {
          fs.unlinkSync(abs);
        } catch (err) {
          this.storage.ops.write({ ...opRecord, state: 'aborted' });
          return errorResult('delete-failed', `Could not delete file: ${redact(String(err))}`, operationId);
        }
      } else {
        const temp = path.join(path.dirname(abs), `.${path.basename(abs)}.tr-${operationId.replace(/[^A-Za-z0-9_-]/g, '')}.tmp`);
        let fd: number;
        try {
          fd = fs.openSync(temp, 'w', 0o600);
        } catch (err) {
          this.storage.ops.write({ ...opRecord, state: 'aborted' });
          return errorResult('temp-failed', `Could not create temp file: ${redact(String(err))}`, operationId);
        }
        try {
          fs.writeFileSync(fd, candidate);
          fs.fsyncSync(fd);
        } catch (err) {
          try { fs.closeSync(fd); } catch { /* noop */ }
          try { fs.unlinkSync(temp); } catch { /* noop */ }
          this.storage.ops.write({ ...opRecord, state: 'aborted' });
          return errorResult('write-failed', `Could not write candidate: ${redact(String(err))}`, operationId);
        }
        try { fs.closeSync(fd); } catch { /* noop */ }
        try {
          // Atomic replace; on Windows a locked target fails here and the
          // original is never destroyed.
          fs.renameSync(temp, abs);
        } catch (err) {
          try { fs.unlinkSync(temp); } catch { /* noop */ }
          this.storage.ops.write({ ...opRecord, state: 'aborted' });
          return errorResult('replace-failed', isWindows ? `File may be locked; Undo aborted: ${redact(String(err))}` : `Replace failed: ${redact(String(err))}`, operationId);
        }
        // 5. Read back and verify the candidate checksum.
        try {
          const written = fs.readFileSync(abs);
          if (digest(written) !== candidateSha) {
            this.storage.ops.write({ ...opRecord, state: 'recoverable' });
            return errorResult('readback-mismatch', 'Written file does not match candidate; backup preserved.', operationId);
          }
        } catch (err) {
          this.storage.ops.write({ ...opRecord, state: 'recoverable' });
          return errorResult('readback-failed', `Could not read back file: ${redact(String(err))}`, operationId);
        }
      }

      // 6. Journal applied; reconcile state.
      this.storage.ops.write({ ...opRecord, state: 'applied' });
      this.storage.journal.append({ type: 'op-applied', id: operationId, ts: this.now(), data: { reviewId: review.id, path: file.relativePath } });
      this.markFileResolved(review, file.relativePath);
      return { status: 'ok' as const, reason: null, message: targetAbsent ? 'File removed.' : 'Undo applied.', backupOperationId: operationId };
    });

    if (!lockOk.acquired) {
      return { result: errorResult('lock-timeout', 'Could not acquire repository lock.'), review };
    }
    // Only advance the review revision when a mutation actually succeeded.
    if (lockOk.result.status === 'ok') {
      review.revision += 1;
      review.status = review.files.some((f) => f.status === 'pending') ? 'pending' : 'kept';
      this.persistReview(review);
    }
    return { result: lockOk.result, review };
  }

  private markFileResolved(review: Review, relPath: string): void {
    const file = review.files.find((f) => f.relativePath === relPath);
    if (!file) return;
    file.status = 'kept';
    file.conflictReason = null;
  }

  private markFileConflict(review: Review, relPath: string, reason: string): void {
    const file = review.files.find((f) => f.relativePath === relPath);
    if (!file) return;
    file.status = 'conflict';
    file.conflictReason = reason;
    this.persistReview(review);
  }

  // ------------------------------------------------------------------
  // Locks + path resolution
  // ------------------------------------------------------------------

  private resolveSafe(rootReal: string, candidate: string): string | null {
    const res = safeRelativePath(rootReal, rootReal, candidate);
    return res.ok ? res.relativePath! : null;
  }

  private resolveAbs(rootReal: string, rel: string): string | null {
    const res = safeRelativePath(rootReal, rootReal, rel);
    if (!res.ok) return null;
    return path.join(rootReal, ...res.relativePath!.split('/'));
  }

  private async withRepoLock<T>(root: string, fn: () => Promise<T>): Promise<{ acquired: boolean; result: T }> {
    const lockDir = path.join(this.storage.root, 'locks');
    fs.mkdirSync(lockDir, { recursive: true, mode: 0o700 });
    const key = digest(root).slice(0, 16);
    const lockFile = path.join(lockDir, `${key}.lock`);
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    for (;;) {
      try {
        const fd = fs.openSync(lockFile, 'wx', 0o600);
        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, ts: Date.now() }));
        try { fs.closeSync(fd); } catch { /* noop */ }
        try {
          const result = await fn();
          return { acquired: true, result };
        } finally {
          try { fs.unlinkSync(lockFile); } catch { /* noop */ }
        }
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'EEXIST' && code !== 'EPERM') {
          throw err;
        }
        // Stale lock recovery.
        try {
          const st = fs.statSync(lockFile);
          if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
            try { fs.unlinkSync(lockFile); } catch { /* ignore */ }
            continue;
          }
        } catch {
          continue;
        }
        if (Date.now() > deadline) {
          return { acquired: false, result: undefined as unknown as T };
        }
        await new Promise((r) => setTimeout(r, LOCK_RETRY_MS));
      }
    }
  }
}

function reviewStub(id: string): Review {
  return {
    id,
    agentId: '',
    workspaceId: null,
    rootRealPath: '',
    branchAtStart: null,
    headOidAtStart: null,
    startedAt: null,
    endedAt: null,
    outcome: 'unknown',
    captureState: 'not-captured',
    ambiguous: false,
    captureBarrier: 'event-best-effort',
    status: 'unsupported',
    revision: 0,
    files: [],
    totalAdditions: 0,
    totalDeletions: 0,
    createdAt: '',
    updatedAt: '',
  };
}
