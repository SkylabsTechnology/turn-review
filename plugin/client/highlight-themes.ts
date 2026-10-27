import type { PanelTheme } from './theme-types';
import type { TokenKind } from './syntax';
import type { SyntaxThemeId } from '../shared/settings';

/**
 * Syntax token palettes for the diff viewers, replicating Paseo's own highlight
 * themes verbatim (packages/highlight/src/themes.ts + colors.ts on main):
 * github, catppuccin, dracula, tokyo-night, one, nord, gruvbox, solarized.
 *
 * Like Paseo, a theme id is resolved against the app's light/dark — a theme
 * ships both variants and the active colorScheme picks one (dracula is the
 * single fixed palette). The dropdown therefore lists themes, not dark/light
 * pairs; light/dark always follows the user's app theme.
 *
 * Paseo highlights with 20 `HighlightStyle`s; this plugin's tokenizer emits 10
 * `TokenKind`s, so each kind is mapped to the Paseo style it corresponds to
 * (`punct` → punctuation, `plain` → variable, `property` → attribute, etc.).
 */

export type { SyntaxThemeId };

export interface HighlightThemeOption {
  label: string;
  value: SyntaxThemeId;
}

/** Paseo's exact theme list + labels (SYNTAX_THEME_OPTIONS in themes.ts). */
export const SYNTAX_THEME_OPTIONS: HighlightThemeOption[] = [
  { label: 'GitHub', value: 'github' },
  { label: 'Catppuccin', value: 'catppuccin' },
  { label: 'Dracula', value: 'dracula' },
  { label: 'Tokyo Night', value: 'tokyo-night' },
  { label: 'One', value: 'one' },
  { label: 'Nord', value: 'nord' },
  { label: 'Gruvbox', value: 'gruvbox' },
  { label: 'Solarized', value: 'solarized' },
];

/** Paseo's 20 highlight styles (types.ts). */
type HighlightStyle =
  | 'keyword'
  | 'comment'
  | 'string'
  | 'number'
  | 'literal'
  | 'function'
  | 'definition'
  | 'class'
  | 'type'
  | 'tag'
  | 'attribute'
  | 'property'
  | 'variable'
  | 'operator'
  | 'punctuation'
  | 'regexp'
  | 'escape'
  | 'meta'
  | 'heading'
  | 'link';

type SyntaxColors = Record<HighlightStyle, string>;

/** Paseo's hand-tuned GitHub maps (colors.ts). */
const darkHighlightColors: SyntaxColors = {
  keyword: '#ff7b72',
  comment: '#8b949e',
  string: '#a5d6ff',
  number: '#79c0ff',
  literal: '#79c0ff',
  function: '#d2a8ff',
  definition: '#d2a8ff',
  class: '#ffa657',
  type: '#ff7b72',
  tag: '#7ee787',
  attribute: '#79c0ff',
  property: '#79c0ff',
  variable: '#c9d1d9',
  operator: '#79c0ff',
  punctuation: '#c9d1d9',
  regexp: '#a5d6ff',
  escape: '#79c0ff',
  meta: '#8b949e',
  heading: '#79c0ff',
  link: '#a5d6ff',
};

const lightHighlightColors: SyntaxColors = {
  keyword: '#cf222e',
  comment: '#6e7781',
  string: '#0a3069',
  number: '#0550ae',
  literal: '#0550ae',
  function: '#8250df',
  definition: '#8250df',
  class: '#953800',
  type: '#cf222e',
  tag: '#116329',
  attribute: '#0550ae',
  property: '#0550ae',
  variable: '#24292f',
  operator: '#0550ae',
  punctuation: '#24292f',
  regexp: '#0a3069',
  escape: '#0550ae',
  meta: '#6e7781',
  heading: '#0550ae',
  link: '#0a3069',
};

/** A compact per-theme role palette (themes.ts). */
interface RolePalette {
  base: string;
  keyword: string;
  comment: string;
  string: string;
  number: string;
  function: string;
  type: string;
  tag: string;
  attribute: string;
  operator: string;
}

function expandRolePalette(r: RolePalette): SyntaxColors {
  return {
    keyword: r.keyword,
    comment: r.comment,
    string: r.string,
    number: r.number,
    literal: r.number,
    function: r.function,
    definition: r.function,
    class: r.type,
    type: r.type,
    tag: r.tag,
    attribute: r.attribute,
    property: r.attribute,
    variable: r.base,
    operator: r.operator,
    punctuation: r.base,
    regexp: r.string,
    escape: r.number,
    meta: r.comment,
    heading: r.function,
    link: r.string,
  };
}

// --- Catppuccin (Latte light / Mocha dark) ---
const catppuccinLatte: RolePalette = {
  base: '#4c4f69', keyword: '#8839ef', comment: '#8c8fa1', string: '#40a02b',
  number: '#fe640b', function: '#1e66f5', type: '#df8e1d', tag: '#8839ef',
  attribute: '#df8e1d', operator: '#04a5e5',
};
const catppuccinMocha: RolePalette = {
  base: '#cdd6f4', keyword: '#cba6f7', comment: '#9399b2', string: '#a6e3a1',
  number: '#fab387', function: '#89b4fa', type: '#f9e2af', tag: '#cba6f7',
  attribute: '#f9e2af', operator: '#89dceb',
};

// --- Dracula (dark only) ---
const dracula: RolePalette = {
  base: '#f8f8f2', keyword: '#ff79c6', comment: '#6272a4', string: '#f1fa8c',
  number: '#bd93f9', function: '#50fa7b', type: '#8be9fd', tag: '#ff79c6',
  attribute: '#50fa7b', operator: '#ff79c6',
};

// --- Tokyo Night (Day light / Night dark) ---
const tokyoDay: RolePalette = {
  base: '#3760bf', keyword: '#9854f1', comment: '#848cb5', string: '#587539',
  number: '#b15c00', function: '#2e7de9', type: '#007197', tag: '#f52a65',
  attribute: '#8c6c3e', operator: '#006a83',
};
const tokyoNight: RolePalette = {
  base: '#c0caf5', keyword: '#bb9af7', comment: '#565f89', string: '#9ece6a',
  number: '#ff9e64', function: '#7aa2f7', type: '#2ac3de', tag: '#f7768e',
  attribute: '#e0af68', operator: '#89ddff',
};

// --- One (One Light / One Dark) ---
const oneLight: RolePalette = {
  base: '#383a42', keyword: '#a626a4', comment: '#a0a1a7', string: '#50a14f',
  number: '#986801', function: '#4078f2', type: '#c18401', tag: '#e45649',
  attribute: '#986801', operator: '#0184bc',
};
const oneDark: RolePalette = {
  base: '#abb2bf', keyword: '#c678dd', comment: '#5c6370', string: '#98c379',
  number: '#d19a66', function: '#61afef', type: '#e5c07b', tag: '#e06c75',
  attribute: '#d19a66', operator: '#56b6c2',
};

// --- Nord (Snow Storm light / Polar Night dark) ---
const nordLight: RolePalette = {
  base: '#2e3440', keyword: '#5e81ac', comment: '#6b7280', string: '#4f6f3a',
  number: '#8f5e91', function: '#2e6f8e', type: '#3b7f87', tag: '#5e81ac',
  attribute: '#8f5e91', operator: '#5e81ac',
};
const nordDark: RolePalette = {
  base: '#d8dee9', keyword: '#81a1c1', comment: '#616e88', string: '#a3be8c',
  number: '#b48ead', function: '#88c0d0', type: '#8fbcbb', tag: '#81a1c1',
  attribute: '#8fbcbb', operator: '#81a1c1',
};

// --- Gruvbox (Light / Dark) ---
const gruvboxLight: RolePalette = {
  base: '#3c3836', keyword: '#9d0006', comment: '#928374', string: '#79740e',
  number: '#8f3f71', function: '#427b58', type: '#b57614', tag: '#076678',
  attribute: '#b57614', operator: '#af3a03',
};
const gruvboxDark: RolePalette = {
  base: '#ebdbb2', keyword: '#fb4934', comment: '#928374', string: '#b8bb26',
  number: '#d3869b', function: '#8ec07c', type: '#fabd2f', tag: '#83a598',
  attribute: '#fabd2f', operator: '#fe8019',
};

// --- Solarized (Light / Dark — shared accents, different base/comment) ---
const solarizedLight: RolePalette = {
  base: '#657b83', keyword: '#859900', comment: '#93a1a1', string: '#2aa198',
  number: '#d33682', function: '#268bd2', type: '#b58900', tag: '#268bd2',
  attribute: '#b58900', operator: '#859900',
};
const solarizedDark: RolePalette = {
  base: '#839496', keyword: '#859900', comment: '#586e75', string: '#2aa198',
  number: '#d33682', function: '#268bd2', type: '#b58900', tag: '#268bd2',
  attribute: '#b58900', operator: '#859900',
};

/** Resolve a theme id + the app's color scheme to the full 20-style palette. */
export function resolveSyntaxColors(id: SyntaxThemeId, colorScheme: 'light' | 'dark'): SyntaxColors {
  const dark = colorScheme === 'dark';
  switch (id) {
    case 'github':
      return dark ? darkHighlightColors : lightHighlightColors;
    case 'catppuccin':
      return expandRolePalette(dark ? catppuccinMocha : catppuccinLatte);
    case 'dracula':
      return expandRolePalette(dracula);
    case 'tokyo-night':
      return expandRolePalette(dark ? tokyoNight : tokyoDay);
    case 'one':
      return expandRolePalette(dark ? oneDark : oneLight);
    case 'nord':
      return expandRolePalette(dark ? nordDark : nordLight);
    case 'gruvbox':
      return expandRolePalette(dark ? gruvboxDark : gruvboxLight);
    case 'solarized':
      return expandRolePalette(dark ? solarizedDark : solarizedLight);
  }
}

/** Which Paseo HighlightStyle each of this plugin's TokenKinds maps to. */
const STYLE_FOR_KIND: Record<TokenKind, HighlightStyle> = {
  comment: 'comment',
  string: 'string',
  keyword: 'keyword',
  number: 'number',
  literal: 'literal',
  function: 'function',
  definition: 'definition',
  type: 'type',
  property: 'attribute',
  tag: 'tag',
  punct: 'punctuation',
  plain: 'variable',
};

function relativeLuminance(hex: string): number | null {
  let h = (hex ?? '').trim().replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (h.length !== 6 || /[^0-9a-fA-F]/.test(h)) return null;
  const n = parseInt(h, 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/** Decide the app's light/dark from the theme background (foreground as fallback). */
function isDarkTheme(colors: PanelTheme['colors']): boolean {
  const lum = relativeLuminance(colors.surface0) ?? relativeLuminance(colors.foreground);
  return lum == null ? true : lum < 0.5;
}

/**
 * Resolve the active token palette for the plugin's 10 kinds. The theme brand
 * is the user's dropdown choice; light/dark follows the app theme (dracula is
 * the only fixed palette), matching Paseo's own editor exactly.
 */
export function paletteFor(themeId: SyntaxThemeId, colors: PanelTheme['colors']): Record<TokenKind, string> {
  const syntax = resolveSyntaxColors(themeId, isDarkTheme(colors) ? 'dark' : 'light');
  const out = {} as Record<TokenKind, string>;
  for (const kind of Object.keys(STYLE_FOR_KIND) as TokenKind[]) {
    out[kind] = syntax[STYLE_FOR_KIND[kind]];
  }
  return out;
}
