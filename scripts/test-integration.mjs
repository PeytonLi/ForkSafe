import { run, main } from './lib/runtime.mjs';
main(() => run('pnpm',['exec','vitest','run','--config','tests/integration/vitest.config.mjs',...process.argv.slice(2)]));
