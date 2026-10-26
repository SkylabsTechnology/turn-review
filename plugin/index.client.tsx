import type { PluginClientContext } from '@getpaseo/plugin/client';
import { ReviewPanel } from './client/review-panel';
import { TurnReviewSettingsScreen } from './client/settings-screen';
import { createTurnReviewCard } from './client/turn-review-card';
import { DenyNoticeCard } from './client/deny-notice-card';
import { selectSharedFile } from './client/selection';
import { TURN_REVIEW_PANEL, TURN_REVIEW_TIMELINE_KIND, TURN_REVIEW_TIMELINE_VERSION, turnReviewCardSchema, TURN_REVIEW_DENY_KIND, TURN_REVIEW_DENY_VERSION, turnReviewDenyCardSchema } from './shared/timeline';

/**
 * Workspace-scoped Turn Review panel (Paseo 0.12 `addWorkspacePanel`).
 * Registered in BOTH `workspace` (tab — can be moved/split into the right pane
 * beside a Pi conversation via native tab controls) and `explorer` (the
 * Explorer sidebar), so it can be opened in either surface. Also registered in
 * Command Center (two commands: open as tab, or open in Explorer) and as a
 * Settings screen for the write-mode gate.
 *
 * After each turn a lightweight review card is appended to the agent's chat
 * (server-side `agent.turn_ended`). Clicking a file row on the card opens the
 * Turn Review panel focused on that file (right pane on desktop via Paseo's
 * native panel open; the chat card itself is the mobile-friendly surface).
 */
export default function contribute(client: PluginClientContext) {
  const removePanel = client.addWorkspacePanel({
    id: TURN_REVIEW_PANEL,
    title: 'Turn Review',
    icon: 'GitCompare',
    context: 'workspace',
    locations: ['workspace', 'explorer'],
    Component: ReviewPanel,
  });
  const removeCard = client.addTimelineRenderer({
    kind: TURN_REVIEW_TIMELINE_KIND,
    version: TURN_REVIEW_TIMELINE_VERSION,
    schema: turnReviewCardSchema,
    Component: createTurnReviewCard((selection) => {
      selectSharedFile(selection);
      client.openPanel(TURN_REVIEW_PANEL, { workspaceId: selection.workspaceId });
    }),
  });
  const removeDenyCard = client.addTimelineRenderer({
    kind: TURN_REVIEW_DENY_KIND,
    version: TURN_REVIEW_DENY_VERSION,
    schema: turnReviewDenyCardSchema,
    Component: DenyNoticeCard,
  });
  const removeCommand = client.addCommandCenterItem({
    id: 'open-turn-review',
    title: 'Open Turn Review',
    icon: 'GitCompare',
    keywords: ['review', 'undo', 'keep', 'diff'],
    context: 'workspace',
    onSelect({ openPanel }) {
      openPanel(TURN_REVIEW_PANEL);
    },
  });
  const removeExplorerCommand = client.addCommandCenterItem({
    id: 'open-turn-review-explorer',
    title: 'Open Turn Review in Explorer',
    icon: 'GitCompare',
    keywords: ['review', 'undo', 'keep', 'diff', 'explorer', 'sidebar'],
    context: 'workspace',
    onSelect({ openPanel }) {
      openPanel(TURN_REVIEW_PANEL, { location: 'explorer' });
    },
  });
  const removeSettings = client.addSettingsScreen({
    id: 'turn-review-settings',
    title: 'Turn Review',
    icon: 'GitCompare',
    Component: TurnReviewSettingsScreen,
  });
  return () => {
    removeSettings();
    removeExplorerCommand();
    removeCommand();
    removeDenyCard();
    removeCard();
    removePanel();
  };
}
