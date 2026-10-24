import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { evaluateBlipRetryRows } from "../chaos/lib/blipRetries.mjs";
import { checks } from "../chaos/lib/check.mjs";
import { redactSecrets } from "../chaos/lib/convex.mjs";
import { selectCleanupInvestigations } from "../chaos/lib/cleanup.mjs";
import { activeTurnsAt } from "../chaos/lib/runners.mjs";
import { rejectedStaleHeartbeat, scale10Provisioning } from "../chaos/lib/resiliencePredicates.mjs";
import { postRunner, sign } from "../chaos/lib/runnerHttp.mjs";
import { parseArgs } from "../chaos/run.mjs";

test("runner signature uses the server formula and its fixed vector", () => {
  const secret = ["k", "e", "y"].join("");
  const timestamp = "1700000000000";
  const rawBody = '{"ok":true}';
  const independent = createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");
  assert.equal(sign(secret, timestamp, rawBody), independent);
  assert.equal(sign(secret, timestamp, rawBody), "9daa577d0624a4878ffe609999a884ecad9878a97b5f9f0fe48cdef1252894ad");
});

test("runner HTTP posts preserve the signed raw body and required headers on non-2xx", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  const secret = ["chaos", "unit", "test"].join("-");
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init });
    return { status: 409, text: async () => '{"error":"stale_epoch"}' };
  };
  try {
    const result = await postRunner(
      "https://example.invalid/",
      { credentialId: "runner-test", secret },
      "/tools/read_findings",
      { limit: 5 },
    );
    assert.equal(result.status, 409);
    assert.deepEqual(result.json, { error: "stale_epoch" });
    assert.equal(requests[0].url, "https://example.invalid/runner/tools/read_findings");
    assert.deepEqual(Object.keys(requests[0].init.headers).sort(), [
      "content-type",
      "x-forksafe-runner",
      "x-forksafe-signature",
      "x-forksafe-timestamp",
    ]);
    assert.equal(requests[0].init.headers["x-forksafe-runner"], "runner-test");
    const expectedSignature = createHmac("sha256", secret)
      .update(`${requests[0].init.headers["x-forksafe-timestamp"]}.${requests[0].init.body}`)
      .digest("hex");
    assert.equal(requests[0].init.headers["x-forksafe-signature"], expectedSignature);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("active turn folding handles unmatched releases, time cutoffs, and multiple files", () => {
  const root = mkdtempSync(join(tmpdir(), "forksafe-chaos-turns-"));
  const first = join(root, "first.jsonl");
  const second = join(root, "second.jsonl");
  try {
    writeFileSync(first, [
      JSON.stringify({ t: 10, ev: "acquired" }),
      JSON.stringify({ t: 20, ev: "released" }),
      JSON.stringify({ t: 30, ev: "released" }),
      JSON.stringify({ t: 40, ev: "acquired" }),
    ].join("\n"));
    writeFileSync(second, `${JSON.stringify({ t: 36, ev: "acquired" })}\n`);
    assert.equal(activeTurnsAt([first, second], 35), 0);
    assert.equal(activeTurnsAt([first, second], 39), 1);
    assert.equal(activeTurnsAt([first, second], 40), 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stale heartbeat predicate accepts the F5 response and legacy rejection shape", () => {
  assert.equal(rejectedStaleHeartbeat({ status: 409, json: { error: "stale_epoch" } }), true);
  assert.equal(rejectedStaleHeartbeat({ status: 200, json: { ok: false } }), true);
  assert.equal(rejectedStaleHeartbeat({ status: 409, json: { error: "other" } }), false);
});

test("scale10 provisioning allows active environments without runner sandbox ops only in external mode", () => {
  const environments = [{ appId: "env-1" }, { appId: "env-2" }];
  const external = scale10Provisioning({
    environments,
    expectedEnvironmentCount: 2,
    everActive: ["env-1", "env-2"],
    runnerOpsSeen: [],
    runnerOpsCount: 0,
  });
  assert.deepEqual(external, {
    externalMode: true,
    runnerOpsCount: 0,
    allEnvironmentsProvisioned: true,
  });
  assert.equal(scale10Provisioning({
    environments,
    expectedEnvironmentCount: 2,
    everActive: ["env-1"],
    runnerOpsSeen: [],
    runnerOpsCount: 0,
  }).allEnvironmentsProvisioned, false);
  const sandbox = scale10Provisioning({
    environments,
    expectedEnvironmentCount: 2,
    everActive: ["env-1", "env-2"],
    runnerOpsSeen: ["env-1", "env-2"],
    runnerOpsCount: 2,
  });
  assert.deepEqual(sandbox, {
    externalMode: false,
    runnerOpsCount: 2,
    allEnvironmentsProvisioned: true,
  });
  assert.equal(scale10Provisioning({
    environments,
    expectedEnvironmentCount: 2,
    everActive: ["env-1", "env-2"],
    runnerOpsSeen: ["env-1"],
    runnerOpsCount: 1,
  }).allEnvironmentsProvisioned, false);
});

test("check collector distinguishes pass, fail, and not reached", () => {
  const collector = checks();
  collector.check("P", "passed", true);
  collector.check("F", "failed", false, { observed: 1 }, "strict");
  collector.notReached("N", "not exercised", "no fixture");
  assert.deepEqual(collector.results.map(({ status, passed, kind }) => ({ status, passed, kind })), [
    { status: "pass", passed: true, kind: "hard" },
    { status: "fail", passed: false, kind: "strict" },
    { status: "not_reached", passed: false, kind: "hard" },
  ]);
});

test("CLI parsing rejects unknown scenarios and environment counts outside 1..10", () => {
  assert.throws(() => parseArgs(["not-a-scenario"]), /Unknown scenario/);
  assert.throws(() => parseArgs(["scale10", "--envs", "0"]), /between 1 and 10/);
  assert.throws(() => parseArgs(["scale10", "--envs", "11"]), /between 1 and 10/);
  assert.deepEqual(parseArgs(["scale10", "--envs", "10", "--token-cap", "4000", "--timeout-min", "20"]), {
    scenario: "scale10",
    options: { envs: 10, tokenCap: 4000, timeoutMin: 20 },
  });
});

test("secret redaction removes runtime credentials and bearer strings", () => {
  const name = "FACTORY_API_KEY";
  const previous = process.env[name];
  const fakeCredential = ["chaos", "test", "credential"].join("-");
  process.env[name] = fakeCredential;
  try {
    const redacted = redactSecrets(`failure ${fakeCredential}; ${name}=${fakeCredential}; Bearer opaque-token`);
    assert.equal(redacted.includes(fakeCredential), false);
    assert.match(redacted, /\[REDACTED\]/);
    assert.match(redacted, /Bearer \[REDACTED\]/);
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
});

test("cleanup selection includes only nonterminal chaos investigations", () => {
  const selected = selectCleanupInvestigations([
    { appId: "keep", title: "chaos: load run", state: "searching" },
    { appId: "terminal", title: "chaos: finished", state: "completed" },
    { appId: "other", title: "manual run", state: "searching" },
  ]);
  assert.deepEqual(selected.map((item) => item.appId), ["keep"]);
});

test("bounded blip retries accept dead-lettered and recent rows", () => {
  const nowMs = 1_000_000;
  const result = evaluateBlipRetryRows([
    { key: "chaos:blip:recent", attempts: 2, status: "pending", lastError: "spacetime_unavailable", createdAtMs: nowMs - 1_000 },
    { key: "chaos:blip:max", attempts: 8, status: "dead", lastError: "spacetime_unavailable", createdAtMs: nowMs - 25 * 60_000 - 1 },
  ], nowMs);
  assert.equal(result.passed, true);
  assert.deepEqual(result.violations, []);
});

test("bounded blip retries reject over-limit, non-dead, and aged retry rows", () => {
  const nowMs = 1_000_000;
  const result = evaluateBlipRetryRows([
    { key: "chaos:blip:over", attempts: 9, status: "dead", createdAtMs: nowMs },
    { key: "chaos:blip:max-pending", attempts: 8, status: "pending", createdAtMs: nowMs },
    { key: "chaos:blip:aged", attempts: 7, status: "pending", createdAtMs: nowMs - 25 * 60_000 - 1 },
  ], nowMs);
  assert.equal(result.passed, false);
  assert.equal(result.violations.length, 3);
});
