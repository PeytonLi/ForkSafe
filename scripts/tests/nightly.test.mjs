import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatSummary, nightlySmoke, smokeFailed, toJson } from '../lib/nightly.mjs';

const SECRET = 'sk-very-secret-value-123456';
const fullEnv = {
  CONVEX_SITE_URL: 'https://example.convex.site', SPACETIMEDB_URI: 'wss://maincloud.spacetimedb.com', SPACETIMEDB_DATABASE: 'forksafe',
  DAYTONA_API_KEY: SECRET, FACTORY_API_KEY: 'factory-secret-xyz', ELASTICSEARCH_URL: 'https://es.example', ELASTICSEARCH_API_KEY: 'es-secret-abc',
  KIBANA_URL: 'https://kb.example', ATLASSIAN_SITE_URL: 'https://x.atlassian.net', ATLASSIAN_EMAIL: 'person@example.com', ATLASSIAN_API_TOKEN: 'atl-secret-tok', ATLASSIAN_PROJECT_KEY: 'FS',
};
const ok = async () => ({ ok: true, status: 200, body: null });

test('an empty environment (forks, PRs) skips every probe as not configured and never fails', async () => {
  let calls = 0;
  const rows = await nightlySmoke({}, async () => { calls++; return ok(); });
  assert.equal(calls, 0);
  assert.equal(rows.length, 7);
  for (const row of rows) {
    assert.equal(row.result, 'skipped', row.service);
    assert.match(row.detail, /^not configured: missing /);
  }
  assert.equal(smokeFailed(rows), false);
});

test('configured services are probed with latency; Factory is reported not_verified, not pass', async () => {
  let t = 0;
  const rows = await nightlySmoke(fullEnv, ok, () => (t += 5));
  const byName = Object.fromEntries(rows.map(r => [r.service, r]));
  assert.equal(byName.Convex.result, 'pass');
  assert.equal(byName.Convex.mode, 'live');
  assert.equal(typeof byName.Convex.latencyMs, 'number');
  assert.equal(byName.Factory.result, 'not_verified');
  assert.equal(byName.Factory.latencyMs, null);
});

test('a failing live probe fails the run; fixture/local modes are skipped, not passed', async () => {
  const rows = await nightlySmoke({ ...fullEnv, ATLASSIAN_MODE: 'fixture', DAYTONA_MODE: 'local' }, async url => ({ ok: !String(url).includes('es.example'), status: String(url).includes('es.example') ? 401 : 200 }));
  const byName = Object.fromEntries(rows.map(r => [r.service, r]));
  assert.equal(byName.Elastic.result, 'fail');
  assert.equal(byName['Atlassian/Jira'].result, 'skipped');
  assert.equal(byName['Atlassian/Jira'].mode, 'fixture');
  assert.equal(byName.Daytona.mode, 'local');
  assert.equal(smokeFailed(rows), true);
});

test('network errors become a fail row without leaking request headers', async () => {
  const rows = await nightlySmoke(fullEnv, async () => { throw new Error('boom Bearer ' + SECRET); });
  const text = formatSummary(rows, fullEnv) + toJson(rows, fullEnv);
  assert.ok(!text.includes(SECRET));
  assert.ok(rows.filter(r => r.mode === 'live' && r.service !== 'Factory').every(r => r.result === 'fail'));
});

test('the summary formatter redacts secret values, auth headers, URL credentials and the Atlassian email', () => {
  const rows = [
    { service: 'Daytona', mode: 'live', result: 'fail', latencyMs: 12, detail: 'echoed ' + SECRET + ' and Bearer abc.def and ApiKey zzz' },
    { service: 'Elastic', mode: 'live', result: 'fail', latencyMs: 3, detail: 'https://user:pw@es.example/ es-secret-abc' },
    { service: 'Atlassian/Jira', mode: 'live', result: 'fail', latencyMs: 4, detail: 'user person@example.com token atl-secret-tok' },
  ];
  const md = formatSummary(rows, fullEnv, { at: 'T' });
  const json = toJson(rows, fullEnv, 'T');
  for (const out of [md, json]) {
    for (const leak of [SECRET, 'abc.def', 'zzz', 'user:pw', 'es-secret-abc', 'person@example.com', 'atl-secret-tok']) assert.ok(!out.includes(leak), 'leaked ' + leak);
    assert.match(out, /\[REDACTED\]/);
  }
});

test('summary is a Markdown table that survives pipes and newlines in details', () => {
  const md = formatSummary([{ service: 'Convex', mode: 'live', result: 'pass', latencyMs: 40, detail: 'a|b\nc' }], {}, { at: 'T' });
  assert.match(md, /\| Service \| Mode \| Latency \| Result \| Detail \|/);
  assert.match(md, /\| Convex \| live \| 40 ms \| pass \| a\\\|b c \|/);
  assert.match(md, /Overall: \*\*PASS\*\*/);
});
