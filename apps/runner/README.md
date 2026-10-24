# @forksafe/runner

Trusted Node 22 runner for `factory_session` jobs. Start with `pnpm --filter @forksafe/runner start`.

## Local file protocol

Without `RUNNER_JOB_SOURCE_URL`, jobs are read from `RUNNER_JOBS_DIR/jobs/<jobId>.json` (default `./var/runner`). Each job is a contracts `Job`. The runner persists attempt/grant state in `state.json`, creates a 30-second lease and a matching execution grant on claim, and renews both deadlines on heartbeat. An expired active lease can be taken over: the job epoch increments, the prior attempt is fenced, and the replacement attempt/grant use the new epoch. Heartbeats and completions must match the current job, attempt, grant, and epoch and arrive before expiry. A completion is accepted at most once per operation ID.

## HTTP protocol

When configured, the runner POSTs JSON to `/runner/claim`, `/runner/heartbeat`, `/runner/complete`, and `/runner/tools/<toolName>`. Requests include `x-forksafe-timestamp` and `x-forksafe-signature`, the hex HMAC-SHA256 of the exact raw JSON body using `RUNNER_CALLBACK_SECRET`. Responses are schema-validated. Tool requests include investigation, environment, session, attempt, grant, and epoch context; the trusted runner checks the fence before each operation and before posting a result.

`RUNNER_CONTROL_URL` routes tools to the control service. When it is unset, local findings are written to `./var/runner/local/findings.jsonl`; experiment execution and candidate submission return an explicitly blocked result because no simulator adapter is configured. Workspaces are UUID-scoped below `RUNNER_WORKSPACE_ROOT` (default `./var/workspaces`).

Readiness JSON omits secrets. Factory cloud mode without `FACTORY_API_KEY` is reported blocked and uses a clearly labeled fixture adapter rather than claiming a live response. SIGINT/SIGTERM stop polling, finish active work, and close sessions.

## Live Factory smoke evidence

- Date (UTC): 2026-10-24
- SDK version: `0.10.0`
- Droid version: `0.249.0`
- Vendor sessionId: `a1eaaea0-64a3-49d2-9599-a60aaf8032d3`
- Success: `true`
- Tool calls:
  - `Script` (`call_7linplIw3FGYgjJ5XwIiIHgJ`, `isError: false`)
  - `ToolSearch` (`db9e16a8-b3cf-425f-8775-01ee62a3b099-1`, `isError: false`)
  - `Script` (`call_TVzLSxWrqPIMEDXKkasniQNE`, `isError: false`)
  - `forksafe___read_findings` (`c2570cf9-df83-4b2f-b08d-640eeff19ff7-1`, `isError: false`)
- Token usage:
  ```json
  {
    "inputTokens": 375,
    "outputTokens": 71,
    "cacheCreationTokens": 11189,
    "cacheReadTokens": 21818,
    "thinkingTokens": 0,
    "factoryCredits": 12480
  }
  ```
- Recorded smoke JSON: `apps/runner/var/smoke/factory-smoke-1792833819439.json` (local output; do not commit).
