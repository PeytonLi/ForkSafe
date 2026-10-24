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
};

export interface ForkSafeToolBackend {
  run_experiment(input: { caseId: string; seed: number; revisionId?: string; hypothesis: string }, ctx: ToolCallContext): Promise<unknown>;
  propose_controller_revision(input: { source: string; rationale: string }, ctx: ToolCallContext): Promise<unknown>;
  submit_candidate(input: { revisionId: string; rationale: string; basedOnFindings: string[] }, ctx: ToolCallContext): Promise<unknown>;
  read_findings(input: { scope: "environment" | "investigation"; limit: number }, ctx: ToolCallContext): Promise<unknown>;
  write_finding(input: { kind: z.infer<typeof FindingKind>; summary: string; evidence: { kind: z.infer<typeof EvidenceKind>; experimentId?: string; artifactId?: string; locator: Record<string, unknown>; excerpt?: string }[] }, ctx: ToolCallContext): Promise<unknown>;
  request_evidence(input: { query: string; experimentId?: string }, ctx: ToolCallContext): Promise<unknown>;
}

export const FORKSAFE_TOOL_NAMES = [
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
  const call = <Input,>(name: typeof FORKSAFE_TOOL_NAMES[number], handler: (input: Input) => Promise<unknown>) =>
    async (input: Input) => {
      await log.record({ atMs: Date.now(), ...ctx, kind: "tool_call", summary: name });
      try {
        const result = await handler(input);
        await log.record({ atMs: Date.now(), ...ctx, kind: "tool_result", summary: name, data: { result: jsonText(result) } });
        return jsonText(result);
      } catch (error) {
        const payload = { error: error instanceof Error ? error.message : String(error) };
        await log.record({ atMs: Date.now(), ...ctx, kind: "error", summary: `${name} failed`, data: payload });
        return jsonText(payload);
      }
    };
  const tools = [
    tool("run_experiment", "Run the MuJoCo simulator on a public case (max 20 per environment) with the current head revision or a given revisionId. Returns the measured outcome, failure kinds and first failure.", {
      caseId: z.string().min(1).max(64),
      seed: z.number().int().nonnegative(),
      revisionId: z.string().uuid().optional(),
      hypothesis: z.string().max(2000),
    }, call("run_experiment", (input: Parameters<ForkSafeToolBackend["run_experiment"]>[0]) => backend.run_experiment(input, ctx))),
    tool("propose_controller_revision", "Commit a new immutable controller revision. Pass the COMPLETE task_controller.py source (must define plan(scene)); ForkSafe hashes it, diffs it against the baseline and returns revisionId.", {
      source: z.string().min(1).max(200_000),
      rationale: z.string().max(4000),
    }, call("propose_controller_revision", (input: Parameters<ForkSafeToolBackend["propose_controller_revision"]>[0]) => backend.propose_controller_revision(input, ctx))),
    tool("submit_candidate", "Submit a committed revision as a candidate for protected evaluation (max 2 per environment).", {
      revisionId: z.string().uuid(),
      rationale: z.string().max(4000),
      basedOnFindings: z.array(z.string().uuid()).default([]),
    }, call("submit_candidate", (input: Parameters<ForkSafeToolBackend["submit_candidate"]>[0]) => backend.submit_candidate(input, ctx))),
    tool("read_findings", "Read existing investigation findings.", {
      scope: z.enum(["environment", "investigation"]).default("investigation"),
      limit: z.number().int().min(1).max(50).default(20),
    }, call("read_findings", (input: Parameters<ForkSafeToolBackend["read_findings"]>[0]) => backend.read_findings(input, ctx)), { annotations: { readOnlyHint: true } }),
    tool("write_finding", "Record a structured investigation finding.", {
      kind: FindingKind,
      summary: z.string().min(1).max(2000),
      evidence: z.array(z.object({
        kind: EvidenceKind,
        experimentId: z.string().uuid().optional(),
        artifactId: z.string().uuid().optional(),
        locator: z.record(z.unknown()).default({}),
        excerpt: z.string().max(4000).optional(),
      })),
    }, call("write_finding", (input: Parameters<ForkSafeToolBackend["write_finding"]>[0]) => backend.write_finding(input, ctx))),
    tool("request_evidence", "Request evidence for an experiment or question.", {
      query: z.string().max(500),
      experimentId: z.string().uuid().optional(),
    }, call("request_evidence", (input: Parameters<ForkSafeToolBackend["request_evidence"]>[0]) => backend.request_evidence(input, ctx)), { annotations: { readOnlyHint: true } }),
  ];
  return createSdkMcpServer({ name: "forksafe", tools });
}
