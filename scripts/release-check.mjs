// Release gate: runs every local check and prints one pass/fail table. Exit 1 on any failure.
// Usage: pnpm release:check [--skip step,step] [--only step,step]
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createWriteStream, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { env, main, redact, root, verifyAssets } from './lib/runtime.mjs';
import { checkAssetManifest, checkContracts, formatTable, releaseFailed } from './lib/release.mjs';

const fixtureEnv = { ...env, INTEGRATION_LIVE: '0', VITE_FORKSAFE_DATA: 'fixture', CI: env.CI ?? '1' };
delete fixtureEnv.VITE_CONVEX_URL;

const steps = [
  ['install', 'pnpm', ['install', '--frozen-lockfile']],
  ['typecheck', 'pnpm', ['typecheck']],
  ['unit-tests', 'pnpm', ['-r', '--if-present', 'test'], fixtureEnv],
  ['ops-tests', 'node', ['--test', 'scripts/tests/*.test.mjs']],
  ['integration', 'pnpm', ['test:integration'], fixtureEnv],
  ['pytest', 'node', ['scripts/pytest.mjs']],
  ['build', 'pnpm', ['build'], fixtureEnv],
  ['e2e-fixture', 'pnpm', ['test:e2e'], fixtureEnv],
  ['diff-check', 'sh', ['-c', 'git diff --check HEAD && if git rev-parse -q --verify origin/main >/dev/null; then git diff --check origin/main...HEAD; fi; ws=$(git ls-files --others --exclude-standard -z | xargs -0 -r grep -nIE "[[:blank:]]+$" --); if [ -n "$ws" ]; then echo "trailing whitespace in untracked files:"; echo "$ws"; exit 1; fi']],
  ['contracts-version', () => checkContracts(root)],
  ['asset-manifest', () => checkAssetManifest(root, verifyAssets)],
];

function list(flag) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? null : (process.argv[i + 1] ?? '').split(',').filter(Boolean);
}

function runLogged(name, command, args, stepEnv, logDir) {
  const logPath = resolve(logDir, name + '.log');
  const out = createWriteStream(logPath);
  return new Promise(done => {
    const child = spawn(command, args, { cwd: root, env: stepEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    for (const stream of [child.stdout, child.stderr]) createInterface({ input: stream }).on('line', line => out.write(redact(line, env) + '\n'));
    child.on('error', error => { out.end(); done({ ok: false, note: 'cannot start ' + command + ': ' + error.code }); });
    child.on('exit', (code, signal) => out.end(() => done(code === 0 ? { ok: true, note: '' } : { ok: false, note: 'exit ' + (signal ?? code) + '; see ' + logPath.replace(root + '/', ''), logPath })));
  });
}

main(async () => {
  const only = list('--only'), skip = list('--skip') ?? [];
  const known = steps.map(s => s[0]);
  for (const name of [...(only ?? []), ...skip]) if (!known.includes(name)) throw new Error('Unknown step "' + name + '". Steps: ' + known.join(', '));
  const logDir = resolve(root, 'var/release-check');
  mkdirSync(logDir, { recursive: true });
  const results = [];
  for (const [name, command, args, stepEnv = env] of steps) {
    if ((only && !only.includes(name)) || skip.includes(name)) continue;
    process.stdout.write('[release] ' + name + ' ...\n');
    const start = Date.now();
    let outcome;
    if (typeof command === 'function') {
      try { outcome = { ok: true, note: String(command()) }; } catch (error) { outcome = { ok: false, note: redact(error.message, env) }; }
    } else outcome = await runLogged(name, command, args, stepEnv, logDir);
    results.push({ step: name, result: outcome.ok ? 'pass' : 'fail', ms: Date.now() - start, note: outcome.note });
    if (!outcome.ok && outcome.logPath) {
      const tail = readFileSync(outcome.logPath, 'utf8').trimEnd().split('\n').slice(-15).join('\n');
      process.stdout.write('[release] ' + name + ' failed; last lines:\n' + tail + '\n');
    }
  }
  if (!results.length) throw new Error('No steps selected.');
  console.log('\n' + formatTable(results));
  if (releaseFailed(results)) process.exitCode = 1;
});
