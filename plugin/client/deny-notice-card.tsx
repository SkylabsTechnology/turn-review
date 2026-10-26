import { Text, View } from 'react-native';
import { type PluginTimelineItemProps } from '@getpaseo/plugin/client';
import type { TurnReviewDenyCard } from '../shared/timeline';

type CardTheme = PluginTimelineItemProps<TurnReviewDenyCard>['theme'];
type CardLayout = PluginTimelineItemProps<TurnReviewDenyCard>['layout'];

/**
 * Legacy renderer for older "rollback" chat notices already persisted in a
 * conversation. No new cards are created (DECISIONS §22, user-directed): a
 * Deny never failed, so a separate card was confusing, and deny/restore
 * outcomes are surfaced inline on the tracker file rows in the Turn Review
 * panel and the embedded per-turn chat card instead. This renderer therefore
 * shows a quiet, accurate confirmation for items that already exist, with no
 * Restore action (restore lives in the tracker's "Restore a denied change"
 * section).
 */
export function DenyNoticeCard({ theme, layout, item }: PluginTimelineItemProps<TurnReviewDenyCard>) {
  const mobile = layout.compact || layout.platform === 'android' || layout.platform === 'ios';
  const data = item.data;

  const s = {
    card: {
      borderWidth: 1, borderColor: theme.colors.border, borderRadius: 10,
      backgroundColor: theme.colors.surface1, padding: mobile ? 10 : 12, gap: 4, marginBottom: 4,
    },
    title: { color: theme.colors.foreground, fontWeight: '600' as const, fontSize: mobile ? 13 : 14 },
    path: { color: theme.colors.foregroundMuted, fontSize: 12, fontFamily: 'monospace' as const },
    muted: { color: theme.colors.foregroundMuted, fontSize: 11 },
  };

  return (
    <View style={s.card}>
      <Text style={s.title}>Change rolled back</Text>
      <Text style={s.path}>{data.path}</Text>
      <Text style={s.muted}>The file was reverted to its pre-turn state. Open Turn Review — while the rollback window is open, the change can be restored there (it then returns as an accept/deny row).</Text>
    </View>
  );
}
