import type { Finding } from "@forksafe/contracts";
import { ServiceError } from "./errors";
import type { EvidenceAnswer } from "./types";

export const QUESTION_MIN = 3;
export const QUESTION_MAX = 500;

export const SUGGESTED_QUESTIONS = [
  "Why did the cube hit the divider?",
  "What change fixed the failure?",
  "Which ideas didn't work, and why?",
] as const;

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const CROSS_SCOPE = /\b(all|every|other|another|across)\s+(investigations?|projects?)\b/i;

/** Questions are always about one investigation. Returns the trimmed question
 *  or throws invalid_input / out_of_scope. `knownIds` are ids that belong to
 *  this investigation (environments, findings, experiments, candidates...). */
export function scopedQuestion(question: string, investigationId: string, knownIds: Iterable<string> = []): string {
  const q = question.replace(/\s+/g, " ").trim();
  if (q.length < QUESTION_MIN) throw new ServiceError("invalid_input", "Type a question about this investigation.");
  if (q.length > QUESTION_MAX) throw new ServiceError("invalid_input", `Keep the question under ${QUESTION_MAX} characters.`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(question)) throw new ServiceError("invalid_input", "The question contains characters that can't be sent.");
  if (CROSS_SCOPE.test(q)) throw new ServiceError("out_of_scope", "Questions can only be about this investigation.");
  const allowed = new Set([investigationId.toLowerCase(), ...[...knownIds].map((id) => id.toLowerCase())]);
  for (const id of q.match(UUID) ?? []) {
    if (!allowed.has(id.toLowerCase())) throw new ServiceError("out_of_scope", "That id isn't part of this investigation.");
  }
  return q;
}

const STOP = new Set("the a an and or of to in on at for by with did does do was were is are be it its this that what which why how when who whom any some there their they them from into about after before not didnt dont work".split(" "));
const SYNONYMS: Record<string, string[]> = {
  hit: ["contact", "clip", "penetration", "collision", "divider"],
  clip: ["contact", "penetration", "divider"],
  crash: ["contact", "penetration", "collision"],
  fail: ["failure", "penetration", "contact"],
  fix: ["raising", "clear", "clearance", "transit_height"],
  fixed: ["raising", "clear", "clearance", "transit_height"],
  change: ["raising", "transit_height", "slowing"],
  idea: ["slowing", "hypothesis", "limit", "lifting"],
  slow: ["slowing", "speed"],
};

const stem = (w: string) => w.replace(/'/g, "").replace(/(ing|ed|es|s)$/, "");
function tokens(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9_']+/).map(stem).filter((w) => w.length >= 3 && !STOP.has(w));
}

/** Withheld source recorded with the demo fixture: an experiment result that
 *  was revoked after the answer was drafted. Fixture mode only. */
const FIXTURE_WITHHELD = { id: "5d1c0e4a-2b7f-4c1e-9a3d-7e2f1b6c8a90", reason: "revoked", topic: /divider|hit|contact|clip|crash/i };

/** Offline answer built only from the recorded findings; labeled fixture. */
export function fixtureAnswer(findings: Finding[], question: string): EvidenceAnswer {
  const q = tokens(question);
  const wanted = new Set(q.flatMap((w) => [w, ...(SYNONYMS[w] ?? []).map(stem)]));
  const scored = findings
    .map((f) => ({ f, score: new Set(tokens(f.summary).filter((w) => wanted.has(w))).size }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || b.f.createdAtMs - a.f.createdAtMs);
  const top = scored[0]?.score ?? 0;
  const strong = scored.filter((x) => x.score >= Math.ceil(top / 2)).slice(0, 3);
  const common = { mode: "fixture" as const, label: "Recorded example answer. The Elastic evidence agent was not used." };
  if (!strong.length) {
    return { ...common, enoughEvidence: false, citations: [], withheld: [], reason: "The recorded evidence doesn't cover that question yet." };
  }
  return {
    ...common,
    enoughEvidence: true,
    answer: strong.map(({ f }) => f.summary).join(" "),
    citations: strong.map(({ f }) => ({ id: f.id, docType: "finding" as const, summary: f.summary, environmentId: f.environmentId })),
    withheld: FIXTURE_WITHHELD.topic.test(question) ? [{ id: FIXTURE_WITHHELD.id, reason: FIXTURE_WITHHELD.reason }] : [],
  };
}

const WITHHELD_WORDS: Record<string, string> = {
  revoked: "was revoked after the answer was written",
  stale: "changed after the answer was written",
  superseded: "was replaced by a newer version",
  deleted: "was deleted",
  unauthorized: "isn't visible to you",
  out_of_scope: "belongs to a different investigation",
  unresolved: "couldn't be found",
  resolver_unavailable: "couldn't be checked right now",
};
export const withheldReason = (reason: string) => WITHHELD_WORDS[reason] ?? "couldn't be verified";
