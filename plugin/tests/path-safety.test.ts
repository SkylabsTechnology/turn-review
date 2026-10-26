import test from 'node:test';
import assert from 'node:assert/strict';
import { isSensitivePath } from '../server/path-safety';

test('P1: common secret files are excluded, case-insensitively, at any depth', () => {
  assert.equal(isSensitivePath('.env'), true);
  assert.equal(isSensitivePath('.ENV'), true);
  assert.equal(isSensitivePath('config/.env'), true);
  assert.equal(isSensitivePath('.env.local'), true);
  assert.equal(isSensitivePath('.env.production'), true);
  assert.equal(isSensitivePath('src/.env.example'), true);
  assert.equal(isSensitivePath('.npmrc'), true);
  assert.equal(isSensitivePath('.netrc'), true);
  assert.equal(isSensitivePath('.pypirc'), true);
  assert.equal(isSensitivePath('.pgpass'), true);
  assert.equal(isSensitivePath('.git-credentials'), true);
  assert.equal(isSensitivePath('.my.cnf'), true);
  assert.equal(isSensitivePath('secrets/credentials'), true);
  assert.equal(isSensitivePath('credentials.yml'), true);
  assert.equal(isSensitivePath('client_secret.json'), true);
  assert.equal(isSensitivePath('config/api_key.txt'), true);
  assert.equal(isSensitivePath('auth_token.enc'), true);
});

test('P2: private keys are excluded by extension or exact name', () => {
  assert.equal(isSensitivePath('key.pem'), true);
  assert.equal(isSensitivePath('certs/server.pem'), true);
  assert.equal(isSensitivePath('id_rsa'), true);
  assert.equal(isSensitivePath('id_rsa.pub'), true);
  assert.equal(isSensitivePath('id_ed25519'), true);
  assert.equal(isSensitivePath('.ssh/id_dsa'), true);
  assert.equal(isSensitivePath('keystore.jks.keystore'), true);
  assert.equal(isSensitivePath('app.p12'), true);
  assert.equal(isSensitivePath('auth.p8'), true);
});

test('P3: secret files nested anywhere, including node_modules, are excluded', () => {
  assert.equal(isSensitivePath('node_modules/pkg/private.pem'), true);
  assert.equal(isSensitivePath('node_modules/pkg/.env'), true);
});

test('P4: ordinary source files are NOT excluded (no false positives on shared prefixes)', () => {
  assert.equal(isSensitivePath('src/tokenizer.ts'), false);
  assert.equal(isSensitivePath('secretary/notes.md'), false);
  assert.equal(isSensitivePath('src/index.ts'), false);
  assert.equal(isSensitivePath('package.json'), false);
  assert.equal(isSensitivePath('docs/credentials-guide.md'), false);
  assert.equal(isSensitivePath('src/token.tsx'), false); // exact name only
});

test('P5: extra deny-path fragments from settings are honored, case-insensitively', () => {
  assert.equal(isSensitivePath('private/ops.sql', ['*.sql']), true);
  assert.equal(isSensitivePath('ops.SQL', ['*.sql']), true);
  assert.equal(isSensitivePath('build/out.js', ['*.sql']), false);
  assert.equal(isSensitivePath('vendor/.terraform', ['.terraform']), true);
});
