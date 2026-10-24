import type { InvestigationWorkspace } from "../services";
import { captureProgressFor } from "./captureProgress";
import styles from "./CaptureProgress.module.css";

const STEP_LABELS = ["Queued", "Recording the robot", "Result", "Agents"];

export function CaptureProgress({ workspace }: { workspace: InvestigationWorkspace }) {
  const investigation = workspace.investigation;
  const baseline = workspace.experiments.find((item) => item.id === investigation.baselineExperimentId);
  const progress = captureProgressFor({
    captureStatus: investigation.captureStatus ?? (baseline ? "recorded" : undefined),
    baselineStatus: baseline?.status,
    investigationState: investigation.state,
    lastError: investigation.lastError,
  });
  if (!progress) return null;

  return (
    <section className={styles.progress} aria-live="polite" data-testid="capture-progress">
      <ol className={styles.steps} aria-label="Baseline capture progress">
        {STEP_LABELS.map((label, index) => (
          <li
            className={styles.step}
            key={label}
            data-state={index < progress.activeStep ? "complete" : index === progress.activeStep ? "active" : "upcoming"}
            aria-current={index === progress.activeStep ? "step" : undefined}
          >
            <span className={styles.marker} aria-hidden="true" />
            <span className={styles.label}>{label}</span>
            {index < progress.activeStep
              ? <strong className={styles.stepStatus}>Done</strong>
              : index === progress.activeStep && index === 2
                ? <strong className={styles.stepStatus}>{progress.resultTitle}</strong>
                : index === progress.activeStep && index === 3
                  ? <strong className={styles.stepStatus}>{progress.agentsTitle}</strong>
                  : null}
          </li>
        ))}
      </ol>
      <div className={styles.current}>
        <strong>{progress.currentTitle}</strong>
        <p>{progress.currentDetail}</p>
        {progress.activeStep === 3 && progress.resultDetail && <p>{progress.resultDetail}</p>}
      </div>
    </section>
  );
}
