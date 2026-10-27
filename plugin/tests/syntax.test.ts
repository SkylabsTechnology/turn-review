import test from 'node:test';
import assert from 'node:assert/strict';
import { languageForPath, tokenizeLine, tokenizeFile, buildLineSpans, tokenColor } from '../client/syntax';

test('S01: language detection by extension', () => {
  assert.equal(languageForPath('src/app.ts'), 'typescript');
  assert.equal(languageForPath('a.js'), 'javascript');
  assert.equal(languageForPath('index.html'), 'html');
  assert.equal(languageForPath('style.css'), 'css');
  assert.equal(languageForPath('main.py'), 'python');
  assert.equal(languageForPath('schema.sql'), 'sql');
  assert.equal(languageForPath('deploy.sh'), 'shell');
  assert.equal(languageForPath('README.md'), 'markdown');
  assert.equal(languageForPath('Makefile'), null);
  assert.equal(languageForPath('data.bin'), null);
});

test('S02: typescript keywords, strings, numbers, and functions are tokenized', () => {
  const { tokens } = tokenizeLine('typescript', 'const n = 42; foo("hi"); // note', { inBlock: false, inTag: false, inFence: false });
  const kinds = tokens.map((t) => `${t.kind}:${t.text}`);
  assert.ok(kinds.includes('keyword:const'));
  assert.ok(kinds.includes('number:42'));
  assert.ok(kinds.includes('function:foo'));
  assert.ok(kinds.some((k) => k.startsWith('string:')));
  assert.ok(kinds.some((k) => k.startsWith('comment:')));
});

test('S03: block comments carry across lines', () => {
  const lines = ['/* start', 'still comment', 'end */ const x = 1;'];
  const out = tokenizeFile('javascript', lines);
  assert.ok(out[0].every((t) => t.kind === 'comment'));
  assert.ok(out[1].every((t) => t.kind === 'comment'));
  const last = out[2];
  assert.ok(last.some((t) => t.text.includes('end */') && t.kind === 'comment'));
  assert.ok(last.some((t) => t.text === 'const' && t.kind === 'keyword'));
});

test('S04: html tags and attributes are recognized', () => {
  const { tokens } = tokenizeLine('html', '<div class="app">Hello</div>', { inBlock: false, inTag: false, inFence: false });
  const kinds = tokens.map((t) => `${t.kind}:${t.text}`);
  assert.ok(kinds.includes('tag:<div'));
  assert.ok(kinds.includes('property:class'));
  assert.ok(kinds.some((k) => k.startsWith('string:')));
});

test('S05: markdown headings and code spans', () => {
  const { tokens } = tokenizeLine('markdown', '## Heading', { inBlock: false, inTag: false, inFence: false });
  assert.equal(tokens[0].kind, 'keyword');
  const { tokens: code } = tokenizeLine('markdown', 'run `npm test` now', { inBlock: false, inTag: false, inFence: false });
  assert.ok(code.some((t) => t.kind === 'string' && t.text.includes('npm test')));
});

test('S06: plain language renders as a single plain token per line', () => {
  const lines = ['just some text', 'more text'];
  const out = tokenizeFile('plain', lines);
  assert.equal(out[0].length, 1);
  assert.equal(out[0][0].kind, 'plain');
  assert.equal(out[1][0].kind, 'plain');
});

test('S08: token colors resolve the default theme (one) by app light/dark', () => {
  const dark = {
    surface0: '#1e1e1e', surface1: '#252526', surface2: '#2d2d2d', border: '#333333',
    foreground: '#d4d4d4', foregroundMuted: '#808080', accent: '#569cd6', accentForeground: '#ffffff',
    statusSuccess: '#4ec9b0', statusWarning: '#dcdcaa', statusDanger: '#f48771',
  };
  assert.equal(tokenColor('keyword', dark), '#c678dd'); // One Dark keyword
  assert.equal(tokenColor('string', dark), '#98c379');
  assert.equal(tokenColor('comment', dark), '#5c6370');
  assert.equal(tokenColor('number', dark), '#d19a66');
  assert.equal(tokenColor('plain', dark), '#abb2bf');

  const light = { ...dark, surface0: '#ffffff', foreground: '#000000' };
  assert.equal(tokenColor('keyword', light), '#a626a4'); // One Light keyword
  assert.equal(tokenColor('string', light), '#50a14f');
  assert.equal(tokenColor('comment', light), '#a0a1a7');
  assert.equal(tokenColor('plain', light), '#383a42');

  // An explicit theme is honoured regardless of the app theme.
  assert.equal(tokenColor('keyword', dark, 'github'), '#ff7b72');
  assert.equal(tokenColor('string', dark, 'dracula'), '#f1fa8c');
});

test('S07: buildLineSpans overlays intra-line highlight ranges on top of syntax tokens', () => {
  const colors = {
    surface0: '#000', surface1: '#111', surface2: '#222', border: '#333',
    foreground: '#eee', foregroundMuted: '#888', accent: '#569cd6', accentForeground: '#fff',
    statusSuccess: '#4ec9b0', statusWarning: '#dcdcaa', statusDanger: '#f48771',
  };
  const line = 'const value = 42;';
  const { tokens } = tokenizeLine('typescript', line, { inBlock: false, inTag: false, inFence: false });
  // Highlight the "42" (chars 14-16) like a modified line's changed span.
  const spans = buildLineSpans(tokens, line, [[14, 16]], colors, 'rgba(1,2,3,0.14)', 'rgba(1,2,3,0.4)');
  const covered = spans.map((s) => s.text).join('');
  assert.equal(covered, line); // spans reconstruct the whole line, in order
  const changed = spans.filter((s) => s.background === 'rgba(1,2,3,0.4)').map((s) => s.text);
  assert.deepEqual(changed, ['42']);
  const rowBg = spans.filter((s) => s.background === 'rgba(1,2,3,0.14)');
  assert.ok(rowBg.length > 0); // the rest of the line keeps the row tint
});

test('S09: JS/TS roles match Lezer-style tagging (imports, definitions, literals, members, types)', () => {
  const scan = (lang: string, line: string) => tokenizeLine(lang, line, { inBlock: false, inTag: false, inFence: false }).tokens;
  const kindsOf = (tokens: { kind: string; text: string }[]) => tokens.map((t) => `${t.kind}:${t.text}`);

  // The reported line: import bindings are definitions (blue), NOT types (yellow).
  let kinds = kindsOf(scan('typescript', "import { ComponentFixture, TestBed } from '@angular/core/testing';"));
  assert.ok(kinds.includes('keyword:import'));
  assert.ok(kinds.includes('definition:ComponentFixture'));
  assert.ok(kinds.includes('definition:TestBed'));
  assert.ok(kinds.includes('keyword:from'));
  assert.ok(kinds.some((k) => k.startsWith('string:') && k.includes('@angular/core/testing')));
  assert.ok(!kinds.includes('type:ComponentFixture'));

  // default import + namespace import
  kinds = kindsOf(scan('typescript', 'import App from "./app"; import * as ns from "mod";'));
  assert.ok(kinds.includes('definition:App'));
  assert.ok(kinds.includes('definition:ns'));

  // class/interface/type/enum declarations and type annotations are types (yellow)
  assert.ok(kindsOf(scan('typescript', 'class Foo extends Bar implements Baz {')).includes('type:Foo'));
  assert.ok(kindsOf(scan('typescript', 'interface Opts {')).includes('type:Opts'));
  assert.ok(kindsOf(scan('typescript', 'type Alias = string;')).includes('type:Alias'));
  assert.ok(kindsOf(scan('typescript', 'enum Color {')).includes('type:Color'));
  assert.ok(kindsOf(scan('typescript', 'const x: Widget = makeWidget();')).includes('type:Widget'));

  // variable/function definitions are definitions (blue)
  kinds = kindsOf(scan('typescript', 'const cfg = build();'));
  assert.ok(kinds.includes('definition:cfg'));
  assert.ok(kinds.includes('function:build'));

  // literals true/false/null use the literal role (number color)
  kinds = kindsOf(scan('typescript', 'const ok = true; const no = false; const nil = null;'));
  assert.ok(kinds.includes('literal:true'));
  assert.ok(kinds.includes('literal:false'));
  assert.ok(kinds.includes('literal:null'));

  // member access is a property (attribute color); spread is not
  kinds = kindsOf(scan('typescript', 'const r = obj.value + Math.PI;'));
  assert.ok(kinds.includes('property:value'));
  assert.ok(kinds.includes('type:Math'));
  assert.ok(kinds.includes('property:PI'));
  kinds = kindsOf(scan('typescript', 'const s = { ...rest };'));
  assert.ok(!kinds.includes('property:rest'));

  // `new Foo()` — Foo is a type (constructor reference), not a function call
  assert.ok(kindsOf(scan('typescript', 'const a = new Date();')).includes('type:Date'));
});
