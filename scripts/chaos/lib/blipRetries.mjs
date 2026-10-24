const MAX_ATTEMPTS = 8;
const MAX_PENDING_AGE_MS = 25 * 60_000;

export function evaluateBlipRetryRows(rows, nowMs) {
  const evidenceRows = rows.map((row) => ({
    key: row.key ?? row.idempotencyKey ?? null,
    attempts: row.attempts,
    status: row.status,
    lastError: row.lastError ?? null,
    createdAtMs: row.createdAtMs,
  }));
  const violations = [];

  for (const row of evidenceRows) {
    if (!Number.isInteger(row.attempts) || row.attempts < 0 || row.attempts > MAX_ATTEMPTS) {
      violations.push({ key: row.key, rule: "attempts must be an integer from 0 through 8", attempts: row.attempts });
    }
    if (row.attempts === MAX_ATTEMPTS && row.status !== "dead") {
      violations.push({ key: row.key, rule: "attempts == 8 requires dead status", status: row.status });
    }
    if (!Number.isFinite(row.createdAtMs)) {
      violations.push({ key: row.key, rule: "createdAtMs must be finite", createdAtMs: row.createdAtMs });
    } else if (nowMs - row.createdAtMs > MAX_PENDING_AGE_MS
      && (row.attempts !== MAX_ATTEMPTS || row.status !== "dead")) {
      violations.push({
        key: row.key,
        rule: "rows older than 25 minutes require attempts == 8 and dead status",
        attempts: row.attempts,
        status: row.status,
        ageMs: nowMs - row.createdAtMs,
      });
    }
  }

  return { passed: violations.length === 0, rows: evidenceRows, violations };
}
