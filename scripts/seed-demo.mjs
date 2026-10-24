import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { env, root, run, log, main } from './lib/runtime.mjs';
main(async () => {
 if (!existsSync(resolve(root,'convex/demo.ts'))) { log('convex/demo.ts not on main yet (pipeline lane)'); process.exitCode = 2; return; }
 if (!env.CONVEX_DEPLOY_KEY) throw new Error('Missing CONVEX_DEPLOY_KEY; set the hosted dev deployment key in .env.local.');
 await run('npx',['convex','run','demo:seed',...process.argv.slice(2)]);
});
