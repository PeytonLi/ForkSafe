import { existsSync, readFileSync, copyFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { env, root, run, main, log, verifyAssets } from './lib/runtime.mjs';
main(async () => {
 log('Installing Node dependencies'); await run('pnpm', ['install']);
 if (!existsSync(resolve(root,'.venv/bin/python'))) await run('uv', ['venv','--python','3.12','.venv']);
 log('Syncing Python dependencies'); await run('uv', ['sync','--frozen']);
 const manifest = resolve(root,'assets/robots/manifest.json');
 const before = existsSync(manifest) ? readFileSync(manifest,'utf8') : null;
 log('Fetching pinned robot assets'); await run(process.execPath, ['scripts/fetch-assets.mjs']);
 const sha = verifyAssets();
 if (before && JSON.parse(before).sha256 !== sha) throw new Error('Fetched asset SHA differs from original manifest; restore pinned assets before continuing.');
 if (before && JSON.parse(before).sha256 === sha) {
  const tracked = spawnSync('git',['show','HEAD:assets/robots/manifest.json'],{cwd:root,encoding:'utf8'});
  if (tracked.status === 0 && JSON.parse(tracked.stdout).sha256 === sha && before === tracked.stdout) {
   await run('git',['checkout','assets/robots/manifest.json']);
  } else log('Keeping manifest: existing local changes or git unavailable.');
 }
 for (const [cmd,args,hint] of [
  ['spacetime',['--version'],'typecheck of packages/spacetimedb needs it. Install: curl -sSf https://install.spacetimedb.com | sh -s -- -y'],
  ['droid',['--version'],'Install Factory Droid CLI: https://docs.factory.ai/cli'],
  ['npx',['convex','--version'],'Install Convex dependencies with pnpm install'],
 ]) {
  const result = spawnSync(cmd,args,{cwd:root,env,timeout:30000,stdio:'ignore'});
  log(result.status === 0 ? cmd + ': available' : 'Warning: ' + cmd + ' unavailable. ' + hint);
 }
 if (!existsSync(resolve(root,'.env.local'))) { copyFileSync(resolve(root,'.env.example'),resolve(root,'.env.local')); log('Created .env.local; fill credentials before live use.'); }
 log('Setup complete: Node + Python installed, assets verified (' + sha + '). Run pnpm doctor.');
});
