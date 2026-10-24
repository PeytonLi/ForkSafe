import { FAILURE_KINDS, MAX_TEXT } from "./constants.js";
import { isSha256, isUuid } from "./ids.js";
import { canonicalJson } from "./hash.js";
import type { LogicResult } from "./types.js";

export interface RequirementRuleInput {
  ruleId: string;
  confluencePageId: string;
  confluencePageRevision: number;
  title: string;
  enforcement: "checked" | "human_review";
  ruleJson: string;
}

export interface BaselineInput {
  id: string;
  simCase: {
    caseId: string;
    suite: string;
    seed: number;
    sceneOverridesJson: string;
    description?: string;
  };
  sceneSha256: string;
  controllerSha256: string;
  assetsManifestSha256: string;
  engineVersion: string;
  failureKinds: string[];
  failureSummary: string;
  sourceExperimentId?: string;
  requirements: RequirementRuleInput[];
}

export interface BaselineExisting {
  baseline: Omit<BaselineInput, "requirements">;
  requirements: Array<RequirementRuleInput & { ordinal: number }>;
}

export function planBaselineRegister(
  existing: BaselineExisting | undefined,
  input: BaselineInput,
): LogicResult<{ noOp: boolean }> {
  if (!isUuid(input.id) || (input.sourceExperimentId !== undefined && !isUuid(input.sourceExperimentId))) {
    return { ok: false, code: "invalid_id", message: "Baseline ids must be UUIDs" };
  }
  if (![input.sceneSha256, input.controllerSha256, input.assetsManifestSha256].every(isSha256)) {
    return { ok: false, code: "invalid_id", message: "Baseline hashes must be lowercase SHA-256" };
  }
  if (!isObjectJson(input.simCase.sceneOverridesJson)) {
    return { ok: false, code: "invalid_baseline", message: "Scene overrides must be a JSON object" };
  }
  if (input.failureKinds.some((kind) => !(FAILURE_KINDS as readonly string[]).includes(kind))) {
    return { ok: false, code: "invalid_baseline", message: "Failure kind is invalid" };
  }
  if (input.failureSummary.length < 1 || input.failureSummary.length > MAX_TEXT) {
    return { ok: false, code: "invalid_baseline", message: "Failure summary length is invalid" };
  }
  if (input.engineVersion.length < 1 || input.engineVersion.length > 200) {
    return { ok: false, code: "invalid_baseline", message: "Engine version length is invalid" };
  }
  if (input.requirements.length > 200) {
    return { ok: false, code: "invalid_baseline", message: "Baseline has too many requirements" };
  }
  const ruleIds = new Set<string>();
  for (const requirement of input.requirements) {
    if (requirement.ruleId.trim().length === 0 || requirement.ruleId.length > 200 || ruleIds.has(requirement.ruleId)) {
      return { ok: false, code: "invalid_baseline", message: "Requirement rule id is invalid or duplicated" };
    }
    ruleIds.add(requirement.ruleId);
    if (!/^\d{1,20}$/.test(requirement.confluencePageId)) {
      return { ok: false, code: "invalid_baseline", message: "Confluence page id is invalid" };
    }
    if (
      !Number.isInteger(requirement.confluencePageRevision) ||
      requirement.confluencePageRevision < 1 ||
      requirement.confluencePageRevision > 4_294_967_295
    ) {
      return { ok: false, code: "invalid_baseline", message: "Confluence page revision is invalid" };
    }
    if (requirement.title.length < 1 || requirement.title.length > 500) {
      return { ok: false, code: "invalid_baseline", message: "Requirement title length is invalid" };
    }
    if (requirement.enforcement !== "checked" && requirement.enforcement !== "human_review") {
      return { ok: false, code: "invalid_baseline", message: "Requirement enforcement is invalid" };
    }
    if (!isObjectJson(requirement.ruleJson)) {
      return { ok: false, code: "invalid_baseline", message: "Requirement rule must be a JSON object" };
    }
  }

  if (!existing) return { ok: true, noOp: false };
  const existingBaseline = { ...existing.baseline };
  const inputBaseline = { ...input };
  delete (existingBaseline as Partial<BaselineInput>).requirements;
  delete (inputBaseline as Partial<BaselineInput>).requirements;
  const sameRequirements =
    existing.requirements.length === input.requirements.length &&
    existing.requirements.every((requirement, ordinal) =>
      requirement.ordinal === ordinal &&
      canonicalJson({
        ruleId: requirement.ruleId,
        confluencePageId: requirement.confluencePageId,
        confluencePageRevision: requirement.confluencePageRevision,
        title: requirement.title,
        enforcement: requirement.enforcement,
        ruleJson: requirement.ruleJson,
      }) === canonicalJson(input.requirements[ordinal]),
    );
  const comparableJson = (value: unknown) => canonicalJson(JSON.parse(JSON.stringify(value)) as unknown);
  if (comparableJson(existingBaseline) === comparableJson(inputBaseline) && sameRequirements) {
    return { ok: true, noOp: true };
  }
  return { ok: false, code: "baseline_conflict", message: "Baseline id is already registered differently" };
}

function isObjectJson(json: string): boolean {
  try {
    const parsed: unknown = JSON.parse(json);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
  } catch {
    return false;
  }
}
