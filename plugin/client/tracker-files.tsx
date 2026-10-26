import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { type PluginWorkspacePanelProps, useRpc } from '@getpaseo/plugin/client';
import { Icon } from '@getpaseo/plugin/client/react-native';
import {
  trackerListRpc,
  trackerDiffRpc,
  trackerAcceptRpc,
  trackerDenyRpc,
  trackerAcceptAllRpc,
  trackerDenyAllRpc,
  trackerRecoverableRpc,
  trackerRecoverRpc,
  pluginInfoRpc,
  type TrackerFileDto,
} from '../shared/contracts';
import { trackerOpId } from '../shared/op-id';
import type { Hunk, OperationResult } from '../shared/types';
import { countColor, rowLabel } from './row-label';
import { openFileDiffPane, useTrackerTick } from './selection';

type TrackerTheme = PluginWorkspacePanelProps['theme'];
type TrackerLayout = PluginWorkspacePanelProps['layout'];

interface DiffData {
  hunks: Hunk[];
  beforeLines: number;
  afterLines: number;
  fullReplace: boolean;
  kind: 'modified' | 'created' | 'deleted';
}

interface Props {
  workspaceId: string;
  theme: TrackerTheme;
  layout: TrackerLayout;
  /** Path + monotonic nonce to auto-expand once per card request (re-expands on repeat taps). */
  focusPath?: { path: string; nonce: number } | null;
  /** Compact chrome: rendered inside a timeline chat card instead of the panel. */
  embedded?: boolean;
  /** Card: tapping the file row opens the Turn Review panel on that file. */
  onOpenFile?: (path: string) => void;
}

const COUNT_ADDED = '#4caf50';
const COUNT_REMOVED = '#ef5350';

const REASON_LABEL: Record<string, string> = {
  'live-changed': 'Edited outside the review — no safe rollback',
  'multi-agent': 'Another agent is working in this repository — attribution unclear',
  unsupported: 'No exact byte baseline for rollback',
  'write-disabled': 'Write mode is disabled',
  'not-fixture': 'Repository is not on the write allowlist',
  'missing-blob': 'Stored baseline data is unavailable — rollback impossible',
};

const REMOVED_BG = 'rgba(229,57,53,0.16)';
const ADDED_BG = 'rgba(67,160,71,0.18)';
const REMOVED_SIGN = 'rgba(229,57,53,0.9)';
const ADDED_SIGN = 'rgba(67,160,71,0.95)';

/** Cheap per-file change signal: working-tree hash + accumulated counts. */
const fileSig = (f: TrackerFileDto): string =>
  `${f.currentHash ?? ''}|${f.added}|${f.deleted}|${f.turns}|${f.deniable}|${f.reason ?? ''}`;

/**
 * The rolling cross-turn file-change list shared by the Turn Review panel and
 * the per-turn chat card. One row per file with a pending change since its
 * last accept/deny/dismiss. Accept (green check) is metadata-only and advances
 * the baseline; Deny (red x) rolls the working tree back to the accumulated
 * baseline (gated + CAS); a file that cannot be denied shows Dismiss (the same
 * accept semantics) so the change can still be acknowledged and dismissed.
 */
export function TrackerFiles({ workspaceId, theme, layout, focusPath, embedded, onOpenFile }: Props) {
  const list = useRpc(trackerListRpc);
  const diff = useRpc(trackerDiffRpc);
  const accept = useRpc(trackerAcceptRpc);
  const deny = useRpc(trackerDenyRpc);
  const acceptAll = useRpc(trackerAcceptAllRpc);
  const denyAll = useRpc(trackerDenyAllRpc);
  const recoverableRpc = useRpc(trackerRecoverableRpc);
  const recoverRpc = useRpc(trackerRecoverRpc);
  const info = useRpc(pluginInfoRpc);

  const [files, setFiles] = useState<TrackerFileDto[]>([]);
  const [recoverable, setRecoverable] = useState<Array<{ path: string; operationId: string; deniedAt: string }>>([]);
  const [writeEnabled, setWriteEnabled] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [diffs, setDiffs] = useState<Record<string, DiffData>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Mirrors `expanded` so the polling `refresh` can re-fetch diffs for the rows
  // currently open without recreating itself on every expand/collapse.
  const expandedRef = useRef<Record<string, boolean>>({});
  useEffect(() => {
    expandedRef.current = expanded;
  }, [expanded]);

  // Per-path signature the diff currently shown was loaded for (see fileSig).
  // When the live file's signature differs, the open diff is stale and must be
  // re-fetched on the next refresh so it stays current across turns.
  const diffLoadedFor = useRef<Record<string, string>>({});

  const mobile = layout.compact || layout.platform === 'android' || layout.platform === 'ios';

  const loadDiff = useCallback(async (path: string, sig?: string) => {
    try {
      const result = await diff({ workspaceId, path });
      setDiffs((prev) => ({ ...prev, [path]: result }));
      if (sig !== undefined) diffLoadedFor.current[path] = sig;
      setError(null);
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : 'Unable to load diff');
    }
  }, [diff, workspaceId]);

  const refresh = useCallback(async () => {
    try {
      const [r, p, rec] = await Promise.all([list({ workspaceId }), info({}), recoverableRpc({ workspaceId })]);
      setFiles(r.files);
      setWriteEnabled(p.writeEnabled);
      setRecoverable(rec.items.map((i) => ({ path: i.path, operationId: i.operationId, deniedAt: i.deniedAt })));
      setError(null);
      // Keep an already-open diff current: re-fetch any expanded row whose file
      // signature (working-tree hash, counts, deniability) changed since its
      // diff was last loaded — e.g. a new turn edited the file. Rows whose
      // signature is unchanged are skipped so the 5s poll does not refetch.
      const byPath = new Map(r.files.map((f) => [f.path, f]));
      for (const path of Object.keys(expandedRef.current)) {
        if (!expandedRef.current[path]) continue;
        const f = byPath.get(path);
        if (!f) continue; // resolved/removed; the list render drops the row
        const sig = fileSig(f);
        if (diffLoadedFor.current[path] !== sig) {
          void loadDiff(path, sig);
        }
      }
      // Drop per-path UI state for rows that resolved (accepted/denied/dismissed)
      // so a path re-introduced by a later turn cannot briefly show the previous
      // lifecycle's diff. Non-rendered rows re-expand/re-fetch on demand.
      const livePaths = new Set(r.files.map((f) => f.path));
      setExpanded((prev) => {
        const next = { ...prev };
        for (const p of Object.keys(next)) if (!livePaths.has(p)) delete next[p];
        return next;
      });
      setDiffs((prev) => {
        const next = { ...prev };
        for (const p of Object.keys(next)) if (!livePaths.has(p)) delete next[p];
        return next;
      });
      for (const p of Object.keys(diffLoadedFor.current)) {
        if (!livePaths.has(p)) delete diffLoadedFor.current[p];
      }
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : 'Unable to load tracked changes');
    }
  }, [list, info, recoverableRpc, workspaceId, loadDiff]);

  // Refresh immediately whenever a new turn-review card is appended to the chat
  // (the card bumps a shared tick on mount), instead of waiting for the poll,
  // so the panel (and any open diff) updates at the same time the card appears.
  const trackerTick = useTrackerTick();
  useEffect(() => {
    void refresh();
  }, [refresh, trackerTick]);

  // Auto-expand a file a chat card asked to open. The nonce distinguishes a
  // repeat tap on the same file (re-expands it) from an identical prop value
  // that React would otherwise skip.
  const lastFocus = useRef<{ path: string; nonce: number } | null>(null);
  useEffect(() => {
    if (focusPath && (!lastFocus.current || lastFocus.current.nonce !== focusPath.nonce)) {
      lastFocus.current = focusPath;
      setExpanded((prev) => ({ ...prev, [focusPath.path]: true }));
      const f = files.find((x) => x.path === focusPath.path);
      void loadDiff(focusPath.path, f ? fileSig(f) : undefined);
    }
  }, [focusPath, files, loadDiff]);

  useEffect(() => {
    // Mount refresh is already handled by the tick effect above; this effect
    // only maintains the periodic poll.
    const timer = setInterval(() => void refresh(), 5000);
    return () => clearInterval(timer);
  }, [refresh]);

  const toggle = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = { ...prev };
      if (next[path]) {
        delete next[path];
      } else {
        next[path] = true;
        const f = files.find((x) => x.path === path);
        void loadDiff(path, f ? fileSig(f) : undefined);
      }
      return next;
    });
  }, [loadDiff, files]);

  const afterAction = useCallback(async (ok: boolean, message?: string) => {
    setBusy(false);
    if (ok) {
      // Refresh list; a resolved file disappears immediately.
      await refresh();
    } else {
      setError(message ?? 'Action failed');
    }
  }, [refresh]);

  const runAcceptFile = useCallback(async (path: string) => {
    setBusy(true);
    setError(null);
    try {
      const res = await accept({ workspaceId, path, operationId: trackerOpId(workspaceId, 'accept', path) });
      await afterAction(res.ok, res.reason === 'not-tracked' ? undefined : res.message);
    } catch (reason: unknown) {
      await afterAction(false, reason instanceof Error ? reason.message : 'Accept failed');
    }
  }, [accept, workspaceId, afterAction]);

  const runDenyFile = useCallback(async (path: string) => {
    const file = files.find((f) => f.path === path);
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const res = await deny({ workspaceId, path, operationId: trackerOpId(workspaceId, 'deny', path, file.currentHash) });
      const result = res.result as OperationResult;
      if (result.status !== 'ok') {
        setBusy(false);
        setError(result.message);
        await refresh();
        return;
      }
      await afterAction(true);
    } catch (reason: unknown) {
      await afterAction(false, reason instanceof Error ? reason.message : 'Deny failed');
    }
  }, [deny, files, workspaceId, afterAction, refresh]);

  const runAcceptAll = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await acceptAll({ workspaceId });
      await afterAction(true);
    } catch (reason: unknown) {
      await afterAction(false, reason instanceof Error ? reason.message : 'Accept all failed');
    }
  }, [acceptAll, workspaceId, afterAction]);

  const runDenyAll = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await denyAll({ workspaceId });
      const results = res.results as Record<string, OperationResult>;
      const failed = Object.values(results).filter((r) => r.status !== 'ok');
      if (failed.length > 0) {
        setBusy(false);
        setError(`${failed.length} file(s) could not be denied. ${failed[0]?.message ?? ''}`);
        await refresh();
        return;
      }
      await afterAction(true);
    } catch (reason: unknown) {
      await afterAction(false, reason instanceof Error ? reason.message : 'Deny all failed');
    }
  }, [denyAll, workspaceId, afterAction, refresh]);

  const runRecover = useCallback(async (path: string, operationId: string) => {
    setBusy(true);
    setError(null);
    try {
      const res = await recoverRpc({ workspaceId, path, operationId });
      if (res.result.status !== 'ok') {
        setError(res.result.message || 'Restore refused.');
      }
      await refresh();
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : 'Restore failed');
    } finally {
      setBusy(false);
    }
  }, [recoverRpc, workspaceId, refresh]);

  const anyDeniable = files.some((f) => f.deniable);
  const totalAdded = files.reduce((n, f) => n + f.added, 0);
  const totalDeleted = files.reduce((n, f) => n + f.deleted, 0);
  const empty = files.length === 0;

  const s = useMemo(() => {
    const scale = embedded ? 0.92 : 1;
    return {
      actions: { flexDirection: 'row' as const, gap: 8, flexWrap: 'wrap' as const },
      button: { borderRadius: 8, paddingVertical: mobile ? 10 : 6, paddingHorizontal: 10, minHeight: mobile ? 44 : undefined, borderWidth: 1, borderColor: theme.colors.border, alignItems: 'center' as const, justifyContent: 'center' as const, flex: 1 },
      buttonText: { color: theme.colors.foreground, fontSize: 12 },
      row: { borderTopWidth: 1, borderTopColor: theme.colors.border, paddingVertical: 6 },
      rowHead: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 6, ...(mobile ? { flexWrap: 'wrap' as const } : {}) },
      pathArea: { flex: 1, flexDirection: 'row' as const, alignItems: 'center' as const, gap: 6, minHeight: mobile ? 44 : undefined, paddingVertical: 2 },
      chevron: { color: theme.colors.foregroundMuted },
      fileName: { color: theme.colors.foreground, fontSize: 12, flexShrink: 0, fontWeight: '600' as const },
      fileDir: { color: theme.colors.foregroundMuted, fontSize: 11, flexShrink: 1 },
      fileMeta: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 6, flexWrap: 'wrap' as const },
      mono: { fontFamily: 'monospace', fontSize: 11, color: theme.colors.foreground },
      muted: { color: theme.colors.foregroundMuted, fontSize: 11 },
      error: { color: theme.colors.statusDanger, fontSize: 11 },
      summary: { color: theme.colors.foregroundMuted, fontSize: 11 },
      iconButton: { borderRadius: 8, paddingVertical: mobile ? 10 : 6, paddingHorizontal: 10, minHeight: mobile ? 44 : undefined, borderWidth: 1, borderColor: theme.colors.border, alignItems: 'center' as const, justifyContent: 'center' as const },
      iconButtonDisabled: { opacity: 0.4 },
      dismissButton: { borderRadius: 8, paddingVertical: mobile ? 10 : 6, paddingHorizontal: 10, minHeight: mobile ? 44 : undefined, borderWidth: 1, borderColor: theme.colors.border, alignItems: 'center' as const, justifyContent: 'center' as const },
      dismissText: { color: theme.colors.foregroundMuted, fontSize: 11 },
      diffBox: { marginTop: 6, borderRadius: 6, borderWidth: 1, borderColor: theme.colors.border, overflow: 'hidden' as const, maxHeight: mobile ? 260 : 340 },
      hunkHeader: { color: theme.colors.foregroundMuted, fontSize: 11, paddingVertical: 4, paddingHorizontal: 6, fontFamily: 'monospace' as const },
      lineRow: { flexDirection: 'row' as const, alignItems: 'flex-start' as const },
      sign: { width: 20, textAlign: 'center' as const, fontFamily: 'monospace' as const, fontSize: 11 },
      line: { flex: 1, fontFamily: 'monospace' as const, fontSize: 11, color: theme.colors.foreground },
      note: { color: theme.colors.foregroundMuted, fontSize: 11, padding: 8 },
      empty: { color: theme.colors.statusSuccess, fontSize: 12 },
      headerRow: { flexDirection: 'row' as const, alignItems: 'center' as const, justifyContent: 'space-between' as const, gap: 8, flexWrap: 'wrap' as const },
    };
  }, [theme, mobile, embedded]);

  const renderDiff = (file: TrackerFileDto, data: DiffData) => (
    <ScrollView style={s.diffBox} nestedScrollEnabled>
      {data.fullReplace || data.hunks.length === 0 ? (
        <Text style={s.note}>
          {data.kind === 'created' ? 'File created since the last accept/deny.' : data.kind === 'deleted' ? 'File deleted since the last accept/deny.' : data.fullReplace ? 'Diff too large; whole-file replace.' : 'No line hunks.'}
        </Text>
      ) : null}
      {data.hunks.map((hunk) => (
        <View key={hunk.id} style={{ borderBottomWidth: 1, borderBottomColor: theme.colors.border }}>
          <Text style={s.hunkHeader}>@@ -{hunk.oldStart},{hunk.oldCount} +{hunk.newStart},{hunk.newCount} @@</Text>
          {hunk.removed.map((line, i) => (
            <View key={`r${i}`} style={[s.lineRow, { backgroundColor: REMOVED_BG }]}>
              <Text style={[s.sign, { color: REMOVED_SIGN }]}>−</Text>
              <Text style={s.line}>{line || ' '}</Text>
            </View>
          ))}
          {hunk.added.map((line, i) => (
            <View key={`a${i}`} style={[s.lineRow, { backgroundColor: ADDED_BG }]}>
              <Text style={[s.sign, { color: ADDED_SIGN }]}>+</Text>
              <Text style={s.line}>{line || ' '}</Text>
            </View>
          ))}
        </View>
      ))}
    </ScrollView>
  );

  const listSection = (
    <>
      {files.map((file) => {
        const isOpen = !!expanded[file.path];
        const data = diffs[file.path];
        const { fileName, dirPath } = rowLabel(file.path);
        const addedColor = countColor(file.added, COUNT_ADDED, theme.colors.foregroundMuted);
        const removedColor = countColor(file.deleted, COUNT_REMOVED, theme.colors.foregroundMuted);
        return (
          <View key={file.path} style={s.row}>
            <View style={s.rowHead}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${isOpen ? 'Collapse' : 'Expand'} ${file.path}`}
                hitSlop={4}
                onPress={() => (onOpenFile ? onOpenFile(file.path) : toggle(file.path))}
                style={s.pathArea}
              >
                <Icon name={isOpen ? 'ChevronDown' : 'ChevronRight'} size={14} color={s.chevron.color} />
                <Text style={s.fileName} numberOfLines={1}>{fileName}</Text>
                {dirPath ? <Text style={s.fileDir} numberOfLines={mobile ? 2 : 1}>{dirPath}</Text> : null}
                <View style={s.fileMeta}>
                  <Text style={[s.mono, { color: addedColor }]}>+{file.added}</Text>
                  <Text style={[s.mono, { color: removedColor }]}>−{file.deleted}</Text>
                  {file.turns > 1 ? <Text style={s.muted}>{file.turns} turns</Text> : null}
                </View>
              </Pressable>
              <View style={{ flexDirection: 'row' as const, gap: 6 }}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`View full diff for ${file.path}`}
                  hitSlop={8}
                  disabled={busy}
                  onPress={() => openFileDiffPane(workspaceId, file.path)}
                  style={[s.iconButton, busy && s.iconButtonDisabled, { borderColor: theme.colors.border }]}
                >
                  <Icon name="FileDiff" size={18} color={theme.colors.foregroundMuted} />
                </Pressable>
                {file.deniable ? (
                  <>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Accept ${file.path}`}
                      hitSlop={8}
                      disabled={busy}
                      onPress={() => void runAcceptFile(file.path)}
                      style={[s.iconButton, busy && s.iconButtonDisabled, { borderColor: theme.colors.statusSuccess }]}
                    >
                      <Icon name="Check" size={18} color={theme.colors.statusSuccess} />
                    </Pressable>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Deny ${file.path}`}
                      hitSlop={8}
                      disabled={busy}
                      onPress={() => void runDenyFile(file.path)}
                      style={[s.iconButton, busy && s.iconButtonDisabled, { borderColor: theme.colors.statusDanger }]}
                    >
                      <Icon name="X" size={18} color={theme.colors.statusDanger} />
                    </Pressable>
                  </>
                ) : (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Dismiss ${file.path}`}
                    hitSlop={8}
                    disabled={busy}
                    onPress={() => void runAcceptFile(file.path)}
                    style={[s.dismissButton, busy && s.iconButtonDisabled]}
                  >
                    <Text style={s.dismissText}>Dismiss</Text>
                  </Pressable>
                )}
              </View>
            </View>
            {!file.deniable ? (
              <Text style={[s.muted, { marginTop: 2 }]}>Cannot be denied: {REASON_LABEL[file.reason ?? ''] ?? file.reason ?? 'unsafe to roll back'}.</Text>
            ) : null}
            {isOpen && data ? renderDiff(file, data) : null}
          </View>
        );
      })}

      {recoverable.length > 0 ? (
        <View style={{ borderTopWidth: 1, borderTopColor: theme.colors.border, paddingTop: 8, gap: 6 }}>
          <Text style={[s.summary, { fontWeight: '600' as const }]}>Restore a denied change</Text>
          {recoverable.map((item) => (
            <View key={item.operationId} style={{ flexDirection: 'row' as const, alignItems: 'center' as const, gap: 6, flexWrap: 'wrap' as const }}>
              <Text style={[s.mono, { flexShrink: 1 }]} numberOfLines={1}>{item.path}</Text>
              <Text style={s.muted}>{new Date(item.deniedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Restore ${item.path}`}
                hitSlop={8}
                disabled={busy}
                onPress={() => void runRecover(item.path, item.operationId)}
                style={[s.dismissButton, busy && s.iconButtonDisabled, { borderColor: theme.colors.statusWarning }]}
              >
                <Text style={[s.dismissText, { color: theme.colors.statusWarning }]}>Restore</Text>
              </Pressable>
            </View>
          ))}
          <Text style={s.muted}>Restore is available only until the next turn starts on this repository.</Text>
        </View>
      ) : null}
    </>
  );

  return (
    <View style={embedded ? { gap: 8 } : { flex: 1, gap: 8 }}>
      <View style={s.headerRow}>
        <Text style={s.summary}>
          {empty ? 'All changes accepted ✓' : `${files.length} ${files.length === 1 ? 'file' : 'files'} changed · +${totalAdded} −${totalDeleted}`}
        </Text>
      </View>
      {!empty ? (
        <View style={s.actions}>
          <Pressable accessibilityRole="button" hitSlop={8} disabled={busy} onPress={() => void runAcceptAll()} style={[s.button, busy && s.iconButtonDisabled]}>
            <Text style={s.buttonText}>Accept all</Text>
          </Pressable>
          <Pressable accessibilityRole="button" hitSlop={8} disabled={busy || !anyDeniable} onPress={() => void runDenyAll()} style={[s.button, (busy || !anyDeniable) && s.iconButtonDisabled]}>
            <Text style={[s.buttonText, { color: theme.colors.statusDanger }]}>Deny all</Text>
          </Pressable>
        </View>
      ) : null}
      {error ? <Text style={s.error}>{error}</Text> : null}
      {!writeEnabled && !empty ? (
        <Text style={s.muted}>Deny (rollback) is disabled — no write mode. Files can be accepted or dismissed.</Text>
      ) : null}
      {/* The header + Accept/Deny all actions stay fixed; only the file list
          scrolls, so on a bounded-height panel (especially mobile) the actions
          remain visible while the list scrolls under them. Embedded cards keep
          natural flow (no inner scroll). */}
      {embedded ? (
        listSection
      ) : (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 8 }} nestedScrollEnabled>
          {listSection}
        </ScrollView>
      )}
    </View>
  );
}
