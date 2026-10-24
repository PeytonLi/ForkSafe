export function parseBenchmarkResult(stdout, code, signal) {
  if (signal || ![0, 1].includes(code)) throw new Error('Benchmark process crashed; inspect Python stderr and run pnpm run setup.');
  let result;
  try { result = JSON.parse(stdout.trim()); }
  catch { throw new Error('Benchmark output is not parseable JSON; inspect Python stderr.'); }
  if (typeof result.completed !== 'boolean' || !Array.isArray(result.failureKinds) || !result.failureKinds.every(kind => typeof kind === 'string')) {
    throw new Error('Benchmark output lacks completed/failureKinds; check the simulator result contract.');
  }
  return { completed: result.completed, failureKinds: result.failureKinds };
}
