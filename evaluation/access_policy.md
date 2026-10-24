# Evaluation access policy

The public manifest is readable by simulator clients. Candidate registration,
simulator requests, controller artifacts, and public API responses must not
reveal withheld scene overrides. Only frozen finalists are eligible for a
withheld evaluation.

## Withheld evaluation delivery

Convex stores the withheld manifest in protected file storage and pins its
SHA-256 in `evaluation/manifests.lock.json` baked into the execution image.
Never call `storage.getUrl` for the withheld file. At final evaluation, Convex
creates a fresh evaluator sandbox from `forksafe-exec-v2` with
`networkBlockAll`, uploads the controller bytes and withheld manifest, runs
`run_candidate --suite withheld --consume-withheld-manifest`, downloads the
result and artifacts, and deletes the sandbox. The runner image and simulator
API never contain or serve the withheld manifest.

The development withheld manifest is currently committed in this repository.
Any runner workspace that clones it could read the manifest, so this is not a
secret boundary. The lead/pipeline must rotate it with a fresh generator seed
held only in Convex and drop the development copy from the repo before relying
on withheld evaluation as a secret benchmark.

Generate a rotated manifest outside the repository with:

```sh
python evaluation/build_suites.py --withheld-out /secure/path/withheld-manifest.json
```

The command prints its SHA-256 for updating the manifest lock. The normal
`python evaluation/build_suites.py` behavior remains unchanged.
