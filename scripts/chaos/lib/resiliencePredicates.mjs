export function rejectedStaleHeartbeat(response) {
  return response?.json?.ok === false
    || (response?.status === 409 && response?.json?.error === "stale_epoch");
}

export function scale10Provisioning({
  environments,
  expectedEnvironmentCount,
  everActive,
  runnerOpsSeen,
  runnerOpsCount,
}) {
  const activeIds = new Set(everActive);
  const runnerEnvironmentIds = new Set(runnerOpsSeen);
  const externalMode = runnerOpsCount === 0 && runnerEnvironmentIds.size === 0;
  const allEnvironmentsProvisioned = environments.length === expectedEnvironmentCount
    && environments.every(({ appId }) => activeIds.has(appId)
      && (externalMode || runnerEnvironmentIds.has(appId)))
    && (!externalMode || runnerOpsCount === 0);
  return { externalMode, runnerOpsCount, allEnvironmentsProvisioned };
}
