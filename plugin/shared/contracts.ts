import { defineRpc } from '@getpaseo/plugin';
import { z } from 'zod';
import type { Review } from './types';

export const reviewSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  workspaceId: z.string().nullable(),
  rootRealPath: z.string(),
  branchAtStart: z.string().nullable(),
  headOidAtStart: z.string().nullable(),
  startedAt: z.string().nullable(),
  endedAt: z.string().nullable(),
  outcome: z.enum(['completed', 'failed', 'canceled', 'unknown']),
  captureState: z.enum([
    'not-captured',
    'in-progress',
    'complete',
    'incomplete',
    'interrupted',
    'failed',
  ]),
  captureError: z.enum(['not-git-repository', 'missing-directory']).nullable().optional(),
  ambiguous: z.boolean(),
  captureBarrier: z.enum(['proven', 'event-best-effort']),
  status: z.enum(['pending', 'kept', 'conflict', 'unsupported']),
  revision: z.number().int().nonnegative(),
  files: z.array(
    z.object({
      relativePath: z.string(),
      kind: z.enum(['modified', 'created', 'deleted']),
      beforeHash: z.string().nullable(),
      afterHash: z.string().nullable(),
      beforeSize: z.number().nullable(),
      afterSize: z.number().nullable(),
      fileKind: z.enum(['text', 'binary', 'symlink', 'submodule', 'other']),
      support: z.enum(['undo-exact', 'keep-only', 'unsupported', 'excluded']),
      preTurnDirty: z.boolean(),
      trackedBefore: z.boolean(),
      trackedAfter: z.boolean(),
      ignored: z.boolean(),
      status: z.enum(['pending', 'kept', 'conflict', 'unsupported']),
      keptHunks: z.array(z.string()),
      conflictReason: z.string().nullable(),
    }),
  ),
  totalAdditions: z.number().int().nonnegative(),
  totalDeletions: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ReviewDto = z.infer<typeof reviewSchema>;

export const hunkSchema = z.object({
  id: z.string(),
  oldStart: z.number().int().positive(),
  oldCount: z.number().int().nonnegative(),
  newStart: z.number().int().positive(),
  newCount: z.number().int().nonnegative(),
  removed: z.array(z.string()),
  added: z.array(z.string()),
});

export const operationResultSchema = z.object({
  status: z.enum(['ok', 'refused', 'conflict', 'error']),
  reason: z.string().nullable(),
  message: z.string(),
  backupOperationId: z.string().nullable(),
});

const reviewQuery = z.object({
  workspaceId: z.string().min(1),
  reviewId: z.string().min(1),
});

export const pluginInfoRpc = defineRpc({
  name: 'turn-review.info',
  input: z.object({}),
  output: z.object({
    undoMode: z.enum(['disabled', 'fixture', 'enabled']),
    writeEnabled: z.boolean(),
    fixtureRoots: z.array(z.string()),
    allowAllProjects: z.boolean(),
    maxFileBytes: z.number(),
    retentionDays: z.number(),
    maxProjectBytes: z.number(),
    captureVersion: z.string(),
    storageRoot: z.string().nullable(),
    storageOk: z.boolean(),
    captureBarrier: z.literal('none'),
  }),
});

export const projectRefSchema = z.object({
  id: z.string(),
  name: z.string(),
  root: z.string(),
  kind: z.enum(['git', 'directory', 'non_git']),
});
export type ProjectRefDto = z.infer<typeof projectRefSchema>;

export const listProjectsRpc = defineRpc({
  name: 'turn-review.projects',
  input: z.object({}),
  output: z.object({ projects: z.array(projectRefSchema) }),
});

export const listReviewsRpc = defineRpc({
  name: 'turn-review.list',
  input: z.object({
    workspaceId: z.string().min(1),
    limit: z.number().int().min(1).max(200).default(100),
  }),
  output: z.object({ reviews: z.array(reviewSchema) }),
});

export const getReviewRpc = defineRpc({
  name: 'turn-review.get',
  input: reviewQuery,
  output: z.object({ review: reviewSchema }),
});

export const getFileDiffRpc = defineRpc({
  name: 'turn-review.file-diff',
  input: reviewQuery.extend({ path: z.string().min(1) }),
  output: z.object({
    review: reviewSchema,
    hunks: z.array(hunkSchema),
    beforeLines: z.number().int().nonnegative(),
    afterLines: z.number().int().nonnegative(),
    fullReplace: z.boolean(),
  }),
});

export const keepAllRpc = defineRpc({
  name: 'turn-review.keep-all',
  input: z.object({
    workspaceId: z.string().min(1),
    reviewId: z.string().min(1),
    operationId: z.string().min(1),
    expectedRevision: z.number().int().nonnegative(),
  }),
  output: z.object({ review: reviewSchema }),
});

export const keepFileRpc = defineRpc({
  name: 'turn-review.keep-file',
  input: z.object({
    workspaceId: z.string().min(1),
    reviewId: z.string().min(1),
    path: z.string().min(1),
    operationId: z.string().min(1),
    expectedRevision: z.number().int().nonnegative(),
  }),
  output: z.object({ review: reviewSchema }),
});

export const keepHunkRpc = defineRpc({
  name: 'turn-review.keep-hunk',
  input: z.object({
    workspaceId: z.string().min(1),
    reviewId: z.string().min(1),
    path: z.string().min(1),
    hunkId: z.string().min(1),
    operationId: z.string().min(1),
    expectedRevision: z.number().int().nonnegative(),
  }),
  output: z.object({ review: reviewSchema }),
});

export const undoFileRpc = defineRpc({
  name: 'turn-review.undo-file',
  input: z.object({
    workspaceId: z.string().min(1),
    reviewId: z.string().min(1),
    path: z.string().min(1),
    operationId: z.string().min(1),
    expectedRevision: z.number().int().nonnegative(),
    expectedCurrentHash: z.string().nullable(),
    /** Set when the expected current state is "file absent" (undo of a created file). */
    expectedCurrentAbsent: z.boolean().default(false),
  }),
  output: z.object({ result: operationResultSchema, review: reviewSchema }),
});

export const undoAllRpc = defineRpc({
  name: 'turn-review.undo-all',
  input: z.object({
    workspaceId: z.string().min(1),
    reviewId: z.string().min(1),
    operationId: z.string().min(1),
    expectedRevision: z.number().int().nonnegative(),
    expectedCurrentHashes: z.record(z.string(), z.string()),
  }),
  output: z.object({ results: z.record(z.string(), operationResultSchema), review: reviewSchema }),
});

export const undoHunkRpc = defineRpc({
  name: 'turn-review.undo-hunk',
  input: z.object({
    workspaceId: z.string().min(1),
    reviewId: z.string().min(1),
    path: z.string().min(1),
    hunkId: z.string().min(1),
    operationId: z.string().min(1),
    expectedRevision: z.number().int().nonnegative(),
    expectedCurrentHash: z.string().nullable(),
    expectedCurrentAbsent: z.boolean().default(false),
  }),
  output: z.object({ result: operationResultSchema, review: reviewSchema }),
});

export const restoreBackupRpc = defineRpc({
  name: 'turn-review.restore-backup',
  input: z.object({
    workspaceId: z.string().min(1),
    reviewId: z.string().min(1),
    path: z.string().min(1),
    operationId: z.string().min(1),
    expectedCurrentHash: z.string().min(1),
  }),
  output: z.object({ result: operationResultSchema, review: reviewSchema }),
});

// --------------------------------------------------------------------------
// Rolling cross-turn tracker
// --------------------------------------------------------------------------

export const trackerFileSchema = z.object({
  path: z.string(),
  kind: z.enum(['modified', 'created', 'deleted']),
  added: z.number().int().nonnegative(),
  deleted: z.number().int().nonnegative(),
  deniable: z.boolean(),
  reason: z.string().nullable(),
  turns: z.number().int().positive(),
  baselineAt: z.string(),
  currentHash: z.string().nullable(),
  fileKind: z.enum(['text', 'binary', 'symlink', 'submodule', 'other']),
});
export type TrackerFileDto = z.infer<typeof trackerFileSchema>;

export const trackerListRpc = defineRpc({
  name: 'turn-review.tracker-list',
  input: z.object({ workspaceId: z.string().min(1) }),
  output: z.object({ files: z.array(trackerFileSchema) }),
});

export const trackerDiffRpc = defineRpc({
  name: 'turn-review.tracker-diff',
  input: z.object({ workspaceId: z.string().min(1), path: z.string().min(1) }),
  output: z.object({
    hunks: z.array(hunkSchema),
    beforeLines: z.number().int().nonnegative(),
    afterLines: z.number().int().nonnegative(),
    fullReplace: z.boolean(),
    kind: z.enum(['modified', 'created', 'deleted']),
  }),
});

/** Full before/after file text for the side-by-side viewer (tracker baseline vs newest captured state). */
export const trackerFullFileRpc = defineRpc({
  name: 'turn-review.tracker-full-file',
  input: z.object({ workspaceId: z.string().min(1), path: z.string().min(1) }),
  output: z.object({
    error: z.string().nullable(),
    before: z.string().nullable(),
    after: z.string().nullable(),
    kind: z.enum(['modified', 'created', 'deleted']).nullable(),
    truncated: z.boolean(),
    // Line-level diff so the client can render VS Code-style aligned rows.
    hunks: z.array(hunkSchema),
    fullReplace: z.boolean(),
  }),
});

export type TrackerFullFileDto = z.infer<typeof trackerFullFileRpc.output>;

export const trackerAcceptRpc = defineRpc({
  name: 'turn-review.tracker-accept',
  input: z.object({
    workspaceId: z.string().min(1),
    path: z.string().min(1),
    operationId: z.string().min(1),
  }),
  output: z.object({ ok: z.boolean(), reason: z.string().nullable(), message: z.string() }),
});

export const trackerDenyRpc = defineRpc({
  name: 'turn-review.tracker-deny',
  input: z.object({
    workspaceId: z.string().min(1),
    path: z.string().min(1),
    operationId: z.string().min(1),
  }),
  output: z.object({ result: operationResultSchema }),
});

export const trackerAcceptAllRpc = defineRpc({
  name: 'turn-review.tracker-accept-all',
  input: z.object({ workspaceId: z.string().min(1) }),
  output: z.object({ results: z.record(z.string(), z.string()) }),
});

export const trackerDenyAllRpc = defineRpc({
  name: 'turn-review.tracker-deny-all',
  input: z.object({ workspaceId: z.string().min(1) }),
  output: z.object({ results: z.record(z.string(), operationResultSchema) }),
});

export const trackerRecoverableRpc = defineRpc({
  name: 'turn-review.tracker-recoverable',
  input: z.object({ workspaceId: z.string().min(1) }),
  output: z.object({
    items: z.array(z.object({
      path: z.string(),
      reviewId: z.string(),
      operationId: z.string(),
      deniedAt: z.string(),
    })),
  }),
});

export const trackerRecoverRpc = defineRpc({
  name: 'turn-review.tracker-recover',
  input: z.object({
    workspaceId: z.string().min(1),
    path: z.string().min(1),
    operationId: z.string().min(1),
  }),
  output: z.object({ result: operationResultSchema }),
});

/**
 * Fixture-only "simulate a proven turn". Produces a proven-barrier review by
 * capturing, applying a real working-tree edit, and capturing again. Gated to
 * fixture mode + fixture-allowlisted roots (see engine.fixtureRun). Content is
 * optional: when omitted a timestamped marker line is appended to `path`.
 */
export const fixtureRunRpc = defineRpc({
  name: 'turn-review.fixture-run',
  input: z.object({ workspaceId: z.string().min(1), path: z.string().min(1), content: z.string().optional() }),
  output: z.object({
    ok: z.boolean(),
    reason: z.string().nullable(),
    message: z.string(),
    reviewId: z.string().nullable(),
  }),
});

export type {
  Review,
};
