import { classify, integrations, probe } from './probes.mjs';
import { redact } from './runtime.mjs';

// Env names whose values must never reach a summary even though their names do not look secret.
const SENSITIVE_NAMES = ['ATLASSIAN_EMAIL'];
const HOSTED = integrations.slice(0, 7);

/** Probes every hosted integration with latency; missing credentials become a clean "skipped" row. */
export async function nightlySmoke(env, request = fetch, now = () => performance.now()) {
  return Promise.all(HOSTED.map(async item => {
    const row = classify(item, env);
    if (row.mode === 'blocked') return { service: row.name, mode: 'blocked', result: 'skipped', latencyMs: null, status: null, detail: 'not configured: missing ' + row.missing.join(', ') };
    if (row.mode !== 'live') return { service: row.name, mode: row.mode, result: 'skipped', latencyMs: null, status: null, detail: row.mode + ' mode; not probed' };
    const start = now();
    const outcome = await probe(row.name, env, request);
    const latencyMs = outcome.result === 'not_verified' ? null : Math.round(now() - start);
    return { service: row.name, mode: 'live', result: outcome.result, latencyMs, status: outcome.status ?? null, detail: outcome.detail ?? (outcome.status ? 'HTTP ' + outcome.status : '') };
  }));
}

export function smokeFailed(rows) { return rows.some(row => row.result === 'fail'); }

export function scrub(value, env) {
  let text = redact(value ?? '', env);
  for (const name of SENSITIVE_NAMES) if (env[name]?.trim()) text = text.split(env[name].trim()).join('[REDACTED]');
  return text;
}

const cell = (value, env) => scrub(value, env).replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');

/** Markdown job summary. Every cell is redacted against the env so a probe can never echo a secret. */
export function formatSummary(rows, env, { title = 'ForkSafe nightly hosted smoke', at = new Date().toISOString() } = {}) {
  const counts = rows.reduce((acc, row) => ({ ...acc, [row.result]: (acc[row.result] ?? 0) + 1 }), {});
  const lines = [
    '## ' + title, '',
    'Run at ' + at + '. Overall: **' + (smokeFailed(rows) ? 'FAIL' : 'PASS') + '** (' + Object.entries(counts).map(([k, v]) => v + ' ' + k).join(', ') + ').', '',
    '| Service | Mode | Latency | Result | Detail |',
    '| --- | --- | --- | --- | --- |',
    ...rows.map(row => '| ' + [row.service, row.mode, row.latencyMs == null ? '-' : row.latencyMs + ' ms', row.result, row.detail || '-'].map(v => cell(String(v), env)).join(' | ') + ' |'),
    '',
    '"skipped" with "not configured" means the GitHub secret is absent; that never fails the job. "not_verified" means the key is present but there is no safe read-only probe (Factory).',
  ];
  return lines.join('\n') + '\n';
}

export function toJson(rows, env, at = new Date().toISOString()) {
  return scrub(JSON.stringify({ at, ok: !smokeFailed(rows), rows }, null, 2), env) + '\n';
}
