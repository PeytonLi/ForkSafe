/** Smallest failing value when higher values are worse. This is arithmetic, not a physics run. */
export function minimizeMonotonic(options: {
  low: number;
  high: number;
  fails: (value: number) => boolean;
  iterations?: number;
}): { value: number; steps: number } | { reason: string } {
  const { low, high, fails } = options;
  if (!Number.isFinite(low) || !Number.isFinite(high)) {
    return { reason: "Search bounds must be finite numbers." };
  }
  if (fails(low)) return { reason: "The low value already fails." };
  if (!fails(high)) return { reason: "The high value does not fail." };

  const requested = options.iterations;
  const steps = requested === undefined ? 12 : Number.isFinite(requested) ? Math.max(0, Math.floor(requested)) : 12;
  let lo = low;
  let hi = high;
  for (let step = 0; step < steps; step += 1) {
    const mid = lo + (hi - lo) / 2;
    if (fails(mid)) hi = mid;
    else lo = mid;
  }
  return { value: Number(hi.toFixed(5)), steps };
}
