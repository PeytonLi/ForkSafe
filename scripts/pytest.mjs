import { resolve } from 'node:path';
import { requirePythonAssets, root, run, main } from './lib/runtime.mjs';
main(async () => { requirePythonAssets(); await run(resolve(root,'.venv/bin/pytest'),['-q',...process.argv.slice(2)]); });
