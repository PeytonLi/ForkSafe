import { createHash } from "node:crypto";
import type { CaseEvaluation, IntegrationMode } from "@forksafe/contracts";
import { PLAYER, STYLE } from "./assets.js";
import { EvidenceBundle, type BundleReplay } from "./bundle.js";
import { canonicalJson, jsonForScript, sha256Hex } from "./canonical.js";
import { EvidencePackError } from "./errors.js";
import { renderDiff } from "./highlight.js";
import { esc } from "./html.js";
import { emptyStats, redactDeep, redactString, type RedactionOptions, type RedactionStats } from "./redact.js";
import { computeVerdict, type CandidateOutcome, type OverallVerdict, type SuiteOutcome } from "./verdict.js";
import { verifyBundle, type Warning } from "./verify.js";

export const PACK_VERSION = 1;
export const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
export const DEFAULT_MAX_FRAMES_PER_REPLAY = 240;

export interface RenderOptions extends RedactionOptions {
  /** Warn when the HTML exceeds this many bytes (default 8 MiB). */
  maxBytes?: number;
  /** Uniformly sample inline replay frames down to this count (default 240). */
  maxFramesPerReplay?: number;
}

export interface RenderResult {
  html: string;
  bytes: number;
  warnings: Warning[];
  redactions: RedactionStats;
  verdict: OverallVerdict;
}

/** Withheld per-case rows are only shown once search has ended (PRD A7). */
const ACTIVE_SEARCH = new Set(["capturing", "admitted", "searching", "evaluating"]);

const MODE_TEXT: Record<IntegrationMode, string> = {
  live: "Live: produced by the real hosted services listed below.",
  local: "Local: real software running on a developer machine, not the hosted services.",
  fixture: "Fixture: recorded, synthetic data for demonstration. These are not live evaluator or simulator results.",
  blocked: "Blocked: an integration needed for this pack was unavailable.",
  not_implemented: "Not implemented: part of this pack has no real integration yet.",
};

const VERDICT_TEXT: Record<string, string> = {
  passed_all: "Passed public + withheld",
  public_only: "Public passed, withheld not run",
  failed: "Failed",
  invalid: "Invalid run",
  pending: "Evaluation pending",
  not_evaluated: "Not evaluated",
  candidate_passed: "Candidate passed",
  no_passing_candidate: "No passing candidate",
  evaluation_incomplete: "Evaluation incomplete",
  no_candidates: "No candidates",
};

const short = (id: string) => id.slice(0, 8);
const iso = (ms: number) => new Date(ms).toISOString().replace(".000Z", "Z");
const badge = (status: string, text = VERDICT_TEXT[status] ?? status.replace(/_/g, " ")) =>
  `<span class="badge s-${esc(status)}">${esc(text)}</span>`;
const fmtSec = (s: number | undefined) => (s === undefined ? "—" : `${Number(s.toFixed(3))} s`);

function sample<T>(items: readonly T[], max: number): T[] {
  if (items.length <= max) return [...items];
  if (max <= 1) return items.slice(0, 1);
  const out: T[] = [];
  for (let i = 0; i < max; i++) out.push(items[Math.round((i * (items.length - 1)) / (max - 1))] as T);
  return out;
}

function zodIssues(error: { issues: { path: (string | number)[]; message: string }[] }): string[] {
  return error.issues.slice(0, 50).map((i) => redactString(`${i.path.join(".") || "(root)"}: ${i.message}`));
}

/** Validates, verifies, redacts and renders one self-contained HTML pack.
 *  Throws EvidencePackError instead of rendering anything untrustworthy. */
export function renderEvidencePack(input: unknown, options: RenderOptions = {}): RenderResult {
  const parsed = EvidenceBundle.safeParse(input);
  if (!parsed.success) throw new EvidencePackError("invalid_bundle", zodIssues(parsed.error));
  const warnings = verifyBundle(parsed.data);

  const redactions = emptyStats();
  const bundle = redactDeep(parsed.data, options, redactions);
  if (redactions.total) {
    warnings.push({
      code: "redacted",
      message: `${redactions.total} secret-like value${redactions.total === 1 ? " was" : "s were"} redacted (${Object.entries(redactions.byRule).map(([k, v]) => `${k}: ${v}`).join(", ")}). Hashes refer to the original, unredacted content.`,
    });
  }

  const hideWithheld = ACTIVE_SEARCH.has(bundle.investigation.state);
  if (hideWithheld && bundle.evaluations.some((e) => e.suite === "withheld")) {
    warnings.push({ code: "withheld_redacted", message: "Search is still active, so withheld per-case results are summarized, not listed." });
  }

  const maxFrames = Math.max(2, options.maxFramesPerReplay ?? DEFAULT_MAX_FRAMES_PER_REPLAY);
  const sampling: Record<string, { kept: number; of: number }> = {};
  const replays: BundleReplay[] = bundle.replays.map((r) => {
    if (!r.frames || r.frames.length <= maxFrames) return r;
    sampling[r.artifactId] = { kept: maxFrames, of: r.frames.length };
    return { ...r, frames: sample(r.frames, maxFrames) };
  });
  if (Object.keys(sampling).length) {
    warnings.push({ code: "frames_sampled", message: `Replay frames were sampled to at most ${maxFrames} per replay for size; framesSha256 refers to the full recording.` });
  }

  const verdict = computeVerdict(bundle);
  const view = { ...bundle, replays };
  const appendixBundle = hideWithheld
    ? { ...view, evaluations: view.evaluations.map((e) => (e.suite === "withheld" ? { ...e, cases: [] } : e)) }
    : view;

  const scenes: Record<string, { divider?: { x: number; y: number; len: number; h: number } }> = {};
  const expById = new Map([bundle.baseline.experiment, ...bundle.experiments].map((e) => [e.id, e]));
  for (const r of replays) {
    const ov =
      expById.get(r.experimentId)?.simCase.sceneOverrides ??
      (r.caseId === bundle.investigation.baselineCase.caseId ? bundle.investigation.baselineCase.sceneOverrides : undefined);
    if (ov && ["divider_x", "divider_y", "divider_length", "divider_height"].every((k) => typeof ov[k] === "number")) {
      scenes[r.artifactId] = {
        divider: { x: ov.divider_x as number, y: ov.divider_y as number, len: ov.divider_length as number, h: ov.divider_height as number },
      };
    }
  }

  const build = (extraWarnings: Warning[]) => {
    const all = [...warnings, ...extraWarnings];
    const appendix = {
      pack: {
        packVersion: PACK_VERSION,
        renderer: "@forksafe/evidence-pack",
        verdict,
        warnings: all,
        redactions: { total: redactions.total, byRule: redactions.byRule, paths: redactions.paths },
        frameSampling: sampling,
        withheldCasesHidden: hideWithheld,
        replayScenes: scenes,
      },
      bundle: appendixBundle,
    };
    return page(view, verdict, all, hideWithheld, jsonForScript(appendix), sha256Hex(canonicalJson(appendix)));
  };

  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  let html = build([]);
  let bytes = Buffer.byteLength(html, "utf8");
  if (bytes > maxBytes) {
    const w: Warning = {
      code: "size_cap",
      message: `Pack is ${(bytes / 1048576).toFixed(2)} MiB, over the ${(maxBytes / 1048576).toFixed(2)} MiB cap; Jira may reject the attachment. Lower maxFramesPerReplay or reference replays by chunk.`,
    };
    html = build([w]);
    bytes = Buffer.byteLength(html, "utf8");
    warnings.push(w);
  }
  return { html, bytes, warnings, redactions, verdict };
}

function cspHash(s: string): string {
  return `'sha256-${createHash("sha256").update(s, "utf8").digest("base64")}'`;
}

function page(
  b: EvidenceBundle,
  verdict: OverallVerdict,
  warnings: Warning[],
  hideWithheld: boolean,
  appendixJson: string,
  appendixSha: string,
): string {
  const inv = b.investigation;
  const mode = b.source.mode;
  const candidates = new Map(b.candidates.map((c) => [c.candidate.id, c]));
  const outcome = new Map(verdict.outcomes.map((o) => [o.candidateId, o]));
  const envIndex = new Map<string, number>();
  b.candidates.forEach((c) => envIndex.set(c.candidate.environmentId, envIndex.size));
  const csp = `default-src 'none'; img-src data:; style-src ${cspHash(STYLE)}; script-src ${cspHash(PLAYER)}; base-uri 'none'; form-action 'none'`;

  const parts: string[] = [];
  parts.push(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${esc(csp)}">
<meta name="referrer" content="no-referrer">
<meta name="forksafe-pack" content="v${PACK_VERSION} mode=${esc(mode)} investigation=${esc(inv.id)}">
<title>${esc(`ForkSafe evidence: ${inv.title}`)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>`);

  // --- header ----------------------------------------------------------------
  parts.push(`<header>
<p class="eyebrow">ForkSafe evidence pack${inv.jiraIssueKey ? ` · Jira ${esc(inv.jiraIssueKey)}` : ""}</p>
<h1>${esc(inv.title)}</h1>
<p class="muted small">Investigation <span class="mono">${esc(inv.id)}</span> · state ${esc(inv.state.replace(/_/g, " "))} · generated ${esc(iso(b.generatedAtMs))} by ${esc(b.source.producer)}</p>
<div class="banner mode-${esc(mode)}" role="note"><strong>Mode: ${esc(mode.toUpperCase())}</strong>${esc(MODE_TEXT[mode])}${b.source.note ? `<br><span class="small">${esc(b.source.note)}</span>` : ""}</div>
${
  b.integrations.length
    ? `<ul class="chips" aria-label="Integration modes">${b.integrations
        .map((r) => `<li class="chip"><strong>${esc(r.name.replace(/_/g, " "))}</strong>: ${esc(r.mode)}${r.detail ? ` · <span class="muted">${esc(r.detail)}</span>` : ""}</li>`)
        .join("")}</ul>`
    : ""
}
</header>`);

  // --- verdict ---------------------------------------------------------------
  const rec = verdict.recommendedCandidateId ? candidates.get(verdict.recommendedCandidateId)?.candidate : undefined;
  const reviews = [...b.reviews].sort((x, y) => x.createdAtMs - y.createdAtMs || (x.id < y.id ? -1 : 1));
  parts.push(`<section aria-labelledby="verdict-h">
<h2 id="verdict-h">Verdict</h2>
<p>${badge(verdict.verdict)}</p>
<p class="verdict">${esc(verdict.headline)}</p>
${
  rec
    ? `<p>Suggested for review: candidate <span class="mono">${esc(short(rec.id))}</span> (controller <span class="mono">${esc(short(rec.controllerSha256))}</span>, ${rec.changedFunctions.length} changed function${rec.changedFunctions.length === 1 ? "" : "s"}).</p>`
    : ""
}
<p class="muted small">Computed only from the independent evaluator's per-case results. Agent rationale, findings and reviews do not change it. The ordering (fewer changed functions, then faster median completion, then id) is a review policy, not proof of real-world safety.</p>
<h3>Human review</h3>
${
  reviews.length
    ? `<ul class="plain">${reviews
        .map(
          (r) =>
            `<li>${badge(r.decision)} by <span class="mono">${esc(r.reviewerIdentity)}</span> on ${esc(iso(r.createdAtMs))} for candidate <span class="mono">${esc(short(r.candidateId))}</span>, controller <span class="mono">${esc(short(r.controllerSha256))}</span>, evaluation <span class="mono">${esc(short(r.evaluationId))}</span>${r.jiraIssueKey ? ` · ${esc(r.jiraIssueKey)}` : ""}${r.notes ? `<br><span class="muted">${esc(r.notes)}</span>` : ""}</li>`,
        )
        .join("")}</ul>`
    : `<p>${badge("pending", "Not reviewed")} No human review has been recorded for this investigation.</p>`
}
</section>`);

  if (warnings.length) {
    parts.push(`<section aria-labelledby="warn-h"><h2 id="warn-h">Warnings</h2><ul class="warn">${warnings.map((w) => `<li>${esc(w.message)}</li>`).join("")}</ul></section>`);
  }

  // --- baseline ----------------------------------------------------------------
  const base = b.baseline.experiment;
  const baseReplay = b.replays.find((r) => r.role === "baseline");
  const ov = Object.entries(inv.baselineCase.sceneOverrides).sort(([a], [c]) => (a < c ? -1 : 1));
  parts.push(`<section aria-labelledby="base-h">
<h2 id="base-h">Baseline failure</h2>
<div class="grid2">
<dl class="kv">
<dt>Case</dt><dd class="mono">${esc(inv.baselineCase.caseId)}</dd>
<dt>Seed</dt><dd>${esc(inv.baselineCase.seed)}</dd>
<dt>Status</dt><dd>${badge(base.status)}</dd>
<dt>Failure</dt><dd>${base.failureKinds.length ? esc(base.failureKinds.join(", ")) : "none recorded"}</dd>
${baseReplay?.firstFailure ? `<dt>First failure</dt><dd>${esc(baseReplay.firstFailure.kind)} at t = ${esc(fmtSec(baseReplay.firstFailure.tSec))}${baseReplay.firstFailure.detail ? `<br><span class="muted small">${esc(baseReplay.firstFailure.detail)}</span>` : ""}</dd>` : ""}
<dt>Experiment</dt><dd class="mono">${esc(base.id)}</dd>
</dl>
<div>
${inv.baselineCase.description ? `<p>${esc(inv.baselineCase.description)}</p>` : ""}
${ov.length ? `<table><thead><tr><th>Scene parameter</th><th>Value</th></tr></thead><tbody>${ov.map(([k, v]) => `<tr><td class="mono">${esc(k)}</td><td>${esc(v)}</td></tr>`).join("")}</tbody></table>` : ""}
</div>
</div>
</section>`);

  // --- replay ------------------------------------------------------------------
  const inlineReplays = b.replays.filter((r) => r.frames?.length);
  const replayLabel = (r: BundleReplay) =>
    r.role === "baseline"
      ? `Baseline · ${r.caseId}`
      : `Candidate ${short(r.candidateId ?? "")} · ${r.caseId}`;
  parts.push(`<section aria-labelledby="replay-h">
<h2 id="replay-h">Replay</h2>
${
  inlineReplays.length
    ? `<div id="fs-player" class="player" hidden>
<div class="controls">
<label class="small">Run <select aria-label="Replay">${b.replays.map((r, i) => (r.frames?.length ? `<option value="${i}">${esc(replayLabel(r))}</option>` : "")).join("")}</select></label>
<button type="button" aria-pressed="false">Play</button>
<input type="range" min="0" max="0" value="0" step="1" aria-label="Scrub replay">
</div>
<canvas width="640" height="360" tabindex="0" aria-label="Sampled replay: top view and side view. Arrow keys step frames, space plays."></canvas>
<p class="small"><output aria-live="polite"></output></p>
<ul class="legend"><li>Blue: arm bodies</li><li>Amber square: cube</li><li>Grey bar: divider</li><li>Dashed green: target</li><li>Red ring: contact</li></ul>
</div>
<p id="fs-player-nojs" class="muted small">The replay player needs JavaScript; frame data is in the appendix.</p>`
    : `<p class="muted">No inline replay frames in this pack.</p>`
}
<ul class="plain small">${b.replays
    .map(
      (r) =>
        `<li><strong>${esc(replayLabel(r))}</strong> · ${r.completed ? badge("passed", "Completed") : badge("failed", "Not completed")}${r.failureKinds.length ? ` ${esc(r.failureKinds.join(", "))}` : ""}${r.completionTimeSec !== undefined ? ` · ${esc(fmtSec(r.completionTimeSec))}` : ""}<br><span class="muted">artifact <span class="mono">${esc(r.artifactId)}</span>, experiment <span class="mono">${esc(r.experimentId)}</span>${r.frames ? `, ${r.frames.length} frames inline` : ""}${r.chunks?.length ? `, ${r.chunks.length} chunk ref${r.chunks.length === 1 ? "" : "s"} (not embedded)` : ""}</span></li>`,
    )
    .join("")}</ul>
<p class="muted small">Positions are projected to 2D from recorded frames. The browser does not simulate anything here.</p>
</section>`);

  // --- candidates --------------------------------------------------------------
  parts.push(`<section aria-labelledby="cand-h"><h2 id="cand-h">Candidates</h2>`);
  if (!b.candidates.length) parts.push(`<p class="muted">No candidates were submitted.</p>`);
  b.candidates.forEach(({ candidate: c, diff }, i) => {
    const o = outcome.get(c.id) as CandidateOutcome;
    const d = renderDiff(diff.text);
    const pub = b.evaluations.find((e) => e.candidateId === c.id && e.suite === "public");
    const wh = b.evaluations.find((e) => e.candidateId === c.id && e.suite === "withheld");
    parts.push(`<article${i ? ` class="cand"` : ""}>
<h3>Candidate <span class="mono">${esc(short(c.id))}</span> ${badge(o.verdict)}</h3>
<dl class="kv small">
<dt>Candidate id</dt><dd class="mono">${esc(c.id)}</dd>
<dt>Controller</dt><dd class="mono">${esc(c.controllerSha256)}</dd>
<dt>Environment</dt><dd><span class="mono">${esc(short(c.environmentId))}</span> · submitted ${esc(iso(c.submittedAtMs))}</dd>
<dt>Changed</dt><dd>${c.changedFunctions.length ? c.changedFunctions.map((f) => `<code>${esc(f)}</code>`).join(", ") : "none"}</dd>
<dt>Diff</dt><dd>${d.stats.files} file${d.stats.files === 1 ? "" : "s"}, +${d.stats.added} −${d.stats.removed} · sha256 <span class="mono">${esc(diff.sha256)}</span></dd>
</dl>
${c.rationale ? `<p class="rationale small"><strong>Agent rationale (a claim, not evidence):</strong> ${esc(c.rationale)}</p>` : ""}
<pre class="diff" aria-label="Unified diff">${d.html}</pre>
${suiteTable("Public suite", pub?.cases, o.public, false)}
${suiteTable("Withheld suite", wh?.cases, o.withheld, hideWithheld)}
</article>`);
  });
  parts.push(`</section>`);

  // --- hashes ------------------------------------------------------------------
  const h = b.hashes;
  const rows: [string, string][] = [
    ["Baseline controller", h.baselineControllerSha256],
    ...b.candidates.map(({ candidate: c }) => [`Candidate ${short(c.id)} controller`, c.controllerSha256] as [string, string]),
    ...b.candidates.map(({ candidate: c, diff }) => [`Candidate ${short(c.id)} diff`, diff.sha256] as [string, string]),
    ["Robot assets", h.assetsSha256],
    ["Scene (baseline case)", h.sceneSha256 ?? `${sha256Hex(canonicalJson(inv.baselineCase))} (computed by pack)`],
    ["Engine", h.engineVersion],
    ["Public suite manifest", h.suiteManifests?.public ?? "not recorded"],
    ["Withheld suite manifest", h.suiteManifests?.withheld ?? "not recorded"],
    ["Evaluator", h.evaluatorSha256 ?? "not recorded"],
    ...b.evaluations.map(
      (e) => [`Evaluation run ${short(e.candidateId)} ${e.suite}`, `${e.id} · attempt ${e.evaluatorAttemptId}`] as [string, string],
    ),
    ...b.replays.filter((r) => r.framesSha256).map((r) => [`Replay ${short(r.artifactId)} frames`, r.framesSha256 as string] as [string, string]),
    ["Appendix JSON", appendixSha],
  ];
  parts.push(`<section aria-labelledby="hash-h"><h2 id="hash-h">Hashes and run ids</h2>
<p class="muted small">Checked before rendering: diffs match their sha256, every run used the same assets and engine, replays and evaluated experiments ran the candidate's exact controller, and every review is bound to the evaluated controller.</p>
<table><thead><tr><th>Item</th><th>Value</th></tr></thead><tbody>${rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td class="mono">${esc(v)}</td></tr>`).join("")}</tbody></table></section>`);

  // --- findings + citations --------------------------------------------------
  const findings = [...b.findings].sort((x, y) => x.createdAtMs - y.createdAtMs || (x.id < y.id ? -1 : 1));
  parts.push(`<section aria-labelledby="find-h"><h2 id="find-h">Findings and citations</h2>
<p class="muted small">Findings are agent observations with provenance. They explain the verdict; they do not decide it.</p>
${
  findings.length
    ? `<ul class="plain">${findings
        .map(
          (f) =>
            `<li><span class="badge s-hidden">${esc(f.kind.replace(/_/g, " "))}</span> ${esc(f.summary)}<br><span class="muted small">finding <span class="mono">${esc(short(f.id))}</span> · environment <span class="mono">${esc(short(f.environmentId))}</span>${f.sessionId ? ` · session <span class="mono">${esc(short(f.sessionId))}</span>` : ""} · ${esc(iso(f.createdAtMs))}</span>${f.evidence.length ? `<ul class="small">${f.evidence.map((e) => `<li>${esc(e.kind.replace(/_/g, " "))}${e.experimentId ? ` · experiment <span class="mono">${esc(short(e.experimentId))}</span>` : ""}${e.artifactId ? ` · artifact <span class="mono">${esc(short(e.artifactId))}</span>` : ""}${Object.keys(e.locator).length ? ` · <code>${esc(canonicalJson(e.locator))}</code>` : ""}${e.excerpt ? `<br><span class="muted">${esc(e.excerpt)}</span>` : ""}</li>`).join("")}</ul>` : ""}</li>`,
        )
        .join("")}</ul>`
    : `<p class="muted">No findings recorded.</p>`
}
<h3>Citations</h3>
${
  b.citations.length
    ? `<ol class="small">${b.citations.map((c) => `<li><strong>${esc(c.title)}</strong> · ${esc(c.source.replace(/_/g, " "))} <span class="mono">${esc(c.ref)}</span>${c.revision ? ` · revision ${esc(c.revision)}` : ""}</li>`).join("")}</ol>`
    : `<p class="muted small">No external citations (Elastic, Jira, Confluence) are attached to this pack.</p>`
}
</section>`);

  parts.push(`<section aria-labelledby="app-h" class="appendix"><h2 id="app-h">JSON appendix</h2>
<p class="muted small">The full redacted bundle is embedded in this file as <code>&lt;script type="application/json" id="fs-bundle"&gt;</code> (sha256 <span class="mono">${esc(appendixSha)}</span>). Extract it with any HTML parser.</p>
</section>
<footer>ForkSafe evidence pack v${PACK_VERSION}. Works offline; no network requests.</footer>
</main>
<script type="application/json" id="fs-bundle">${appendixJson}</script>
<script>${PLAYER}</script>
</body>
</html>
`);
  return parts.join("\n");
}

function suiteTable(
  title: string,
  cases: CaseEvaluation[] | undefined,
  o: SuiteOutcome | undefined,
  hidden: boolean,
): string {
  if (!cases || !o) return `<h3>${esc(title)}</h3><p class="muted small">${badge("not_evaluated")} No ${esc(title.toLowerCase())} evaluation recorded.</p>`;
  const head = `<h3>${esc(title)} ${badge(o.status)} <span class="muted small">${o.passed}/${o.total} passed · median ${esc(fmtSec(o.medianCompletionTimeSec))}</span></h3>`;
  if (hidden) return `${head}<p class="muted small">${badge("hidden", "Per-case rows hidden")} Withheld case results are summarized until search ends.</p>`;
  return `${head}<table><thead><tr><th class="c-case">Case</th><th class="c-status">Result</th><th class="c-time">Time</th><th>Failure</th><th class="c-exp">Experiment</th></tr></thead><tbody>${cases
    .map(
      (c) =>
        `<tr><td class="mono">${esc(c.caseId)}</td><td>${badge(c.status)}</td><td>${esc(fmtSec(c.completionTimeSec))}</td><td>${c.failureKinds.length ? esc(c.failureKinds.join(", ")) : "—"}</td><td class="c-exp mono">${c.experimentId ? esc(short(c.experimentId)) : "—"}</td></tr>`,
    )
    .join("")}</tbody></table>`;
}
