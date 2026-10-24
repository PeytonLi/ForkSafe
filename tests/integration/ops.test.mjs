import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEnv, redact } from '../../scripts/lib/runtime.mjs';
import { classify, integrations, probe, probeRequest, doctorFailed } from '../../scripts/lib/probes.mjs';
import { parseBenchmarkResult } from '../../scripts/lib/benchmark.mjs';
import { isForksafeSandbox } from '../../scripts/lib/sandboxes.mjs';

const dirs = [];
describe('benchmark outcomes', () => {
 it('accepts a reproduced collision even when the simulator exits 1', () => {
  expect(parseBenchmarkResult('{"completed":false,"failureKinds":["forbidden_contact"]}',1,null)).toEqual({completed:false,failureKinds:['forbidden_contact']});
 });
 it('accepts a successful run with no failures', () => { expect(parseBenchmarkResult('{"completed":true,"failureKinds":[]}',0,null)).toEqual({completed:true,failureKinds:[]}); });
 it.each([['',0,null],['{}',0,null],['not JSON',1,null],['{"completed":true,"failureKinds":[]}',2,null],['{}',null,'SIGTERM']])('rejects invalid output or process crashes', (stdout,code,signal) => { expect(() => parseBenchmarkResult(stdout,code,signal)).toThrow(); });
});
describe('doctor exit policy', () => {
 it('treats missing credentials as warnings by default', () => { expect(doctorFailed([{mode:'blocked'}])).toBe(false); });
 it('fails for blocked integrations only in strict mode', () => { expect(doctorFailed([{mode:'blocked'}],true)).toBe(true); });
 it('fails for a failed live probe with or without strict', () => { expect(doctorFailed([{mode:'live',result:'fail'}])).toBe(true); });
 it('accepts empty and healthy reports', () => { expect(doctorFailed([],true)).toBe(false); expect(doctorFailed([{mode:'live',result:'pass'}],true)).toBe(false); });
});
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
describe('environment loading', () => {
 it('preserves process values and uses local before default, filling blanks', () => {
  const dir = mkdtempSync(join(tmpdir(),'forksafe-env-')); dirs.push(dir);
  writeFileSync(join(dir,'.env.local'), 'A=local\nB="two words"\nC=local # note\nD=\n');
  writeFileSync(join(dir,'.env'), 'A=default\nB=default\nD=fallback\n');
  expect(loadEnv({ A:'process', B:'' },dir)).toEqual({ A:'process',B:'two words',C:'local',D:'fallback' });
 });
 it('handles absent files without mutating its input', () => {
  const dir = mkdtempSync(join(tmpdir(),'forksafe-env-')); dirs.push(dir);
  const input = { A:'x' }; expect(loadEnv(input,dir)).toEqual(input); expect(loadEnv(input,dir)).not.toBe(input);
 });
});
describe('redaction', () => {
 it('removes secrets and authorization and URL credentials', () => {
  expect(redact('abc123 Bearer abc123 https://user:pass@host', { API_KEY:'abc123' })).toBe('[REDACTED] Bearer [REDACTED] https://[REDACTED]@host');
 });
 it('ignores blank secrets and ordinary config', () => { expect(redact('hello', { API_KEY:'',MODE:'hello' })).toBe('hello'); });
});
describe('sandbox ownership', () => {
 it('accepts only the exact owned label', () => { expect(isForksafeSandbox({labels:{'forksafe.project':'forksafe'}})).toBe(true); });
 it.each([null, {}, {name:'forksafe-demo'}, {labels:{forksafe:'true'}}, {labels:{'forksafe.project':'trueforge'}}, {name:'trueforge-demo',labels:{'forksafe.project':'forksafe'}}])('rejects unrelated resources %j', value => { expect(isForksafeSandbox(value)).toBe(false); });
});
describe('doctor modes', () => {
 const elastic = integrations.find(row => row[0] === 'Elastic');
 it('reports exact missing credentials', () => { expect(classify(elastic,{})).toMatchObject({mode:'blocked',missing:['ELASTICSEARCH_URL','ELASTICSEARCH_API_KEY']}); });
 it.each(['local','fixture','disabled'])('classifies %s explicitly', mode => { expect(classify(elastic,{ELASTIC_MODE:mode})).toMatchObject({mode:mode === 'disabled' ? 'not_implemented' : mode,missing:[]}); });
 it('accepts shared Elastic credentials for Kibana', () => { expect(classify(integrations[5],{KIBANA_URL:'https://k',ELASTICSEARCH_API_KEY:'key'}).mode).toBe('live'); });
 it('accepts optional Kibana fallback', () => { expect(classify(integrations[5],{KIBANA_URL:'https://k',KIBANA_API_KEY:'key'}).mode).toBe('live'); });
 it('labels loopback Python adapters local', () => { expect(classify(integrations[8], {SIMULATOR_MODE:'cloud',SIMULATOR_URL:'http://127.0.0.1:8000',EVALUATOR_URL:'http://localhost:8001'}).mode).toBe('local'); });
 it('preserves an explicit Python fixture mode', () => { expect(classify(integrations[8], {SIMULATOR_MODE:'fixture',SIMULATOR_URL:'http://127.0.0.1:8000',EVALUATOR_URL:'http://localhost:8001'}).mode).toBe('fixture'); });
 it('does not require an admin key for the hosted health route', () => { expect(classify(integrations[0],{CONVEX_URL:'https://x.convex.cloud'}).mode).toBe('live'); });
});
describe('read-only probes', () => {
 it('never returns response bodies', async () => { expect(await probe('Convex',{CONVEX_SITE_URL:'https://x'},async () => new Response('secret',{status:403}))).toEqual({result:'fail',status:403}); });
 it('returns safe errors', async () => { expect(await probe('Convex',{CONVEX_SITE_URL:'https://x'},async () => { throw new Error('secret'); })).toEqual({result:'fail',detail:'network/timeout; check endpoint and credentials'}); });
 it('honestly leaves Factory unverified', async () => { expect(await probe('Factory',{})).toMatchObject({result:'not_verified'}); });
 it('uses the database identity endpoint', () => { expect(probeRequest('SpacetimeDB',{SPACETIMEDB_URI:'wss://maincloud.spacetimedb.com',SPACETIMEDB_DATABASE:'forksafe'})[0]).toBe('https://maincloud.spacetimedb.com/v1/database/forksafe'); });
 it('prefers the shared Elastic key for Kibana', () => { expect(probeRequest('Kibana Agent Builder',{KIBANA_URL:'https://k',ELASTICSEARCH_API_KEY:'shared',KIBANA_API_KEY:'fallback'})[1].authorization).toBe('ApiKey shared'); });
});
