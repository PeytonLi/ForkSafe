// Nightly hosted smoke: probes each hosted integration, writes JSON + a Markdown summary.
// Usage: node scripts/nightly-smoke.mjs [--json path] [--summary path]
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { env, log, main, root } from './lib/runtime.mjs';
import { formatSummary, nightlySmoke, smokeFailed, toJson } from './lib/nightly.mjs';

function arg(name) {
  const i = process.argv.indexOf(name);
  if (i === -1) return undefined;
  const value = process.argv[i + 1];
  if (!value || value.startsWith('--')) throw new Error(name + ' needs a path.');
  return value;
}

main(async () => {
  const jsonPath = resolve(root, arg('--json') ?? 'var/nightly/smoke.json');
  const summaryPath = arg('--summary') ?? env.GITHUB_STEP_SUMMARY;
  const rows = await nightlySmoke(env);
  const at = new Date().toISOString();
  mkdirSync(dirname(jsonPath), { recursive: true });
  writeFileSync(jsonPath, toJson(rows, env, at));
  const summary = formatSummary(rows, env, { at });
  if (summaryPath) appendFileSync(summaryPath, summary);
  for (const row of rows) log(row.service + ' | ' + row.mode + ' | ' + (row.latencyMs ?? '-') + ' | ' + row.result + ' | ' + row.detail);
  log('JSON written to ' + jsonPath);
  if (smokeFailed(rows)) process.exitCode = 1;
});
