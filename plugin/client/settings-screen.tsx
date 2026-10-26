import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { useSettings, useRpc, type PluginSurfaceProps } from '@getpaseo/plugin/client';
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
  type SettingsInputHandle,
} from '@getpaseo/plugin/client/ui';
import { turnReviewSettings } from '../shared/settings';
import { listProjectsRpc, type ProjectRefDto } from '../shared/contracts';
import type { SettingsState } from '@getpaseo/plugin/client';

type Ready = Extract<SettingsState<typeof turnReviewSettings.schema>, { status: 'ready' }>;

/**
 * Host settings for the write-mode gate. Defaults keep Undo disabled. The only
 * non-disabled mode is `fixture`, which restricts rollback to the projects the
 * user picked (or, with "allow for all projects", every project). Real projects
 * are never written unless write mode is enabled for them here.
 *
 * The project scope is selected from Paseo's own project list (a project maps
 * to its root path), so users pick a project instead of typing a path.
 *
 * NOTE on persistence: `SettingsInput` owns in-progress text (it is
 * uncontrolled, seeded by `initialValue`). We therefore read the current text
 * through the input ref (`getText()`) at save time rather than trusting a
 * change-event draft, and we surface `saveError`/`saving` instead of failing
 * silently. After a successful write we reload so the screen holds a fresh
 * revision (the settings query never auto-refetches, and a stale revision
 * makes the daemon reject the next write).
 */
export function TurnReviewSettingsScreen({ theme }: PluginSurfaceProps) {
  const settings = useSettings(turnReviewSettings);
  const listProjects = useRpc(listProjectsRpc);

  const bytesRef = useRef<SettingsInputHandle>(null);
  const retentionRef = useRef<SettingsInputHandle>(null);
  const capRef = useRef<SettingsInputHandle>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [projects, setProjects] = useState<ProjectRefDto[]>([]);
  const [pickerRoot, setPickerRoot] = useState<string | null>(null);

  const ready = settings.status === 'ready' ? settings : null;
  const style = useMemo(() => ({ label: { color: theme.colors.foreground }, muted: { color: theme.colors.foregroundMuted }, warn: { color: theme.colors.statusWarning } }), [theme]);

  // Load Paseo projects for the picker; refresh after every settings reload too.
  const loadProjects = useCallback(async () => {
    try {
      const result = await listProjects({});
      setProjects(result.projects);
    } catch {
      setProjects([]);
    }
  }, [listProjects]);
  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  const save = useCallback(async (r: Ready, values: Ready['values'], okText: string) => {
    setNotice(null);
    if (await r.save(values, r.revision)) {
      setNotice(okText);
      // Refresh so the next save uses a current revision (the settings query
      // does not auto-refetch; a stale revision is rejected by the daemon).
      await settings.reload();
      void loadProjects();
    } else {
      setNotice(`Save failed${r.saveError ? `: ${r.saveError}` : ' (unknown error — the revision may be stale)'}. Please try again.`);
    }
  }, [settings, loadProjects]);

  const saveScope = useCallback(async (r: Ready, allowAll: boolean) => {
    await save(r, { ...r.values, allowAllProjects: allowAll }, allowAll ? 'Rollback now allowed for all projects.' : 'Rollback restricted to the selected projects.');
  }, [save]);

  const addProject = useCallback(async (r: Ready, root: string) => {
    if (!root) {
      setNotice('Select a project to add first.');
      return;
    }
    const roots = r.values.fixtureRoots;
    if (roots.some((x) => x.toLowerCase() === root.toLowerCase())) {
      setNotice('That project is already on the allowlist.');
      return;
    }
    await save(r, { ...r.values, fixtureRoots: [...roots, root] }, 'Project added to the rollback allowlist.');
  }, [save]);

  const removeRoot = useCallback(async (r: Ready, root: string) => {
    await save(r, { ...r.values, fixtureRoots: r.values.fixtureRoots.filter((x) => x.toLowerCase() !== root.toLowerCase()) }, 'Project removed from the rollback allowlist.');
  }, [save]);

  const saveBytes = useCallback(async (r: Ready) => {
    const text = bytesRef.current?.getText() ?? '';
    const n = Number.parseInt(text, 10);
    if (!Number.isFinite(n) || n < 1024) {
      setNotice('Max file bytes must be a number >= 1024.');
      return;
    }
    await save(r, { ...r.values, maxFileBytes: n }, 'Max file bytes saved.');
  }, [save]);

  const saveRetention = useCallback(async (r: Ready) => {
    const text = retentionRef.current?.getText() ?? '';
    const n = Number.parseInt(text, 10);
    if (!Number.isFinite(n) || n < 1 || n > 365) {
      setNotice('Retention must be a number of days between 1 and 365.');
      return;
    }
    await save(r, { ...r.values, retentionDays: n }, 'Retention saved.');
  }, [save]);

  const saveCap = useCallback(async (r: Ready) => {
    const text = capRef.current?.getText() ?? '';
    const n = Number.parseFloat(text);
    if (!Number.isFinite(n) || n < 0) {
      setNotice('Per-project cap must be a number of MiB (0 = unlimited).');
      return;
    }
    await save(r, { ...r.values, maxProjectBytes: Math.round(n * 1024 * 1024) }, 'Per-project cap saved.');
  }, [save]);

  if (settings.status === 'loading' || settings.status === 'error' || settings.status === 'invalid') {
    return <Text style={style.label}>Loading settings…</Text>;
  }

  const current = settings as Ready;
  const mode = current.values.undoMode;
  const allowAll = current.values.allowAllProjects === true;
  const allowlisted = current.values.fixtureRoots;

  // Projects available to add = those whose root is not already allowlisted.
  const available = projects.filter((p) => !allowlisted.some((x) => x.toLowerCase() === p.root.toLowerCase()));
  // A displayed allowlisted entry resolves back to a project when possible.
  const rootProject = (root: string): ProjectRefDto | undefined => projects.find((p) => p.root.toLowerCase() === root.toLowerCase());
  const pickerOptions = available.map((p) => ({ label: `${p.name} — ${p.root}`, value: p.root }));
  const pickerValue = pickerRoot && pickerOptions.some((o) => o.value === pickerRoot) ? pickerRoot : (pickerOptions[0]?.value ?? '');

  const modeOptions = [
    { label: 'Disabled (safe default)', value: 'disabled' as const },
    { label: 'Fixture only (test repositories)', value: 'fixture' as const },
    { label: 'Enabled (real projects — rollback on every repository)', value: 'enabled' as const },
  ];

  return (
    <SettingsSection title="Turn Review safety gate" info="Undo writes to disk and is disabled by default.">
      <SettingsCard>
        <SettingsRow label="Write mode" hint="Fixture mode restricts rollback to the projects you choose below. Enabled (real-project) mode allows rollback on every repository — same safety gates, but on real work, so review each change before denying.">
          <SettingsSelect
            label="Undo mode"
            value={current.values.undoMode}
            options={modeOptions}
            onValueChange={(undoMode) => void save(current, { ...current.values, undoMode }, 'Write mode saved.')}
          />
        </SettingsRow>
        {mode === 'fixture' ? (
          <>
            <SettingsRow label="Rollback projects" hint="Off = only the projects listed below can be rolled back, on = every project.">
              <SettingsSwitch value={allowAll} onValueChange={(v) => void saveScope(current, v)} label="Allow rollback for all projects" />
            </SettingsRow>
            {!allowAll ? (
              <SettingsRow label="Allowed projects" hint="Pick a Paseo project to add it to the rollback allowlist (a project is its root path).">
                {projects.length === 0 ? (
                  <Text style={style.muted}>No projects found — the daemon project list is unavailable or empty.</Text>
                ) : (
                  <>
                    {pickerOptions.length > 0 ? (
                      <View style={{ gap: 8 }}>
                        <SettingsSelect label="Project" value={pickerValue} options={pickerOptions} onValueChange={setPickerRoot} />
                        <SettingsAction label="Project" actionLabel="Add project" disabled={settings.saving} onPress={() => void addProject(current, pickerValue)} />
                      </View>
                    ) : (
                      <Text style={style.muted}>All known projects are already on the allowlist.</Text>
                    )}
                  </>
                )}
                {allowlisted.length > 0 ? (
                  <View style={{ gap: 6, marginTop: 8 }}>
                    <Text style={style.muted}>Currently allowed:</Text>
                    {allowlisted.map((root) => {
                      const proj = rootProject(root);
                      return (
                        <View key={root} style={{ gap: 6 }}>
                          <SettingsRow label={proj ? proj.name : root} hint={root} error={proj ? undefined : 'Not a known project — manually entered path.'}>
                            <SettingsAction label="Remove" actionLabel="Remove" disabled={settings.saving} onPress={() => void removeRoot(current, root)} />
                          </SettingsRow>
                        </View>
                      );
                    })}
                  </View>
                ) : (
                  <Text style={style.muted}>No projects allowed yet — rollback stays disabled until you add one.</Text>
                )}
              </SettingsRow>
            ) : null}
          </>
        ) : (
          <SettingsRow label="Rollback scope" hint="Only Fixture mode lets you choose which repositories can be rolled back.">
            <Text style={style.muted}>
              {mode === 'enabled'
                ? 'Enabled (real-project) mode: every repository is eligible for rollback — the project allowlist is bypassed by design.'
                : 'Write mode is disabled — no rollback is possible. Switch to Fixture to choose specific projects, or to Enabled for every repository.'}
            </Text>
          </SettingsRow>
        )}
        <SettingsRow label="Max file bytes" hint="Per-file raw capture cap (1 MiB default).">
          <SettingsInput
            ref={bytesRef}
            label="Max file bytes"
            initialValue={String(current.values.maxFileBytes)}
            onChangeText={() => undefined}
          />
          <SettingsAction label="Max file bytes" actionLabel="Save cap" disabled={settings.saving} onPress={() => void saveBytes(current)} />
        </SettingsRow>
        <SettingsRow label="Retention (days)" hint="Resolved reviews, their backups and ops older than this are pruned automatically (30 default). Pending/active reviews and the working tree are never touched.">
          <SettingsInput
            ref={retentionRef}
            label="Retention days"
            initialValue={String(current.values.retentionDays)}
            onChangeText={() => undefined}
          />
          <SettingsAction label="Retention days" actionLabel="Save retention" disabled={settings.saving} onPress={() => void saveRetention(current)} />
        </SettingsRow>
        <SettingsRow label="Per-project cap (MiB)" hint="Total stored review data per project before oldest resolved reviews are pruned; 0 = unlimited (1 GiB default).">
          <SettingsInput
            ref={capRef}
            label="Per-project cap MiB"
            initialValue={String(Math.round((current.values.maxProjectBytes ?? 1024 * 1024 * 1024) / (1024 * 1024)))}
            onChangeText={() => undefined}
          />
          <SettingsAction label="Per-project cap MiB" actionLabel="Save cap" disabled={settings.saving} onPress={() => void saveCap(current)} />
        </SettingsRow>
        {notice ? <Text style={style.warn}>{notice}</Text> : null}
        {settings.saveError ? <Text style={style.warn}>Last write failed: {settings.saveError}</Text> : null}
        <Text style={style.muted}>
          Captures are stored privately under the daemon plugin-data directory with owner-only permissions. Keep and Undo
          never stage, commit, or change your Git index. After a Deny, the change can be restored from the panel or the
          chat notice until the next turn starts on that repository.
        </Text>
      </SettingsCard>
    </SettingsSection>
  );
}
