import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  createSdkMcpServer,
  tool,
  type SdkMcpServer,
} from "@factory/droid-sdk/node";
import { EvidenceKind, FindingKind } from "@forksafe/contracts";
import type { ActivityLog } from "./activity-log.js";

export type ToolCallContext = {
  investigationId: string;
  environmentId: string;
  sessionId: string;
  attemptId: string;
  grantId: string;
  epoch: number;
  callId?: string;
  turnBudget?: { used: number; max: number };
  revisionState?: { headRevisionId?: string };
  jobId?: string;
  turnIndex?: number;
  parentSessionId?: string;
  role?: "primary" | "subtask";
};

export interface ForkSafeToolBackend {
  inspect_failure(input: Record<string, never>, ctx: ToolCallContext): Promise<unknown>;
  read_source(input: { path: string; revisionId?: string }, ctx: ToolCallContext): Promise<unknown>;
  apply_patch(input: { diff: string; expectedHeadRevisionId: string | null; rationale: string; basedOnFindings?: string[] }, ctx: ToolCallContext): Promise<unknown>;
  fork_candidate(input: { candidateId: string; rationale: string; basedOnFindings?: string[] }, ctx: ToolCallContext): Promise<unknown>;
  request_subtask(input: { prompt: string; purpose: string }, ctx: ToolCallContext): Promise<unknown>;
  run_experiment(input: { caseId: string; seed: number; revisionId?: string; hypothesis: string; basedOnFindings?: string[] }, ctx: ToolCallContext): Promise<unknown>;
  propose_controller_revision(input: { source: string; rationale: string; basedOnFindings?: string[] }, ctx: ToolCallContext): Promise<unknown>;
  submit_candidate(input: { revisionId: string; rationale: string; basedOnFindings: string[] }, ctx: ToolCallContext): Promise<unknown>;
  read_findings(input: { scope: "environment" | "investigation"; limit: number }, ctx: ToolCallContext): Promise<unknown>;
  write_finding(input: { kind: z.infer<typeof FindingKind>; summary: string; evidence: { kind: z.infer<typeof EvidenceKind>; experimentId?: string; artifactId?: string; locator: Record<string, unknown>; excerpt?: string }[] }, ctx: ToolCallContext): Promise<unknown>;
  request_evidence(input: { query: string; experimentId?: string }, ctx: ToolCallContext): Promise<unknown>;
}

export const FORKSAFE_TOOL_NAMES = [
  "inspect_failure",
  "read_source",
  "apply_patch",
  "fork_candidate",
  "request_subtask",
  "run_experiment",
  "propose_controller_revision",
  "submit_candidate",
  "read_findings",
  "write_finding",
  "request_evidence",
] as const;

function jsonText(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({ error: "tool result could not be serialized" });
  }
}

export function createForkSafeMcpServer(
  backend: ForkSafeToolBackend,
  ctx: ToolCallContext,
  log: ActivityLog,
): SdkMcpServer {
  const call = <Input,>(name: typeof FORKSAFE_TOOL_NAMES[number], handler: (input: Input, callContext: ToolCallContext & { callId: string }) => Promise<unknown>) =>
    async (input: Input) => {
      const callContext = { ...ctx, callId: randomUUID() };
      await log.record({ atMs: Date.now(), ...ctx, kind: "tool_call", summary: name });
      try {
        const result = await handler(input, callContext);
        if (["apply_patch", "propose_controller_revision", "fork_candidate"].includes(name)
          && result && typeof result === "object"
          && (result as { status?: unknown }).status === "committed"
          && typeof (result as { revisionId?: unknown }).revisionId === "string") {
          if (ctx.revisionState) ctx.revisionState.headRevisionId = (result as { revisionId: string }).revisionId;
        }
        await log.record({ atMs: Date.now(), ...ctx, kind: "tool_result", summary: name, data: { result: jsonText(result) } });
        return jsonText(result);
      } catch (error) {
        const payload = { error: error instanceof Error ? error.message : String(error) };
        await log.record({ atMs: Date.now(), ...ctx, kind: "error", summary: `${name} failed`, data: payload });
        return jsonText(payload);
      }
    };
  const tools = [
    tool("inspect_failure", "Inspect the captured baseline failure and a bounded first-contact trace window.", {}, call("inspect_failure", (input: Parameters<ForkSafeToolBackend["inspect_failure"]>[0], callContext) => backend.inspect_failure(input, callContext)), { annotations: { readOnlyHint: true } }),
    tool("read_source", "Read an allowed controller revision or the public case manifest.", {
      path: z.string().min(1).max(300),
      revisionId: z.string().uuid().optional(),
    }, call("read_source", (input: Parameters<ForkSafeToolBackend["read_source"]>[0], callContext) => backend.read_source(input, callContext)), { annotations: { readOnlyHint: true } }),
    tool("apply_patch", "Apply a strict unified diff to task_controller.py using an expected revision head.", {
      diff: z.string().min(1).max(200_000),
      expectedHeadRevisionId: z.string().uuid().nullable(),
      rationale: z.string().max(4000),
      basedOnFindings: z.array(z.string().uuid()).optional(),
    }, call("apply_patch", (input: Parameters<ForkSafeToolBackend["apply_patch"]>[0], callContext) => backend.apply_patch(input, callContext))),
    tool("fork_candidate", "Create a child revision from a submitted candidate.", {
      candidateId: z.string().uuid(),
      rationale: z.string().max(4000),
      basedOnFindings: z.array(z.string().uuid()).optional(),
    }, call("fork_candidate", (input: Parameters<ForkSafeToolBackend["fork_candidate"]>[0], callContext) => backend.fork_candidate(input, callContext))),
    tool("request_subtask", "Ask a bounded same-environment specialist session for one focused analysis.", {
      prompt: z.string().min(1).max(4000),
      purpose: z.string().min(1).max(200),
    }, call("request_subtask", (input: Parameters<ForkSafeToolBackend["request_subtask"]>[0], callContext) => backend.request_subtask(input, callContext))),
    tool("run_experiment", "Run the MuJoCo simulator on a public case (max 20 per environment) with the current head revision or a given revisionId. Returns the measured outcome, failure kinds and first failure.", {
      caseId: z.string().min(1).max(64),
      seed: z.number().int().nonnegative(),
      revisionId: z.string().uuid().optional(),
      hypothesis: z.string().max(2000),
      basedOnFindings: z.array(z.string().uuid()).optional(),
    }, call("run_experiment", (input: Parameters<ForkSafeToolBackend["run_experiment"]>[0], callContext) => backend.run_experiment(input, callContext))),
    tool("propose_controller_revision", "Commit a new immutable controller revision. Pass the COMPLETE task_controller.py source (must define plan(scene)); ForkSafe hashes it, diffs it against the baseline and returns revisionId.", {
      source: z.string().min(1).max(200_000),
      rationale: z.string().max(4000),
      basedOnFindings: z.array(z.string().uuid()).optional(),
    }, call("propose_controller_revision", (input: Parameters<ForkSafeToolBackend["propose_controller_revision"]>[0], callContext) => backend.propose_controller_revision(input, callContext))),
    tool("submit_candidate", "Submit a committed revision as a candidate for protected evaluation (max 2 per environment). REQUIRES at least one write_finding from this environment first, otherwise it is rejected with reason finding_required. Cite other environments' finding ids you relied on in basedOnFindings.", {
      revisionId: z.string().uuid(),
      rationale: z.string().max(4000),
      basedOnFindings: z.array(z.string().uuid()).optional(),
    }, call("submit_candidate", (
      input: { revisionId: string; rationale: string; basedOnFindings?: string[] },
      callContext,
    ) => backend.submit_candidate({ ...input, basedOnFindings: input.basedOnFindings ?? [] }, callContext))),
    tool("read_findings", "Read investigation findings, other environments' findings first. Call it before patching and cite any finding ids you rely on in basedOnFindings (apply_patch, propose_controller_revision, run_experiment, submit_candidate).", {
      scope: z.enum(["environment", "investigation"]).default("investigation"),
      limit: z.number().int().min(1).max(50).default(20),
    }, call("read_findings", (input: Parameters<ForkSafeToolBackend["read_findings"]>[0], callContext) => backend.read_findings(input, callContext)), { annotations: { readOnlyHint: true } }),
    tool("write_finding", "Publish a finding (REQUIRED before submit_candidate): one measured observation shared with every other environment. Cite the experimentId from run_experiment as evidence, e.g. kind limit_violation with evidence [{kind: 'metric', experimentId, locator: {}}].", {
      kind: FindingKind,
      summary: z.string().min(1).max(2000),
      evidence: z.array(z.object({
        kind: EvidenceKind,
        experimentId: z.string().uuid().optional(),
        artifactId: z.string().uuid().optional(),
        locator: z.record(z.unknown()).default({}),
        excerpt: z.string().max(4000).optional(),
      })),
    }, call("write_finding", (input: Parameters<ForkSafeToolBackend["write_finding"]>[0], callContext) => backend.write_finding(input, callContext))),
    tool("request_evidence", "Request evidence for an experiment or question.", {
      query: z.string().max(500),
      experimentId: z.string().uuid().optional(),
    }, call("request_evidence", (input: Parameters<ForkSafeToolBackend["request_evidence"]>[0], callContext) => backend.request_evidence(input, callContext)), { annotations: { readOnlyHint: true } }),
  ];
  return createSdkMcpServer({ name: "forksafe", tools });
}
