import assert from 'node:assert/strict';
import { test } from 'node:test';
import { paletteFor, resolveSyntaxColors, SYNTAX_THEME_OPTIONS } from '../client/highlight-themes';
import { tokenColor } from '../client/syntax';
import { turnReviewSettings } from '../shared/settings';

const KINDS = ['comment', 'string', 'keyword', 'number', 'literal', 'function', 'definition', 'type', 'property', 'tag', 'punct', 'plain'] as const;
const THEMES = ['github', 'catppuccin', 'dracula', 'tokyo-night', 'one', 'nord', 'gruvbox', 'solarized'] as const;

const dark = {
  surface0: '#1e1e1e', surface1: '#252526', surface2: '#2d2d2d', border: '#333333',
  foreground: '#d4d4d4', foregroundMuted: '#808080', accent: '#569cd6', accentForeground: '#ffffff',
  statusSuccess: '#4ec9b0', statusWarning: '#dcdcaa', statusDanger: '#f48771',
};
const light = { ...dark, surface0: '#ffffff', foreground: '#000000' };

test('H01: the dropdown lists exactly Paseo\'s 8 themes and every option is a valid enum member', () => {
  assert.deepEqual(SYNTAX_THEME_OPTIONS.map((o) => o.value), [...THEMES]);
  assert.deepEqual(SYNTAX_THEME_OPTIONS.map((o) => o.label), ['GitHub', 'Catppuccin', 'Dracula', 'Tokyo Night', 'One', 'Nord', 'Gruvbox', 'Solarized']);
  for (const opt of SYNTAX_THEME_OPTIONS) {
    assert.doesNotThrow(() => turnReviewSettings.schema.shape.syntaxTheme.parse(opt.value), `option ${opt.value}`);
  }
});

test('H02: every theme resolves to a complete 20-style map and a 10-kind palette in both schemes', () => {
  for (const id of THEMES) {
    for (const scheme of ['light', 'dark'] as const) {
      const colors20 = resolveSyntaxColors(id, scheme);
      assert.equal(Object.keys(colors20).length, 20, `${id} ${scheme} style map incomplete`);
      for (const kind of KINDS) {
        const c = paletteFor(id, scheme === 'dark' ? dark : light)[kind];
        assert.match(c, /^#[0-9a-fA-F]{6}$/, `${id} ${scheme} ${kind} is not a hex color`);
      }
    }
  }
});

test('H03: GitHub matches Paseo\'s colors.ts in both schemes', () => {
  assert.equal(paletteFor('github', dark).keyword, '#ff7b72');
  assert.equal(paletteFor('github', dark).string, '#a5d6ff');
  assert.equal(paletteFor('github', dark).comment, '#8b949e');
  assert.equal(paletteFor('github', dark).number, '#79c0ff');
  assert.equal(paletteFor('github', dark).plain, '#c9d1d9');
  assert.equal(paletteFor('github', light).keyword, '#cf222e');
  assert.equal(paletteFor('github', light).string, '#0a3069');
});

test('H04: one resolves One Dark/One Light; dracula is the fixed palette', () => {
  assert.equal(paletteFor('one', dark).keyword, '#c678dd');
  assert.equal(paletteFor('one', dark).string, '#98c379');
  assert.equal(paletteFor('one', dark).comment, '#5c6370');
  assert.equal(paletteFor('one', dark).plain, '#abb2bf');
  assert.equal(paletteFor('one', light).keyword, '#a626a4');
  assert.equal(paletteFor('one', light).string, '#50a14f');
  // dracula applies its single palette regardless of scheme
  assert.equal(paletteFor('dracula', dark).keyword, '#ff79c6');
  assert.equal(paletteFor('dracula', light).keyword, '#ff79c6');
  assert.equal(paletteFor('dracula', light).comment, '#6272a4');
  assert.equal(paletteFor('dracula', light).string, '#f1fa8c');
});

test('H05: light/dark variants differ per theme (incl. shared-accent solarized)', () => {
  assert.equal(paletteFor('nord', dark).plain, '#d8dee9');
  assert.equal(paletteFor('nord', light).plain, '#2e3440');
  assert.equal(paletteFor('solarized', dark).plain, '#839496');
  assert.equal(paletteFor('solarized', light).plain, '#657b83');
  assert.equal(paletteFor('tokyo-night', dark).keyword, '#bb9af7');
  assert.equal(paletteFor('tokyo-night', light).keyword, '#9854f1');
  assert.equal(paletteFor('gruvbox', dark).keyword, '#fb4934');
  assert.equal(paletteFor('gruvbox', light).keyword, '#9d0006');
  assert.equal(paletteFor('catppuccin', dark).keyword, '#cba6f7');
  assert.equal(paletteFor('catppuccin', light).keyword, '#8839ef');
});

test('H06: tokenColor honours the theme and defaults to one', () => {
  assert.equal(tokenColor('keyword', dark), '#c678dd'); // default one → One Dark
  assert.equal(tokenColor('keyword', light), '#a626a4'); // One Light
  assert.equal(tokenColor('keyword', dark, 'github'), '#ff7b72');
  assert.equal(tokenColor('string', light, 'gruvbox'), '#79740e');
  assert.equal(tokenColor('number', dark, 'catppuccin'), '#fab387');
});

test('H07: settings schema defaults to one; migrate maps every legacy syntaxTheme value', () => {
  assert.equal(turnReviewSettings.schema.parse({}).syntaxTheme, 'one');
  // A legacy value is not a member of the new enum...
  assert.throws(() => turnReviewSettings.schema.parse({ syntaxTheme: 'auto' }));
  // ...but the v1 → v2 migrate maps every old value onto the Paseo theme set.
  const migrate = turnReviewSettings.migrate!;
  const migrated = (old: string) => (migrate({ undoMode: 'disabled', syntaxTheme: old }, 1) as { syntaxTheme: string }).syntaxTheme;
  assert.equal(migrated('auto'), 'one');
  assert.equal(migrated('dark-modern'), 'github');
  assert.equal(migrated('light-modern'), 'github');
  assert.equal(migrated('github-dark'), 'github');
  assert.equal(migrated('github-light'), 'github');
  assert.equal(migrated('monokai'), 'dracula');
  assert.equal(migrated('solarized-dark'), 'solarized');
  assert.equal(migrated('solarized-light'), 'solarized');
  assert.equal(migrated('nord'), 'nord');
  assert.equal(migrated('dracula'), 'dracula');
  assert.equal(migrated('not-a-real-theme'), 'one'); // unknown → default
  // Every migrated document passes the current schema.
  for (const old of ['auto', 'monokai', 'dark-modern', 'github-light', 'nord']) {
    assert.doesNotThrow(() => turnReviewSettings.schema.parse(migrate({ undoMode: 'disabled', syntaxTheme: old }, 1)));
  }
  // fromVersion >= 2 passes through untouched.
  assert.equal((migrate({ syntaxTheme: 'one' }, 2) as { syntaxTheme: string }).syntaxTheme, 'one');
});
