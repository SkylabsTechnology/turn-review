import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { type PluginWorkspacePanelProps, useRpc, useWorkspace } from '@getpaseo/plugin/client';
import { pluginInfoRpc } from '../shared/contracts';
import { TrackerFiles } from './tracker-files';
import { selectSharedFile, useSelectedFile } from './selection';

/**
 * Rolling cross-turn file-change tracker (right-side Turn Review panel).
 *
 * Every file changed since its last accept/deny/dismiss appears as one
 * accumulated row; Accept advances the baseline (metadata only), Deny rolls the
 * working tree back to the baseline (gated + CAS), and a file that cannot be
 * denied shows Dismiss (the same accept semantics). A chat card can ask the
 * panel to focus a file via the shared selection store (consumed once).
 */
export function ReviewPanel({ theme, layout, workspaceId }: PluginWorkspacePanelProps) {
  const info = useRpc(pluginInfoRpc);

  // Paseo classifies the workspace as `git` / `non_git` / `directory`. Turn
  // Review requires a Git work tree; for a non-Git workspace show a clear
  // banner instead of an empty-looking panel (a brand-new Paseo project is
  // non-git until git init, which previously looked like the plugin was
  // broken).
  const projectKind = useWorkspace(workspaceId, (w) => w.projectKind);
  const notGit = projectKind === 'non_git' || projectKind === 'directory';

  const [plugin, setPlugin] = useState<Awaited<ReturnType<typeof info>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [focusPath, setFocusPath] = useState<{ path: string; nonce: number } | null>(null);
  const focusNonce = useRef(0);

  const compact = layout.compact;
  const mobile = compact || layout.platform === 'android' || layout.platform === 'ios';

  const refreshInfo = useCallback(async () => {
    try {
      setPlugin(await info({}));
      setError(null);
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : 'Unable to load plugin status');
    }
  }, [info]);

  useEffect(() => {
    void refreshInfo();
    const timer = setInterval(() => void refreshInfo(), 5000);
    return () => clearInterval(timer);
  }, [refreshInfo]);

  // A chat card set a file selection: focus that file (auto-expand it). The
  // selection is consumed so a later open shows the plain list.
  const cardSelection = useSelectedFile();
  useEffect(() => {
    if (cardSelection && cardSelection.workspaceId === workspaceId) {
      const { path } = cardSelection;
      selectSharedFile(null);
      // Monotonic nonce so a repeat tap on the same card file re-expands it.
      setFocusPath({ path, nonce: ++focusNonce.current });
    }
  }, [cardSelection, workspaceId]);

  const s = useMemo(() => ({
    root: { flex: 1, gap: 10, padding: mobile ? 10 : 16, backgroundColor: theme.colors.surface0 },
    title: { color: theme.colors.foreground, fontSize: mobile ? 17 : 20, fontWeight: '600' as const, flexShrink: 1 },
    muted: { color: theme.colors.foregroundMuted, fontSize: 12 },
    error: { color: theme.colors.statusDanger, fontSize: 12 },
    button: { borderRadius: 8, paddingVertical: 10, paddingHorizontal: 12, minHeight: mobile ? 44 : undefined, borderWidth: 1, borderColor: theme.colors.border, alignItems: 'center' as const, justifyContent: 'center' as const },
    buttonText: { color: theme.colors.foreground, fontSize: 13 },
    header: { flexDirection: 'row' as const, justifyContent: 'space-between' as const, alignItems: 'center' as const, flexWrap: 'wrap' as const, gap: 8 },
    banner: { borderRadius: 8, borderWidth: 1, borderColor: theme.colors.statusWarning, padding: 10, backgroundColor: 'transparent' },
  }), [theme, mobile]);

  return (
    <View style={s.root}>
      <View style={s.header}>
        <Text style={s.title}>Turn Review</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Refresh" hitSlop={8} onPress={() => { void refreshInfo(); }} style={s.button}>
          <Text style={s.buttonText}>Refresh</Text>
        </Pressable>
      </View>
      {plugin ? (
        <Text style={s.muted}>
          Write mode: {plugin.undoMode === 'enabled' ? 'enabled (real projects)' : plugin.undoMode === 'fixture' ? (plugin.allowAllProjects ? 'fixture (all projects)' : 'fixture (selected projects only)') : 'disabled'} · captures stored {plugin.storageOk ? 'in plugin data' : 'unavailable'}
        </Text>
      ) : null}
      {error ? <Text style={s.error}>{error}</Text> : null}
      {notGit ? (
        <View style={s.banner}>
          <Text style={[s.muted, { color: theme.colors.statusWarning }]}>
            This workspace isn't a Git repository. Turn Review requires Git — initialize a repository in this workspace to capture and review turns here.
          </Text>
        </View>
      ) : null}
      <TrackerFiles workspaceId={workspaceId} theme={theme} layout={layout} focusPath={focusPath} />
    </View>
  );
}
