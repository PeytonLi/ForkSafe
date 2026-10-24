import { createRequire } from 'node:module';
export function isForksafeSandbox(sandbox) {
 return sandbox?.labels?.['forksafe.project'] === 'forksafe' && !String(sandbox.name ?? '').toLowerCase().startsWith('trueforge');
}
export async function daytonaClient(env) {
 if (!env.DAYTONA_API_KEY) throw new Error('Missing DAYTONA_API_KEY; set it in .env.local.');
 const require = createRequire(new URL('../../packages/integrations/daytona/package.json', import.meta.url));
 const { Daytona } = await import(require.resolve('@daytonaio/sdk'));
 return new Daytona({ apiKey: env.DAYTONA_API_KEY, apiUrl: env.DAYTONA_API_URL || 'https://app.daytona.io/api' });
}
