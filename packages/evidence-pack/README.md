# @forksafe/evidence-pack

Turns one ForkSafe investigation bundle into a single self-contained, offline HTML evidence pack that a reviewer can open locally or attach to a Jira issue.

The pack contains: an honest mode header (live, local, fixture, blocked, not_implemented), a verdict computed only from evaluator per-case results, the baseline failure, public and withheld case tables, each candidate's exact unified diff with inline highlighting, a hash and run-ID table, citations and finding provenance, a small canvas replay of sampled frames (top and side 2D projections, play and scrub), and the redacted bundle as a JSON appendix in `<script type="application/json" id="fs-bundle">`.

## Use

```sh
pnpm --filter @forksafe/evidence-pack run pack --in bundle.json --out pack.html
pnpm --filter @forksafe/evidence-pack run example   # builds examples/ from apps/web/src/fixtures/demo.json
```

`run` is required: `pnpm pack` without it is pnpm's built-in tarball command. Relative paths resolve from the directory you ran pnpm in.

Options: `--max-bytes N` (size warning cap, default 8 MiB), `--max-frames N` (replay frames kept per run, default 240), `--keep-emails`, `--fail-on-warning`. Exit codes: 0 written, 1 refused (invalid bundle, hash mismatch, review bound to another controller, inconsistent evaluation, dishonest mode), 2 usage, 3 written with warnings under `--fail-on-warning`.

Library:

```ts
import { renderEvidencePack, EvidencePackError } from "@forksafe/evidence-pack";
const { html, verdict, warnings, redactions } = renderEvidencePack(bundle);
```

## What it refuses

Rendering fails closed with a typed `EvidencePackError` when the bundle does not match the schema (built from `@forksafe/contracts`), when any diff, replay frame set, scene, controller, asset or engine hash disagrees with the records that reference it, when an evaluation's summary disagrees with its own cases, when a review is bound to a different controller version, candidate or evaluation (or approves a failed one), when records point at another investigation, or when a pack labeled `live` contains non-live integrations.

## Redaction

After verification, every string is scanned for bearer/basic/API-key headers, JWTs, private keys, URL credentials, common vendor keys (OpenAI and Anthropic, GitHub, AWS, Slack, Google, Atlassian, Factory, Daytona), secret-like assignments, and optionally e-mail addresses. Hashes in the pack refer to the original, unredacted content. Hex digests and UUIDs are kept.

## Determinism

Same input gives byte-identical HTML: keys are canonically sorted, no wall-clock or random values are used, and the generated-at time comes from the bundle.
