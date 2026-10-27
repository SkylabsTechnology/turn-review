import { defineSettings } from '@getpaseo/plugin';
import { z } from 'zod';

/**
 * Host-scoped Turn Review settings.
 *
 * Safety: write features (Undo) default to `disabled`. Write modes:
 * `fixture` restricts rollback to repositories whose canonical root is listed
 * in `fixtureRoots` (or every repository with `allowAllProjects`); `enabled`
 * is real-project mode — every repository is eligible. Both non-disabled
 * modes run the same safety stack (capture completeness, ambiguity, repo
 * identity, writer-active, live-match/CAS); `disabled` never writes.
 */
/** The exact syntax-highlight theme ids Paseo ships (packages/highlight/src/themes.ts). */
const syntaxThemeIds = [
  'github',
  'catppuccin',
  'dracula',
  'tokyo-night',
  'one',
  'nord',
  'gruvbox',
  'solarized',
] as const;

/** A selectable syntax-highlight theme id (mirrors Paseo's SyntaxThemeId). */
export type SyntaxThemeId = (typeof syntaxThemeIds)[number];

/** Map pre-0.13 syntaxTheme values to the Paseo theme set (v1 → v2 migration). */
const LEGACY_SYNTAX_THEME: Record<string, SyntaxThemeId> = {
  auto: 'one',
  'dark-modern': 'github',
  'light-modern': 'github',
  'github-dark': 'github',
  'github-light': 'github',
  monokai: 'dracula',
  'solarized-dark': 'solarized',
  'solarized-light': 'solarized',
  nord: 'nord',
  dracula: 'dracula',
};

export const turnReviewSettings = defineSettings({
  id: 'turn-review',
  scope: 'host',
  version: 2,
  migrate: (values, fromVersion) => {
    if (fromVersion >= 2) return values;
    const v = (values ?? {}) as Record<string, unknown>;
    const old = v.syntaxTheme as string | undefined;
    const syntaxTheme = (old && LEGACY_SYNTAX_THEME[old]) || 'one';
    return { ...v, syntaxTheme };
  },
  schema: z.object({
    /** Write mode: 'disabled' | 'fixture' (allowlist-scoped) | 'enabled' (real projects). */
    undoMode: z.enum(['disabled', 'fixture', 'enabled']).default('disabled'),
    fixtureRoots: z.array(z.string().min(1)).default([]),
    /** When true, fixture write mode applies to every project (no allowlist). */
    allowAllProjects: z.boolean().default(false),
    /** Per-file raw-byte capture cap. Files over this are keep-only (or excluded). */
    maxFileBytes: z.number().int().min(1024).max(50 * 1024 * 1024).default(1024 * 1024),
    /** Retention for journal + backups, in days. */
    retentionDays: z.number().int().min(1).max(365).default(30),
    /** Per-project storage cap in bytes (0 = unlimited). GC prunes oldest resolved data to stay under it. */
    maxProjectBytes: z.number().int().min(0).default(1024 * 1024 * 1024),
    /** Extra path fragments never captured (secret/sensitive names). */
    denyPaths: z.array(z.string().min(1)).default([]),
    /**
     * Syntax token palette for the full-file diff and Turn Review inline diffs.
     * Uses Paseo's own highlight themes (github, catppuccin, dracula,
     * tokyo-night, one, nord, gruvbox, solarized). Like Paseo, a theme is a
     * single id resolved against the app's light/dark (dracula is fixed).
     */
    syntaxTheme: z.enum(syntaxThemeIds).default('one'),
  }),
});

export type TurnReviewSettingsValues = z.infer<typeof turnReviewSettings.schema>;
