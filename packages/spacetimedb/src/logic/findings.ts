import {
  CLAIMS,
  EVIDENCE_KINDS,
  FINDING_KINDS,
  FINDING_LINK_RELATIONS,
  MAX_TEXT,
} from "./constants.js";
import type { LogicResult } from "./types.js";

export interface FindingInput {
  kind: string;
  claim: string;
  summary: string;
  evidence: Array<{ kind: string; locatorJson: string; excerpt?: string }>;
  links: Array<{ toFindingId: string; relation: string }>;
}

export function validateFindingInput(input: FindingInput): LogicResult<object> {
  if (!(FINDING_KINDS as readonly string[]).includes(input.kind)) {
    return { ok: false, code: "invalid_finding", message: "Finding kind is invalid" };
  }
  if (!(CLAIMS as readonly string[]).includes(input.claim)) {
    return { ok: false, code: "invalid_finding", message: "Finding claim must be observation or inference" };
  }
  if (input.summary.length < 1 || input.summary.length > MAX_TEXT) {
    return { ok: false, code: "invalid_finding", message: "Finding summary length is invalid" };
  }
  for (const evidence of input.evidence) {
    if (!(EVIDENCE_KINDS as readonly string[]).includes(evidence.kind)) {
      return { ok: false, code: "invalid_finding", message: "Evidence kind is invalid" };
    }
    if (evidence.excerpt !== undefined && evidence.excerpt.length > MAX_TEXT) {
      return { ok: false, code: "invalid_finding", message: "Evidence excerpt is too long" };
    }
    let locator: unknown;
    try {
      locator = JSON.parse(evidence.locatorJson) as unknown;
    } catch {
      return { ok: false, code: "invalid_finding", message: "Evidence locator must be valid JSON" };
    }
    if (locator === null || typeof locator !== "object" || Array.isArray(locator)) {
      return { ok: false, code: "invalid_finding", message: "Evidence locator must be a JSON object" };
    }
  }
  if (
    input.links.some(
      (link) => !(FINDING_LINK_RELATIONS as readonly string[]).includes(link.relation),
    )
  ) {
    return { ok: false, code: "invalid_finding", message: "Finding link relation is invalid" };
  }
  return { ok: true };
}
