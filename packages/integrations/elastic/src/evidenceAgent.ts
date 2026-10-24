import { z } from "zod";
import { EnvironmentId, InvestigationId, type EnvConfig } from "@forksafe/contracts";
import { agentBuilderReadiness, resolveConfig } from "./config.ts";
import { canonicalJSON } from "./indexer.ts";
import { KibanaClient, KibanaError } from "./kibana.ts";
import { INDICES } from "./mappings.ts";
import { resolveEvidence, type CanonicalRef, type CanonicalResolver, type Dropped } from "./search.ts";

export const FORKSAFE_AGENT_ID = "forksafe-evidence-agent";
export const NOT_ENOUGH_EVIDENCE = "not enough evidence";
export const AGENT_INDICES = [INDICES.finding, INDICES.evidence, INDICES.experiment_result] as const;

export interface AgentToolDefinition {
  id: string; type: "index_search" | "esql"; description: string; tags: string[];
  configuration: Record<string, unknown>;
}
const TAGS = ["forksafe", "evidence"];
export const FORKSAFE_TOOLS: readonly AgentToolDefinition[] = [
  { id: "forksafe.search_findings", type: "index_search", tags: TAGS, configuration: { pattern: INDICES.finding },
    description: "Search ForkSafe findings (agent claims about a robot-controller investigation). Always filter by the investigationId given in the question. Each row has docType, id, investigationId and sourceVersion; cite those exact values." },
  { id: "forksafe.search_evidence", type: "index_search", tags: TAGS, configuration: { pattern: INDICES.evidence },
    description: "Search ForkSafe evidence items (log excerpts, contacts, traces) attached to findings. Always filter by the investigationId given in the question. Each row has docType, id, investigationId and sourceVersion; cite those exact values." },
  { id: "forksafe.search_experiments", type: "index_search", tags: TAGS, configuration: { pattern: INDICES.experiment_result },
    description: "Search ForkSafe simulation experiment results (status, failureKinds, suite, caseId). Always filter by the investigationId given in the question. Each row has docType, id, investigationId and sourceVersion; cite those exact values." },
  { id: "forksafe.investigation_records", type: "esql", tags: TAGS,
    description: "List every ForkSafe finding, evidence item and experiment result for exactly one investigationId, with the id and sourceVersion needed for citations.",
    configuration: {
      query: `FROM ${AGENT_INDICES.join(",")} | WHERE investigationId == ?investigationId | KEEP docType, id, investigationId, sourceVersion, findingId, experimentId, kind, status, failureKinds, text | SORT docType, id | LIMIT 100`,
      params: { investigationId: { type: "string", description: "The ForkSafe investigation UUID named in the question" } },
    } },
];

export const AGENT_INSTRUCTIONS = [
  "You explain recorded ForkSafe robot-controller investigation evidence. You are read-only: you never change scores, approve candidates, reinterpret failing cases as passing, or claim anything the tools did not return.",
  "Only use the forksafe.* tools, and only for the single investigationId named in the question. Start with forksafe.investigation_records for that investigationId; use the search tools to narrow down.",
  "Every factual sentence must cite the finding, evidence or experiment_result documents that support it.",
  "End every answer with exactly one fenced ```json block of the form {\"citations\":[{\"docType\":\"finding|evidence|experiment_result\",\"id\":\"...\",\"investigationId\":\"...\",\"sourceVersion\":\"...\"}]} using values copied exactly from tool results.",
  `If the tools return no documents that answer the question for that investigation, reply exactly "${NOT_ENOUGH_EVIDENCE}" followed by {"citations":[]} in the json block. Never guess.`,
].join("\n");

export const FORKSAFE_AGENT = {
  id: FORKSAFE_AGENT_ID,
  name: "ForkSafe Evidence Agent",
  description: "Answers questions about ForkSafe investigations from indexed findings, evidence and experiments, with canonical citations. Read-only; cannot change scores or reviews.",
  labels: ["forksafe"],
  configuration: {
    instructions: AGENT_INSTRUCTIONS,
    tools: [{ tool_ids: FORKSAFE_TOOLS.map(tool => tool.id) }],
    enable_elastic_capabilities: false,
  },
} as const;

export type EnsureAction = "created" | "updated" | "unchanged";
export interface EnsureResult { mode: "live"; tools: { id: string; action: EnsureAction }[]; agent: { id: string; action: EnsureAction } }

const remoteTool = z.object({ id: z.string(), type: z.string(), description: z.string().optional(), tags: z.array(z.string()).optional(),
  configuration: z.record(z.unknown()).optional(), readonly: z.boolean().optional() }).passthrough();
const remoteAgent = z.object({ id: z.string(), name: z.string().optional(), description: z.string().optional(), labels: z.array(z.string()).optional(),
  readonly: z.boolean().optional(),
  configuration: z.object({ instructions: z.string().optional(), enable_elastic_capabilities: z.boolean().optional(),
    tools: z.array(z.object({ tool_ids: z.array(z.string()) }).passthrough()).optional() }).passthrough().optional() }).passthrough();

/** Thrown when an existing Kibana object with our stable id cannot be converged without deleting it. */
export class AgentConfigConflictError extends Error {
  constructor(message: string) { super(message); this.name = "AgentConfigConflictError"; }
}

const toolMatches = (remote: z.infer<typeof remoteTool>, wanted: AgentToolDefinition) =>
  remote.description === wanted.description && canonicalJSON([...(remote.tags ?? [])].sort()) === canonicalJSON([...wanted.tags].sort())
  && canonicalJSON(remote.configuration ?? {}) === canonicalJSON(wanted.configuration);
const agentMatches = (remote: z.infer<typeof remoteAgent>) => {
  const wanted = FORKSAFE_AGENT;
  const remoteToolIds = (remote.configuration?.tools ?? []).flatMap(t => t.tool_ids).sort();
  return remote.name === wanted.name && remote.description === wanted.description
    && canonicalJSON([...(remote.labels ?? [])].sort()) === canonicalJSON([...wanted.labels].sort())
    && remote.configuration?.instructions === wanted.configuration.instructions
    && remote.configuration?.enable_elastic_capabilities === wanted.configuration.enable_elastic_capabilities
    && canonicalJSON(remoteToolIds) === canonicalJSON(FORKSAFE_TOOLS.map(t => t.id).sort());
};

export const AskInput = z.object({
  question: z.string().trim().min(1).max(2000),
  scope: z.object({ investigationId: InvestigationId, environmentId: EnvironmentId.optional() }).strict(),
});
export type AskInput = z.infer<typeof AskInput>;
export type AskStatus = "grounded" | "partially_grounded" | "withheld" | "not_enough_evidence" | "unavailable";
export interface AskCitation { docType: CanonicalRef["docType"]; id: string; sourceVersion: string; canonical: unknown }
export interface AskResult {
  mode: "live" | "blocked" | "not_implemented"; status: AskStatus; agentId: string; answer: string; reason?: string;
  citations: AskCitation[]; droppedCitations: Dropped[]; malformedCitations: number;
  toolIds: string[]; conversationId?: string; usage: "evidence_only"; scoreAffecting: false;
}

const citationRef = z.object({ docType: z.enum(["finding", "evidence", "experiment_result"]), id: z.string().min(1).max(512),
  investigationId: z.string().min(1).max(128), sourceVersion: z.string().min(1).max(256) });
export interface ParsedCitations { refs: CanonicalRef[]; malformed: number; blocks: number; notEnoughEvidence: boolean; prose: string }

/** Extracts the agent's declared citations from fenced ```json blocks (or a trailing bare {"citations":...} object). */
export function parseAgentCitations(message: string): ParsedCitations {
  const fenced = [...message.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
  const candidates = fenced.map(match => match[1] ?? "");
  let prose = message;
  for (const match of fenced) prose = prose.replace(match[0], "");
  if (!fenced.length) {
    const start = message.lastIndexOf("{\"citations\"");
    if (start >= 0) { candidates.push(message.slice(start)); prose = message.slice(0, start); }
  }
  const refs = new Map<string, CanonicalRef>();
  let malformed = 0, blocks = 0;
  for (const candidate of candidates) {
    let parsed: unknown;
    try { parsed = JSON.parse(candidate.trim()); } catch { malformed++; continue; }
    const list = parsed && typeof parsed === "object" && Array.isArray((parsed as { citations?: unknown }).citations)
      ? (parsed as { citations: unknown[] }).citations : undefined;
    if (!list) { malformed++; continue; }
    blocks++;
    for (const item of list) {
      const ref = citationRef.safeParse(item);
      if (!ref.success) { malformed++; continue; }
      refs.set(`${ref.data.docType}:${ref.data.id}`, ref.data);
    }
  }
  prose = prose.trim();
  return { refs: [...refs.values()], malformed, blocks, prose,
    notEnoughEvidence: prose.toLowerCase().replace(/[.!\s]+$/, "").includes(NOT_ENOUGH_EVIDENCE) };
}

const converseResponse = z.object({
  conversation_id: z.string().optional(),
  steps: z.array(z.object({ type: z.string().optional(), tool_id: z.string().optional() }).passthrough()).optional(),
  response: z.object({ message: z.string() }).passthrough(),
}).passthrough();

export interface EvidenceAgentOptions { fetcher?: typeof fetch; agentId?: string; timeoutMs?: number; converseTimeoutMs?: number }

/** Provisions and queries the ForkSafe Agent Builder agent. Generated prose is evidence-only and is re-checked against canonical records. */
export class ForkSafeEvidenceAgent {
  private env: EnvConfig;
  readonly agentId: string;
  constructor(env: EnvConfig, private resolver: CanonicalResolver, private options: EvidenceAgentOptions = {}) {
    this.env = resolveConfig(env);
    this.agentId = options.agentId ?? FORKSAFE_AGENT_ID;
  }
  private client() {
    return new KibanaClient(this.env.KIBANA_URL, this.env.KIBANA_API_KEY, this.options.fetcher ?? fetch, this.options.timeoutMs);
  }
  private requireLive() {
    const mode = agentBuilderReadiness(this.env, 0).mode;
    if (mode !== "live") throw new KibanaError(mode === "blocked" ? "auth" : "bad_request", undefined, `Agent Builder is ${mode}; set ELASTIC_AGENT_BUILDER_MODE=cloud with KIBANA_URL and KIBANA_API_KEY`);
  }

  /** Idempotently create or converge the ForkSafe tools and agent by stable id. Never deletes Kibana objects. */
  async ensureAgent(): Promise<EnsureResult> {
    this.requireLive();
    const kibana = this.client();
    const tools: EnsureResult["tools"] = [];
    for (const tool of FORKSAFE_TOOLS) tools.push({ id: tool.id, action: await this.ensureTool(kibana, tool) });
    return { mode: "live", tools, agent: { id: FORKSAFE_AGENT_ID, action: await this.ensureAgentObject(kibana) } };
  }
  private async ensureTool(kibana: KibanaClient, tool: AgentToolDefinition): Promise<EnsureAction> {
    const path = `/api/agent_builder/tools/${encodeURIComponent(tool.id)}`;
    const read = async () => {
      const { data } = await kibana.request("GET", path, undefined, { allow404: true });
      if (data === undefined) return undefined;
      const parsed = remoteTool.safeParse(data);
      if (!parsed.success) throw new KibanaError("invalid_response", 200, `Unexpected tool shape for ${tool.id}`);
      return parsed.data;
    };
    let existing = await read();
    if (!existing) {
      try { await kibana.request("POST", "/api/agent_builder/tools", tool); return "created"; }
      catch (error) {
        // A concurrent ensure may have created it; converge on what is there instead of failing.
        existing = await read();
        if (!existing) throw error;
      }
    }
    if (existing.type !== tool.type || existing.readonly) throw new AgentConfigConflictError(`Tool ${tool.id} exists with an incompatible type or is read-only`);
    if (toolMatches(existing, tool)) return "unchanged";
    await kibana.request("PUT", path, { description: tool.description, tags: tool.tags, configuration: tool.configuration });
    return "updated";
  }
  private async ensureAgentObject(kibana: KibanaClient): Promise<EnsureAction> {
    const path = `/api/agent_builder/agents/${encodeURIComponent(FORKSAFE_AGENT_ID)}`;
    const read = async () => {
      const { data } = await kibana.request("GET", path, undefined, { allow404: true });
      if (data === undefined) return undefined;
      const parsed = remoteAgent.safeParse(data);
      if (!parsed.success) throw new KibanaError("invalid_response", 200, "Unexpected agent shape");
      return parsed.data;
    };
    const { id: _id, ...update } = FORKSAFE_AGENT;
    let existing = await read();
    if (!existing) {
      try { await kibana.request("POST", "/api/agent_builder/agents", { ...FORKSAFE_AGENT, access_control: { access_mode: "shared" } }); return "created"; }
      catch (error) { existing = await read(); if (!existing) throw error; }
    }
    if (existing.readonly) throw new AgentConfigConflictError(`Agent ${FORKSAFE_AGENT_ID} is read-only`);
    if (agentMatches(existing)) return "unchanged";
    await kibana.request("PUT", path, update);
    return "updated";
  }

  /** Ask a scoped question; every cited id is re-checked against canonical authorization before anything is returned. */
  async ask(question: string, scope: AskInput["scope"]): Promise<AskResult> {
    const input = AskInput.parse({ question, scope });
    const base = { agentId: this.agentId, citations: [], droppedCitations: [], malformedCitations: 0, toolIds: [],
      usage: "evidence_only" as const, scoreAffecting: false as const };
    const mode = agentBuilderReadiness(this.env, 0).mode;
    if (mode !== "live") return { ...base, mode: mode === "blocked" ? "blocked" : "not_implemented", status: "unavailable",
      answer: "Agent Builder unavailable.", reason: mode === "blocked" ? "Agent Builder credentials unavailable" : `Agent Builder mode is ${mode}` };
    const { investigationId, environmentId } = input.scope;
    const prompt = [`investigationId: ${investigationId}`, ...(environmentId ? [`environmentId: ${environmentId}`] : []),
      "Answer only from forksafe.* tool results for this investigationId. Cite docType, id, investigationId and sourceVersion in the final json block.",
      `Question: ${input.question}`].join("\n");
    let data: z.infer<typeof converseResponse>;
    try {
      const response = await this.client().request("POST", "/api/agent_builder/converse", { agent_id: this.agentId, input: prompt },
        { timeoutMs: this.options.converseTimeoutMs ?? 180_000 });
      const parsed = converseResponse.safeParse(response.data);
      if (!parsed.success) return { ...base, mode: "blocked", status: "unavailable", answer: "Agent Builder unavailable.", reason: "Agent Builder returned an unexpected response" };
      data = parsed.data;
    } catch (error) {
      const reason = error instanceof KibanaError
        ? error.code === "not_found" ? `Agent ${this.agentId} not found; run ensureAgent` : error.message
        : "Agent Builder request failed";
      return { ...base, mode: "blocked", status: "unavailable", answer: "Agent Builder unavailable.", reason: this.redact(reason) };
    }
    const toolIds = [...new Set((data.steps ?? []).flatMap(step => step.type === "tool_call" && step.tool_id ? [step.tool_id] : []))];
    const parsed = parseAgentCitations(data.response.message);
    const { accepted, dropped } = await resolveEvidence(parsed.refs, investigationId, this.resolver);
    const citations = parsed.refs.flatMap(ref => accepted.has(ref.id)
      ? [{ docType: ref.docType, id: ref.id, sourceVersion: ref.sourceVersion, canonical: accepted.get(ref.id)!.record }] : []);
    let status: AskStatus, answer: string;
    if (!parsed.refs.length) {
      status = "not_enough_evidence";
      answer = parsed.notEnoughEvidence ? NOT_ENOUGH_EVIDENCE : `${NOT_ENOUGH_EVIDENCE} (the agent answered without verifiable citations; its prose is withheld)`;
    } else if (!citations.length) {
      status = "withheld";
      answer = `${NOT_ENOUGH_EVIDENCE} (no cited record passed the canonical re-check)`;
    } else if (dropped.length || parsed.malformed) {
      // The prose may lean on a revoked or out-of-scope record, so only the surviving citations are surfaced.
      status = "partially_grounded";
      answer = `Answer withheld: ${dropped.length + parsed.malformed} citation(s) failed the canonical re-check. Inspect the ${citations.length} authorized citation(s) directly.`;
    } else {
      status = "grounded";
      answer = parsed.prose || data.response.message;
    }
    return { ...base, mode: "live", status, answer: this.redact(answer), citations,
      droppedCitations: dropped,
      malformedCitations: parsed.malformed, toolIds, conversationId: data.conversation_id };
  }
  private redact(value: string) {
    for (const secret of [this.env.KIBANA_API_KEY, this.env.ELASTICSEARCH_API_KEY, this.env.KIBANA_URL, this.env.ELASTICSEARCH_URL]) {
      if (secret) value = value.split(secret).join("[REDACTED]");
    }
    return value;
  }
}

export const ensureAgent = (env: EnvConfig, options: EvidenceAgentOptions = {}) =>
  new ForkSafeEvidenceAgent(env, { resolve: async () => new Map() }, options).ensureAgent();
