import type { PluginServerContext } from '@getpaseo/plugin/server';
import { wireRpc, paseoHolder } from './server/rpc';
import { TURN_REVIEW_TIMELINE_KIND, TURN_REVIEW_TIMELINE_VERSION } from './shared/timeline';

/**
 * Turn Review server entry.
 *
 * Lifecycle observation is best-effort (Paseo events are not a synchronous
 * pre-edit barrier). Since the user-authorized policy change (DECISIONS §17),
 * the gate for Undo is a complete before/after capture PLUS the write-mode
 * gate PLUS CAS/live-match, ambiguity, repo identity and writer-active checks
 * — not the capture-barrier label. Write modes: `fixture` (allowlist-scoped)
 * and `enabled` (real-project mode, every repository), both gated by the same
 * safety stack; `disabled` never writes.
 */
export default function contribute(server: PluginServerContext) {
  // No chat card is appended on Deny. Deny outcomes (and Restore = rewind) are
  // already surfaced inline on the tracker file rows in the Turn Review panel
  // and the embedded per-turn chat card — a separate "Rollback denied" card
  // read like a failure even though the rollback always worked (DECISIONS §22,
  // user-directed). The engine still exposes the optional `onDenyApplied` hook
  // (tested by the suite); we simply do not create a timeline card for it.
  const engine = wireRpc(server, {});

  // Per-agent FIFO of occurrence ids so queued turns end in start order.
  const pendingByAgent = new Map<string, string[]>();
  const queue = (agentId: string, occurrenceId: string) => {
    const list = pendingByAgent.get(agentId) ?? [];
    list.push(occurrenceId);
    pendingByAgent.set(agentId, list);
  };
  const shift = (agentId: string): string | undefined => {
    const list = pendingByAgent.get(agentId);
    if (!list || list.length === 0) return undefined;
    const first = list.shift();
    if (list.length === 0) pendingByAgent.delete(agentId);
    return first;
  };

  const cleanupStart = server.on('agent.turn_started', async ({ agent, turnId }, context) => {
    paseoHolder.current = context.paseo;
    try {
      const occurrenceId = await engine.startTurn({
        agentId: agent.id,
        workspaceId: agent.workspaceId,
        cwd: agent.cwd,
        turnId,
        barrier: 'event-best-effort',
      });
      queue(agent.id, occurrenceId);
    } catch (error) {
      console.error('[turn-review] start capture failed', error);
    }
  });

  const cleanupEnd = server.on('agent.turn_ended', async ({ agent, outcome, turnId }, context) => {
    paseoHolder.current = context.paseo;
    let reviewId: string | null = null;
    try {
      const occurrenceId = shift(agent.id);
      if (occurrenceId) {
        const review = await engine.endTurn({
          occurrenceId,
          agentId: agent.id,
          workspaceId: agent.workspaceId,
          cwd: agent.cwd,
          outcome: outcome.kind,
          barrier: 'event-best-effort',
        });
        reviewId = review?.id ?? null;
      } else {
        engine.recordUncapturedEnd({
          occurrenceId: turnId ?? 'unknown',
          agentId: agent.id,
          workspaceId: agent.workspaceId,
          cwd: agent.cwd,
          outcome: outcome.kind,
          barrier: 'event-best-effort',
        });
      }
    } catch (error) {
      console.error('[turn-review] end capture failed', error);
    }
    // Append a lightweight review card to the chat after the turn. Additive,
    // read-only; never fails the hook and never changes capture behavior.
    if (reviewId) {
      try {
        const card = await engine.timelineCard(reviewId);
        if (card) {
          await context.paseo.agents.ref(agent.id).timeline.append({
            type: 'plugin',
            id: `turn-review:${reviewId}`,
            kind: TURN_REVIEW_TIMELINE_KIND,
            version: TURN_REVIEW_TIMELINE_VERSION,
            data: card,
          });
        }
      } catch (error) {
        console.error('[turn-review] timeline card failed', error);
      }
    }
  });

  return () => {
    cleanupStart();
    cleanupEnd();
  };
}
