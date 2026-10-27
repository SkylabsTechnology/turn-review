/**
 * Core domain types for Turn Review. Pure data shapes shared between the
 * daemon-side engine (server/) and the React Native surface (client/).
 *
 * Capture records are immutable observations of a turn's before/after state.
 * Review records are mutable resolution state derived from a capture.
 */

/** Review-level resolution status. */
export type ReviewStatus = 'pending' | 'kept' | 'conflict' | 'unsupported';

/**
 * Capture lifecycle. A capture is only ever offered for Undo when it is
 * `complete` AND not ambiguous. Every other state is read-only.
 */
export type CaptureState =
  | 'not-captured'
  | 'in-progress'
  | 'complete'
  | 'incomplete'
  | 'interrupted'
  | 'failed';

/**
 * Why a capture could not produce a review (read-only marker).
 * - `not-git-repository`: the workspace directory is not inside a Git work
 *   tree, so there is no baseline to capture against. Turn Review requires
 *   Git (fail-closed by design); the UI surfaces this instead of silently
 *   showing nothing.
 * - `missing-directory`: the workspace directory did not exist at capture time.
 */
export type CaptureError = 'not-git-repository' | 'missing-directory';

export type ChangeKind = 'modified' | 'created' | 'deleted';

/** Byte-level classification used to decide what may be touched. */
export type FileKind = 'text' | 'binary' | 'symlink' | 'submodule' | 'other';

/**
 * What the engine is allowed to do for this file.
 * - `undo-exact`: raw before bytes stored; exact-match undo allowed.
 * - `keep-only`: metadata Keep allowed; Undo disabled (missing snapshot,
 *   size cap, unstable capture downgrade, etc.).
 * - `unsupported`: no operations.
 * - `excluded`: deliberately not captured (ignored/secret/denied); shown as a
 *   marker only.
 */
export type FileSupport = 'undo-exact' | 'keep-only' | 'unsupported' | 'excluded';

export type FileReviewStatus = 'pending' | 'kept' | 'conflict' | 'unsupported';
export type HunkStatus = 'pending' | 'kept' | 'conflict';

/**
 * A contiguous edit region between A (before) and B (after), with no context
 * lines so that a revert is a single exact splice in B:
 *   replace B lines [newStart, newStart + newCount) with `removed`.
 * Stable identity is content-derived (path + hashes + anchors), never a bare
 * line number.
 */
export interface Hunk {
  id: string;
  oldStart: number; // 1-based first line in A
  oldCount: number; // number of A lines in the region (=== removed.length)
  newStart: number; // 1-based first line in B
  newCount: number; // number of B lines in the region (=== added.length)
  removed: string[]; // A lines removed (without trailing line break)
  added: string[]; // B lines added
}

export interface FileChange {
  relativePath: string;
  kind: ChangeKind;
  beforeHash: string | null;
  afterHash: string | null;
  beforeSize: number | null;
  afterSize: number | null;
  fileKind: FileKind;
  support: FileSupport;
  /** True when the file already differed from HEAD (worktree or index) at turn start. */
  preTurnDirty: boolean;
  trackedBefore: boolean;
  trackedAfter: boolean;
  ignored: boolean;
  status: FileReviewStatus;
  keptHunks: string[];
  conflictReason: string | null;
}

export interface Review {
  id: string; // plugin-local capture UUID (never the provider turnId)
  agentId: string;
  workspaceId: string | null;
  rootRealPath: string; // canonical repo root (case/symlink normalized)
  branchAtStart: string | null;
  headOidAtStart: string | null;
  startedAt: string | null;
  endedAt: string | null;
  outcome: 'completed' | 'failed' | 'canceled' | 'unknown';
  captureState: CaptureState;
  ambiguous: boolean;
  /**
   * How the before snapshot was sequenced relative to agent writes.
   * `proven` = a synchronous in-process capture completed before any write
   * (fixture harness). `event-best-effort` = Paseo lifecycle event. Since the
   * user-authorized policy change (DECISIONS §17), this label is informational
   * only — the `before -> agent write -> after` workflow itself is the gate,
   * and a complete before/after capture is denyable inside the fixture write
   * allowlist when the other gates (live-match, ambiguity, repo identity,
   * writer-active) hold.
   */
  captureBarrier: 'proven' | 'event-best-effort';
  /**
   * True when no file changed while the before-capture scan was running (no
   * downgrade to keep-only). When false, the baseline may have raced the
   * agent's first writes; the affected files were downgraded and are not
   * rollback-able, and the rest are surfaced with reduced-confidence.
   */
  captureStable?: boolean;
  /** Paths downgraded to keep-only because they changed during the before scan. */
  unstablePaths?: string[];
  /**
   * Why the capture failed, when it did. `null`/absent when the capture was
   * complete or failed for an unspecified reason. Currently used to surface a
   * clear "requires Git" notice for non-Git workspaces (the turn is never
   * undo-able either way — fail-closed).
   */
  captureError?: CaptureError | null;
  /**
   * `restore` = a synthetic re-opened row created by a successful rollback
   * recovery (rewind) so the file can be accepted/denied again. These rows are
   * not real turns: they must not close other deny recovery windows, but they
   * participate in the tracker exactly like a captured turn.
   */
  source?: 'capture' | 'restore';
  /** Mutable resolution state. */
  status: ReviewStatus;
  revision: number;
  files: FileChange[];
  totalAdditions: number;
  totalDeletions: number;
  createdAt: string;
  updatedAt: string;
}

/** Operation-level result for a single destructive write (per file). */
export interface OperationResult {
  status: 'ok' | 'refused' | 'conflict' | 'error';
  /** Stable machine reason, e.g. `file-changed`, `writer-active`, `stale-review`. */
  reason: string | null;
  message: string;
  /** Set when a recovery backup exists. */
  backupOperationId: string | null;
}

/**
 * One row of the rolling cross-turn file-change tracker. A file is tracked
 * while any turn since its last accept/deny/dismiss has a pending change to it;
 * the row aggregates the oldest pending baseline -> newest pending after-state.
 */
export interface TrackerFile {
  /** Repository-relative path (forward slashes). */
  path: string;
  /** Net change kind across all accumulated turns. */
  kind: ChangeKind;
  added: number;
  deleted: number;
  /** True when Deny (rollback to baseline) is currently safe + permitted. */
  deniable: boolean;
  /** Why Deny is unavailable: 'live-changed' | 'ambiguous' | 'unsupported' | 'write-disabled' | 'not-fixture'. */
  reason: string | null;
  /** How many turns contributed pending changes to this row. */
  turns: number;
  /** startedAt of the oldest contributing turn (baseline). */
  baselineAt: string;
  /** Newest recorded after-state hash (null when the net current state is absent). */
  currentHash: string | null;
  fileKind: FileKind;
}

/** Client-view summary of the write feature gate. */
export interface PluginInfo {
  undoMode: 'disabled' | 'fixture' | 'enabled';
  writeEnabled: boolean;
  fixtureRoots: string[];
  allowAllProjects: boolean;
  maxFileBytes: number;
  retentionDays: number;
  maxProjectBytes: number;
  captureVersion: string;
  storageRoot: string | null;
  storageOk: boolean;
  captureBarrier: 'none';
}
