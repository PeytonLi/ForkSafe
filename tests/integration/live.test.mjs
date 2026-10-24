import { describe, expect, it } from 'vitest';
import { loadEnv } from '../../scripts/lib/runtime.mjs';
import { classify, integrations, probe } from '../../scripts/lib/probes.mjs';

const env = loadEnv();
const optedIn = env.INTEGRATION_LIVE === '1';
for (const name of ['Convex','Elastic','Atlassian/Jira','SpacetimeDB']) {
  const row = classify(integrations.find(item => item[0] === name),env);
  const reason = !optedIn ? 'set INTEGRATION_LIVE=1; missing env: ' + (row.missing.join(', ') || 'none') : row.mode !== 'live' ? 'missing env: ' + (row.missing.join(', ') || 'cloud mode required') : '';
  if (reason) console.log('[live skipped] ' + name + ': ' + reason);
  describe.skipIf(Boolean(reason))('live read-only ' + name, () => {
    it('returns a successful HTTP status without exposing response bodies', async () => {
      const result = await probe(name,env);
      console.log('[live] ' + name + ': ' + result.result + ' HTTP ' + (result.status ?? '-'));
      expect(result.result).toBe('pass');
      expect(result.status).toBeGreaterThanOrEqual(200);
      expect(result.status).toBeLessThan(300);
    });
  });
}
