import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { env, root, python, requirePythonAssets, main, log } from './lib/runtime.mjs';
import { parseBenchmarkResult } from './lib/benchmark.mjs';
main(async () => {
 requirePythonAssets();
 const benchmark = existsSync(resolve(root,'services/evaluator/benchmark.py'));
 log(benchmark ? 'Running evaluator benchmark module' : 'Running simulator baseline fallback (known collision is an expected result)');
 const start = performance.now();
 try {
  const args = benchmark ? ['-m','evaluator.benchmark',...process.argv.slice(2)] : ['-m','simulator.cli','--controller-dir','controllers/baseline','--case-id','original-divider-collision','--seed','0','--out-dir','var/artifacts/benchmark','--experiment-id',randomUUID(),...process.argv.slice(2)];
  const result = await new Promise((done, fail) => {
   const child = spawn(python,args,{cwd:root,env:{...env,PYTHONPATH:resolve(root,'services')},stdio:['ignore','pipe','pipe']});
   let stdout = '';
   child.stdout.setEncoding('utf8');
   child.stdout.on('data',chunk => { stdout += chunk; });
   createInterface({input:child.stderr}).on('line',line => log(line,'python'));
   child.on('error',() => fail(new Error('Cannot start Python; run pnpm run setup.')));
   child.on('close',(code,signal) => {
    try { done(parseBenchmarkResult(stdout,code,signal)); } catch (error) { fail(error); }
   });
  });
  log('Result: completed=' + result.completed + '; failureKinds=' + JSON.stringify(result.failureKinds));
 } finally { log('Wall time: ' + ((performance.now()-start)/1000).toFixed(2) + 's'); }
});
