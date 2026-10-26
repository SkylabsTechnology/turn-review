import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { type PluginWorkspacePanelProps, useRpc } from '@getpaseo/plugin/client';
import { Icon } from '@getpaseo/plugin/client/react-native';
import { trackerFullFileRpc, type TrackerFullFileDto } from '../shared/contracts';
import { languageForPath, tokenizeFile, buildLineSpans, hexToRgba, type LineSpan, type Token } from './syntax';
import { buildAlignment, splitLines, wordDiffRanges, type AlignedRow } from './diff-align';
import { useDiffSelection, useTrackerTick } from './selection';

const LINE_HEIGHT = 18;
const GUTTER_WIDTH = 34;
const STRIP_WIDTH = 3;

/** VS Code-style translucent tints derived from the active theme. */
function tints(colors: PluginWorkspacePanelProps['theme']['colors']) {
  return {
    removeBg: hexToRgba(colors.statusDanger, 0.14),
    removeStrong: hexToRgba(colors.statusDanger, 0.4),
    addBg: hexToRgba(colors.statusSuccess, 0.14),
    addStrong: hexToRgba(colors.statusSuccess, 0.4),
    regionBg: hexToRgba(colors.foreground, 0.035),
  };
}

/** Renders one side's line as colored spans with optional row/intra-line backgrounds. */
function LineText({ spans, codeStyle }: { spans: LineSpan[]; codeStyle: object }) {
  if (spans.length === 0) return <Text style={codeStyle}>{' '}</Text>;
  return (
    <Text style={codeStyle}>
      {spans.map((span, idx) => (
        <Text key={idx} style={{ color: span.color, backgroundColor: span.background ?? undefined }}>
          {span.text}
        </Text>
      ))}
    </Text>
  );
}

/**
 * Side-by-side full-file viewer styled like the VS Code source-control diff
 * editor: original on the left, updated on the right, line-aligned from the
 * server's hunks (removed/added blocks interleaved like VS Code), translucent
 * red/green full-line backgrounds, intra-line word-level highlights, a colored
 * gutter change strip, and colored line numbers. Both columns live in one
 * scroll container, so they always scroll together.
 */
export function FileDiffPanel({ theme, layout, workspaceId }: PluginWorkspacePanelProps) {
  const rpc = useRpc(trackerFullFileRpc);
  const selection = useDiffSelection();
  const tick = useTrackerTick();

  const [data, setData] = useState<TrackerFullFileDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shownPath, setShownPath] = useState<string | null>(null);
  const [loadedKey, setLoadedKey] = useState<string>(''); // "ws|path|nonce|force" guard
  const [force, setForce] = useState(0);
  const loadingRef = useRef(false);

  const mobile = layout.compact || layout.platform === 'android' || layout.platform === 'ios';
  const active = selection && selection.workspaceId === workspaceId ? selection : null;
  const path = active?.path ?? shownPath;

  const load = useCallback(async () => {
    if (!path) {
      setData(null);
      setError(null);
      setShownPath(null);
      return;
    }
    const key = `${workspaceId}|${path}|${active?.nonce ?? 0}|${force}`;
    if (key === loadedKey) return;
    if (loadingRef.current) return;
    loadingRef.current = true;
    setBusy(true);
    try {
      const result = await rpc({ workspaceId, path });
      if (result.error) {
        setData(null);
        setError(result.error);
      } else {
        setData(result);
        setError(null);
      }
      setShownPath(path);
      setLoadedKey(key);
    } catch (reason: unknown) {
      setData(null);
      setError(reason instanceof Error ? reason.message : 'Unable to load file');
      setShownPath(path);
      setLoadedKey(key);
    } finally {
      loadingRef.current = false;
      setBusy(false);
    }
  }, [path, workspaceId, rpc, active?.nonce, force, loadedKey]);

  useEffect(() => {
    void load();
  }, [load, tick]);

  const language = shownPath ? languageForPath(shownPath) : null;
  const beforeLines = useMemo(() => (data?.before == null ? [] : splitLines(data.before)), [data]);
  const afterLines = useMemo(() => (data?.after == null ? [] : splitLines(data.after)), [data]);
  const beforeTokens = useMemo(
    () => (language && data ? tokenizeFile(language, beforeLines) : beforeLines.map((l) => (l ? [{ text: l, kind: 'plain' as const }] : []))),
    [language, data, beforeLines],
  );
  const afterTokens = useMemo(
    () => (language && data ? tokenizeFile(language, afterLines) : afterLines.map((l) => (l ? [{ text: l, kind: 'plain' as const }] : []))),
    [language, data, afterLines],
  );
  const alignment = useMemo(() => {
    if (!data || data.kind == null) return null;
    return buildAlignment(beforeLines, afterLines, data.hunks ?? [], data.kind);
  }, [data, beforeLines, afterLines]);

  const t = tints(theme.colors);
  const codeStyle = useMemo(
    () => ({ fontFamily: 'monospace' as const, fontSize: 12, lineHeight: LINE_HEIGHT, flexShrink: 1 }),
    [],
  );
  const s = useMemo(
    () => ({
      root: { flex: 1, backgroundColor: theme.colors.surface0, gap: 8 },
      header: { paddingHorizontal: mobile ? 10 : 16, paddingTop: mobile ? 10 : 12, gap: 6 },
      titleRow: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 8, flexWrap: 'wrap' as const },
      title: { color: theme.colors.foreground, fontSize: mobile ? 16 : 18, fontWeight: '600' as const, flexShrink: 1 },
      path: { color: theme.colors.foregroundMuted, fontSize: 12, flexShrink: 1 },
      muted: { color: theme.colors.foregroundMuted, fontSize: 12 },
      danger: { color: theme.colors.statusDanger, fontSize: 12 },
      warn: { color: theme.colors.statusWarning, fontSize: 12 },
      badge: { borderRadius: 6, paddingVertical: 2, paddingHorizontal: 8, fontSize: 11, fontWeight: '600' as const, overflow: 'hidden' as const },
      button: { borderRadius: 8, paddingVertical: 6, paddingHorizontal: 10, borderWidth: 1, borderColor: theme.colors.border, flexDirection: 'row' as const, alignItems: 'center' as const, gap: 6 },
      buttonText: { color: theme.colors.foreground, fontSize: 12 },
      summaryRow: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 12, flexWrap: 'wrap' as const },
      summaryText: { color: theme.colors.foregroundMuted, fontSize: 12 },
      addCount: { color: theme.colors.statusSuccess, fontSize: 12, fontWeight: '600' as const },
      delCount: { color: theme.colors.statusDanger, fontSize: 12, fontWeight: '600' as const },
      legendRow: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 14, flexWrap: 'wrap' as const },
      legendItem: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 5 },
      legendSwatch: { width: 12, height: 12, borderRadius: 2, borderWidth: 1, borderColor: theme.colors.border },
      legendText: { color: theme.colors.foregroundMuted, fontSize: 11 },
      row: { flexDirection: 'row' as const, minHeight: LINE_HEIGHT },
      cell: { flex: 1, flexDirection: 'row' as const, alignItems: 'flex-start' as const },
      gutter: { color: theme.colors.foregroundMuted, fontSize: 11, width: GUTTER_WIDTH, textAlign: 'right' as const, paddingRight: 6 },
      divider: { width: 1, backgroundColor: theme.colors.border },
      strip: { width: STRIP_WIDTH },
      regionBand: { backgroundColor: t.regionBg },
      center: { paddingHorizontal: mobile ? 10 : 16, paddingVertical: 24, alignItems: 'center' as const, gap: 8 },
    }),
    [theme, mobile, t],
  );

  const kindColor = data?.kind === 'created' ? theme.colors.statusSuccess : data?.kind === 'deleted' ? theme.colors.statusDanger : theme.colors.accent;
  const kindLabel = data?.kind === 'created' ? 'Added' : data?.kind === 'deleted' ? 'Removed' : 'Modified';

  const renderCell = (opts: {
    tokens: Token[];
    line: string | null;
    lineNo: number | null;
    bg: string | null;
    strong: string | null;
    changed: Array<[number, number]>;
    numberColor: string | null;
    stripColor: string | null;
    codeStyle: object;
    colors: PluginWorkspacePanelProps['theme']['colors'];
  }) => {
    const { tokens, line, lineNo, bg, strong, changed, numberColor, stripColor, colors } = opts;
    if (line == null) return <View style={s.cell} />;
    const spans = buildLineSpans(tokens, line, changed, colors, bg, strong);
    return (
      <View style={[s.cell, { backgroundColor: bg ?? undefined }]}>
        <View style={[s.strip, { backgroundColor: stripColor ?? 'transparent' }]} />
        <Text style={[s.gutter, numberColor ? { color: numberColor, fontWeight: '600' as const } : null]}>{lineNo}</Text>
        <LineText spans={spans} codeStyle={opts.codeStyle} />
      </View>
    );
  };

  const renderRow = (row: AlignedRow) => {
    const beforeIdx = row.beforeLine != null ? row.beforeLine - 1 : -1;
    const afterIdx = row.afterLine != null ? row.afterLine - 1 : -1;
    const red = theme.colors.statusDanger;
    const green = theme.colors.statusSuccess;
    if (row.type === 'context') {
      return (
        <View key={row.beforeLine} style={s.row}>
          {renderCell({ tokens: beforeTokens[beforeIdx] ?? [], line: row.before, lineNo: row.beforeLine, bg: null, strong: null, changed: [], numberColor: null, stripColor: null, codeStyle, colors: theme.colors })}
          <View style={s.divider} />
          {renderCell({ tokens: afterTokens[afterIdx] ?? [], line: row.after, lineNo: row.afterLine, bg: null, strong: null, changed: [], numberColor: null, stripColor: null, codeStyle, colors: theme.colors })}
        </View>
      );
    }
    if (row.type === 'remove') {
      return (
        <View key={row.beforeLine} style={s.row}>
          {renderCell({ tokens: beforeTokens[beforeIdx] ?? [], line: row.before, lineNo: row.beforeLine, bg: t.removeBg, strong: t.removeStrong, changed: [], numberColor: red, stripColor: red, codeStyle, colors: theme.colors })}
          <View style={s.divider} />
          {renderCell({ tokens: [], line: null, lineNo: null, bg: null, strong: null, changed: [], numberColor: null, stripColor: null, codeStyle, colors: theme.colors })}
        </View>
      );
    }
    if (row.type === 'add') {
      return (
        <View key={`a${row.afterLine}`} style={s.row}>
          {renderCell({ tokens: [], line: null, lineNo: null, bg: null, strong: null, changed: [], numberColor: null, stripColor: null, codeStyle, colors: theme.colors })}
          <View style={s.divider} />
          {renderCell({ tokens: afterTokens[afterIdx] ?? [], line: row.after, lineNo: row.afterLine, bg: t.addBg, strong: t.addStrong, changed: [], numberColor: green, stripColor: green, codeStyle, colors: theme.colors })}
        </View>
      );
    }
    // change: paired modified line — intra-line highlight on both sides.
    const ranges = wordDiffRanges(row.before, row.after);
    return (
      <View key={`c${row.beforeLine}`} style={s.row}>
        {renderCell({ tokens: beforeTokens[beforeIdx] ?? [], line: row.before, lineNo: row.beforeLine, bg: t.removeBg, strong: t.removeStrong, changed: ranges.a, numberColor: red, stripColor: red, codeStyle, colors: theme.colors })}
        <View style={s.divider} />
        {renderCell({ tokens: afterTokens[afterIdx] ?? [], line: row.after, lineNo: row.afterLine, bg: t.addBg, strong: t.addStrong, changed: ranges.b, numberColor: green, stripColor: green, codeStyle, colors: theme.colors })}
      </View>
    );
  };

  // Group rows into segments so each changed region gets one faint band.
  const segments = useMemo(() => {
    if (!alignment) return [];
    const out: Array<{ region: number | null; rows: AlignedRow[] }> = [];
    for (const row of alignment.rows) {
      const key = row.region;
      const last = out[out.length - 1];
      if (last && last.region === key) last.rows.push(row);
      else out.push({ region: key, rows: [row] });
    }
    return out;
  }, [alignment]);

  return (
    <View style={s.root}>
      <View style={s.header}>
        <View style={s.titleRow}>
          <Text style={s.title}>Full File Diff</Text>
          {data ? <Text style={[s.badge, { color: kindColor, backgroundColor: theme.colors.surface1 }]}>{kindLabel}</Text> : null}
          <Pressable accessibilityRole="button" accessibilityLabel="Refresh diff" hitSlop={8} onPress={() => setForce((f) => f + 1)} style={s.button}>
            <Icon name="RefreshCw" size={14} color={theme.colors.foregroundMuted} />
            <Text style={s.buttonText}>Refresh</Text>
          </Pressable>
        </View>
        {shownPath ? <Text style={s.path} numberOfLines={2}>{shownPath}</Text> : null}
        {data && alignment ? (
          <View style={s.summaryRow}>
            <Text style={s.summaryText}>
              {data.before == null ? '—' : beforeLines.length} line{beforeLines.length === 1 ? '' : 's'} → {data.after == null ? '—' : afterLines.length} line{afterLines.length === 1 ? '' : 's'}
              {language ? ` · ${language}` : ''}
              {busy ? ' · loading…' : ''}
            </Text>
            {alignment.additions > 0 ? <Text style={s.addCount}>+{alignment.additions}</Text> : null}
            {alignment.deletions > 0 ? <Text style={s.delCount}>−{alignment.deletions}</Text> : null}
          </View>
        ) : null}
        {data?.truncated ? <Text style={s.warn}>Showing the first 2000 lines of each side; the full file was truncated.</Text> : null}
        {data?.fullReplace ? <Text style={s.warn}>Large change set — lines are paired block-by-block.</Text> : null}
        {error ? <Text style={s.danger}>Cannot view: {error === 'unsupported' ? 'binary or non-text file' : error === 'missing-blob' ? 'captured content unavailable' : error === 'not-tracked' ? 'no pending change tracked for this file' : error}</Text> : null}
        {data ? (
          <View style={s.legendRow}>
            <View style={s.legendItem}>
              <View style={[s.legendSwatch, { backgroundColor: t.removeBg }]} />
              <Text style={s.legendText}>removed</Text>
            </View>
            <View style={s.legendItem}>
              <View style={[s.legendSwatch, { backgroundColor: t.addBg }]} />
              <Text style={s.legendText}>added</Text>
            </View>
            <View style={s.legendItem}>
              <View style={[s.legendSwatch, { backgroundColor: t.removeStrong }]} />
              <Text style={s.legendText}>changed characters</Text>
            </View>
          </View>
        ) : null}
      </View>

      {alignment && data ? (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 24 }}>
          {segments.map((seg) => (
            <View key={seg.region ?? `ctx-${seg.rows[0].beforeLine}`} style={seg.region != null ? s.regionBand : null}>
              {seg.rows.map((row) => renderRow(row))}
            </View>
          ))}
        </ScrollView>
      ) : (
        <View style={s.center}>
          <Icon name="FileDiff" size={26} color={theme.colors.foregroundMuted} />
          <Text style={s.muted}>
            {busy ? 'Loading full file…' : 'Press the "view difference" icon on any tracked file row to see the full side-by-side view here.'}
          </Text>
        </View>
      )}
    </View>
  );
}
