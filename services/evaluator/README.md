# Evaluator service

The evaluator authenticates every operation other than `/health` with
`Authorization: Bearer $EVALUATOR_SERVICE_TOKEN` and identifies itself as
`forksafe-evaluator`. It verifies robot assets and the locked public/withheld
manifest hashes on startup.

Start locally from the repository root with:

```sh
PYTHONPATH=services EVALUATOR_SERVICE_TOKEN=... \
  .venv/bin/uvicorn evaluator.app:app --host 127.0.0.1 --port 8001
```

Candidates are stored by controller SHA under `var/evaluator/candidates` (or
`EVALUATOR_STORE`). Each case runs in a fresh evaluator-owned temporary
directory via the simulator CLI; withheld cases are never sent to the public
simulator API. Finalization filters public passers, freezes at most three
distinct finalists, and evaluates each finalist against withheld cases once.
