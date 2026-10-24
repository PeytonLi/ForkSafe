# Simulator service

The simulator verifies the checked-in Panda asset hash on startup, builds a
fresh MuJoCo scene for each run, and runs one controller case per subprocess.
The CLI can run a public manifest case by ID or a supplied `SimCase` JSON file:

```sh
PYTHONPATH=services .venv/bin/python -m simulator.cli \
  --controller-dir controllers/baseline \
  --case-id original-divider-collision --seed 0 \
  --out-dir var/artifacts/baseline-original \
  --experiment-id 6e3f0d4a-0665-41ce-8f7f-0ac846ef7ae9
```

`RunSession` exposes the same loop incrementally through `step()` and
`run_to_end()`. A run can be checkpointed and resumed while preserving the
physics integration state and controller state:

```sh
PYTHONPATH=services .venv/bin/python -m simulator.cli snapshot \
  --case original-divider-collision --at-step 1500 --out var/snapshot.json
PYTHONPATH=services .venv/bin/python -m simulator.cli restore \
  --snapshot var/snapshot.json --out-dir var/artifacts/restored \
  --experiment-id 6e3f0d4a-0665-41ce-8f7f-0ac846ef7ae9
```

Successful and invalid-run CLI executions keep the complete `trace.json` and
also export a `trace-manifest.json` with content-addressed files in
`trace-chunks/`. `result.json` contains a `traceRef` with the manifest digest
and chunk/frame counts; the legacy one-line stdout result remains unchanged.
Use `simulator.trace_store.read_trace(out_dir, manifest_sha256)` to validate
and reassemble a chunked trace.

`PYTHONPATH=services .venv/bin/python -m simulator.calibrate --check` runs the
ordered deterministic scene gates and checks that the selected configuration
matches `scene_config.json`. Use `--out PATH` to write the generated scene
configuration, or `--report PATH` to save the candidate and gate measurements.

The optional `push_through_gap` task family uses `taskFamily` on its case
definition and is available through the `push-gap-aligned` and
`push-gap-offset` public cases. Generate deterministic scenario grids and SVG
heatmaps with:

```sh
PYTHONPATH=services .venv/bin/python -m simulator.fuzz \
  --controller controllers/baseline --around original-divider-collision \
  --n 64 --workers 8 --out grid.json --svg grid.svg
```

Start the local API from the repository root with
`PYTHONPATH=services .venv/bin/uvicorn simulator.app:app --host 127.0.0.1 --port 8000`.
`/runs` accepts only public case IDs and writes artifacts below `var/artifacts`
(or the configured `ARTIFACT_ROOT`).
