import { ConvexError } from "convex/values";
import { z } from "zod";

export const QUESTION_MIN = 3;
export const QUESTION_MAX = 500;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const CROSS_SCOPE = /\b(all|every|other|another|across)\s+(investigations?|projects?)\b/i;

export const AskArgs = z.object({
  investigationId: z.string().uuid(),
  question: z.string().transform((q) => q.replace(/\s+/g, " ").trim()).pipe(z.string().min(QUESTION_MIN).max(QUESTION_MAX)),
});

/** Throws invalid_input / out_of_scope; returns the normalized question and
 *  the ids it mentions (all must belong to this investigation). */
export function parseAsk(raw: { investigationId: string; question: string }): { investigationId: string; question: string; mentionedIds: string[] } {
  // eslint-disable-next-line no-control-regex
  if (typeof raw.question !== "string" || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(raw.question)) throw new ConvexError("invalid_input");
  const parsed = AskArgs.safeParse(raw);
  if (!parsed.success) throw new ConvexError("invalid_input");
  const { investigationId, question } = parsed.data;
  if (CROSS_SCOPE.test(question)) throw new ConvexError("out_of_scope");
  const mentionedIds = [...new Set((question.match(UUID) ?? []).map((id) => id.toLowerCase()))].filter((id) => id !== investigationId.toLowerCase());
  if (mentionedIds.length > 10) throw new ConvexError("invalid_input");
  return { investigationId, question, mentionedIds };
}

const DOC_TYPES = ["finding", "evidence", "experiment_result"] as const;
type Mode = "live" | "local" | "fixture" | "blocked" | "not_implemented";
interface AgentAnswerLike {
  mode: "live" | "fixture" | "not_implemented" | "blocked";
  answer?: string; label?: string; reason?: string;
  citations?: { id: string; docType: string; canonical: unknown }[];
  droppedCitations?: { id: string; reason: string }[];
}

function finiteTime(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Smallest locator time on a finding or experiment. Missing times stay missing. */
export function citationTime(canonical: unknown): number | undefined {
  const record = (canonical ?? {}) as Record<string, unknown>;
  const times = [finiteTime(record.tSec), finiteTime(record.timeSec), finiteTime(record.failureTSec)];
  const evidence = Array.isArray(record.evidence) ? record.evidence : [];
  for (const item of evidence) {
    if (!item || typeof item !== "object") continue;
    const locator = (item as { locator?: unknown }).locator;
    if (!locator || typeof locator !== "object") continue;
    const fields = locator as Record<string, unknown>;
    times.push(finiteTime(fields.tSec), finiteTime(fields.timeSec), finiteTime(fields.failureTSec));
  }
  const found = times.filter((time): time is number => time !== undefined);
  return found.length ? Math.min(...found) : undefined;
}

function summarize(docType: string, canonical: unknown): { summary: string; environmentId?: string; tSec?: number } {
  const r = (canonical ?? {}) as Record<string, unknown>;
  const environmentId = typeof r.environmentId === "string" ? r.environmentId : undefined;
  const tSec = citationTime(canonical);
  const base = docType === "experiment_result"
    ? `${String(r.status ?? "experiment")}${Array.isArray(r.failureKinds) && r.failureKinds.length ? `: ${r.failureKinds.join(", ")}` : ""}`
    : String(r.summary ?? "Recorded evidence");
  return { summary: base.slice(0, 500), ...(environmentId ? { environmentId } : {}), ...(tSec !== undefined ? { tSec } : {}) };
}

/** Maps the Elastic AgentBuilder answer to the web's EvidenceAnswer. Only a
 *  live answer with validated citations and nothing withheld counts as enough. */
export interface WebAnswer {
  mode: Mode; enoughEvidence: boolean; answer?: string; label?: string; reason?: string;
  citations: { id: string; docType: "finding" | "evidence" | "experiment_result"; summary: string; environmentId?: string; tSec?: number }[];
  withheld: { id: string; reason: string }[];
}

export function toWebAnswer(a: AgentAnswerLike): WebAnswer {
  const citations = (a.citations ?? []).flatMap((c) => {
    const docType = DOC_TYPES.find((d) => d === c.docType);
    return docType ? [{ id: c.id, docType, ...summarize(docType, c.canonical) }] : [];
  });
  const withheld = (a.droppedCitations ?? []).map((d) => ({ id: d.id, reason: d.reason }));
  const enoughEvidence = a.mode === "live" && citations.length > 0 && withheld.length === 0;
  return {
    mode: a.mode, enoughEvidence, citations, withheld,
    ...(enoughEvidence && a.answer ? { answer: a.answer.slice(0, 8000) } : {}),
    ...(a.label ? { label: a.label } : {}),
    ...(!enoughEvidence ? { reason: a.mode === "blocked" ? "The evidence agent isn't reachable right now." : withheld.length ? "Some sources behind the answer couldn't be verified, so it isn't shown." : "None of the recorded evidence answers this question." } : {}),
  };
}

export const notConnected = (mode: Mode): WebAnswer => ({
  mode, enoughEvidence: false, citations: [], withheld: [],
  reason: mode === "blocked" ? "The evidence agent isn't set up on this deployment yet." : "The evidence agent isn't switched on for this deployment.",
});
