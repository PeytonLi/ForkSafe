import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkAssetManifest, checkContracts, formatTable, releaseFailed } from '../lib/release.mjs';

const PIN = 'f3b6013629c7b94f8ee93fd977b161fa8350f9bc';
const SHA = 'b'.repeat(64);
const dirs = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function repo({ version = '0.1.0', consumer = 'workspace:*', manifest = { pinnedCommit: PIN, sha256: SHA }, pin = PIN } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'forksafe-release-')); dirs.push(root);
  const write = (p, v) => { mkdirSync(join(root, p, '..'), { recursive: true }); writeFileSync(join(root, p), typeof v === 'string' ? v : JSON.stringify(v)); };
  write('packages/contracts/package.json', { name: '@forksafe/contracts', version });
  write('apps/web/package.json', { name: '@forksafe/web', dependencies: { '@forksafe/contracts': consumer } });
  write('packages/integrations/elastic/package.json', { name: '@forksafe/elastic', dependencies: { '@forksafe/contracts': 'workspace:*' } });
  write('assets/robots/manifest.json', manifest);
  write('scripts/fetch-assets.mjs', 'const PIN = "' + pin + '";');
  return root;
}

test('contracts check passes for semver + workspace pins and reports the version', () => {
  assert.equal(checkContracts(repo()), 'v0.1.0');
});
test('contracts check rejects a non-semver version', () => {
  assert.throws(() => checkContracts(repo({ version: '1.0' })), /not semver/);
});
test('contracts check rejects a consumer pinned to a registry version', () => {
  assert.throws(() => checkContracts(repo({ consumer: '^0.1.0' })), /@forksafe\/web dependencies=\^0.1.0/);
});
test('asset check passes only when the tree hash matches the manifest', () => {
  assert.equal(checkAssetManifest(repo(), () => SHA), SHA.slice(0, 12));
  assert.throws(() => checkAssetManifest(repo(), () => 'c'.repeat(64)), /does not match manifest/);
});
test('asset check rejects a manifest pin that differs from fetch-assets', () => {
  assert.throws(() => checkAssetManifest(repo({ pin: 'a'.repeat(40) }), () => SHA), /does not match scripts\/fetch-assets/);
});
test('asset check rejects malformed hashes and propagates missing assets', () => {
  assert.throws(() => checkAssetManifest(repo({ manifest: { pinnedCommit: PIN, sha256: 'abc' } }), () => SHA), /SHA-256/);
  assert.throws(() => checkAssetManifest(repo({ manifest: { pinnedCommit: 'main', sha256: SHA } }), () => SHA), /40-char/);
  assert.throws(() => checkAssetManifest(repo(), () => { throw new Error('Robot assets missing'); }), /missing/);
});
test('table shows every step and the overall verdict; any non-pass fails', () => {
  const results = [{ step: 'install', result: 'pass', ms: 1200, note: '' }, { step: 'pytest', result: 'fail', ms: 50, note: 'exit 1' }];
  const table = formatTable(results);
  assert.match(table, /\| install +\| PASS +\| 1\.2s/);
  assert.match(table, /\| pytest +\| FAIL +\| 0\.1s +\| exit 1/);
  assert.match(table, /Release check: FAIL \(1\/2 passed\)/);
  assert.equal(releaseFailed(results), true);
  assert.equal(releaseFailed([results[0]]), false);
});
