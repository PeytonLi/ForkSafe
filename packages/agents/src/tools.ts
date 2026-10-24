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
  run_experiment(input: { caseId: string; seed: number; controllerPath?: string; hypothesis: string }, ctx: ToolCallContext): Promise<unknown>;
  submit_candidate(input: { controllerPath: string; changedFunctions: string[]; rationale: string; basedOnFindings: string[] }, ctx: ToolCallContext): Promise<unknown>;
  read_findings(input: { scope: "environment" | "investigation"; limit: number }, ctx: ToolCallContext): Promise<unknown>;
  write_finding(input: { kind: z.infer<typeof FindingKind>; summary: string; evidence: { kind: z.infer<typeof EvidenceKind>; experimentId?: string; artifactId?: string; locator: Record<string, unknown>; excerpt?: string }[] }, ctx: ToolCallContext): Promise<unknown>;
  request_evidence(input: { query: string; experimentId?: string }, ctx: ToolCallContext): Promise<unknown>;
}

export const FORKSAFE_TOOL_NAMES = [
  "run_experiment",
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
    tool("run_experiment", "Run a simulation experiment for a case.", {
      caseId: z.string().min(1),
      seed: z.number().int().nonnegative(),
      controllerPath: z.string().optional(),
      hypothesis: z.string().max(2000),
    }, call("run_experiment", (input: Parameters<ForkSafeToolBackend["run_experiment"]>[0]) => backend.run_experiment(input, ctx))),
    tool("submit_candidate", "Submit a controller candidate for evaluation.", {
      controllerPath: z.string().min(1),
      changedFunctions: z.array(z.string()),
      rationale: z.string().max(4000),
      basedOnFindings: z.array(z.string().uuid()),
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
