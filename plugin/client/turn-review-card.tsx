import { useEffect, useMemo } from 'react';
import { Text, View } from 'react-native';
import { type PluginTimelineItemProps } from '@getpaseo/plugin/client';
import { type TurnReviewCard } from '../shared/timeline';
import { TrackerFiles } from './tracker-files';
import { type FileSelection, notifyTrackerChanged } from './selection';

type CardTheme = PluginTimelineItemProps<TurnReviewCard>['theme'];
type CardLayout = PluginTimelineItemProps<TurnReviewCard>['layout'];

export function createTurnReviewCard(open: (selection: FileSelection) => void) {
  return function TurnReviewCard({ theme, layout, item }: PluginTimelineItemProps<TurnReviewCard>) {
    return <TurnReviewCardView theme={theme} layout={layout} data={item.data} open={open} />;
  };
}

/**
 * Live cross-turn change tracker embedded in the chat after each turn. It
 * renders the SAME rolling list as the Turn Review panel (accumulated changes
 * since the last accept/deny/dismiss) and stays in sync with panel actions.
 * Clicking a file row opens the Turn Review panel (right pane on desktop, tab
 * fallback on mobile). When nothing is left it shows "all changes accepted".
 */
function TurnReviewCardView({ theme, layout, data, open }: { theme: CardTheme; layout: CardLayout; data: TurnReviewCard; open: (s: FileSelection) => void }) {
  // This card mounts exactly when a new review is appended to the chat. Bump
  // the shared tick so every mounted Turn Review panel refreshes immediately
  // (no manual Refresh click needed).
  useEffect(() => {
    notifyTrackerChanged();
  }, []);

  const mobile = layout.compact || layout.platform === 'android' || layout.platform === 'ios';

  const s = useMemo(() => ({
    card: {
      borderWidth: 1, borderColor: theme.colors.border, borderRadius: 10,
      backgroundColor: theme.colors.surface1, padding: mobile ? 10 : 12, gap: 8, marginBottom: 4,
    },
    header: { flexDirection: 'row' as const, justifyContent: 'space-between' as const, alignItems: 'center' as const, gap: 8, flexWrap: 'wrap' as const },
    title: { color: theme.colors.foreground, fontWeight: '600' as const, fontSize: mobile ? 13 : 14, flexShrink: 1 },
    muted: { color: theme.colors.foregroundMuted, fontSize: 11 },
    warn: { color: theme.colors.statusWarning, fontSize: 11 },
  }), [theme, mobile]);

  return (
    <View style={s.card}>
      <View style={s.header}>
        <Text style={s.title}>Turn review</Text>
        <Text style={s.muted}>{new Date(data.endedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</Text>
      </View>
      {data.captureError === 'not-git-repository' ? (
        <Text style={s.warn}>
          This turn could not be captured for review because this workspace isn't a Git repository.
          Turn Review requires Git — initialize a repository in this workspace to enable review and undo.
        </Text>
      ) : (
        <>
          {data.captureStable === false ? (
            <Text style={s.warn}>
              Baseline was captured while the agent may already have been writing — only verified untouched files can be rolled back.
            </Text>
          ) : null}
          <TrackerFiles
            workspaceId={data.workspaceId}
            theme={theme}
            layout={layout}
            embedded
            onOpenFile={(path) => open({ reviewId: data.reviewId, workspaceId: data.workspaceId, path })}
          />
        </>
      )}
    </View>
  );
}
