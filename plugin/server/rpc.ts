import type { PluginServerContext, PluginHandlerContext } from '@getpaseo/plugin/server';
import { ReviewEngine, type SettingsSnapshot } from './review-engine';
import { openStorage, type Storage } from './storage';
import { turnReviewSettings } from '../shared/settings';
import {
  pluginInfoRpc,
  listReviewsRpc,
  getReviewRpc,
  getFileDiffRpc,
  keepAllRpc,
  keepFileRpc,
  keepHunkRpc,
  undoFileRpc,
  undoAllRpc,
  undoHunkRpc,
  restoreBackupRpc,
  trackerListRpc,
  trackerDiffRpc,
  trackerAcceptRpc,
  trackerDenyRpc,
  trackerAcceptAllRpc,
  trackerDenyAllRpc,
  trackerRecoverableRpc,
  trackerRecoverRpc,
  listProjectsRpc,
  fixtureRunRpc,
  type ReviewDto,
} from '../shared/contracts';

export interface RpcWireOptions {
  storage?: Storage;
  onReviewChanged?: (review: ReviewDto) => void;
  /** Optional: fired when a Deny rollback succeeds (chat notice). */
  onDenyApplied?: (info: { agentId: string; workspaceId: string; path: string; operationId: string }) => void;
}

/**
 * The daemon PaseoApi is only exposed per handler/hook invocation. Handlers
 * store it here so the engine's idle check can query live agent state.
 */

/**
 * The daemon SDK type, resolved through the allowed server entry. `@getpaseo/client`
 * is a client SDK entry and cannot be imported from server code (Paseo build
 * boundary), even as a type — so PaseoApi is derived from the handler context.
 */
type PaseoApi = PluginHandlerContext['paseo'];

export const paseoHolder: { current: PaseoApi | null } = { current: null };

function capturePaseo(context: PluginHandlerContext): void {
  paseoHolder.current = context.paseo;
}

function mapSettings(values: { undoMode: 'disabled' | 'fixture' | 'enabled'; fixtureRoots: string[]; allowAllProjects?: boolean; maxFileBytes: number; retentionDays: number; maxProjectBytes?: number; denyPaths: string[] }): SettingsSnapshot {
  return {
    undoMode: values.undoMode,
    fixtureRoots: values.fixtureRoots,
    allowAllProjects: values.allowAllProjects === true,
    maxFileBytes: values.maxFileBytes,
    retentionDays: values.retentionDays,
    maxProjectBytes: values.maxProjectBytes,
    denyPaths: values.denyPaths,
  };
}

/**
 * Register the plugin's RPC surface and return the shared engine instance that
 * the lifecycle layer also drives. All filesystem work stays in the engine.
 */
export function wireRpc(server: PluginServerContext, options: RpcWireOptions): ReviewEngine {
  const storage = options.storage ?? openStorage();
  const settingsApi = server.registerSettings(turnReviewSettings);

  const getSettings = async (): Promise<SettingsSnapshot> => {
    try {
      const state = await settingsApi.read();
      if (state.status === 'ready') return mapSettings(state.values);
    } catch {
      // fall through to defaults
    }
    return { undoMode: 'disabled', fixtureRoots: [], allowAllProjects: false, maxFileBytes: 1024 * 1024, retentionDays: 30, maxProjectBytes: 1024 * 1024 * 1024, denyPaths: [] };
  };

  const engine = new ReviewEngine({
    storage,
    getSettings,
    isAgentRunning: async (agentId: string) => {
      try {
        const paseo = paseoHolder.current;
        if (!paseo) return true; // cannot confirm idle -> fail closed
        const handle = paseo.agents.ref(agentId);
        await handle.refresh();
        const status = handle.status;
        return status === 'running' || status === 'initializing' || status === null;
      } catch {
        // If we cannot confirm the agent is idle, treat it as busy (fail closed).
        return true;
      }
    },
    // Find an idle real agent for the workspace so a fixture-run review passes
    // the writer-active gate on Deny (never fabricates a running agent).
    findIdleAgent: async (workspaceId: string | null) => {
      try {
        const paseo = paseoHolder.current;
        if (!paseo) return null;
        const result = await paseo.agents.list({ filter: { statuses: ['idle'] } });
        const entry = result.entries.find((e) => e.agent.workspaceId === workspaceId && e.agent.status === 'idle');
        return entry ? entry.agent.id : null;
      } catch {
        return null;
      }
    },
    onReviewChanged: options.onReviewChanged,
    onDenyApplied: options.onDenyApplied,
  });
  engine.load();
  // Retention/cap GC at startup and periodically (synchronous critical section
  // inside gc(), so it is safe against concurrent journal appends).
  void engine.gc();
  const gcTimer = setInterval(() => void engine.gc(), 5 * 60 * 1000);
  gcTimer.unref?.();

  const toDto = (r: unknown): ReviewDto => r as ReviewDto;

  server.handle(pluginInfoRpc, async (_input, ctx) => { capturePaseo(ctx); return engine.pluginInfo(); });
  server.handle(listProjectsRpc, async (_input, ctx) => {
    capturePaseo(ctx);
    try {
      const result = await ctx.paseo.projects.list();
      const projects = result.projects.map((p) => ({
        id: p.projectId,
        name: p.projectCustomName ?? p.projectDisplayName,
        root: p.projectRootPath,
        kind: p.projectKind,
      }));
      return { projects };
    } catch {
      // The daemon API can be unavailable on some hosts; fail closed with an
      // empty list rather than crashing the settings screen.
      return { projects: [] };
    }
  });
  server.handle(listReviewsRpc, ({ workspaceId, limit }, ctx) => {
    capturePaseo(ctx);
    return { reviews: engine.list(workspaceId, limit).map(toDto) };
  });
  server.handle(getReviewRpc, ({ reviewId }, ctx) => {
    capturePaseo(ctx);
    const review = engine.get(reviewId);
    if (!review) throw new Error('review-not-found');
    return { review: toDto(review) };
  });
  server.handle(getFileDiffRpc, async ({ reviewId, path }, ctx) => {
    capturePaseo(ctx);
    const result = await engine.fileDiff(reviewId, path);
    if ('error' in result) throw new Error(result.error);
    return result;
  });

  server.handle(keepAllRpc, async ({ workspaceId, reviewId, operationId, expectedRevision }, ctx) => {
    capturePaseo(ctx);
    const outcome = await engine.keep(reviewId, workspaceId, expectedRevision, operationId, { kind: 'all' });
    if (!outcome.ok || !outcome.review) throw new Error(outcome.reason ?? 'keep-failed');
    return { review: toDto(outcome.review) };
  });
  server.handle(keepFileRpc, async ({ workspaceId, reviewId, path, operationId, expectedRevision }, ctx) => {
    capturePaseo(ctx);
    const outcome = await engine.keep(reviewId, workspaceId, expectedRevision, operationId, { kind: 'file', path });
    if (!outcome.ok || !outcome.review) throw new Error(outcome.reason ?? 'keep-failed');
    return { review: toDto(outcome.review) };
  });
  server.handle(keepHunkRpc, async ({ workspaceId, reviewId, path, hunkId, operationId, expectedRevision }, ctx) => {
    capturePaseo(ctx);
    const outcome = await engine.keep(reviewId, workspaceId, expectedRevision, operationId, { kind: 'hunk', path, hunkId });
    if (!outcome.ok || !outcome.review) throw new Error(outcome.reason ?? 'keep-failed');
    return { review: toDto(outcome.review) };
  });

  server.handle(undoFileRpc, async ({ workspaceId, reviewId, path, operationId, expectedRevision, expectedCurrentHash, expectedCurrentAbsent }, ctx) => {
    capturePaseo(ctx);
    const outcome = await engine.undoFile(reviewId, workspaceId, expectedRevision, operationId, path, expectedCurrentHash, expectedCurrentAbsent);
    return { result: outcome.result, review: toDto(outcome.review) };
  });
  server.handle(undoHunkRpc, async ({ workspaceId, reviewId, path, hunkId, operationId, expectedRevision, expectedCurrentHash, expectedCurrentAbsent }, ctx) => {
    capturePaseo(ctx);
    const outcome = await engine.undoHunk(reviewId, workspaceId, expectedRevision, operationId, path, hunkId, expectedCurrentHash, expectedCurrentAbsent);
    return { result: outcome.result, review: toDto(outcome.review) };
  });
  server.handle(undoAllRpc, async ({ workspaceId, reviewId, operationId, expectedRevision, expectedCurrentHashes }, ctx) => {
    capturePaseo(ctx);
    const hashes: Record<string, string> = expectedCurrentHashes as Record<string, string>;
    const outcome = await engine.undoAll(reviewId, workspaceId, expectedRevision, operationId, hashes);
    return { results: outcome.results, review: toDto(outcome.review) };
  });
  server.handle(restoreBackupRpc, async ({ workspaceId, reviewId, path, operationId, expectedCurrentHash }, ctx) => {
    capturePaseo(ctx);
    const outcome = await engine.restoreBackup(reviewId, workspaceId, operationId, path, expectedCurrentHash);
    return { result: outcome.result, review: toDto(outcome.review) };
  });

  server.handle(trackerListRpc, async ({ workspaceId }, ctx) => {
    capturePaseo(ctx);
    return { files: await engine.trackerList(workspaceId) };
  });
  server.handle(trackerDiffRpc, async ({ workspaceId, path }, ctx) => {
    capturePaseo(ctx);
    const result = await engine.trackerDiff(workspaceId, path);
    if ('error' in result) throw new Error(result.error);
    return result;
  });
  server.handle(trackerAcceptRpc, async ({ workspaceId, path, operationId }, ctx) => {
    capturePaseo(ctx);
    const outcome = await engine.trackerAccept(workspaceId, path, operationId);
    return { ok: outcome.ok, reason: outcome.reason ?? null, message: outcome.message ?? '' };
  });
  server.handle(trackerDenyRpc, async ({ workspaceId, path, operationId }, ctx) => {
    capturePaseo(ctx);
    const outcome = await engine.trackerDeny(workspaceId, path, operationId);
    return { result: outcome.result };
  });
  server.handle(trackerAcceptAllRpc, async ({ workspaceId }, ctx) => {
    capturePaseo(ctx);
    return await engine.trackerAcceptAll(workspaceId);
  });
  server.handle(trackerDenyAllRpc, async ({ workspaceId }, ctx) => {
    capturePaseo(ctx);
    return await engine.trackerDenyAll(workspaceId);
  });
  server.handle(trackerRecoverableRpc, async ({ workspaceId }, ctx) => {
    capturePaseo(ctx);
    const items = await engine.trackerRecoverable(workspaceId);
    return { items };
  });
  server.handle(trackerRecoverRpc, async ({ workspaceId, path, operationId }, ctx) => {
    capturePaseo(ctx);
    const outcome = await engine.trackerRecover(workspaceId, path, operationId);
    return { result: outcome.result };
  });
  server.handle(fixtureRunRpc, async ({ workspaceId, path, content }, ctx) => {
    capturePaseo(ctx);
    const r = await engine.fixtureRun({ workspaceId, path, content });
    if (r.ok) return { ok: true, reason: null, message: '', reviewId: r.reviewId };
    return { ok: false, reason: r.reason, message: r.message, reviewId: null };
  });

  return engine;
}
