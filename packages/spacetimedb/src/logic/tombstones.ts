export interface TombstoneLike {
  key?: string;
  targetKind?: string;
  targetId?: string;
  reason: string;
  createdAtMs: number | bigint;
}

export interface TombstoneEntry {
  reason: string;
  createdAtMs: number;
}

export function tombstoneKey(kind: string, id: string): string {
  return `${kind}:${id}`;
}

export function buildTombstoneIndex(rows: readonly TombstoneLike[]): Map<string, TombstoneEntry> {
  return new Map(rows.map((row) => [
    row.key ?? tombstoneKey(row.targetKind ?? "", row.targetId ?? ""),
    { reason: row.reason, createdAtMs: Number(row.createdAtMs) },
  ]));
}

export function partitionFindings<
  FindingRow extends { id: string },
  EvidenceRow extends { id: string | bigint; findingId: string; artifactId?: string },
>(
  findings: readonly FindingRow[],
  evidence: readonly EvidenceRow[],
  tombstones: ReadonlyMap<string, TombstoneEntry>,
): {
  live: Array<FindingRow & { evidence: EvidenceRow[] }>;
  revoked: Array<{ findingId: string; reason: string; tombstonedAtMs: number }>;
} {
  const live: Array<FindingRow & { evidence: EvidenceRow[] }> = [];
  const revoked: Array<{ findingId: string; reason: string; tombstonedAtMs: number }> = [];
  for (const finding of findings) {
    const findingTombstone = tombstones.get(tombstoneKey("finding", finding.id));
    if (findingTombstone) {
      revoked.push({
        findingId: finding.id,
        reason: findingTombstone.reason,
        tombstonedAtMs: findingTombstone.createdAtMs,
      });
      continue;
    }
    live.push({
      ...finding,
      evidence: evidence.filter((item) =>
        item.findingId === finding.id &&
        !tombstones.has(tombstoneKey("evidence", String(item.id))) &&
        (item.artifactId === undefined || !tombstones.has(tombstoneKey("artifact", item.artifactId))),
      ),
    });
  }
  return { live, revoked };
}

export function partitionCandidates<CandidateRow extends { id: string; sourceArtifactId: string }>(
  candidates: readonly CandidateRow[],
  tombstones: ReadonlyMap<string, TombstoneEntry>,
): {
  live: CandidateRow[];
  revoked: Array<{ candidateId: string; reason: string; tombstonedAtMs: number }>;
} {
  const live: CandidateRow[] = [];
  const revoked: Array<{ candidateId: string; reason: string; tombstonedAtMs: number }> = [];
  for (const candidate of candidates) {
    const tombstone =
      tombstones.get(tombstoneKey("candidate", candidate.id)) ??
      tombstones.get(tombstoneKey("artifact", candidate.sourceArtifactId));
    if (tombstone) {
      revoked.push({
        candidateId: candidate.id,
        reason: tombstone.reason,
        tombstonedAtMs: tombstone.createdAtMs,
      });
    } else {
      live.push(candidate);
    }
  }
  return { live, revoked };
}
