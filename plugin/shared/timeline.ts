import { z } from 'zod';

/**
 * Timeline card payload for a completed turn. The card is a lightweight
 * summary appended to the agent's chat after `agent.turn_ended`; the full
 * review + hunks stay in the review engine (single source of truth). The
 * client card fetches fresh per-file status via `turn-review.get`.
 */
export const TURN_REVIEW_TIMELINE_KIND = 'turn-review';
export const TURN_REVIEW_TIMELINE_VERSION = 1;
/**
 * Legacy kind for old rollback chat notices already persisted in a
 * conversation. No new cards are created (DECISIONS §22, user-directed); deny
 * outcomes are surfaced inline on tracker file rows instead. Kept so existing
 * timeline items still render (see client/deny-notice-card.tsx).
 */
export const TURN_REVIEW_DENY_KIND = 'turn-review-deny';
export const TURN_REVIEW_DENY_VERSION = 1;
/** id used for the workspace panel; the chat card opens it via openPanel(). */
export const TURN_REVIEW_PANEL = 'turn-review';
/** id of the side-by-side full-file diff pane (opened by the row diff button). */
export const TURN_REVIEW_DIFF_PANEL = 'turn-review-diff';
/** Files kept in a card row; the rest are only counted ("and N more"). */
export const TURN_REVIEW_MAX_CARD_FILES = 20;

export const turnReviewCardSchema = z.object({
  reviewId: z.string(),
  workspaceId: z.string(),
  agentId: z.string(),
  endedAt: z.string(),
  /** False when the before-capture may have raced the agent's writes. */
  captureStable: z.boolean(),
  /**
   * Set when the turn could not be captured because the workspace is not a
   * Git repository; the card renders a "requires Git" notice instead of a
   * file list, so a newly created non-Git workspace is not silent.
   */
  captureError: z.enum(['not-git-repository', 'missing-directory']).nullable().optional(),
  fileCount: z.number().int().nonnegative(),
  added: z.number().int().nonnegative(),
  deleted: z.number().int().nonnegative(),
  /** Per-file +/- line counts from the turn snapshots; null = no text diff (binary/large). */
  files: z.array(
    z.object({
      path: z.string(),
      kind: z.enum(['modified', 'created', 'deleted']),
      added: z.number().int().nonnegative().nullable(),
      deleted: z.number().int().nonnegative().nullable(),
      /** True when the file has an exact byte baseline so Undo can revert it. */
      undoExact: z.boolean(),
      /** Status at append time; the card refreshes it from the review on the client. */
      status: z.enum(['pending', 'kept', 'conflict', 'unsupported']),
    }),
  ),
});
export type TurnReviewCard = z.output<typeof turnReviewCardSchema>;

export function turnReviewCardHeader(data: TurnReviewCard): string {
  const files = `${data.fileCount} ${data.fileCount === 1 ? 'file' : 'files'} changed`;
  if (data.fileCount === 0) return files;
  return `${files} +${data.added} −${data.deleted}`;
}

/**
 * Payload for legacy rollback notices (see TURN_REVIEW_DENY_KIND); the client
 * shows a muted "Change rolled back" confirmation for already-persisted items.
 */
export const turnReviewDenyCardSchema = z.object({
  operationId: z.string(),
  workspaceId: z.string(),
  agentId: z.string(),
  path: z.string(),
  deniedAt: z.string(),
  /** True when the restore window was still open at append time. */
  recoverable: z.boolean(),
});
export type TurnReviewDenyCard = z.output<typeof turnReviewDenyCardSchema>;
