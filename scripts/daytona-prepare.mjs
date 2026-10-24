import { env, run, main, log } from './lib/runtime.mjs';
main(async () => {
 if (!env.DAYTONA_API_KEY) throw new Error('Missing DAYTONA_API_KEY; set it in .env.local before pnpm daytona:prepare.');
 log('Delegating image preparation to @forksafe/daytona');
 await run('pnpm',['--filter','@forksafe/daytona','daytona:prepare',...process.argv.slice(2)]);
});
