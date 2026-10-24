# Sandboxed evaluator

`python -m evaluator.run_candidate` runs a candidate controller against the
public, withheld, or combined suite. It does not import the FastAPI service.
Run from the repository root with `PYTHONPATH=services`, for example:

```sh
PYTHONPATH=services .venv/bin/python -m evaluator.run_candidate \
  --controller controllers/baseline/task_controller.py \
  --expected-sha256 "$CONTROLLER_SHA256" --suite public --out result.json
```

`--expected-sha256` must be the controller file's lowercase SHA-256. A
withheld run also requires `--withheld-manifest PATH` (or
`FORKSAFE_WITHHELD_MANIFEST`). `--consume-withheld-manifest` removes that file
after reading and verifying it, before candidate code runs; it is intended for
the protected evaluation pipeline and is never enabled by default. Candidate
and investigation IDs default deterministically from the controller SHA;
`idsDerived` records this. The evaluator attempt ID defaults to a fresh UUID.
`--case-ids` filters cases by comma-separated ID. Resource defaults are a
10-second plan wall/CPU limit, 1 GiB plan memory, 180-second case wall limit,
and 3 GiB case memory.

Exit codes:

| Code | Meaning |
| ---: | --- |
| 0 | Every selected case passed |
| 1 | Evaluation completed with failed or invalid candidate cases |
| 2 | CLI usage or argument error |
| 3 | Integrity error (controller, assets, manifests, or evaluator code) |
| 4 | Infrastructure error (worker, artifacts, isolation requirement, or output) |

When `--out` is writable, completed evaluations and integrity/infrastructure
errors are written atomically as `forksafe.run_candidate.v1`. The document
contains suite-level `CandidateEvaluation` contracts, per-case status and
failure information, deterministic trace/replay artifact paths and hashes,
isolation metadata, and aggregate timings. Withheld failure details are
redacted in the document; full details remain in the protected trace artifact.

Each case has a trusted worker and a separate plan process. The worker computes
the scene input, validates the returned plan, and runs physics only after the
plan process exits. The plan process gets a minimal environment, CPU/address
space/file/descriptor limits, a dropped UID when the parent is root, and a
separate user+network namespace when available. An audit hook blocks network
and disallowed filesystem/process access as defense in depth. The code boundary
is the separate process, not the audit hook: Python audit hooks are not a
complete security boundary against native code, and network protection falls
back to the hook when user namespaces are unavailable. Withheld data should
only be delivered into a fresh network-blocked evaluator sandbox.

### Residual risks

The audit hook is defense in depth and determined native-level tricks may
bypass it. When the sandbox user is not root, the plan process cannot drop its
UID; a hook bypass could read earlier cases' artifacts in the same sandbox.
Network namespaces and Daytona `networkBlockAll` remove the network
exfiltration path, each evaluation uses a fresh sandbox, and a plan only
affects its own case.

Run the public-only benchmark with:

```sh
PYTHONPATH=services .venv/bin/python -m evaluator.benchmark --case-ids nominal
```

It reports per-run wall/physics/plan timing and simulation throughput as
`forksafe.benchmark.v1` JSON on stdout, with a human-readable table on stderr.
It has no withheld-suite option.

The FastAPI service remains available for local development. It authenticates
all operations other than `/health` with
`Authorization: Bearer $EVALUATOR_SERVICE_TOKEN` and identifies itself as
`forksafe-evaluator`. Candidates are stored by controller SHA under
`var/evaluator/candidates` (or `EVALUATOR_STORE`); `_run_case` reuses the same
isolated `execute_case` path as the CLI.
