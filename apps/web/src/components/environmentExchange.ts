export interface EnvironmentExchange {
  authored: { id: string; summary: string }[];
  citedBy: { environmentIndex: number; candidateId: string; findingId: string }[];
}

type ExchangeWorkspace = {
  environments: readonly { id: string; index: number }[];
  candidates: readonly { id: string; environmentId: string; basedOnFindings: readonly string[] }[];
};

type ExchangeFinding = { id: string; summary: string; environmentId: string };

/** Findings this environment authored, and other environments' candidates that cited them. */
export function environmentExchange(
  environmentId: string,
  workspace: ExchangeWorkspace,
  findings: readonly ExchangeFinding[],
): EnvironmentExchange {
  const authored = findings
    .filter((finding) => finding.environmentId === environmentId)
    .map((finding) => ({ id: finding.id, summary: finding.summary }));
  const authoredIds = new Set(authored.map((finding) => finding.id));
  const indexByEnvironment = new Map(workspace.environments.map((environment) => [environment.id, environment.index]));
  const citedBy: EnvironmentExchange["citedBy"] = [];
  for (const candidate of workspace.candidates) {
    if (candidate.environmentId === environmentId) continue;
    const environmentIndex = indexByEnvironment.get(candidate.environmentId);
    if (environmentIndex === undefined) continue;
    const seen = new Set<string>();
    for (const findingId of candidate.basedOnFindings) {
      if (!authoredIds.has(findingId) || seen.has(findingId)) continue;
      seen.add(findingId);
      citedBy.push({ environmentIndex, candidateId: candidate.id, findingId });
    }
  }
  citedBy.sort((a, b) => a.environmentIndex - b.environmentIndex);
  return { authored, citedBy };
}
