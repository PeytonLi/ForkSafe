export interface SearchWidthRow {
  id: string;
  title: string;
  taskFamily: string;
  requestedEnvironments: number;
  findingCount: number;
  candidateCount: number;
  passedCandidateCount: number;
}

export interface SearchWidthGroup {
  taskFamily: string;
  requestedEnvironments: number;
  investigationCount: number;
  findingCount: number;
  candidateCount: number;
  passedCandidateCount: number;
}

/** A candidate counts only when every recorded evaluation passed, and at least one exists. */
export function countPassedCandidates(
  candidates: readonly { id: string }[],
  evaluations: readonly { candidateId: string; allRequiredPassed: boolean }[],
): number {
  return candidates.filter((candidate) => {
    const rows = evaluations.filter((evaluation) => evaluation.candidateId === candidate.id);
    return rows.length > 0 && rows.every((evaluation) => evaluation.allRequiredPassed === true);
  }).length;
}

/** Groups only the rows the caller supplies. Investigations that were not returned are not filled in. */
export function searchWidthReport(rows: SearchWidthRow[]): SearchWidthGroup[] {
  const groups = new Map<string, SearchWidthGroup>();
  for (const row of rows) {
    const key = `${row.taskFamily}|${row.requestedEnvironments}`;
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, {
        taskFamily: row.taskFamily,
        requestedEnvironments: row.requestedEnvironments,
        investigationCount: 1,
        findingCount: row.findingCount,
        candidateCount: row.candidateCount,
        passedCandidateCount: row.passedCandidateCount,
      });
      continue;
    }
    existing.investigationCount += 1;
    existing.findingCount += row.findingCount;
    existing.candidateCount += row.candidateCount;
    existing.passedCandidateCount += row.passedCandidateCount;
  }
  return [...groups.values()].sort((a, b) => a.taskFamily.localeCompare(b.taskFamily) || a.requestedEnvironments - b.requestedEnvironments);
}
