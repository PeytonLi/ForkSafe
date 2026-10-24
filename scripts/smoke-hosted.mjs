import { env, log, main } from './lib/runtime.mjs';
import { healthReport } from './lib/probes.mjs';
main(async () => {
 const rows = await healthReport(env);
 log('Service | result | HTTP | action');
 for (const row of rows) log(row.name + ' | ' + row.result + ' | ' + (row.status ?? '-') + ' | ' + (row.missing.length ? 'blocked: missing ' + row.missing.join(', ') : row.detail ?? row.fix));
 if (rows.some(row => row.result === 'fail')) process.exitCode = 1;
});
