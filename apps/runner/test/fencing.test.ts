import { describe, expect, it } from "vitest";
import { assertFence, StaleLeaseError } from "../src/fencing.js";
import { sampleLease } from "./helpers.js";

describe("assertFence", () => {
  it("accepts a matching current lease", () => {
    const lease = sampleLease(100);
    expect(() => assertFence(lease, 101)).not.toThrow();
  });

  it("rejects mismatched identifiers, epochs, revocation, and expiry", () => {
    const lease = sampleLease(100);
    lease.grant.epoch = 1;
    expect(() => assertFence(lease, 101)).toThrow(StaleLeaseError);
    lease.grant.epoch = 0;
    lease.grant.revokedAtMs = 100;
    expect(() => assertFence(lease, 101)).toThrow(StaleLeaseError);
    delete lease.grant.revokedAtMs;
    expect(() => assertFence(lease, 30_100)).toThrow(StaleLeaseError);
  });
});
