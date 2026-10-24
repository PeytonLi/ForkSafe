export type SceneAction = "search" | "capture";

export function sceneActionMessage(mode: string, reason: string, action: SceneAction) {
  if (mode === "fixture") {
    return {
      label: "Sample data",
      message: action === "search"
        ? "This is sample data, so ForkSafe can't run the physics needed to find a failure. On the live app, this button searches nearby scenes for one that fails."
        : "This is sample data, so ForkSafe can't record a new robot run here. On the live app, Start records the scene and then starts the agents.",
    };
  }

  const normalized = reason.toLowerCase();
  if (/daytona_cloud_provider_blocked|daytona_api_key|sandbox|execution_sandbox/.test(normalized)) {
    return {
      label: mode === "local" ? "Local mode" : "Setup needed",
      message: action === "search"
        ? "The physics sandbox isn't set up yet, so ForkSafe can't search right now."
        : "The physics sandbox isn't set up yet, so ForkSafe can't record a new robot run right now.",
    };
  }
  if (/simulator.*bundle|bundle.*simulator|simulator_bundle|baseline[_ ]controller/.test(normalized)) {
    return {
      label: "Setup needed",
      message: action === "search"
        ? "The simulator isn't installed yet, so ForkSafe can't search right now."
        : "The simulator isn't installed yet, so ForkSafe can't record a new robot run right now.",
    };
  }

  const safeReason = reason.replace(/\b[A-Z][A-Z0-9_]{2,}\b/g, "the required setting");
  return {
    label: mode === "local" ? "Local mode" : mode === "blocked" ? "Setup needed" : mode === "live" ? "Live" : "Not available",
    message: mode === "blocked" || mode === "local" || /^[a-z0-9_:-]+$/i.test(reason)
      ? action === "search" ? "ForkSafe can't search nearby scenes right now." : "ForkSafe can't record a new robot run right now."
      : safeReason || (action === "search" ? "ForkSafe couldn't search nearby scenes right now." : "ForkSafe couldn't record a new robot run right now."),
  };
}
