# @forksafe/agents

Factory adapter boundary and deterministic fixture implementation for ForkSafe.

- `UsageLedger` reserves per-turn token budgets, charges unknown turns conservatively, and reports contract-shaped usage.
- Permission policy allows workspace-local file creation, an explicit read-only command set, and allowlisted ForkSafe MCP calls only.
- The `forksafe` MCP server exposes experiment, candidate, finding, and evidence tools through an injected backend.
- `LiveFactoryAdapter` connects to Factory Droid; `FixtureFactoryAdapter` is deterministic and labels fixture output. Readiness reports blocked credentials instead of claiming live access.
- `SessionManager` isolates UUID-scoped workspaces, limits sessions and turns, records usage, supports resume/replacement lineage, and emits validated `AgentSession` records.
- `ActivityLog` is a bounded ring with optional JSONL sink and secret/pattern redaction. It stores content digests and lengths rather than file bodies.
- Repair prompts constrain workspace use, tool use, claims, and the trust level of findings.

## Droid built-in tools and permissions

At `AutonomyLevel.Low`, Droid's own risk classification auto-runs low-risk tools without consulting the permission handler; the handler governs escalated requests. `disabledToolIds` removes the built-ins listed below. The `forksafe` MCP server is configured separately and remains available. Permission decisions that do reach the handler are logged with tool names, allowed status, and reasons, without arguments or file contents.

The SDK child process inherits the runner process environment. Therefore the trusted runner process must not hold secrets other than `FACTORY_API_KEY`; generated code never runs in the runner.

This listTools inventory was collected with SDK `0.10.0` and Droid `0.249.0`, with no prompt. The first `allowed` value is before applying `disabledToolIds`; the second is after.

| id | allowed before | allowed after |
| --- | --- | --- |
| `ApplyPatch` | true | false |
| `AskUser` | true | false |
| `ConnectApp` | true | false |
| `CreateAutomation` | true | false |
| `DeleteAutomation` | true | false |
| `DismissHandoffItems` | true | false |
| `EditAutomation` | true | false |
| `EndFeatureRun` | true | false |
| `Execute` | true | true |
| `ExitSpecMode` | false | false |
| `FetchUrl` | true | false |
| `GenerateDroid` | true | false |
| `GenerateImage` | true | false |
| `Glob` | true | true |
| `Grep` | true | true |
| `ListAutomations` | true | false |
| `ListAutomationTemplates` | true | false |
| `Loop` | true | false |
| `LS` | true | true |
| `ProposeMission` | true | false |
| `Read` | true | true |
| `ReadAutomation` | true | false |
| `RunAutomation` | true | false |
| `Script` | true | true |
| `Skill` | true | false |
| `StageSettingsChanges` | true | false |
| `StartMissionRun` | true | false |
| `Task` | true | false |
| `TaskOutput` | true | false |
| `TaskStop` | true | false |
| `TodoWrite` | true | false |
| `ToolSearch` | true | true |
| `WaitForScript` | true | false |
| `WebSearch` | true | false |

`Create` was not present in this CLI's listTools inventory and is not in the disabled ID list. The permission handler still allows only workspace-contained Create requests.

Run `pnpm --filter @forksafe/agents typecheck` and `pnpm --filter @forksafe/agents test`.
