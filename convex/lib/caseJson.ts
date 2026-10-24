export interface CaseJsonInput {
  caseId: string;
  suite: string;
  seed: number;
  sceneOverrides: Record<string, number>;
  taskFamily?: string;
  description?: string;
}

export function caseJsonFor(simCase: CaseJsonInput) {
  return {
    caseId: simCase.caseId,
    suite: simCase.suite,
    seed: simCase.seed,
    sceneOverrides: simCase.sceneOverrides,
    ...(simCase.taskFamily ? { taskFamily: simCase.taskFamily } : {}),
    ...(simCase.description ? { description: simCase.description } : {}),
  };
}
