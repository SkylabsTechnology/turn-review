import test from 'node:test';
import assert from 'node:assert/strict';
import { languageForPath, tokenizeLine, tokenizeFile, buildLineSpans } from '../client/syntax';

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
