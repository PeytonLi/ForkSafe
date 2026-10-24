import type { InvestigationWorkspace } from "../services";
import styles from "./CaptureProgress.module.css";

export function CaptureProgress({ workspace }: { workspace: InvestigationWorkspace }) {
  const investigation = workspace.investigation;
  const baseline = workspace.experiments.find((item) => item.id === investigation.baselineExperimentId);
  const status = investigation.captureStatus ?? (baseline ? "recorded" : undefined);
  if (!status) return null;

  let title = "Baseline capture queued";
  let detail = "The selected scene will be run before agent environments start.";
  let active = true;
  if (status === "running") {
    title = "Recording the baseline failure";
    detail = "The simulator is running the selected scene.";
  } else if (status === "recorded") {
    title = "Baseline recorded";
    active = ["admitted", "searching", "evaluating"].includes(investigation.state);
    detail = investigation.state === "admitted"
      ? "Agents are starting in their environments."
      : ["searching", "evaluating"].includes(investigation.state)
        ? "Agents are working through the investigation."
        : "The baseline replay and evidence are ready.";
  } else if (status === "failed") {
    active = false;
    if (baseline?.status === "physics_failure") {
      title = "The baseline failed with a physics failure";
      detail = "The scene produced a physics failure before the capture could be recorded.";
    } else if (baseline?.status === "constraint_violation") {
      title = "The baseline failed with a constraint violation";
      detail = "The scene produced a constraint violation before the capture could be recorded.";
    } else if (baseline?.status === "succeeded") {
      title = "The baseline succeeded";
      detail = "No failure was recorded for this scene.";
    } else {
      title = "Baseline capture failed";
      detail = investigation.lastError ?? "The baseline run could not be recorded.";
    }
  }

  return (
    <section className={styles.progress} data-active={active || undefined} aria-live="polite" data-testid="capture-progress">
      <span className={styles.marker} aria-hidden="true" />
      <div>
        <strong>{title}</strong>
        <p>{detail}</p>
      </div>
    </section>
  );
}
