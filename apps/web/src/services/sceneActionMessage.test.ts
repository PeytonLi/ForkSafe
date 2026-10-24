import { describe, expect, it } from "vitest";
import { sceneActionMessage } from "./sceneActionMessage";

describe("scene action messages", () => {
  it("explains fixture search and capture without exposing setup details", () => {
    expect(sceneActionMessage("fixture", "Fixture mode cannot search (VITE_CONVEX_URL)", "search")).toEqual({
      label: "Sample data",
      message: "This is sample data, so ForkSafe can't run the physics needed to find a failure. On the live app, this button searches nearby scenes for one that fails.",
    });
    expect(sceneActionMessage("fixture", "fixture refusal", "capture")).toEqual({
      label: "Sample data",
      message: "This is sample data, so ForkSafe can't record a new robot run here. On the live app, Start records the scene and then starts the agents.",
    });
  });

  it("maps blocked sandbox and simulator bundle codes", () => {
    expect(sceneActionMessage("blocked", "daytona_cloud_provider_blocked", "search").message)
      .toBe("The physics sandbox isn't set up yet, so ForkSafe can't search right now.");
    expect(sceneActionMessage("blocked", "The simulator and baseline controller bundles must be published before searching.", "search").message)
      .toBe("The simulator isn't installed yet, so ForkSafe can't search right now.");
    expect(sceneActionMessage("blocked", "capture needs a Daytona execution sandbox; DAYTONA_API_KEY is not configured", "capture").message)
      .toBe("The physics sandbox isn't set up yet, so ForkSafe can't record a new robot run right now.");
    expect(sceneActionMessage("live", "daytona_exec_failed:Error", "search").message)
      .toBe("ForkSafe can't search nearby scenes right now.");
  });
});
