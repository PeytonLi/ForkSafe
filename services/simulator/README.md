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

Start the local API from the repository root with
`PYTHONPATH=services .venv/bin/uvicorn simulator.app:app --host 127.0.0.1 --port 8000`.
`/runs` accepts only public case IDs and writes artifacts below `var/artifacts`
(or the configured `ARTIFACT_ROOT`).
