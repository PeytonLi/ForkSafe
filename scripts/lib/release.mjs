import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** Contracts must carry a valid semver and every workspace consumer must pin it with workspace:*. */
export function checkContracts(root) {
  const pkg = JSON.parse(readFileSync(resolve(root, 'packages/contracts/package.json'), 'utf8'));
  if (pkg.name !== '@forksafe/contracts') throw new Error('packages/contracts is not @forksafe/contracts.');
  if (!SEMVER.test(pkg.version ?? '')) throw new Error('contracts version "' + pkg.version + '" is not semver.');
  const bad = [];
  for (const manifest of workspaceManifests(root)) {
    const json = JSON.parse(readFileSync(manifest, 'utf8'));
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
      const spec = json[field]?.['@forksafe/contracts'];
      if (spec !== undefined && spec !== 'workspace:*') bad.push(json.name + ' ' + field + '=' + spec);
    }
  }
  if (bad.length) throw new Error('contracts not pinned to workspace:* in ' + bad.join('; '));
  return 'v' + pkg.version;
}

function workspaceManifests(root) {
  const out = [];
  for (const parent of ['apps', 'packages', 'packages/integrations']) {
    const dir = resolve(root, parent);
    if (!existsSync(dir)) continue;
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      const manifest = resolve(dir, item.name, 'package.json');
      if (item.isDirectory() && existsSync(manifest)) out.push(manifest);
    }
  }
  if (existsSync(resolve(root, 'convex/package.json'))) out.push(resolve(root, 'convex/package.json'));
  return out;
}

/** The manifest must match the pin in fetch-assets.mjs and the fetched tree hash. */
export function checkAssetManifest(root, treeSha) {
  const manifest = JSON.parse(readFileSync(resolve(root, 'assets/robots/manifest.json'), 'utf8'));
  if (!/^[0-9a-f]{40}$/.test(manifest.pinnedCommit ?? '')) throw new Error('manifest pinnedCommit is not a 40-char commit SHA.');
  if (!/^[0-9a-f]{64}$/.test(manifest.sha256 ?? '')) throw new Error('manifest sha256 is not a SHA-256 hex digest.');
  const fetcher = readFileSync(resolve(root, 'scripts/fetch-assets.mjs'), 'utf8');
  if (!fetcher.includes('"' + manifest.pinnedCommit + '"')) throw new Error('manifest pinnedCommit does not match scripts/fetch-assets.mjs PIN.');
  const actual = treeSha();
  if (actual !== manifest.sha256) throw new Error('asset tree hash does not match manifest.');
  return manifest.sha256.slice(0, 12);
}

export function releaseFailed(results) { return results.some(r => r.result !== 'pass'); }

function pad(text, width) { return text + ' '.repeat(Math.max(0, width - text.length)); }

export function formatTable(results) {
  const rows = [['Step', 'Result', 'Time', 'Note'], ...results.map(r => [r.step, r.result.toUpperCase(), (r.ms / 1000).toFixed(1) + 's', r.note ?? ''])];
  const widths = rows[0].map((_, i) => Math.max(...rows.map(row => row[i].length)));
  const line = row => '| ' + row.map((c, i) => pad(c, widths[i])).join(' | ') + ' |';
  const out = [line(rows[0]), '|' + widths.map(w => '-'.repeat(w + 2)).join('|') + '|', ...rows.slice(1).map(line)];
  out.push('', 'Release check: ' + (releaseFailed(results) ? 'FAIL' : 'PASS') + ' (' + results.filter(r => r.result === 'pass').length + '/' + results.length + ' passed)');
  return out.join('\n');
}
