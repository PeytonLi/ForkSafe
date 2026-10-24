import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { env, root, python, requirePythonAssets, main, log } from './lib/runtime.mjs';
async function portFree(port) {
 await new Promise((ok, fail) => {
  const server = createServer();
  server.once('error', () => fail(new Error('Port ' + port + ' busy; stop its owner before pnpm dev.')));
  server.listen(port,'127.0.0.1',() => server.close(ok));
 });
}
main(async () => {
 requirePythonAssets();
 const port = Number(env.WEB_PORT || 5173);
 for (const p of [port,8000,8001]) await portFree(p);
 log(env.VITE_CONVEX_URL ? 'Web uses hosted Convex (VITE_CONVEX_URL set).' : 'Web uses fixture mode (VITE_CONVEX_URL not set).');
 if (!env.EVALUATOR_SERVICE_TOKEN) log('Evaluator health is available; set EVALUATOR_SERVICE_TOKEN to use authenticated operations.');
 const children = [];
 let stopping = false;
 let timer;
 const stop = (code = 0) => {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  log('Stopping all development process groups');
  for (const child of children) { try { process.kill(-child.pid,'SIGTERM'); } catch {} }
  timer = setTimeout(() => {
   for (const child of children) { try { process.kill(-child.pid,'SIGKILL'); } catch {} }
  },5000);
 };
 process.once('SIGINT',() => stop(0));
 process.once('SIGTERM',() => stop(0));
 for (const [name,color,command,args] of [
  ['web',36,'pnpm',['--filter','@forksafe/web','dev','--host','127.0.0.1','--port',String(port),'--strictPort']],
  ['sim',32,python,['-m','uvicorn','simulator.app:app','--host','127.0.0.1','--port','8000']],
  ['eval',35,python,['-m','uvicorn','evaluator.app:app','--host','127.0.0.1','--port','8001']],
 ]) {
  const child = spawn(command,args,{cwd:root,env:{...env,PYTHONPATH:resolve(root,'services'),PYTHONUNBUFFERED:'1'},detached:true,stdio:['ignore','pipe','pipe']});
  children.push(child);
  for (const stream of [child.stdout,child.stderr]) createInterface({input:stream}).on('line',line => log(line,name,color));
  child.once('error',() => { log('Failed to launch ' + name + '; run pnpm setup.'); stop(1); });
  child.once('exit',(code,signal) => { if (!stopping) { log(name + ' exited (' + (signal ?? code) + ')'); stop(code || 1); } });
 }
});
