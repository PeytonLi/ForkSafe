# @forksafe/agents

Factory adapter boundary and deterministic fixture implementation for ForkSafe.

- `UsageLedger` reserves per-turn token budgets, charges unknown turns conservatively, and reports contract-shaped usage.
- Permission policy allows workspace-local file creation, an explicit read-only command set, and allowlisted ForkSafe MCP calls only.
- The `forksafe` MCP server exposes experiment, candidate, finding, and evidence tools through an injected backend.
- `LiveFactoryAdapter` connects to Factory Droid; `FixtureFactoryAdapter` is deterministic and labels fixture output. Readiness reports blocked credentials instead of claiming live access.
- `SessionManager` isolates UUID-scoped workspaces, limits sessions and turns, records usage, supports resume/replacement lineage, and emits validated `AgentSession` records.
- `ActivityLog` is a bounded ring with optional JSONL sink and secret/pattern redaction. It stores content digests and lengths rather than file bodies.
- Repair prompts constrain workspace use, tool use, claims, and the trust level of findings.

Run `pnpm --filter @forksafe/agents typecheck` and `pnpm --filter @forksafe/agents test`.
