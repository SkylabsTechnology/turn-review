import { useSyncExternalStore } from 'react';

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
