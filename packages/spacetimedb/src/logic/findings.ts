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

export interface FindingUseCheck {
  grant: { investigationId: string; environmentId?: string };
  finding?: { investigationId: string; environmentId: string };
  findingTombstoned: boolean;
  targetCount: number;
  target?: { investigationId: string; environmentId?: string };
  existing?: { findingId: string; experimentId?: string; candidateId?: string };
  requested: { findingId: string; experimentId?: string; candidateId?: string };
}

/** A finding use records that one environment relied on another environment's
 *  finding for an experiment or candidate. */
export function validateFindingUse(input: FindingUseCheck): LogicResult<{ duplicate: boolean }> {
  if (input.targetCount !== 1) {
    return { ok: false, code: "finding_use_target_invalid", message: "Exactly one of experimentId or candidateId is required" };
  }
  if (!input.finding) return { ok: false, code: "finding_missing", message: "Finding does not exist" };
  if (input.findingTombstoned) return { ok: false, code: "finding_tombstoned", message: "Finding is tombstoned" };
  if (!input.target) return { ok: false, code: "target_missing", message: "Finding use target does not exist" };
  if (
    input.finding.investigationId !== input.grant.investigationId ||
    input.target.investigationId !== input.grant.investigationId
  ) {
    return { ok: false, code: "scope_mismatch", message: "Finding use is outside the grant investigation" };
  }
  const usedBy = input.grant.environmentId ?? input.target.environmentId;
  if (usedBy === undefined || (input.target.environmentId !== undefined && input.target.environmentId !== usedBy)) {
    return { ok: false, code: "scope_mismatch", message: "Finding use target is outside the grant environment" };
  }
  if (input.finding.environmentId === usedBy) {
    return { ok: false, code: "finding_use_same_environment", message: "Finding uses must cross environments" };
  }
  if (input.existing) {
    const same = input.existing.findingId === input.requested.findingId
      && input.existing.experimentId === input.requested.experimentId
      && input.existing.candidateId === input.requested.candidateId;
    if (!same) return { ok: false, code: "finding_use_conflict", message: "Finding use id already records a different use" };
    return { ok: true, duplicate: true };
  }
  return { ok: true, duplicate: false };
}
