import { afterEach, describe, expect, it, vi } from "vitest";
import { FixtureClient } from "./fixtureClient";

const INVESTIGATION_ID = "3b7d9303-7082-4b73-a3b6-1391b3e2fc4d";
const BASELINE_EXPERIMENT_ID = "b8fb628a-7783-40e0-ab5b-de53edc24208";
const BASELINE_REPLAY_ID = "48f14573-c5b4-413f-a65f-9796177adf26";

afterEach(() => vi.useRealTimers());

describe("fixture live stream", () => {
  it("labels normal fixture data unavailable without changing workspace data", async () => {
    const client = new FixtureClient({ latencyMs: 0, storage: null });
    let snapshot: unknown;
    client.watchLive(BASELINE_EXPERIMENT_ID, (next) => { snapshot = next; });
    expect(snapshot).toMatchObject({ mode: "fixture", status: "unavailable", reason: "fixture_no_physics", chunks: [] });
    const workspacePromise = client.getWorkspace(INVESTIGATION_ID);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const workspace = await workspacePromise;
    expect(workspace.experiments.find((e) => e.id === BASELINE_EXPERIMENT_ID)).toMatchObject({
      status: "physics_failure",
      replayArtifactId: BASELINE_REPLAY_ID,
    });
  });

  it("streams the demo replay after waiting, then restores fixture experiments", async () => {
    vi.useFakeTimers();
    const client = new FixtureClient({ latencyMs: 0, storage: null, simulateStream: true });
    const updates: { status: string; chunks: { seq: number; final: boolean; frames: unknown[] }[]; replayArtifactId?: string }[] = [];
    const invalidated = vi.fn();
    client.subscribe(INVESTIGATION_ID, invalidated);
    client.watchLive(BASELINE_EXPERIMENT_ID, (next) => updates.push(next));
    expect(updates[0]).toMatchObject({ status: "waiting", mode: "fixture" });
    const initialWorkspacePromise = client.getWorkspace(INVESTIGATION_ID);
    await vi.advanceTimersByTimeAsync(0);
    const initialWorkspace = await initialWorkspacePromise;
    expect(initialWorkspace.experiments.find((e) => e.id === BASELINE_EXPERIMENT_ID)).toMatchObject({ status: "running" });
    expect(initialWorkspace.experiments.find((e) => e.id === BASELINE_EXPERIMENT_ID)?.replayArtifactId).toBeUndefined();
    const environment = initialWorkspace.environments[0]!;
    expect(environment.state).toBe("active");
    expect(initialWorkspace.sessions.filter((session) =>
      session.environmentId === environment.id && (session.state === "streaming" || session.state === "idle"),
    )).toHaveLength(1);
    const environmentExperiment = initialWorkspace.experiments
      .filter((e) => e.environmentId === environment.id)
      .sort((a, b) => b.startedAtMs - a.startedAtMs)[0]!;
    const environmentUpdates: { status: string }[] = [];
    client.watchLive(environmentExperiment.id, (next) => environmentUpdates.push(next));

    await vi.advanceTimersByTimeAsync(1_500);
    expect(updates.at(-1)?.status).toBe("streaming");
    expect(updates.at(-1)?.chunks.length).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(7_500);
    expect(updates.at(-1)).toMatchObject({ status: "finished", replayArtifactId: BASELINE_REPLAY_ID });
    expect(updates.at(-1)?.chunks.length).toBeLessThanOrEqual(8);
    expect(updates.at(-1)?.chunks.at(-1)?.final).toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    expect(invalidated).toHaveBeenCalled();
    const restoredPromise = client.getWorkspace(INVESTIGATION_ID);
    await vi.advanceTimersByTimeAsync(0);
    const restored = await restoredPromise;
    expect(restored.experiments.find((e) => e.id === BASELINE_EXPERIMENT_ID)).toMatchObject({
      status: "physics_failure",
      replayArtifactId: BASELINE_REPLAY_ID,
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(environmentUpdates.at(-1)?.status).toBe("finished");
    const environmentRestoredPromise = client.getWorkspace(INVESTIGATION_ID);
    await vi.advanceTimersByTimeAsync(0);
    const environmentRestored = await environmentRestoredPromise;
    expect(environmentRestored.environments.find((e) => e.id === environment.id)?.state).toBe("closed");
    expect(environmentRestored.sessions.filter((session) =>
      session.environmentId === environment.id && (session.state === "streaming" || session.state === "idle"),
    )).toHaveLength(0);
  });
});
