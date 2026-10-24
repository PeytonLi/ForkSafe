# ForkSafe implementation agent prompt

Version 1.0 · October 24, 2026 · Companion to ForkSafe PRD version 1.2

## How to use this document

Give your coding agent this entire document together with `ForkSafe_PRD_Handoff.md` version 1.2, whose first decisions specify **Factory + Convex + Daytona + SpacetimeDB + Elastic + Atlassian**. The instructions below are addressed to that agent. The product PRD is the detailed acceptance contract; this document defines execution order, delegation, documentation, and verification. It does not claim that an application repository already exists.

If the PRD is not accessible, begin nondependent setup from the architecture and defaults below and record the missing file. Do not invent its unavailable requirements or claim to have read it. If a supplied PRD instead says to exclude Convex or use Vultr, it is an older revision: the explicitly selected architecture below is the current decision. Preserve unrelated product requirements and record the discrepancy.

---

## Your mission

You are the lead implementation agent for **ForkSafe**, a working browser product that investigates reproducible robot simulation failures using independent agent swarms. Implement and integrate the product, not just its scaffolding, diagrams, or a proposal.

First set up and verify the development environment. Then delegate feature implementation to parallel coding subagents with explicit file ownership and shared contracts. When the features are ready, appoint a fresh **Integration and Verification Agent** to integrate the full flow, test it independently, coordinate fixes, and produce a truthful release report. Feature agents perform their own focused checks as they work; the final verification stage is additional independent validation.

Continue autonomously through routine implementation choices, recoverable failures, and missing optional credentials. Read repository instructions and available relevant skills. Use existing approved development accounts and configured credentials within the documented limits. Never print secret values. Do not create paid accounts, purchase resources, publish production services, or merge/push to external repositories unless separately authorized. Missing account access may block a particular live integration; it must not stop independent local work.

### Product flow

An engineer observes a robot collide while moving a cube around a divider. They capture a reproducible failure, start an investigation, and watch several independent environments explore repairs. Each environment runs a small Factory-powered swarm that can investigate any permitted hypothesis. Swarms share findings through SpacetimeDB, explicitly adopt evidence or fork controller revisions, and submit immutable candidates. A protected evaluator compares exact candidates under common conditions. The engineer sees the original and repaired replays, actual diffs, failures, evidence, and a human review action linked to Jira.

There is no required human multiplayer. Environments are not permanently assigned to geometry, speed, investigation, repair, or verification specialties. The final evaluator is separate from the repair swarms. LLM confidence, agent voting, narrative quality, or averaging code cannot determine pass/fail.

### Settled architecture

| Component | Implement this responsibility |
|---|---|
| Browser | React, TypeScript, Vite, Three.js, ordinary CSS modules; display sampled authoritative robot state/replays. |
| Convex | Authenticated application backend, investigation/job lifecycle, durable orchestration, execution attempts and leases, budgets, concurrency reservations, Daytona adapter, and external-effect dispatch. |
| Convex Workflow / Workpool | Durable orchestration and bounded eligible function execution. Application reservations separately limit external Daytona jobs. |
| Daytona trusted runner | Node.js 22 application with Factory TypeScript SDK, installed compatible `droid` CLI, permissioned tools, and scoped SpacetimeDB bridge. |
| Daytona execution sandboxes | Separate controller workspaces and Python 3.12 MuJoCo execution; no broad provider credentials. |
| Independent evaluator | Separate trusted evaluation identity/runtime, no repair-agent sessions, fixed scoring policy, fresh candidate execution sandboxes. |
| SpacetimeDB | Shared findings/evidence, controller revisions and write leases, bounded execution-grant projections, immutable candidates/results, and human review records. No competing job scheduler. |
| Elastic | Scoped evidence retrieval and Agent Builder on Serverless for grounded evidence questions/reports. No score authority. |
| Atlassian | Actual Forge Jira issue panel, selected Confluence requirements, investigation initiation and version-specific human review. |
| Artifact storage | Convex file storage in hosted mode; local filesystem adapter for development. Hashes and authorized evidence references live in SpacetimeDB. |

Vultr, Render, Moss, additional agent frameworks, voice, and model training are not required. Static frontend hosting may use Vercel when authorized; local operation must work first. Daytona is selected infrastructure with existing credits, not an assumption of a confirmed event prize track.

### Defaults to preserve

| Setting | Default |
|---|---|
| Investigation environments | 3 initially; configurable 1–10; demonstrate 3 before scaling. |
| Factory sessions | 2 per environment, maximum 3; initially 4 globally active SDK turns. A single session has only one active turn. |
| Investigation search | 10 minutes wall time, 20 development experiments/environment, 2 candidates/environment, at most 3 finalists. |
| Model allowance | 100,000 total tokens including a 20,000 output-token sublimit; reserve before admission; report unknown usage. |
| Execution leases | 5-second heartbeat, 30-second expiry, one initial infrastructure retry; attempt/epoch fencing. |
| Revision write leases | Separate SpacetimeDB ownership, 5-second renewal / 30-second expiry, bounded by execution grant. |
| Active sandbox cap | 5 initially, including trusted runners, bridge-only jobs, workspace sandboxes, and evaluator/execution sandboxes. |
| Initial resource requests | 2 vCPU, 4 GiB RAM, 10 GiB disk per sandbox, provisional and subject to actual quota/measurement. |
| Simulation | Franka Emika Panda from pinned MuJoCo Menagerie commit, SI units, canonical Z-up, fixed 0.002-second physics timestep, 0.01-second high-level control. |
| Viewer | Selected preview target 10 Hz; interpolate state rather than running authoritative physics in the browser. |
| Task | Move a rigid cube around a divider into a target region. |
| Completion | Cube center within 30 mm, settled/supported for 0.5 simulated seconds, before a 30-second simulated timeout. |
| Forbidden contact | Robot-divider, robot-wall, or cube-divider penetration over 1 mm for 5 consecutive physics steps. |
| Other failure conditions | Joint/command limit violations, NaN/nonfinite commands, stopping without completion, invalid engine runs. |
| Evaluation suites | Original failure + 9 public cases, then 8 withheld cases; validate reachability before scoring candidates. |
| Ranking | All required cases must validly pass; then fewer changed controller functions, lower median successful completion time, stable candidate ID. |

An explicitly labeled idealized grasp is allowed only under the PRD conditions: within 20 mm of the grasp pose after the close-gripper skill; attachment state captured; cube obstacle contact remains checked. Do not silently switch robot/engine/task or fabricate a physics outcome to get a demo passing.

## Phase 0 — Read, inspect, and establish control

Do this before writing application features or launching feature subagents:

1. Read the full current PRD, relevant `AGENTS.md` files, existing README, workspace manifests, and available relevant skills. Inspect existing source before deciding to scaffold anything.
2. Work in the existing ForkSafe repository when present; otherwise create `./forksafe`. Preserve unrelated edits. Do not overwrite a repository merely because this prompt suggests a layout.
3. Establish a single lead coordinator. Create or update `IMPLEMENTATION_STATUS.md` with phase, agent ownership, integration readiness, evidence paths, blockers, and next action.
4. Create `docs/execution-plan.md` with the feature assignments below, actual subagent capacity, dependency gates, and write ownership. The number of build agents is distinct from the product's runtime swarm/session limits.
5. Read official documentation for the feature you touch. Links below are starting points; installed SDK type declarations and current official docs determine signatures. Do not copy a guessed API from this prompt or fabricate a package/method/model ID.
6. Maintain a decision log for routine choices. Ask only for information that is genuinely inaccessible and prevents all useful progress; continue unrelated work first. Do not ask the user to reselect the settled architecture.

## Phase 1 — Environment and contracts first

Delegate this phase to one **Environment and Contracts Agent**, or perform it as lead if delegation is unavailable. This is a sequential bootstrap gate, not seven agents simultaneously changing root configuration.

### Environment responsibilities

- Inspect installed Node, package manager, Python, uv, Docker/container tooling, SpacetimeDB CLI, Convex tooling, browser-test prerequisites, and Factory CLI. Install only missing compatible development dependencies using supported methods. Record actual versions and platform assumptions.
- Use pnpm workspaces for TypeScript, uv and a lockfile for Python. Pin resolved dependencies in lockfiles. Keep Factory SDK tool schemas compatible with its documented Zod requirements; the current reference uses Zod 3.
- Prepare the monorepo paths below, adapting existing code instead of replacing it. Select a supported TypeScript SpacetimeDB module for a new project, with matching CLI/SDK/generated bindings.
- Create checked `.env.example` files, ignored local secret files, configuration validation, and a `doctor` command. Detect missing credentials by name only. Reuse configured credentials without printing them or copying secrets into source, logs, screenshots, or browser bundles.
- Use real local/dev Convex, actual SpacetimeDB, and actual MuJoCo for local integration. A local container executor may replace Daytona during development if explicitly labeled. Fixture Factory/Atlassian adapters are allowed for unavailable access, but they do not count as live sponsor functionality.
- Use existing repository auth if suitable. Otherwise select the smallest documented React/Vite-compatible Convex auth approach and record it before feature development. A localhost-only development identity can unblock local work; it must be conspicuous and must fail closed outside development. Forge requests require real invocation-context verification, not a browser-supplied user ID.
- Start local services with isolated ports and durable development data paths; make startup, teardown, seed, and readiness deterministic. Default web 5173, simulator adapter 8000, SpacetimeDB 3000, Elasticsearch 9200; use actual Convex tooling output for its URL/port.
- Verify Python can import MuJoCo and load the pinned Panda model/assets. Perform a small real physics step and save the engine/model versions. The Simulation Agent subsequently implements the full successful/failing task calibration.
- Add narrow foundational checks for contract serialization, configuration rejection, and service readiness. Avoid meaningless tests that only mirror implementation strings.
- Produce `docs/environment.md`, `docs/configuration.md`, and `docs/dependencies.md` with exact commands, installed versions, credential locations, service modes, and platform blockers.

### Repository layout and write ownership

| Path | Owner after bootstrap |
|---|---|
| Root manifests, shared lockfiles, workspace configuration, CI, `.env.example` | Lead coordinator; apply dependency requests serially. |
| `packages/contracts`, `docs/contracts.md`, shared schema fixtures | Lead coordinator after Environment Agent defines the initial contract. |
| `services/simulator`, `services/evaluator`, `controllers`, `assets/robots`, `evaluation` | Simulation and Evaluation Agent. |
| `convex`, `packages/integrations/daytona`, `infra/daytona` | Convex and Daytona Agent. |
| `apps/runner`, `packages/agents` | Factory Runtime Agent. |
| `packages/spacetimedb`, `packages/integrations/spacetime` | SpacetimeDB Agent. |
| `packages/integrations/elastic` | Elastic Agent. |
| `apps/forge`, `packages/integrations/atlassian` | Atlassian Agent. |
| `apps/web` | Browser Product Agent. |
| Shared end-to-end suites and final verification report | Final Integration and Verification Agent. Feature tests remain with their owners. |

### Freeze shared contracts before parallel implementation

Define and validate schemas for:

- Investigation, environment, job, attempt/epoch, execution grant, revision/write lease, agent session, experiment, finding, candidate, evaluation, review, artifact, outbox event, and adapter readiness.
- A stable UUID-based application ID scheme across both databases; separate vendor-native IDs from application IDs.
- The Convex-to-SpacetimeDB handoff: admission reserved → grant installed → work started → artifacts persisted → evidence committed → completion acknowledged. No distributed transaction is assumed.
- Runner claim/heartbeat/completion, signed scoped operations, command admission, provisioning receipts, cancellation, and remote cleanup reconciliation.
- Factory tools: `inspect_failure`, `read_source`, `apply_patch`, `run_experiment`, `publish_finding`, `search_evidence`, `fork_candidate`, `submit_candidate`, `request_subtask`.
- Python experiment request/response and replay manifest, including hashes, named geometries, seed, frame convention, body IDs, validity, contact events, and metrics.
- Public UI read models joining Convex lifecycle with SpacetimeDB evidence, and explicit pending/unavailable/error states.
- Durable artifact upload/download and authorization, including chunked replay/trace files.

Use versioned schema fixtures as interface examples. They may contain clearly labeled illustrative data, but must never masquerade as measured physics or a live SDK run. Export shared contracts so agents do not independently invent incompatible shapes. Backend and Python serialization must agree on optional values, enums, units, timestamps, and numeric limits.

Record public interface names as **ForkSafe application contracts**, not vendor SDK APIs. Agents may propose changes; only the lead changes shared contracts and notifies all affected owners. Do not hide contract drift behind `any`, broad casts, silent field dropping, or duplicated interfaces.

### Bootstrap completion gate

Parallel feature work starts when the repository installs, basic type/import checks run, real local/dev dependencies are reachable or precisely diagnosed, shared schemas/fixtures exist, and ownership is published. Missing external credentials do not prevent this gate when local paths remain testable. Do not declare live integration ready merely because a key variable exists.

### Bootstrap reference documents

| Document | Use it for |
|---|---|
| [pnpm workspaces](https://pnpm.io/workspaces) | Workspace package layout and dependency boundaries. |
| [uv documentation](https://docs.astral.sh/uv/) | Python environments, dependency resolution, and locking. |
| [Convex documentation](https://docs.convex.dev/) | Current project initialization and development tooling. |
| [Convex authentication](https://docs.convex.dev/auth/overview) | Select a supported auth integration and validate identity server-side. |
| [SpacetimeDB TypeScript quickstart](https://spacetimedb.com/docs/quickstarts/typescript/) | Module setup, matching tooling, and generated bindings. |
| [Factory TypeScript SDK](https://docs.factory.com/sdk/typescript) | Package/runtime/CLI prerequisites and compatible tool schemas. |
| [MuJoCo Python](https://mujoco.readthedocs.io/en/stable/python.html) | Native engine installation, model loading, and stepping. |

## Phase 2 — Parallel feature implementation

Launch the seven feature workstreams below **as concurrently as the agent platform allows**. With a six-worker limit, start Simulation, Convex/Daytona, Factory, SpacetimeDB, Browser, and Elastic; start Atlassian as soon as one slot opens. Keep the lead available for contract decisions, dependency requests, and integration checkpoints. Do not spawn beyond actual capacity or nest unlimited subagents.

Prefer isolated git worktrees/branches when supported. If agents share one workspace, enforce the ownership table strictly. Use path-scoped changes/commits; do not stage or revert another agent's work. The lead serializes lockfile changes, merges/cherry-picks, migrations, generated shared bindings, and shared configuration edits. Feature agents request root dependency changes instead of racing to regenerate lockfiles.

Each agent must receive this prompt, the PRD, its task below, the current shared contracts, allowed paths, dependency receipts, and its required evidence. Agents build against contract adapters while dependencies are unfinished, then replace fixtures with real integration before claiming completion. Do not stop an agent simply because another feature is still building.

Each agent creates `docs/handoffs/<agent-name>.md` and its integration document with:

- Files changed and exported interfaces.
- Dependencies and configuration names, never secret values.
- Commands actually run, exit outcomes, and relevant artifact paths.
- Real/local/fixture/disabled/unavailable status per integration.
- API assumptions verified against official docs and installed types.
- Known blockers, remaining integration actions, and cleanup instructions.

Do not let multiple feature agents edit `IMPLEMENTATION_STATUS.md`; send status to the lead, who updates it. A build agent's role assignment does not impose a specialty on the product's runtime environments.

### Agent 1 — Simulation and independent evaluation

**Goal:** establish real robot behavior, reproducible failure capture, and a protected scoring path before agent-generated repairs are trusted.

Implement:

1. Pinned Panda assets, licensing/hash manifest, cube/divider/target scene, bounded controller skills, and a deterministic calibration script selecting reachable task poses.
2. A nominal success and an actual divider-induced forbidden contact, both measured by MuJoCo. Preserve full simulator and controller state for replay/reproduction.
3. Headless command-line experiment execution using shared JSON schemas. Keep rendering separate from stepping and model latency.
4. Immutable run inputs and trace/replay export; preserve coordinate conventions and body/quaternion mapping.
5. Public and withheld suite construction, validity/reachability checks, fixed rule enforcement, and clean candidate installation. Treat invalid runs as invalid, never passing.
6. Independent evaluator logic outside the generated controller's authority. Controllers cannot alter manifests, scoring code, scores, or other candidate artifacts. Withheld inputs remain outside repair-agent access.
7. Candidate deduplication, public filtering, maximum-three-finalist freeze, common withheld evaluation, and declared tie-break ranking. No agent votes or untested patch merges.
8. Tests that catch no-op controllers, forbidden scene edits, controller-state leakage between runs, missing hashes, nonfinite commands, invalid runs, and false task completion.

**Done when:** the original failure reproduces, nominal behavior succeeds, real experiment artifacts drive the viewer contract, and the evaluator rejects known bad controllers without consulting an LLM.

**Write:** `docs/simulation.md`, `docs/evaluation.md`, and `docs/handoffs/simulation.md`.

**Reference documents:**

- [MuJoCo Python bindings](https://mujoco.readthedocs.io/en/stable/python.html) — load models, access state, run physics, and export measurements.
- [MuJoCo simulation](https://mujoco.readthedocs.io/en/stable/programming/simulation.html) — state restoration, stepping, numerical assumptions, and reproducibility.
- [MuJoCo Menagerie](https://github.com/google-deepmind/mujoco_menagerie) — Panda model assets, revisions, and licensing.
- [pytest documentation](https://docs.pytest.org/en/stable/) — meaningful Python boundary/physics tests.

### Agent 2 — Convex backend and Daytona execution

**Goal:** a real backend that durably controls bounded external execution.

Implement:

1. Convex schema, server-side authorization, investigation lifecycle, dependencies, atomic claims, attempt/epoch fences, heartbeat/expiry, and bounded infrastructure retry.
2. Workflow for orchestration and Workpool for eligible function work. Track **external** job, sandbox, and model-turn reservations separately; a returned dispatch function must not free a still-running environment slot.
3. Daytona provisioning with persisted operation IDs, sandbox purpose labels, recorded snapshot IDs, quota checks, asynchronous commands, bounded result polling/log collection, and orphan reconciliation.
4. Separate prepared images/snapshots for trusted runner versus MuJoCo execution. Keep Factory credentials only in trusted runners; keep the account-wide Daytona API key in Convex backend configuration.
5. Scoped runner-facing operations. Validate sandbox ownership, project, environment, attempt, allowed command, and resource budget. Generated code must never gain account-wide Daytona access.
6. Durable cross-service admission/grant/evidence/completion handoff with the SpacetimeDB Agent. Retry idempotently; fail closed when grants cannot synchronize.
7. Cancellation requested/pending/completed states, process interruption, grant revocation/expiry, bounded termination, and cleanup receipts. Retain capacity reservations when remote creation/termination is ambiguous.
8. Hosted Convex artifact storage plus local adapter. Hash and authorize every file. Use permission-checked byte-serving for revocable/private evidence; do not treat ordinary `storage.getUrl()` bearer URLs as expiring private links. Chunk replay/trace files at no more than 8 MiB for this MVP.
9. Artifact export before sandbox deletion and trusted evaluator/bridge-only job admission after repair runners stop. These extra sandboxes count toward the same cap.
10. Status/readiness queries, authenticated callbacks when supported, and polling fallback. A provider callback is not proof an experiment passed.

**Done when:** one real Daytona experiment can be started from the backend, tracked to measured completion, persisted, and cleaned up; recovery and active-work limits hold after a deliberately lost/ambiguous response.

**Write:** `docs/integrations/convex.md`, `docs/integrations/daytona.md`, and `docs/handoffs/orchestration.md`.

**Reference documents:**

- [Convex actions](https://docs.convex.dev/functions/actions) — external API calls, Node/runtime limits, and side-effect handling.
- [Convex Workflow](https://www.convex.dev/components/workflow) — durable orchestration, parallel steps, cancellation, and retries.
- [Convex Workpool](https://www.convex.dev/components/workpool) — bounded function queues and completion callbacks.
- [Convex file storage](https://docs.convex.dev/file-storage/overview) — upload/download references and bearer-URL security model.
- [Convex authentication](https://docs.convex.dev/auth/overview) — identity validation and backend authorization integration.
- [Daytona TypeScript SDK](https://www.daytona.io/docs/en/typescript-sdk/) — actual adapter signatures and SDK types.
- [Daytona sandboxes](https://www.daytona.io/docs/en/sandboxes/) — creation, resource allocation, and lifecycle.
- [Daytona snapshots](https://www.daytona.io/docs/en/snapshots/) — prepared dependencies; distinguish filesystem snapshots from MuJoCo state capture.
- [Daytona process execution](https://www.daytona.io/docs/en/process-code-execution/) — commands, background sessions, and result collection.
- [Daytona limits](https://www.daytona.io/docs/en/limits/) — account quotas, aggregate resources, and rate limits.

### Agent 3 — Factory runtime swarms and tool broker

**Goal:** Factory Droid performs consequential runtime investigation and repair in the product.

Implement:

1. `apps/runner` with `@factory/droid-sdk/node` and installed compatible `droid` CLI. Verify package exports/types instead of guessing calls. Use the SDK programmatically, not a shell-only invocation presented as SDK use.
2. One initial trusted runner per investigation, independent sessions associated with each environment, default two sessions/environment, and a global four-active-turn reservation through Convex. One session has one active turn.
3. Permissioned tools from the shared contract for inspection, source reads, patches, experiments, findings, retrieval, candidate forking/submission, and bounded delegation.
4. Controlled working contexts and path validation. Disable/restrict unrestricted built-in execution/file tools. No generated controller modules execute in the trusted runner; experiment tools route to the separate execution adapter.
5. Autonomous multi-step behavior: inspect a failure, select an experiment, use measured feedback, revise a hypothesis, edit permitted controller files, and submit an exact candidate. Do not hardcode a successful patch or lock environments to specialties.
6. Shared findings through SpacetimeDB and retrieval through Elastic, with canonical ID/permission validation. Retrieved text cannot alter tool grants or budgets.
7. Visible sanitized plans, SDK session/tool activity, experiment requests, diffs, outcomes, and token usage. Keep private chain-of-thought and credentials out of logs/UI.
8. Cancellation, rate-limit recovery within budgets, session checkpointing and actual resume with runtime handlers/tools reattached. Missing session state is an interruption/replacement, not a claimed resume.
9. A clearly labeled fixture adapter for credential-free development using the same broker, plus a real live SDK path.

**Done when:** a designed user/failure trigger invokes a live SDK session, Droid performs a real experiment and controller edit, and the dashboard/README can show exactly what it did and how independent evaluation scored the result.

**Write:** `docs/integrations/factory.md`, `docs/agent-tools.md`, and `docs/handoffs/factory.md`. Include runtime entry point, trigger, SDK import, tool permissions, budgets, session/artifact references, an actual diff, and measured results.

**Reference documents:**

- [Factory TypeScript SDK](https://docs.factory.com/sdk/typescript) — Node subprocess runtime, sessions, streaming, SDK MCP tools, permissions, models, interruption, cleanup, and resume behavior. Use this as the primary SDK reference.
- [Daytona process execution](https://www.daytona.io/docs/en/process-code-execution/) — host the trusted runner process and collect its bounded output.
- [Convex actions](https://docs.convex.dev/functions/actions) — understand why persistent local Droid processes belong in the runner rather than a long-lived backend action.
- [SpacetimeDB TypeScript client](https://spacetimedb.com/docs/clients/typescript/) — implement the scoped evidence bridge against generated bindings.

### Agent 4 — SpacetimeDB shared evidence and revisions

**Goal:** swarms actually learn from one another while preserving provenance and write ownership.

Implement:

1. Canonical evidence/revision tables, scoped subscriptions, generated TypeScript bindings, and reducers for baseline metadata, findings, experiment evidence, candidates, evaluator results, reviews, and explicit approved memories where needed.
2. Atomic branch/revision write ownership with expected version/hash, write-lease renewal, and explicit child branches for concurrent changes.
3. Scoped execution grants mirroring Convex admission. Only authorized bridge identities install/revoke them. Check job attempt, epoch, expiry, project, and allowed operation on relevant writes.
4. Findings with observation/inference distinction, evidence IDs/hashes, scope, author, contradiction/replication/supersession links. Do not promote unsupported agent text to verified fact.
5. Experiment reservations/deduplication and deliberate replication identity. Immutable candidate admission and evaluator/reviewer-only writes.
6. Durable evidence outbox and acknowledged handoff to Convex for Elastic/Jira dispatch, with replay after interruption and operation deduplication.
7. Tombstones/revocation enforcement and canonical ID lookups for retrieval. Subscription filters alone must not be treated as authorization.
8. Proof that one environment publishes evidence and another uses it to choose or justify a subsequent experiment. This must affect actual behavior, not just UI display.

Do not implement a second environment-task scheduler, lifecycle owner, or retry authority here. Reducers perform state transitions, not external network calls, Factory execution, or physics.

**Done when:** a conflicting write and expired/revoked grant are rejected atomically, scoped evidence appears to another swarm, and interrupted outbox delivery can recover without losing provenance.

**Write:** `docs/integrations/spacetimedb.md`, `docs/state-ownership.md`, and `docs/handoffs/shared-state.md`.

**Reference documents:**

- [SpacetimeDB TypeScript quickstart](https://spacetimedb.com/docs/quickstarts/typescript/) — supported module setup and matching generated clients.
- [SpacetimeDB reducers](https://spacetimedb.com/docs/functions/reducers/) — transactional mutations and external-effect restrictions.
- [SpacetimeDB TypeScript client](https://spacetimedb.com/docs/clients/typescript/) — connection identity, reducers, subscriptions, and generated types.
- [SpacetimeDB documentation index](https://spacetimedb.com/docs/) — current authorization, deployment, and subscription reference pages for the installed version.

### Agent 5 — Elastic retrieval and grounded reporting

**Goal:** useful evidence reuse and explanations grounded in actual runs.

Implement:

1. Scoped indexing for findings, experiments, candidates, requirements, and optional approved memories. Carry canonical ID, source version, project/robot scope, hashes, status, visibility, and timestamps.
2. Idempotent indexing/update/delete from the durable outbox, plus lag/error visibility and reconciliation.
3. Retrieval by useful keywords and metadata first. Do not claim semantic search exists without a configured model/index and a tested need.
4. Canonical permission/revision checks after retrieval. A stale index cannot restore deleted/revoked/out-of-scope evidence.
5. Actual Agent Builder tools on an accessible Serverless instance for measured result lookup, candidate comparison, evidence questions, and replay references. Local Elasticsearch search alone does not satisfy the live Agent Builder milestone.
6. Grounded explanations answering, for example, why a candidate failed and why a passing repair was ranked first. Reports cite exact evidence and distinguish measurement from interpretation.
7. A labeled deterministic summary when Agent Builder is unavailable; do not fabricate a successful external response or let reporting alter scoring/review state.

**Done when:** another swarm retrieves a useful authorized finding, and a live Agent Builder question/report links to real measured outcomes. Report access blockers precisely if live completion is unavailable.

**Write:** `docs/integrations/elastic.md` and `docs/handoffs/elastic.md`, including index schemas, tool definitions, endpoint types, privileges, and a real query/result example with secrets removed.

**Reference documents:**

- [Elastic Agent Builder overview](https://www.elastic.co/docs/explore-analyze/ai-features/elastic-agent-builder) — capabilities and availability requirements.
- [Get started with Agent Builder](https://www.elastic.co/docs/explore-analyze/ai-features/agent-builder/get-started) — setup, ingestion, conversations, and required access.
- [Agent Builder tools](https://www.elastic.co/docs/explore-analyze/ai-features/agent-builder/tools) — tool types and integration details.
- [Elastic Cloud Serverless](https://www.elastic.co/docs/deploy-manage/deploy/elastic-cloud/serverless) — deployment and service configuration.

### Agent 6 — Atlassian Forge, Jira, and Confluence

**Goal:** connect an actual engineering issue to the investigation and human review.

Implement:

1. A real Forge Jira issue panel with setup/readiness, investigation initiation, lifecycle summary, evidence links, candidate comparison entry point, and a reviewer action tied to exact evaluated version/hash.
2. A documented Forge Remote or resolver-backed authenticated path to the Convex backend. Validate the actual Forge Invocation Token/context, intended application, and caller/project permissions. Do not trust browser-supplied Jira account IDs or expose shared secrets to the client.
3. Selected Confluence page retrieval with page/revision IDs and least-privilege scopes. Translate applicable rules into versioned evaluator/review requirements; distinguish human guidance from executable criteria.
4. Idempotent Jira evidence/status synchronization through the outbox. Reconcile a stable operation marker after a lost response rather than creating duplicate issues/comments.
5. Project-specific workflow mapping: mark ready for review only when required evidence exists; do not assume every Jira site has identical status names or transitions.
6. Clearly labeled local issue/requirements fixtures for development, alongside real configured Forge behavior. A comment-only or disconnected panel is not the planned feature.
7. Setup, manifest scopes/egress, backend endpoint configuration, development deployment/install instructions, and demo steps. Use available authorized development access; record any inaccessible site/admin requirement.

**Done when:** a real Forge issue interaction starts an investigation and displays traceable results, selected requirements carry revisions, and human review records the evaluated artifact. Verify event eligibility separately from implementing the product integration.

**Write:** `docs/integrations/atlassian.md`, `docs/forge-development.md`, and `docs/handoffs/atlassian.md`.

**Reference documents:**

- [Forge getting started](https://developer.atlassian.com/platform/forge/getting-started/) — environment, CLI, app creation, development, deployment, and installation.
- [Jira issue panel module](https://developer.atlassian.com/platform/forge/manifest-reference/modules/jira-issue-panel/) — issue-panel manifest and module behavior.
- [Forge Remote](https://developer.atlassian.com/platform/forge/remote/) — connect Forge to the application backend.
- [Forge Remote essentials](https://developer.atlassian.com/platform/forge/remote/essentials/) — invocation contract and Forge Invocation Token verification.
- [Jira Cloud REST API v3 introduction](https://developer.atlassian.com/cloud/jira/platform/rest/v3/intro/) — authentication, scopes, permissions, and links to issue/transition APIs.
- [Confluence REST API v2 pages](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-page/) — page content/version retrieval.

### Agent 7 — Browser product and robot viewer

**Goal:** a usable engineering workflow with observable runtime activity and evidence.

Implement:

1. Investigation list and scenario capture/editor, with supported cube/divider parameters and actual baseline capture/reproduction status.
2. Three.js Panda scene viewer from pinned assets and sampled backend state. Test the MuJoCo Z-up to viewer transform, body IDs, distances, and quaternions. The browser never manufactures a score.
3. Environment grid, selected environment detail, agent activity, budgets, experiment timeline, shared finding feed, and explicit fixture/live/readiness labels.
4. Convex lifecycle subscriptions and scoped SpacetimeDB evidence subscriptions joined by stable IDs. Show pending synchronization, interrupted jobs, unavailable integrations, and reconnect states.
5. Candidate comparison with exact diffs/hashes, per-case validity/failure metrics, synchronized original/repaired replays, rejected candidates, and human review action.
6. Evidence search and grounded report UI with working source/replay links and denied/revoked evidence states.
7. Stop/cancel behavior, permission-aware controls, accessible keyboard operation, readable tables, responsive layout, and usable empty/error states.
8. Browser tests against real local services for the main story after the integration checkpoint. Contract fixtures may unblock early UI work but must stay labeled and must be replaced in the acceptance path.

Use the PRD engineering dashboard direction: light background, dark text, restrained status colors plus labels; keep the robot and evidence readable. Avoid ornamental effects that obscure behavior.

**Done when:** a user can capture a real failure, start an investigation, observe actual progress/evidence, inspect evaluated candidates, and record a review without developer narration.

**Write:** `docs/browser-workflow.md`, `docs/replay-format.md`, and `docs/handoffs/browser.md`.

**Reference documents:**

- [React documentation](https://react.dev/learn) — component/state structure.
- [Vite guide](https://vite.dev/guide/) — development/build setup and environment handling.
- [Three.js manual](https://threejs.org/manual/) — scene, camera, transforms, assets, rendering, and animation.
- [SpacetimeDB TypeScript client](https://spacetimedb.com/docs/clients/typescript/) — scoped subscriptions and generated bindings.
- [Convex documentation](https://docs.convex.dev/) — React client and reactive backend queries for the installed version.
- [Playwright](https://playwright.dev/docs/intro) — actual browser workflow verification.

## Phase 3 — Integration checkpoints while features finish

The lead coordinates these checkpoints; do not wait until the final testing agent to discover interface incompatibilities. Integrate tested commits into a clean integration branch/workspace while feature agents retain their scoped ownership.

| Checkpoint | Required connection |
|---|---|
| Physics foundation | Real nominal success + real reproducible failure; baseline/replay schemas validated. |
| One job | Convex intent → scoped runner → local/Daytona experiment → durable artifacts → SpacetimeDB evidence → Convex completion. |
| One runtime repair | A live Factory SDK session chooses an experiment, makes a permitted edit, and submits an exact candidate for independent evaluation. |
| Shared search | Three environments with isolated revisions; one swarm uses another's sourced finding through the intended retrieval path. |
| Review path | Browser/Forge shows exact candidate results, report/source links, and a version-specific human review. |

Use a real local stack for the core checkpoints. Add hosted paths using available access without claiming missing integrations are complete. Missing Factory credentials may allow a fixture-driven orchestration checkpoint, but it does not satisfy the live runtime repair gate. Missing Agent Builder access does not permit labeling local search as Serverless Agent Builder.

Before final verification, collect all feature handoffs, resolve dependency/contract drift, run generated-client/type checks, and produce a coherent runnable integrated branch. Do not leave the final agent to guess which of seven incompatible APIs was intended.

## Phase 4 — Fresh Integration and Verification Agent

Only after the integrated feature paths are ready, appoint a new agent with no feature-ownership obligation to act as **Integration and Verification Lead**. Give it the full PRD, this prompt, integrated repository, status file, all handoffs, and actual available credentials/modes. This is a coding/test agent, not the product's runtime robot evaluator.

Its instructions are:

> Independently verify the complete customer journey and cross-service boundaries. Read existing tests, then run the system and inspect actual behavior. Do not accept a feature owner's completion claim as evidence. Fix integration defects directly in agreed integration-owned paths; route larger feature defects to their original owners with a minimal reproduction and expected behavior. The lead may reopen those agents for bounded fixes. Integrate the fixes and rerun the affected tests plus the end-to-end story. Continue until the applicable acceptance gates pass or a precise external blocker remains. Never turn a failing test into a pass by removing the requirement, loosening the evaluator, hardcoding the repair, substituting fixtures, or suppressing the failure.

### Required verification matrix

| Area | Exercise and evidence |
|---|---|
| Clean setup | A clean checkout/environment can install pinned dependencies, prepare assets/bindings, seed demo data, and run doctor. Report platform assumptions. |
| Contracts | TypeScript/Python request/results agree; no duplicate IDs, unit drift, invalid versions, missing hashes, or unsupported fields silently accepted. |
| Real physics | Nominal task succeeds; captured divider collision reproduces; snapshots restore controller as well as simulator state. |
| Evaluation integrity | No-op/stop, forbidden scene edits, NaN/limits, invalid runs, and known collision cases cannot pass. All finalists use common declared cases. |
| Held-out isolation | Repair tools/retrieval cannot read withheld inputs; finalists cannot iterate against leaked final cases; modified tests invalidate comparison. |
| Real Factory work | Record SDK session/tool IDs, experiment request, actual diff, submitted hash, and measured result. Verify permitted tools/paths and interruption handling. |
| Real Daytona work | Run a real headless experiment and trusted runner; verify isolation, labels, resource reservations, artifact export, and scoped cleanup. |
| Concurrency | Three real investigation environments run independently; configured session count is distinguished from active SDK turns; external jobs remain bounded after dispatch returns. |
| Shared learning | Publish a finding, retrieve it in another environment, and link its use to a subsequent decision/experiment. |
| Conflicting writes | Two agents cannot edit the same revision without proper ownership/branching; immutable running inputs remain unchanged. |
| Stale attempt | Kill a worker, expire/reclaim its job, revoke/expire old grants, and reject its late completion/current-state update. |
| Cross-service handoff | Interrupt at grant install, artifact persistence, evidence commit, and completion acknowledgement; reconcile without duplicate candidates or competing authority. |
| Ambiguous provisioning | Lose a create/terminate response and reconcile owned remote resources before retry/releasing capacity. |
| Cancellation/budgets | Stop new admission, interrupt work, revoke/expire grants, retain partial evidence, and surface cleanup pending until verified. |
| Elastic | Index real evidence, retrieve authorized sources, verify revoked evidence denial despite stale projection, and run the actual Serverless Agent Builder question when accessible. |
| Atlassian | Actual Forge issue action, verified caller context, selected Confluence revisions, retry-safe synchronization, and exact-version review when access permits. |
| Artifact access | Generated code cannot read runner secrets; private evidence is permission-checked; raw bearer storage URLs do not leak held-out or revocable artifacts. |
| Browser story | Capture → reproduce → investigate → observe swarms/findings → compare candidates → replay → review. Include stop, error, reconnect, and unresolved outcomes. |
| Honest reporting | Fixtures/local/live are labeled; unknown usage is not zero; missing credentials/privileges are explicit; no fabricated sponsor completion or benchmark result. |

Use a bounded hosted smoke run first. Record a persistent run/operation ID so retries do not repeatedly launch chargeable investigations. Run broader hosted trials only when a new change or unresolved failure justifies them and budgets permit. Use real local physics plus clearly labeled fixtures for non-provider orchestration fault injection where appropriate; report that distinction.

### Commands to provide and run

Implement these project scripts with the PRD meanings. They are required commands to create, not a claim they already exist:

```bash
pnpm setup
pnpm doctor
pnpm seed:demo
pnpm build
pnpm test
pnpm test:integration
pnpm test:e2e
pnpm smoke:hosted
pnpm benchmark
pnpm cleanup:sandboxes
```

`pnpm dev` starts the local stack with readiness checks and clean shutdown. `pnpm daytona:prepare` prepares the authorized development images/snapshots separately from ordinary local startup. The hosted smoke command must refuse to proceed without explicit live configuration and valid caps; it must not report success when skipped. Benchmark reports measured single-versus-parallel outcomes under matched budgets; if not runnable, document it as unperformed rather than inventing a speedup.

Choose Vitest for meaningful TypeScript contract/boundary checks, pytest for physics/evaluator checks, and Playwright for the browser customer journey. Test focused changes during feature development; after integration run the complete applicable suite once. Repeat only for new changes, failures, or unresolved concerns.

### Final verification documents

Produce:

- `docs/verification-report.md`: commit/revision, platform/tool versions, commands with exit outcomes, actual modes/accounts referenced without secrets, passed/failed/blocked/skipped checks, investigation/candidate/artifact IDs, failure reproductions, and known limits.
- `docs/integration-matrix.md`: each feature/provider marked `live_verified`, `local_verified`, `fixture_only`, `blocked`, or `not_implemented`, with evidence path and remaining action. Distinguish ordinary local search from Elastic Agent Builder on Serverless.
- `docs/demo-runbook.md`: exact startup/seed commands, three-minute customer flow, expected observable events, bounded resource use, recorded-backup labeling, unresolved-outcome behavior, and cleanup.
- Updated `README.md`: product purpose, architecture, prerequisites, setup/configuration, root commands, access modes, and a specific section explaining where the Factory Droid SDK does real work in the running product.
- Updated `IMPLEMENTATION_STATUS.md`: final gates, remaining external blockers, exact next actions, and cleanup status.

Private local screenshots/logs may support debugging. Only export sanitized user-facing evidence intentionally; do not save credential-bearing screenshots or logs to published docs.

**Final test references:**

- [Playwright documentation](https://playwright.dev/docs/intro) — browser automation and observable user-flow checks.
- [Vitest documentation](https://vitest.dev/guide/) — TypeScript boundary and integration tests.
- [pytest documentation](https://docs.pytest.org/en/stable/) — deterministic Python/evaluator checks.
- The feature-specific official documents above — verify actual integration semantics, not just transport success.

## Completion and final response

The lead remains responsible for delivery. A subagent reporting completion does not end the task. Finish with runnable integrated code and evidence; if a particular external dependency is inaccessible, complete all independent work and identify the exact blocked live gate.

Do not deploy controller changes to physical hardware or automatically merge a candidate into a repository. Human review accepts an exact simulation-tested artifact for engineering review.

Your final response must state:

1. What works end to end and how to start it.
2. Which sponsor/platform integrations were actually verified live versus local/fixture/blocked.
3. Which tests ran and their actual results, with links to the verification report and demo runbook.
4. Any remaining external access requirements and the smallest concrete action needed.
5. Whether owned Daytona resources were cleaned up or intentionally retained, with a cleanup command.

Do not claim completion while the main customer journey is disconnected. Do not finish with only a list of agents, an implementation plan, generated placeholder screens, or mocked physics.

## Documentation maintenance note

The official URLs in this prompt were checked on October 24, 2026. Resolve redirects and recheck installed-version compatibility while implementing. Use the real Forge Remote essentials page for invocation-token verification; do not invent a deeper authentication URL. Jira's reference is linked through the REST introduction because the full issue API page can be too large for some retrieval tools. Documentation describes vendor capabilities; the specific budgets, ownership split, sandbox layout, and acceptance gates here are ForkSafe design decisions.
