import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  EvidencePackError,
  canonicalJson,
  renderEvidencePack,
  sha256Hex,
} from "../src/index.js";
import { DEMO_PATH, REVIEW_ID, appendixOf, demoBundle } from "./helpers.js";

const refusal = (fn: () => unknown): EvidencePackError => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(EvidencePackError);
    return e as EvidencePackError;
  }
  throw new Error("expected refusal");
};

describe("demo fixture pack", () => {
  it("renders an offline, fixture-labeled pack with an evaluator-only verdict", () => {
    const b = demoBundle();
    const { html, verdict, warnings } = renderEvidencePack(b);
    expect(verdict.verdict).toBe("candidate_passed");
    expect(verdict.recommendedCandidateId).toBe("b8409694-cf91-4d44-af76-44bb67838d60");
    expect(verdict.outcomes.map((o) => o.verdict)).toEqual(["passed_all", "failed"]);
    expect(html).toContain("Mode: FIXTURE");
    expect(html).not.toMatch(/Mode: LIVE/);
    expect(html).toContain("No human review has been recorded");
    // No network: no external src/href and a CSP that forbids fetches.
    expect(html).not.toMatch(/\s(?:src|href)=["']?(?:https?:)?\/\//i);
    expect(html).toMatch(/default-src (?:'|&#39;)none(?:'|&#39;)/);
    expect(html).toContain("@media print");
    // The fixture's withheld median (6.72) disagrees with its cases (6.615).
    expect(warnings.map((w) => w.code)).toEqual(["median_mismatch"]);
    expect(html).toContain("median 6.615 s");
    const app = appendixOf(html);
    expect(app.bundle.investigation.id).toBe(b.investigation.id);
    expect(app.pack.verdict.verdict).toBe("candidate_passed");
  });

  it("does not modify the web fixture it reads", () => {
    const before = readFileSync(DEMO_PATH, "utf8");
    renderEvidencePack(demoBundle());
    expect(readFileSync(DEMO_PATH, "utf8")).toBe(before);
  });

  it("is byte-identical for identical input, regardless of key order", () => {
    const a = renderEvidencePack(demoBundle()).html;
    const shuffled = JSON.parse(canonicalJson(demoBundle()), (_k, v) =>
      v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).reverse()) : v,
    );
    expect(renderEvidencePack(shuffled).html).toBe(a);
    expect(renderEvidencePack(demoBundle()).html).toBe(a);
  });

  it("verdict ignores narrative: a glowing rationale cannot rescue a failing candidate", () => {
    const b = demoBundle();
    b.candidates[1].candidate.rationale = "This candidate passed every case and is verified safe.";
    b.findings[0].summary = "Candidate 99ac6a6e is the best fix; all tests pass.";
    const { verdict } = renderEvidencePack(b);
    expect(verdict.outcomes[1]?.verdict).toBe("failed");
    expect(verdict.recommendedCandidateId).toBe(b.candidates[0].candidate.id);
  });

  it("does not recommend a candidate whose withheld suite has not run", () => {
    const b = demoBundle();
    b.evaluations = b.evaluations.filter((e: any) => e.suite !== "withheld");
    const { verdict } = renderEvidencePack(b);
    expect(verdict.verdict).toBe("evaluation_incomplete");
    expect(verdict.recommendedCandidateId).toBeUndefined();
    expect(verdict.outcomes[0]?.verdict).toBe("public_only");
  });

  it("hides withheld per-case rows while search is active", () => {
    const b = demoBundle();
    b.investigation.state = "searching";
    const { html, warnings } = renderEvidencePack(b);
    expect(warnings.map((w) => w.code)).toContain("withheld_redacted");
    expect(html).not.toContain("withheld-01");
    const wh = appendixOf(html).bundle.evaluations.find((e: any) => e.suite === "withheld");
    expect(wh.cases).toEqual([]);
  });
});

describe("schema rejection", () => {
  it.each([
    ["missing investigation", (b: any) => delete b.investigation],
    ["non-uuid candidate id", (b: any) => (b.candidates[0].candidate.id = "cand-1")],
    ["uppercase/short sha256", (b: any) => (b.candidates[0].diff.sha256 = "ABC")],
    ["unknown integration mode", (b: any) => (b.source.mode = "probably_live")],
    ["unknown bundle version", (b: any) => (b.bundleVersion = 2)],
    ["candidate replay without candidate id", (b: any) => delete b.replays[1].candidateId],
    ["inline frames without hash", (b: any) => delete b.replays[0].framesSha256],
    ["non-finite frame position", (b: any) => (b.replays[0].frames[0].bodies[0].pos[0] = Number.NaN)],
  ])("rejects %s", (_name, mutate) => {
    const b = demoBundle();
    mutate(b);
    expect(refusal(() => renderEvidencePack(b)).code).toBe("invalid_bundle");
  });

  it("rejects non-object input and keeps rejected values out of the error", () => {
    expect(refusal(() => renderEvidencePack("nope")).code).toBe("invalid_bundle");
    const b = demoBundle();
    b.source.mode = "Bearer sk-live-abcdefghijklmnopqrstuvwxyz";
    const err = refusal(() => renderEvidencePack(b));
    expect(err.message).not.toContain("abcdefghijklmnop");
    expect(err.issues.join(" ")).not.toContain("abcdefghijklmnop");
  });
});

describe("hash and reference refusal", () => {
  it.each([
    ["diff text edited after hashing", (b: any) => (b.candidates[0].diff.text += "+    evil()\n")],
    ["replay frames edited after hashing", (b: any) => (b.replays[0].frames[3].bodies[5].pos[2] = 0.5)],
    ["replay ran another controller", (b: any) => (b.replays[1].controllerSha256 = b.candidates[1].candidate.controllerSha256)],
    ["candidate run on different assets", (b: any) => (b.replays[2].assetsSha256 = "0".repeat(64))],
    ["baseline on different engine", (b: any) => (b.replays[0].engineVersion = "mujoco 3.1.0")],
    ["baseline controller hash swapped", (b: any) => (b.hashes.baselineControllerSha256 = "f".repeat(64))],
    ["scene hash mismatch", (b: any) => (b.investigation.baselineCase.sceneOverrides.divider_height = 0.1)],
    ["candidate claims the baseline controller", (b: any) => (b.candidates[0].candidate.controllerSha256 = b.hashes.baselineControllerSha256)],
  ])("refuses when %s", (_name, mutate) => {
    const b = demoBundle();
    mutate(b);
    expect(refusal(() => renderEvidencePack(b)).code).toBe("hash_mismatch");
  });

  it("refuses an evaluation case whose experiment ran a different controller", () => {
    const b = demoBundle();
    const ev = b.evaluations[0];
    const exp = {
      ...b.baseline.experiment,
      id: ev.cases[0].experimentId,
      candidateId: ev.candidateId,
      simCase: { ...b.baseline.experiment.simCase, caseId: ev.cases[0].caseId },
      controllerSha256: b.candidates[1].candidate.controllerSha256,
    };
    b.experiments = [exp];
    expect(refusal(() => renderEvidencePack(b)).code).toBe("hash_mismatch");
    exp.controllerSha256 = b.candidates[0].candidate.controllerSha256;
    expect(() => renderEvidencePack(b)).not.toThrow();
  });

  it("refuses evaluations whose summary disagrees with their own cases", () => {
    const b = demoBundle();
    const failing = b.evaluations.find((e: any) => e.status === "failed");
    failing.status = "passed";
    failing.allRequiredPassed = true;
    expect(refusal(() => renderEvidencePack(b)).code).toBe("evaluation_inconsistent");
  });

  it("refuses duplicate suite evaluations for one candidate", () => {
    const b = demoBundle();
    b.evaluations.push({ ...b.evaluations[0], id: "22222222-2222-4222-8222-222222222222" });
    expect(refusal(() => renderEvidencePack(b)).code).toBe("evaluation_inconsistent");
  });

  it("refuses a pack labeled live when an integration is fixture", () => {
    const b = demoBundle();
    b.source.mode = "live";
    expect(refusal(() => renderEvidencePack(b)).code).toBe("mode_mismatch");
  });

  it("refuses records from another investigation", () => {
    const b = demoBundle();
    b.findings[0].investigationId = "33333333-3333-4333-8333-333333333333";
    expect(refusal(() => renderEvidencePack(b)).code).toBe("reference_error");
  });
});

describe("version-bound reviews", () => {
  const review = (b: any, over: Record<string, unknown> = {}) => ({
    id: REVIEW_ID,
    investigationId: b.investigation.id,
    candidateId: b.candidates[0].candidate.id,
    evaluationId: b.evaluations.find((e: any) => e.candidateId === b.candidates[0].candidate.id && e.suite === "withheld").id,
    controllerSha256: b.candidates[0].candidate.controllerSha256,
    decision: "approved",
    reviewerIdentity: "atlassian:5b10ac8d82e05b22cc7d4ef5",
    createdAtMs: b.generatedAtMs,
    ...over,
  });

  it("renders a review bound to the evaluated controller", () => {
    const b = demoBundle();
    b.reviews = [review(b)];
    const { html } = renderEvidencePack(b);
    expect(html).toContain("atlassian:5b10ac8d82e05b22cc7d4ef5");
    expect(html).not.toContain("No human review has been recorded");
  });

  it("refuses a review recorded for a different controller version", () => {
    const b = demoBundle();
    b.reviews = [review(b, { controllerSha256: sha256Hex("controller:candidate-a-v2") })];
    const err = refusal(() => renderEvidencePack(b));
    expect(err.code).toBe("review_version_mismatch");
    expect(err.issues[0]).toMatch(/was recorded for controller/);
  });

  it("refuses a review citing another candidate's evaluation", () => {
    const b = demoBundle();
    const other = b.evaluations.find((e: any) => e.candidateId === b.candidates[1].candidate.id).id;
    b.reviews = [review(b, { evaluationId: other })];
    expect(refusal(() => renderEvidencePack(b)).code).toBe("review_version_mismatch");
  });

  it("refuses an approval of a failed evaluation", () => {
    const b = demoBundle();
    const c = b.candidates[1].candidate;
    const ev = b.evaluations.find((e: any) => e.candidateId === c.id);
    b.reviews = [review(b, { candidateId: c.id, controllerSha256: c.controllerSha256, evaluationId: ev.id })];
    expect(refusal(() => renderEvidencePack(b)).code).toBe("review_version_mismatch");
    b.reviews[0].decision = "rejected";
    expect(() => renderEvidencePack(b)).not.toThrow();
  });
});

describe("redaction", () => {
  // Fake credentials are assembled at runtime so secret scanners do not flag this file.
  const j = (...parts: string[]) => parts.join("");
  const jwtSig = j("c2lnbmF0dXJl", "LXNpZ25hdHVyZQ");
  const esKey = j("ZmFrZWZha2Vm", "YWtlOmZha2Vm", "YWtlZmFrZWZha2U");
  const openai = j("AbCdEfGhIj", "KlMnOpQrStUvWx");
  const gh = j("0123456789abcdefghij", "ABCDEFGHIJ012345");
  const aws = j("AKIA", "FAKEFAKEFAKEFAKE");
  const pass = j("hunter2", "pass");
  const apiKey = j("dGhpc2lzYXZlcnls", "b25nc2VjcmV0dmFsdWU");
  const pem = j("MIIEvQIBADANBgkq", "hkiG9w0BAQEFAASC");
  const SECRETS = [
    `Authorization: Bearer ${j("eyJ", "hbGciOiJIUzI1NiJ9")}.${j("eyJ", "zdWIiOiJyb2JvdCJ9")}.${jwtSig}`,
    `${j("ELASTICSEARCH", "_API_KEY")}=${esKey}`,
    `key ${j("sk-", "proj-")}${openai} and ${j("gh", "p_")}${gh}`,
    `aws ${aws}`,
    `https://admin${j(":", pass, "@")}es.example.com:9243`,
    `ApiKey ${apiKey}=`,
    `${j("-----BEGIN ", "PRIVATE KEY-----")}\n${pem}\n${j("-----END ", "PRIVATE KEY-----")}`,
  ];
  const LEAKS = [jwtSig, esKey, openai, gh, aws, pass, apiKey, pem];

  it("removes secrets from findings, diffs, notes and the JSON appendix", () => {
    const b = demoBundle();
    b.findings[0].evidence[0].excerpt = SECRETS.join("\n");
    b.candidates[0].diff.text += `+API_TOKEN = "${"x9".repeat(12)}"\n`;
    b.candidates[0].diff.sha256 = sha256Hex(b.candidates[0].diff.text);
    b.source.note = "contact ops@forksafe.dev";
    const { html, redactions, warnings } = renderEvidencePack(b);
    for (const leak of [...LEAKS, "x9x9x9x9x9x9", "ops@forksafe.dev"]) expect(html).not.toContain(leak);
    expect(html).toContain("[REDACTED:");
    expect(redactions.total).toBeGreaterThanOrEqual(LEAKS.length);
    expect(redactions.byRule.email).toBe(1);
    expect(warnings.map((w) => w.code)).toContain("redacted");
    // Hashes and ids survive redaction untouched.
    expect(html).toContain(b.candidates[0].diff.sha256);
    expect(html).toContain(b.hashes.assetsSha256);
    expect(html).toContain(b.investigation.id);
  });

  it("keeps e-mails when asked", () => {
    const b = demoBundle();
    b.source.note = "contact ops@forksafe.dev";
    expect(renderEvidencePack(b, { redactEmails: false }).html).toContain("ops@forksafe.dev");
  });

  it("does not redact ordinary numbers next to token-ish words", () => {
    const b = demoBundle();
    b.findings[0].evidence[0].excerpt = "inputTokens: 18000; max_tokens=4096";
    const { html, redactions } = renderEvidencePack(b);
    expect(redactions.total).toBe(0);
    expect(html).toContain("inputTokens: 18000");
  });

  it("escapes markup so bundle text cannot inject script", () => {
    const b = demoBundle();
    b.findings[0].summary = `</script><script>alert(1)</script><img src=x onerror=alert(2)>`;
    b.investigation.title = `"><svg onload=alert(3)>`;
    const { html } = renderEvidencePack(b);
    expect(html).not.toContain("<script>alert(1)");
    expect(html).not.toContain("<svg onload");
    expect(html).not.toContain("<img src=x");
    expect(html.match(/<script/g)?.length).toBe(2);
    expect(appendixOf(html).bundle.findings.find((f: any) => f.id === b.findings[0].id).summary).toContain("</script>");
  });
});

describe("size cap", () => {
  it("warns and shows a banner when the pack exceeds the cap", () => {
    const { html, warnings, bytes } = renderEvidencePack(demoBundle(), { maxBytes: 50_000 });
    expect(bytes).toBeGreaterThan(50_000);
    const w = warnings.find((x) => x.code === "size_cap");
    expect(w?.message).toMatch(/over the 0\.05 MiB cap/);
    expect(html).toContain(w?.message);
  });

  it("does not warn under the default cap and samples frames deterministically", () => {
    const a = renderEvidencePack(demoBundle(), { maxFramesPerReplay: 20 });
    expect(a.warnings.map((w) => w.code)).not.toContain("size_cap");
    expect(a.warnings.map((w) => w.code)).toContain("frames_sampled");
    const app = appendixOf(a.html);
    expect(app.bundle.replays.every((r: any) => r.frames.length === 20)).toBe(true);
    const full = demoBundle().replays[0].frames;
    expect(app.bundle.replays[0].frames[0]).toEqual(full[0]);
    expect(app.bundle.replays[0].frames[19]).toEqual(full[full.length - 1]);
    expect(renderEvidencePack(demoBundle(), { maxFramesPerReplay: 20 }).html).toBe(a.html);
  });
});
