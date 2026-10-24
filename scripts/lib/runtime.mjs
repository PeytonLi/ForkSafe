import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export const root = resolve(import.meta.dirname, '../..');
export function loadEnv(base = process.env, dir = root) {
  const env = { ...base };
  for (const file of ['.env.local', '.env']) {
    if (!existsSync(resolve(dir, file))) continue;
    for (const line of readFileSync(resolve(dir, file), 'utf8').split(/\r?\n/)) {
      const match = line.match(/^\s*(?:export\s+)?([\w]+)\s*=\s*(.*?)\s*$/);
      if (!match || env[match[1]]?.trim()) continue;
      let value = match[2];
      if (/^['"]/.test(value)) value = value.slice(1, value.lastIndexOf(value[0]));
      else value = value.replace(/\s+#.*$/, '').trim();
      env[match[1]] = value;
    }
  }
  return env;
}
export function redact(value, env = process.env) {
  let result = String(value);
  const secrets = Object.entries(env).filter(([key, val]) => /KEY|TOKEN|SECRET|PASSWORD/i.test(key) && val).map(([, val]) => val).sort((a,b) => b.length-a.length);
  for (const secret of secrets) result = result.split(secret).join('[REDACTED]');
  return result.replace(/(Bearer|Basic|ApiKey)\s+[^\s,"']+/gi, '$1 [REDACTED]').replace(/(https?:\/\/)[^/@\s]+:[^/@\s]+@/g, '$1[REDACTED]@');
}
export const env = loadEnv();
export function log(message, name = 'ops', color = 36) {
  const prefix = process.stdout.isTTY ? `\x1b[${color}m[${name}]\x1b[0m` : `[${name}]`;
  console.log(`${prefix} ${redact(message, env)}`);
}
export function run(command, args = [], options = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd: root, env, stdio: ['ignore','pipe','pipe'], ...options });
    for (const stream of [child.stdout, child.stderr]) if (stream) createInterface({ input: stream }).on('line', line => log(line, options.label ?? 'ops'));
    child.on('error', () => reject(new Error(`Cannot start ${command}; install it and run pnpm setup.`)));
    child.on('exit', (code, signal) => code === 0 ? resolveRun() : reject(new Error(`${command} failed (${signal ?? code}). Check the output above.`)));
  });
}
export function main(fn) { Promise.resolve().then(fn).catch(error => { log(redact(error.message, env), 'error', 31); process.exitCode = 1; }); }
export const python = resolve(root, '.venv/bin/python');
export function requirePythonAssets() {
  if (!existsSync(python)) throw new Error('Python .venv missing; run pnpm setup.');
  verifyAssets();
}
export function treeHash(dir) {
  const hash = createHash('sha256');
  const files = [];
  const walk = d => { for (const item of readdirSync(d, { withFileTypes: true })) item.isDirectory() ? walk(resolve(d,item.name)) : files.push(resolve(d,item.name)); };
  walk(dir);
  for (const file of files.sort((a,b) => relative(dir,a) < relative(dir,b) ? -1 : 1)) { hash.update(relative(dir,file)); hash.update(readFileSync(file)); }
  return hash.digest('hex');
}
export function verifyAssets() {
  const manifest = resolve(root, 'assets/robots/manifest.json');
  const dir = resolve(root, 'assets/robots/mujoco_menagerie/franka_emika_panda');
  if (!existsSync(manifest) || !existsSync(dir)) throw new Error('Robot assets missing; run pnpm setup.');
  const sha = treeHash(dir);
  if (sha !== JSON.parse(readFileSync(manifest, 'utf8')).sha256) throw new Error('Robot asset SHA mismatch; restore pinned assets and run pnpm setup.');
  return sha;
}
