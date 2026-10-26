import type { PanelTheme } from './theme-types';

/**
 * Lightweight, dependency-free syntax tokenizer for the side-by-side viewer.
 *
 * Paseo exposes no code-viewer/highlighter primitive (checked against
 * @getpaseo/plugin client exports), so tokens are produced here and colored
 * from the active theme palette — colors therefore adapt to light/dark themes
 * like the built-in editors do. This is intentionally a *viewer-grade*
 * highlighter: per-line, regex-based, never throws. Multi-line constructs are
 * handled only where cheap to track (block comments, template-free strings,
 * HTML tags, Markdown code fences). It is not a parser.
 */

export type TokenKind =
  | 'comment'
  | 'string'
  | 'keyword'
  | 'number'
  | 'function'
  | 'type'
  | 'property'
  | 'tag'
  | 'punct'
  | 'plain';

export interface Token {
  text: string;
  kind: TokenKind;
}

export interface TokenizeState {
  /** Inside a block comment (/* *​ / or HTML comment). */
  inBlock: boolean;
  /** Inside an HTML tag that did not close on the previous line. */
  inTag: boolean;
  /** Inside a Markdown code fence (```). */
  inFence: boolean;
}

const EMPTY_STATE: TokenizeState = { inBlock: false, inTag: false, inFence: false };

type Flavor = 'c' | 'python' | 'shell' | 'sql' | 'json' | 'css' | 'html' | 'markdown' | 'plain';

interface FlavorConfig {
  lineComment: string | null;
  blockStart: string | null;
  blockEnd: string | null;
  quotes: string[];
}

const FLAVORS: Record<Exclude<Flavor, 'html' | 'markdown' | 'plain'>, FlavorConfig> = {
  c: { lineComment: '//', blockStart: '/*', blockEnd: '*/', quotes: ['"', "'", '`'] },
  python: { lineComment: '#', blockStart: null, blockEnd: null, quotes: ['"', "'"] },
  shell: { lineComment: '#', blockStart: null, blockEnd: null, quotes: ['"', "'", '`'] },
  sql: { lineComment: '--', blockStart: '/*', blockEnd: '*/', quotes: ["'"] },
  json: { lineComment: null, blockStart: null, blockEnd: null, quotes: ['"'] },
  css: { lineComment: null, blockStart: '/*', blockEnd: '*/', quotes: ['"', "'"] },
};

const KEYWORDS: Record<string, string[]> = {
  javascript: ['const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default', 'break', 'continue', 'new', 'delete', 'typeof', 'instanceof', 'in', 'of', 'class', 'extends', 'super', 'this', 'null', 'undefined', 'true', 'false', 'async', 'await', 'try', 'catch', 'finally', 'throw', 'import', 'export', 'from', 'as', 'yield', 'static', 'get', 'set', 'void', 'with', 'debugger'],
  typescript: ['const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default', 'break', 'continue', 'new', 'delete', 'typeof', 'instanceof', 'in', 'of', 'class', 'extends', 'super', 'this', 'null', 'undefined', 'true', 'false', 'async', 'await', 'try', 'catch', 'finally', 'throw', 'import', 'export', 'from', 'as', 'yield', 'static', 'get', 'set', 'void', 'with', 'debugger', 'interface', 'type', 'namespace', 'declare', 'readonly', 'keyof', 'infer', 'is', 'satisfies', 'enum', 'implements', 'public', 'private', 'protected', 'abstract', 'override', 'unknown', 'never', 'any'],
  java: ['public', 'private', 'protected', 'class', 'interface', 'extends', 'implements', 'import', 'package', 'static', 'final', 'void', 'return', 'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default', 'break', 'continue', 'new', 'this', 'super', 'null', 'true', 'false', 'try', 'catch', 'finally', 'throw', 'throws', 'abstract', 'synchronized', 'volatile', 'transient', 'instanceof', 'enum', 'record', 'var', 'yield', 'sealed', 'non-sealed', 'permits'],
  c: ['auto', 'break', 'case', 'char', 'const', 'continue', 'default', 'do', 'double', 'else', 'enum', 'extern', 'float', 'for', 'goto', 'if', 'inline', 'int', 'long', 'register', 'restrict', 'return', 'short', 'signed', 'sizeof', 'static', 'struct', 'switch', 'typedef', 'union', 'unsigned', 'void', 'volatile', 'while'],
  cpp: ['auto', 'break', 'case', 'char', 'class', 'const', 'constexpr', 'continue', 'default', 'delete', 'do', 'double', 'else', 'enum', 'explicit', 'export', 'extern', 'float', 'for', 'friend', 'goto', 'if', 'inline', 'int', 'long', 'namespace', 'new', 'noexcept', 'nullptr', 'operator', 'private', 'protected', 'public', 'register', 'return', 'short', 'signed', 'sizeof', 'static', 'struct', 'switch', 'template', 'this', 'throw', 'try', 'typedef', 'typename', 'union', 'unsigned', 'using', 'virtual', 'void', 'volatile', 'while'],
  csharp: ['public', 'private', 'protected', 'internal', 'class', 'interface', 'struct', 'enum', 'namespace', 'using', 'static', 'readonly', 'const', 'void', 'int', 'string', 'bool', 'double', 'float', 'long', 'return', 'if', 'else', 'for', 'foreach', 'while', 'do', 'switch', 'case', 'default', 'break', 'continue', 'new', 'this', 'base', 'null', 'true', 'false', 'try', 'catch', 'finally', 'throw', 'async', 'await', 'var', 'get', 'set', 'partial', 'abstract', 'virtual', 'override', 'sealed', 'record', 'is', 'as', 'in', 'out', 'ref', 'params', 'lock', 'event', 'delegate'],
  go: ['break', 'case', 'chan', 'const', 'continue', 'default', 'defer', 'else', 'fallthrough', 'for', 'func', 'go', 'goto', 'if', 'import', 'interface', 'map', 'package', 'range', 'return', 'select', 'struct', 'switch', 'type', 'var'],
  rust: ['as', 'async', 'await', 'break', 'const', 'continue', 'crate', 'dyn', 'else', 'enum', 'extern', 'false', 'fn', 'for', 'if', 'impl', 'in', 'let', 'loop', 'match', 'mod', 'move', 'mut', 'pub', 'ref', 'return', 'self', 'Self', 'static', 'struct', 'super', 'trait', 'true', 'type', 'unsafe', 'use', 'where', 'while'],
  swift: ['import', 'class', 'struct', 'enum', 'protocol', 'extension', 'func', 'let', 'var', 'if', 'else', 'for', 'while', 'repeat', 'switch', 'case', 'default', 'return', 'break', 'continue', 'guard', 'defer', 'in', 'is', 'as', 'where', 'throws', 'throw', 'do', 'try', 'catch', 'init', 'self', 'super', 'nil', 'true', 'false', 'public', 'private', 'internal', 'fileprivate', 'static', 'final', 'override', 'mutating', 'nonmutating', 'lazy', 'weak', 'unowned', 'associatedtype', 'typealias', 'some', 'any'],
  php: ['echo', 'print', 'function', 'return', 'if', 'else', 'elseif', 'for', 'foreach', 'while', 'do', 'switch', 'case', 'default', 'break', 'continue', 'new', 'class', 'extends', 'implements', 'interface', 'trait', 'namespace', 'use', 'public', 'private', 'protected', 'static', 'final', 'abstract', 'const', 'var', 'try', 'catch', 'finally', 'throw', 'true', 'false', 'null', 'require', 'require_once', 'include', 'include_once', 'isset', 'unset', 'empty', 'list', 'global', 'instanceof', 'match', 'fn', 'enum', 'readonly', 'clone', 'yield', 'die', 'exit'],
  python: ['and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del', 'elif', 'else', 'except', 'False', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'None', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'True', 'try', 'while', 'with', 'yield', 'match', 'case', 'self'],
  sql: ['select', 'from', 'where', 'insert', 'into', 'values', 'update', 'set', 'delete', 'create', 'table', 'alter', 'drop', 'index', 'view', 'procedure', 'function', 'trigger', 'join', 'inner', 'left', 'right', 'full', 'outer', 'on', 'as', 'and', 'or', 'not', 'null', 'is', 'in', 'between', 'like', 'group', 'by', 'order', 'having', 'limit', 'offset', 'distinct', 'union', 'all', 'exists', 'case', 'when', 'then', 'else', 'end', 'primary', 'key', 'foreign', 'references', 'default', 'unique', 'check', 'constraint', 'if', 'begin', 'commit', 'rollback', 'transaction', 'desc', 'asc', 'top', 'with', 'over', 'partition'],
  shell: ['if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'do', 'done', 'case', 'esac', 'function', 'return', 'break', 'continue', 'export', 'local', 'readonly', 'set', 'unset', 'shift', 'source', 'exit', 'echo', 'printf', 'read', 'cd', 'mkdir', 'rm', 'cp', 'mv', 'grep', 'sed', 'awk', 'test', 'true', 'false', 'in', 'select', 'declare', 'typeset'],
};

const LANGUAGE_BY_EXT: Record<string, string> = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'typescript',
  json: 'json', jsonc: 'json', json5: 'json',
  html: 'html', htm: 'html', xml: 'html', svg: 'html', xhtml: 'html',
  css: 'css', scss: 'css', sass: 'css', less: 'css',
  py: 'python', pyw: 'python',
  sh: 'shell', bash: 'shell', zsh: 'shell', fish: 'shell', ps1: 'shell', psd1: 'shell', psm1: 'shell',
  sql: 'sql',
  md: 'markdown', markdown: 'markdown', mdx: 'markdown',
  java: 'java',
  c: 'c', h: 'c',
  cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', hxx: 'cpp',
  cs: 'csharp',
  go: 'go',
  rs: 'rust',
  swift: 'swift',
  php: 'php',
};

/** Language id for a path, or null when unknown (plain monospace). */
export function languageForPath(filePath: string): string | null {
  const base = filePath.toLowerCase();
  const dot = base.lastIndexOf('.');
  if (dot === -1) return null;
  const ext = base.slice(dot + 1);
  return LANGUAGE_BY_EXT[ext] ?? null;
}

function flavorOf(language: string): Flavor {
  if (language === 'html') return 'html';
  if (language === 'markdown') return 'markdown';
  if (language === 'plain') return 'plain';
  if (FLAVORS[language as keyof typeof FLAVORS]) return language as Flavor;
  // Remaining C-like languages reuse the c flavor with their own keywords.
  return 'c';
}

const NUMBER_RE = /^(?:0[xX][0-9a-fA-F]+|0[bB][01]+|0[oO][0-7]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/;
const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*/;

function scanGeneric(language: string, line: string, state: TokenizeState): { tokens: Token[]; next: TokenizeState } {
  const flavor = flavorOf(language) as Exclude<Flavor, 'html' | 'markdown' | 'plain'>;
  const cfg = FLAVORS[flavor];
  const keywords = new Set(KEYWORDS[language] ?? []);
  const tokens: Token[] = [];
  let i = 0;
  let inBlock = state.inBlock;

  while (i < line.length) {
    if (inBlock) {
      const end = line.indexOf(cfg.blockEnd!, i);
      if (end === -1) {
        tokens.push({ text: line.slice(i), kind: 'comment' });
        i = line.length;
      } else {
        tokens.push({ text: line.slice(i, end + cfg.blockEnd!.length), kind: 'comment' });
        i = end + cfg.blockEnd!.length;
        inBlock = false;
      }
      continue;
    }
    if (cfg.lineComment && line.startsWith(cfg.lineComment, i)) {
      tokens.push({ text: line.slice(i), kind: 'comment' });
      break;
    }
    if (cfg.blockStart && line.startsWith(cfg.blockStart, i)) {
      inBlock = true;
      continue;
    }
    const ch = line[i];
    if (cfg.quotes.includes(ch)) {
      let j = i + 1;
      while (j < line.length) {
        if (line[j] === '\\') {
          j += 2;
          continue;
        }
        if (line[j] === ch) {
          j += 1;
          break;
        }
        j += 1;
      }
      tokens.push({ text: line.slice(i, Math.min(j, line.length)), kind: 'string' });
      i = j;
      continue;
    }
    if (ch >= '0' && ch <= '9') {
      const rest = line.slice(i);
      const m = NUMBER_RE.exec(rest);
      if (m) {
        tokens.push({ text: m[0], kind: 'number' });
        i += m[0].length;
        continue;
      }
    }
    if ((ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || ch === '_' || ch === '$') {
      const m = IDENT_RE.exec(line.slice(i))!;
      const word = m[0];
      const after = line.slice(i + word.length);
      let kind: TokenKind = 'plain';
      if (keywords.has(word)) {
        kind = 'keyword';
      } else if (flavor === 'css') {
        if (line.slice(0, i).trimEnd().endsWith('@')) kind = 'keyword';
        else if (/^\s*:/.test(after)) kind = 'property';
      } else if (/^\s*\(/.test(after)) {
        kind = 'function';
      } else if (/^[A-Z]/.test(word) && word.length > 1 && !/^[A-Z0-9_$]+$/.test(word)) {
        kind = 'type';
      }
      tokens.push({ text: word, kind });
      i += word.length;
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      tokens.push({ text: ch, kind: 'plain' });
      i += 1;
      continue;
    }
    tokens.push({ text: ch, kind: 'punct' });
    i += 1;
  }
  return { tokens, next: { ...state, inBlock } };
}

function scanHtml(line: string, state: TokenizeState): { tokens: Token[]; next: TokenizeState } {
  const tokens: Token[] = [];
  let i = 0;
  let inBlock = state.inBlock;
  let inTag = state.inTag;

  while (i < line.length) {
    if (inBlock) {
      const end = line.indexOf('-->', i);
      if (end === -1) {
        tokens.push({ text: line.slice(i), kind: 'comment' });
        i = line.length;
      } else {
        tokens.push({ text: line.slice(i, end + 3), kind: 'comment' });
        i = end + 3;
        inBlock = false;
      }
      continue;
    }
    if (line.startsWith('<!--', i)) {
      inBlock = true;
      continue;
    }
    const ch = line[i];
    if (inTag) {
      // Inside a tag: attribute names, strings, punctuation until '>'.
      if (ch === '"' || ch === "'") {
        let j = i + 1;
        while (j < line.length && line[j] !== ch) j += 1;
        tokens.push({ text: line.slice(i, Math.min(j + 1, line.length)), kind: 'string' });
        i = j + 1;
        continue;
      }
      if (ch === '>') {
        tokens.push({ text: '>', kind: 'punct' });
        i += 1;
        inTag = false;
        continue;
      }
      const m = /^[A-Za-z_:][A-Za-z0-9_.:-]*/.exec(line.slice(i));
      if (m) {
        const attr = m[0];
        tokens.push({ text: attr, kind: 'property' });
        i += attr.length;
        continue;
      }
      if (ch === ' ' || ch === '\t') {
        tokens.push({ text: ch, kind: 'plain' });
        i += 1;
        continue;
      }
      tokens.push({ text: ch, kind: 'punct' });
      i += 1;
      continue;
    }
    if (ch === '<') {
      const rest = line.slice(i);
      const tagMatch = /^<\/?[A-Za-z][A-Za-z0-9-]*/.exec(rest);
      if (tagMatch) {
        tokens.push({ text: tagMatch[0], kind: 'tag' });
        i += tagMatch[0].length;
        inTag = true;
        continue;
      }
      tokens.push({ text: '<', kind: 'punct' });
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < line.length && line[j] !== ch) j += 1;
      tokens.push({ text: line.slice(i, Math.min(j + 1, line.length)), kind: 'string' });
      i = j + 1;
      continue;
    }
    tokens.push({ text: ch, kind: 'plain' });
    i += 1;
  }
  return { tokens, next: { ...state, inBlock, inTag } };
}

function scanMarkdown(line: string, state: TokenizeState): { tokens: Token[]; next: TokenizeState } {
  const tokens: Token[] = [];
  let i = 0;
  let inFence = state.inFence;

  if (!inFence && /^\s*```/.test(line)) {
    return { tokens: [{ text: line, kind: 'string' }], next: { ...state, inFence: true } };
  }
  if (inFence && /^\s*```/.test(line)) {
    return { tokens: [{ text: line, kind: 'string' }], next: { ...state, inFence: false } };
  }
  if (inFence) {
    return { tokens: [{ text: line, kind: 'plain' }], next: state };
  }
  // Heading.
  const heading = /^(#{1,6})\s+/.exec(line);
  if (heading) {
    tokens.push({ text: heading[0], kind: 'keyword' });
    tokens.push({ text: line.slice(heading[0].length), kind: 'plain' });
    return { tokens, next: state };
  }
  while (i < line.length) {
    const ch = line[i];
    if (ch === '`') {
      const end = line.indexOf('`', i + 1);
      if (end !== -1) {
        tokens.push({ text: line.slice(i, end + 1), kind: 'string' });
        i = end + 1;
        continue;
      }
      tokens.push({ text: ch, kind: 'punct' });
      i += 1;
      continue;
    }
    if (ch === '[') {
      const linkMatch = /^\[([^\]]*)\]\(([^)]*)\)/.exec(line.slice(i));
      if (linkMatch) {
        tokens.push({ text: linkMatch[0], kind: 'string' });
        i += linkMatch[0].length;
        continue;
      }
      tokens.push({ text: ch, kind: 'punct' });
      i += 1;
      continue;
    }
    tokens.push({ text: ch, kind: 'plain' });
    i += 1;
  }
  return { tokens, next: state };
}

/** Tokenize a single line, threading minimal multi-line state. */
export function tokenizeLine(language: string, line: string, state: TokenizeState): { tokens: Token[]; next: TokenizeState } {
  switch (flavorOf(language)) {
    case 'html':
      return scanHtml(line, state);
    case 'markdown':
      return scanMarkdown(line, state);
    case 'plain':
      return { tokens: line ? [{ text: line, kind: 'plain' }] : [], next: state };
    default:
      return scanGeneric(language, line, state);
  }
}

/** Tokenize a whole file line-by-line, threading block-comment/tag/fence state. */
export function tokenizeFile(language: string, lines: string[]): Token[][] {
  const out: Token[][] = [];
  let state: TokenizeState = { ...EMPTY_STATE };
  for (const line of lines) {
    const { tokens, next } = tokenizeLine(language, line, state);
    out.push(tokens);
    state = next;
  }
  return out;
}

/** Map a token kind to a color from the active theme (adapts to light/dark). */
export function tokenColor(kind: TokenKind, colors: PanelTheme['colors']): string {
  switch (kind) {
    case 'comment':
      return colors.foregroundMuted;
    case 'string':
      return colors.statusSuccess;
    case 'keyword':
    case 'type':
      return colors.accent;
    case 'number':
      return colors.statusWarning;
    case 'function':
      return colors.accent;
    case 'property':
    case 'tag':
      return colors.statusWarning;
    case 'punct':
      return colors.foregroundMuted;
    default:
      return colors.foreground;
  }
}

/** Convert a #rgb/#rrggbb hex color to an rgba() string at the given alpha. */
export function hexToRgba(hex: string, alpha: number): string {
  let h = (hex ?? '').trim().replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (h.length !== 6 || /[^0-9a-fA-F]/.test(h)) return hex; // not hex: pass through
  const n = parseInt(h, 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export interface LineSpan {
  text: string;
  color: string;
  background: string | null;
}

/**
 * Turn one line's syntax tokens into renderable spans, overlaying a
 * VS Code-style intra-line highlight: characters inside `changedRanges` get
 * `strongBg`, every other character on the line gets the row `bg`.
 */
export function buildLineSpans(tokens: Token[], line: string, changedRanges: Array<[number, number]>, colors: PanelTheme['colors'], bg: string | null, strongBg: string | null): LineSpan[] {
  if (changedRanges.length === 0) {
    return tokens.map((t) => ({ text: t.text, color: tokenColor(t.kind, colors), background: bg }));
  }
  const boundaries = new Set<number>([0, line.length]);
  let off = 0;
  for (const t of tokens) {
    off += t.text.length;
    boundaries.add(off);
  }
  for (const [s, e] of changedRanges) {
    boundaries.add(Math.max(0, s));
    boundaries.add(Math.min(line.length, e));
  }
  const sorted = [...boundaries].sort((x, y) => x - y);
  const spans: LineSpan[] = [];
  let tokenIndex = 0;
  let tokenStart = 0;
  let tokenEnd = tokens[0] ? tokens[0].text.length : 0;
  for (let k = 0; k < sorted.length - 1; k += 1) {
    const s = sorted[k];
    const e = sorted[k + 1];
    if (e <= s) continue;
    while (tokenIndex < tokens.length && s >= tokenEnd) {
      tokenIndex += 1;
      tokenStart = tokenEnd;
      tokenEnd += tokenIndex < tokens.length ? tokens[tokenIndex].text.length : 0;
    }
    const kind = tokenIndex < tokens.length ? tokens[tokenIndex].kind : 'plain';
    const inChanged = changedRanges.some(([cs, ce]) => s >= cs && e <= ce);
    spans.push({
      text: line.slice(s, e),
      color: tokenColor(kind, colors),
      background: inChanged ? strongBg : bg,
    });
  }
  return spans;
}
