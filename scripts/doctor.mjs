import { existsSync } from 'node:fs';
import { env, log, main, verifyAssets, python } from './lib/runtime.mjs';
import { classify, integrations, healthReport, doctorFailed } from './lib/probes.mjs';
main(async () => {
 const rows = integrations.map(item => classify(item, env));
 const probes = process.argv.includes('--live') ? await healthReport(env) : [];
 for (const row of rows) Object.assign(row, probes.find(p => p.name === row.name) ?? {});
 try { verifyAssets(); if (!existsSync(python)) throw new Error(); }
 catch { Object.assign(rows.find(row => row.name === 'Simulator/Evaluator/Python'), { mode: 'blocked', fix: 'Run pnpm setup to install Python and verify robot assets.' }); }
 if (process.argv.includes('--json')) console.log(JSON.stringify(rows, null, 2));
 else for (const row of rows) log(row.name + ': ' + row.mode + (row.missing.length ? '; missing ' + row.missing.join(', ') : '') + (row.result ? '; ' + row.result + (row.status ? ' HTTP ' + row.status : '') + (row.detail ? ' (' + row.detail + ')' : '') : '') + ' — ' + row.fix);
 if (doctorFailed(rows,process.argv.includes('--strict'))) process.exitCode = 1;
});
