export const integrations = [
 ['Convex','CONVEX_MODE',['CONVEX_SITE_URL']],
 ['SpacetimeDB','SPACETIMEDB_MODE',['SPACETIMEDB_URI','SPACETIMEDB_DATABASE']],
 ['Daytona','DAYTONA_MODE',['DAYTONA_API_KEY']],
 ['Factory','FACTORY_MODE',['FACTORY_API_KEY']],
 ['Elastic','ELASTIC_MODE',['ELASTICSEARCH_URL','ELASTICSEARCH_API_KEY']],
 ['Kibana Agent Builder','ELASTIC_AGENT_BUILDER_MODE',['KIBANA_URL','ELASTICSEARCH_API_KEY']],
 ['Atlassian/Jira','ATLASSIAN_MODE',['ATLASSIAN_SITE_URL','ATLASSIAN_EMAIL','ATLASSIAN_API_TOKEN','ATLASSIAN_PROJECT_KEY']],
 ['Forge','FORGE_MODE',['FORGE_APP_ID']],
 ['Simulator/Evaluator/Python','SIMULATOR_MODE',['SIMULATOR_URL','EVALUATOR_URL']],
 ['Artifacts','ARTIFACT_MODE',['CONVEX_URL']],
];
export function classify([name, variable, required], env) {
 let configured = env[variable] || (name === 'Artifacts' ? 'local' : 'cloud');
 if (name === 'Simulator/Evaluator/Python' && configured === 'cloud' && ['SIMULATOR_URL','EVALUATOR_URL'].every(key => /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(env[key] || ''))) configured = 'local';
 const missing = required.filter(key => !env[key]?.trim()
   && !(name === 'Kibana Agent Builder' && key === 'ELASTICSEARCH_API_KEY' && env.KIBANA_API_KEY?.trim())
   && !(name === 'Convex' && (env.CONVEX_URL || env.VITE_CONVEX_URL)));
 const mode = configured === 'fixture' ? 'fixture' : ['disabled','not_implemented'].includes(configured) ? 'not_implemented' : configured === 'local' ? 'local' : missing.length ? 'blocked' : 'live';
 return { name, mode, missing: ['blocked','live'].includes(mode) ? missing : [], fix: mode === 'blocked' ? 'Set ' + missing.join(', ') + ' in .env.local.' : mode === 'live' ? 'Run pnpm doctor --live to verify connectivity.' : mode === 'local' ? 'Start the local adapter (pnpm dev for Python services).' : mode === 'fixture' ? 'Set ' + variable + '=cloud and configure credentials.' : 'Deploy and configure this integration before use.' };
}
export function probeRequest(name, e) {
 const trim = v => v.replace(/\/$/,'');
 switch (name) {
  case 'Convex': return [trim(e.CONVEX_SITE_URL || (e.CONVEX_URL || e.VITE_CONVEX_URL).replace('.convex.cloud','.convex.site')) + '/health', {}];
  case 'SpacetimeDB': return [trim(e.SPACETIMEDB_URI.replace(/^ws/,'http')) + '/v1/database/' + encodeURIComponent(e.SPACETIMEDB_DATABASE), {}];
  case 'Daytona': return [trim(e.DAYTONA_API_URL || 'https://app.daytona.io/api') + '/sandbox', { authorization: 'Bearer ' + e.DAYTONA_API_KEY }];
  case 'Elastic': return [trim(e.ELASTICSEARCH_URL) + '/', { authorization: 'ApiKey ' + e.ELASTICSEARCH_API_KEY }];
  case 'Kibana Agent Builder': return [trim(e.KIBANA_URL) + '/api/agent_builder/agents', { authorization: 'ApiKey ' + (e.ELASTICSEARCH_API_KEY || e.KIBANA_API_KEY), 'kbn-xsrf': 'forksafe-doctor' }];
  case 'Atlassian/Jira': return [trim(e.ATLASSIAN_SITE_URL) + '/rest/api/3/project/' + encodeURIComponent(e.ATLASSIAN_PROJECT_KEY), { authorization: 'Basic ' + Buffer.from(e.ATLASSIAN_EMAIL + ':' + e.ATLASSIAN_API_TOKEN).toString('base64') }];
  default: return null;
 }
}
export async function probe(name, env, request = fetch) {
 const spec = probeRequest(name, env);
 if (!spec) return { result: 'not_verified', detail: 'key present, not verified' };
 try {
  const response = await request(spec[0], { headers: spec[1], signal: AbortSignal.timeout(10000), redirect: 'error' });
  await response.body?.cancel();
  return { result: response.ok ? 'pass' : 'fail', status: response.status };
 } catch { return { result: 'fail', detail: 'network/timeout; check endpoint and credentials' }; }
}
export async function healthReport(env) {
 return Promise.all(integrations.slice(0,7).map(async item => {
  const row = classify(item, env);
  return { ...row, ...(row.mode === 'live' ? await probe(row.name, env) : { result: row.mode }) };
 }));
}
export function doctorFailed(rows, strict = false) {
 return rows.some(row => row.result === 'fail' || (strict && row.mode === 'blocked'));
}
