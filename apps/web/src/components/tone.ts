import type { IntegrationMode } from "@forksafe/contracts";

type Tone = "blue" | "green" | "amber" | "red" | "gray";

export const modeTone: Record<IntegrationMode, Tone> = {
  live: "green",
  local: "blue",
  fixture: "amber",
  blocked: "red",
  not_implemented: "gray",
};

export function stateTone(s: string): Tone {
  if (["passed", "succeeded", "completed", "approved", "evaluated"].includes(s)) return "green";
  if (["failed", "physics_failure", "constraint_violation", "engine_error", "invalid", "error", "rejected", "cancelled"].includes(s)) return "red";
  if (["awaiting_review", "needs_changes", "provisioning", "queued", "restricted", "closing"].includes(s)) return "amber";
  if (["running", "searching", "evaluating", "active", "streaming", "capturing", "admitted"].includes(s)) return "blue";
  return "gray";
}

export const words = (s: string) => s.replace(/_/g, " ");

export const human = (s: string) => {
  const label = words(s);
  return label ? `${label[0]!.toUpperCase()}${label.slice(1)}` : label;
};
