import type { EnvConfig } from "@forksafe/contracts";

export interface CanonicalRef { docType: "finding" | "evidence" | "experiment_result" | "candidate" | "evaluation"; id: string; investigationId: string; sourceVersion: string }
export interface CanonicalRecord { authorized: boolean; revoked?: boolean; superseded?: boolean; deleted?: boolean; sourceVersion: string; record: unknown }
export interface CanonicalResolver { resolve(refs: CanonicalRef[]): Promise<Map<string, CanonicalRecord>> }
export interface AgentQuestion { input: string; investigationId: string; agentId?: string; conversationId?: string }
export interface AgentAnswer {
  mode: "live" | "fixture" | "not_implemented" | "blocked"; answer?: string; label?: string; reason?: string;
  citations?: { id: string; docType: string; canonical: unknown }[]; droppedCitations?: { id: string; reason: string }[];
  conversationId?: string; usage: "evidence_only"; scoreAffecting: false;
}
export declare class AgentBuilder {
  constructor(env: EnvConfig, resolver: CanonicalResolver, search: unknown, fetcher?: typeof fetch);
  ask(question: AgentQuestion): Promise<AgentAnswer>;
}
export declare function agentBuilderReadiness(env: EnvConfig, now: number): { mode: "live" | "local" | "fixture" | "blocked" | "not_implemented" };
export declare function toDocuments(record: unknown): { index: string; id: string; body: { sourceVersion: string } }[];
