import type { CandidateEvaluation, CaseEvaluation, IntegrationMode } from "@forksafe/contracts";
import { canonicalJson, sha256Hex } from "./canonical.js";
import type { EvidenceBundle } from "./bundle.js";
import { EvidencePackError, type EvidencePackErrorCode } from "./errors.js";

export interface Warning {
  code: "median_mismatch" | "missing_finding" | "withheld_redacted" | "size_cap" | "frames_sampled" | "redacted";
  message: string;
}

const short = (s: string) => s.slice(0, 8);

/** Recomputes the suite status exactly as services/evaluator does. */
export function recomputeSuite(cases: readonly CaseEvaluation[]): {
  status: "passed" | "failed" | "invalid" | "pending";
  allRequiredPassed: boolean;
  medianCompletionTimeSec?: number;
} {
  if (cases.some((c) => c.status === "queued" || c.status === "running")) {
    return { status: "pending", allRequiredPassed: false };
  }
  const allPassed = cases.length > 0 && cases.every((c) => c.status === "passed");
  const status = allPassed ? "passed" : cases.some((c) => c.status === "invalid") ? "invalid" : "failed";
  const times = cases
    .filter((c) => c.status === "passed" && c.completionTimeSec !== undefined)
    .map((c) => c.completionTimeSec as number)
    .sort((a, b) => a - b);
  let median: number | undefined;
  if (times.length) {
    const mid = Math.floor(times.length / 2);
    median = times.length % 2 ? times[mid] : ((times[mid - 1] as number) + (times[mid] as number)) / 2;
  }
  return { status, allRequiredPassed: allPassed, ...(median === undefined ? {} : { medianCompletionTimeSec: median }) };
}

const MODE_RANK: Record<IntegrationMode, number> = {
  live: 0,
  local: 1,
  fixture: 2,
  blocked: 3,
  not_implemented: 4,
};

/** Fails closed: every cross-reference and hash must agree before anything
 *  is rendered. Returns non-fatal warnings. */
export function verifyBundle(b: EvidenceBundle): Warning[] {
  const failures = new Map<EvidencePackErrorCode, string[]>();
  const fail = (code: EvidencePackErrorCode, msg: string) => {
    const list = failures.get(code) ?? [];
    list.push(msg);
    failures.set(code, list);
  };
  const warnings: Warning[] = [];
  const inv = b.investigation;
  const h = b.hashes;

  // --- honest mode -------------------------------------------------------
  const worst = b.integrations.reduce<IntegrationMode>(
    (acc, r) => (MODE_RANK[r.mode] > MODE_RANK[acc] ? r.mode : acc),
    "live",
  );
  if (b.integrations.length && MODE_RANK[b.source.mode] < MODE_RANK[worst]) {
    fail("mode_mismatch", `pack claims ${b.source.mode} but an integration reports ${worst}`);
  }

  // --- baseline ----------------------------------------------------------
  const base = b.baseline.experiment;
  if (base.id !== inv.baselineExperimentId) fail("reference_error", `baseline experiment ${short(base.id)} is not the investigation's baseline`);
  if (base.investigationId !== inv.id) fail("reference_error", "baseline experiment belongs to another investigation");
  if (canonicalJson(base.simCase) !== canonicalJson(inv.baselineCase)) fail("hash_mismatch", "baseline experiment SimCase differs from the investigation's baseline case");
  if (base.controllerSha256 !== h.baselineControllerSha256) fail("hash_mismatch", "baseline experiment controllerSha256 differs from hashes.baselineControllerSha256");
  if (h.sceneSha256 && sha256Hex(canonicalJson(inv.baselineCase)) !== h.sceneSha256) fail("hash_mismatch", "hashes.sceneSha256 does not match the baseline case");

  const checkRun = (label: string, r: { assetsSha256: string; engineVersion: string }) => {
    if (r.assetsSha256 !== h.assetsSha256) fail("hash_mismatch", `${label} ran on assets other than hashes.assetsSha256`);
    if (r.engineVersion !== h.engineVersion) fail("hash_mismatch", `${label} ran on engine ${r.engineVersion}, expected ${h.engineVersion}`);
  };
  checkRun("baseline experiment", base);

  // --- candidates --------------------------------------------------------
  const candidates = new Map(b.candidates.map((c) => [c.candidate.id, c]));
  if (candidates.size !== b.candidates.length) fail("reference_error", "duplicate candidate id");
  const findingIds = new Set(b.findings.map((f) => f.id));
  for (const { candidate: c, diff } of b.candidates) {
    if (c.investigationId !== inv.id) fail("reference_error", `candidate ${short(c.id)} belongs to another investigation`);
    if (sha256Hex(diff.text) !== diff.sha256) fail("hash_mismatch", `candidate ${short(c.id)} diff does not match its sha256`);
    if (!diff.text.trim()) fail("invalid_bundle", `candidate ${short(c.id)} has an empty diff`);
    if (c.controllerSha256 === h.baselineControllerSha256) fail("hash_mismatch", `candidate ${short(c.id)} has the baseline controller hash`);
    for (const fid of c.basedOnFindings) {
      if (!findingIds.has(fid)) warnings.push({ code: "missing_finding", message: `candidate ${short(c.id)} cites finding ${short(fid)} not in this pack` });
    }
  }
  for (const f of b.findings) {
    if (f.investigationId !== inv.id) fail("reference_error", `finding ${short(f.id)} belongs to another investigation`);
  }

  // --- evaluations -------------------------------------------------------
  const experiments = new Map(b.experiments.map((e) => [e.id, e]));
  const seenSuite = new Set<string>();
  const evaluations = new Map<string, CandidateEvaluation>();
  for (const ev of b.evaluations) {
    evaluations.set(ev.id, ev);
    const cand = candidates.get(ev.candidateId)?.candidate;
    if (!cand) {
      fail("reference_error", `evaluation ${short(ev.id)} names unknown candidate ${short(ev.candidateId)}`);
      continue;
    }
    if (ev.investigationId !== inv.id) fail("reference_error", `evaluation ${short(ev.id)} belongs to another investigation`);
    const key = `${ev.candidateId}:${ev.suite}`;
    if (seenSuite.has(key)) fail("evaluation_inconsistent", `candidate ${short(ev.candidateId)} has two ${ev.suite} evaluations`);
    seenSuite.add(key);
    const caseIds = new Set<string>();
    for (const c of ev.cases) {
      if (caseIds.has(c.caseId)) fail("evaluation_inconsistent", `evaluation ${short(ev.id)} repeats case ${c.caseId}`);
      caseIds.add(c.caseId);
      if (c.status === "passed" && c.failureKinds.length) fail("evaluation_inconsistent", `case ${c.caseId} passed with failure kinds`);
      const exp = c.experimentId ? experiments.get(c.experimentId) : undefined;
      if (exp) {
        if (exp.controllerSha256 !== cand.controllerSha256) fail("hash_mismatch", `case ${c.caseId} experiment ran a different controller than candidate ${short(cand.id)}`);
        if (exp.candidateId && exp.candidateId !== cand.id) fail("reference_error", `case ${c.caseId} experiment belongs to another candidate`);
        if (exp.simCase.caseId !== c.caseId) fail("reference_error", `case ${c.caseId} experiment ran case ${exp.simCase.caseId}`);
        checkRun(`case ${c.caseId} experiment`, exp);
      }
    }
    const re = recomputeSuite(ev.cases);
    if (re.status !== "pending") {
      if (re.allRequiredPassed !== ev.allRequiredPassed) fail("evaluation_inconsistent", `evaluation ${short(ev.id)} allRequiredPassed disagrees with its cases`);
      if (re.status !== ev.status) fail("evaluation_inconsistent", `evaluation ${short(ev.id)} status ${ev.status} disagrees with its cases (${re.status})`);
    } else if (ev.status === "passed" || ev.allRequiredPassed) {
      fail("evaluation_inconsistent", `evaluation ${short(ev.id)} claims a result while cases are still pending`);
    }
    if (
      ev.medianCompletionTimeSec !== undefined &&
      re.medianCompletionTimeSec !== undefined &&
      Math.abs(ev.medianCompletionTimeSec - re.medianCompletionTimeSec) > 1e-6
    ) {
      warnings.push({
        code: "median_mismatch",
        message: `evaluation ${short(ev.id)} reports median ${ev.medianCompletionTimeSec} s; its passed cases give ${re.medianCompletionTimeSec} s (pack shows the recomputed value)`,
      });
    }
  }

  // --- replays -----------------------------------------------------------
  for (const r of b.replays) {
    const label = `replay ${short(r.artifactId)}`;
    checkRun(label, r);
    if (r.frames && r.framesSha256 && sha256Hex(canonicalJson(r.frames)) !== r.framesSha256) fail("hash_mismatch", `${label} frames do not match framesSha256`);
    if (r.role === "baseline") {
      if (r.controllerSha256 !== h.baselineControllerSha256) fail("hash_mismatch", `${label} is labeled baseline but ran another controller`);
      if (r.experimentId !== base.id) fail("reference_error", `${label} is labeled baseline but is not the baseline experiment`);
    } else {
      const cand = r.candidateId ? candidates.get(r.candidateId)?.candidate : undefined;
      if (!cand) fail("reference_error", `${label} names an unknown candidate`);
      else if (cand.controllerSha256 !== r.controllerSha256) fail("hash_mismatch", `${label} ran a controller other than candidate ${short(cand.id)}`);
    }
    const exp = experiments.get(r.experimentId) ?? (r.experimentId === base.id ? base : undefined);
    if (exp && exp.controllerSha256 !== r.controllerSha256) fail("hash_mismatch", `${label} controller differs from its experiment`);
  }

  // --- artifacts referenced by replays/candidates must agree -------------
  const artifacts = new Map(b.artifacts.map((a) => [a.id, a]));
  for (const r of b.replays) {
    for (const ch of r.chunks ?? []) {
      const a = artifacts.get(ch.artifactId);
      if (a && (a.sha256 !== ch.sha256 || a.bytes !== ch.bytes)) fail("hash_mismatch", `replay chunk ${short(ch.artifactId)} disagrees with its artifact record`);
    }
  }

  // --- reviews are bound to the exact evaluated controller --------------
  for (const rv of b.reviews) {
    const cand = candidates.get(rv.candidateId)?.candidate;
    if (!cand) {
      fail("reference_error", `review ${short(rv.id)} names unknown candidate ${short(rv.candidateId)}`);
      continue;
    }
    if (rv.investigationId !== inv.id) fail("reference_error", `review ${short(rv.id)} belongs to another investigation`);
    if (rv.controllerSha256 !== cand.controllerSha256) {
      fail("review_version_mismatch", `review ${short(rv.id)} was recorded for controller ${short(rv.controllerSha256)}, not candidate ${short(cand.id)} (${short(cand.controllerSha256)})`);
    }
    const ev = evaluations.get(rv.evaluationId);
    if (!ev) fail("review_version_mismatch", `review ${short(rv.id)} cites evaluation ${short(rv.evaluationId)} not in this pack`);
    else if (ev.candidateId !== cand.id) fail("review_version_mismatch", `review ${short(rv.id)} cites an evaluation of another candidate`);
    else if (rv.decision === "approved" && ev.status !== "passed") fail("review_version_mismatch", `review ${short(rv.id)} approves a candidate whose cited evaluation ${ev.status}`);
  }

  // Report the most severe class first; include every issue.
  const order: EvidencePackErrorCode[] = [
    "review_version_mismatch",
    "hash_mismatch",
    "evaluation_inconsistent",
    "mode_mismatch",
    "reference_error",
    "invalid_bundle",
  ];
  for (const code of order) {
    if (failures.has(code)) {
      const all = order.flatMap((c) => failures.get(c) ?? []);
      throw new EvidencePackError(code, all);
    }
  }
  return warnings;
}
