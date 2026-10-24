export type CaptureStatus = "pending" | "running" | "recorded" | "failed";

interface CaptureProgressInput {
  captureStatus?: CaptureStatus;
  baselineStatus?: string;
  investigationState: string;
  lastError?: string;
}

interface CaptureProgressView {
  activeStep: number;
  currentTitle: string;
  currentDetail: string;
  resultTitle: string;
  resultDetail?: string;
  agentsTitle: string;
}

export function captureProgressFor({
  captureStatus,
  baselineStatus,
  investigationState,
  lastError,
}: CaptureProgressInput): CaptureProgressView | null {
  if (!captureStatus) return null;

  let activeStep = 0;
  let currentTitle = "Queued";
  let currentDetail = "The selected scene is waiting to be recorded.";
  let resultTitle = "Waiting for the robot run";
  let resultDetail: string | undefined;
  let agentsTitle = "Waiting for the result";

  if (captureStatus === "running") {
    activeStep = 1;
    currentTitle = "Recording the robot";
    currentDetail = "The simulator is running the selected scene.";
  } else if (captureStatus === "failed") {
    activeStep = 2;
    currentTitle = "Recording didn't work";
    currentDetail = lastError ?? "The baseline run could not be recorded.";
    resultTitle = currentTitle;
    resultDetail = currentDetail;
  } else if (captureStatus === "recorded") {
    if (baselineStatus === "physics_failure" || baselineStatus === "constraint_violation") {
      resultTitle = "Failed as expected";
      resultDetail = "The robot failed in this scene, so agents have something to fix.";
    } else if (baselineStatus === "succeeded") {
      resultTitle = "Passed unexpectedly";
      resultDetail = "The robot finished without failing, so this scene doesn't show the problem. Try changing the scene.";
    } else {
      resultTitle = "Baseline recorded";
      resultDetail = "The baseline replay and evidence are ready.";
    }

    if (investigationState === "admitted") {
      activeStep = 3;
      currentTitle = "Agents starting";
      currentDetail = "Agent environments are being prepared.";
      agentsTitle = currentTitle;
    } else if (investigationState === "searching" || investigationState === "evaluating") {
      activeStep = 3;
      currentTitle = "Agents working";
      currentDetail = "Agents are exploring the failure.";
      agentsTitle = currentTitle;
    } else {
      activeStep = 2;
      currentTitle = resultTitle;
      currentDetail = resultDetail;
      agentsTitle = "Waiting for agents";
    }
  }

  return { activeStep, currentTitle, currentDetail, resultTitle, resultDetail, agentsTitle };
}
