import { useSyncExternalStore } from 'react';
import type { PluginClientContext } from '@getpaseo/plugin/client';
import { TURN_REVIEW_DIFF_PANEL } from '../shared/timeline';

/**
 * The clicked file travels from a chat card to the Turn Review panel through
 * this tiny module-level store, because `openPanel` opens a panel by id only.
 * Same pattern the reference turn-diff plugin uses.
 */
export interface FileSelection {
  reviewId: string;
  workspaceId: string;
  path: string;
}

let selection: FileSelection | null = null;
const listeners = new Set<() => void>();

export function selectSharedFile(next: FileSelection | null): void {
  selection = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The file a chat card asked the Turn Review panel to open, if any. */
export function useSelectedFile(): FileSelection | null {
  return useSyncExternalStore(subscribe, () => selection);
}

// ---------------------------------------------------------------------------
// Live-refresh tick
//
// When a new turn-review card mounts in the chat, it bumps this counter so any
// mounted Turn Review panel (Explorer/tab) refreshes immediately instead of
// waiting for its polling interval. Same module-level-store pattern as the
// selection above.
// ---------------------------------------------------------------------------

let trackerTick = 0;
const tickListeners = new Set<() => void>();

/** Signal that a turn-review card was just added (call from card mount). */
export function notifyTrackerChanged(): void {
  trackerTick += 1;
  for (const listener of tickListeners) listener();
}

function subscribeTick(listener: () => void): () => void {
  tickListeners.add(listener);
  return () => tickListeners.delete(listener);
}

/** Re-renders + lets a component react whenever a new review card appears. */
export function useTrackerTick(): number {
  return useSyncExternalStore(subscribeTick, () => trackerTick);
}

// ---------------------------------------------------------------------------
// Side-by-side full-file diff pane
//
// The row diff button asks the plugin client to open the dedicated diff panel
// (a second workspace panel, `turn-review-diff`) and hands it the file through
// this same module-level-store mechanism, because `openPanel` only accepts a
// panel id + workspace id. The `client` context is stashed on registration
// (contribute) so both the workspace panel and the embedded chat card can open
// the diff pane — mirrors how the server stashes `paseo` in paseoHolder.
// ---------------------------------------------------------------------------

export interface DiffSelection {
  workspaceId: string;
  path: string;
  nonce: number;
}

let diffSelection: DiffSelection | null = null;
const diffListeners = new Set<() => void>();
let clientContext: PluginClientContext | null = null;

/** Stash the plugin client context on registration (call from contribute). */
export function setClientContext(client: PluginClientContext | null): void {
  clientContext = client;
}

function subscribeDiff(listener: () => void): () => void {
  diffListeners.add(listener);
  return () => diffListeners.delete(listener);
}

/** The file the side-by-side viewer should show, if any. */
export function useDiffSelection(): DiffSelection | null {
  return useSyncExternalStore(subscribeDiff, () => diffSelection);
}

/** Record the file to view (repeat taps bump the nonce so a stale pane reloads). */
export function selectDiffFile(workspaceId: string, path: string): void {
  diffSelection = { workspaceId, path, nonce: (diffSelection?.nonce ?? 0) + 1 };
  for (const listener of diffListeners) listener();
}

/** Select the file and open the side-by-side diff pane in the same workspace. */
export function openFileDiffPane(workspaceId: string, path: string): void {
  selectDiffFile(workspaceId, path);
  clientContext?.openPanel(TURN_REVIEW_DIFF_PANEL, { workspaceId });
}
