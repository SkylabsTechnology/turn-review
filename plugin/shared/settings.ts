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
export const turnReviewSettings = defineSettings({
  id: 'turn-review',
  scope: 'host',
  version: 1,
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
  }),
});

export type TurnReviewSettingsValues = z.infer<typeof turnReviewSettings.schema>;
