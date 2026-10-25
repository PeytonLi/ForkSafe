import type { SimRunResult, TaskFamily } from "@forksafe/contracts";
import { useLoad } from "../hooks";
import type { InvestigationWorkspace } from "../services";
import { LiveViewer } from "../viewer/LiveViewer";
import { ReplayViewer } from "../viewer/ReplayViewer";
import { ReplayControls } from "../viewer/ReplayControls";
import { replayDuration } from "../viewer/transform";
import { useReplayClock } from "../viewer/useReplayClock";
import styles from "./EnvLiveSlot.module.css";

type Experiment = InvestigationWorkspace["experiments"][number];
type ExperimentWithReplay = Experiment & { replayArtifactId: string };

export function EnvLiveSlot({
  compact,
  selected,
  experiment,
  finishedExperiment,
  investigationId,
  scene,
  taskFamily,
  onSelectLive,
}: {
  compact: boolean;
  selected: boolean;
  experiment: Experiment | undefined;
  /** Latest finished experiment for this env when nothing is running. */
  finishedExperiment?: ExperimentWithReplay;
  investigationId: string;
  scene: Record<string, number>;
  taskFamily?: string;
  onSelectLive: (button: HTMLButtonElement) => void;
}) {
  if (compact && !selected) {
    return (
      <button type="button" className={styles.watchLive} onClick={(event) => onSelectLive(event.currentTarget)}>
        {experiment ? "Watch live" : finishedExperiment ? "Watch replay" : "Watch live"}
      </button>
    );
  }
  if (experiment) {
    return (
      <LiveViewer
        key={experiment.id}
        experimentId={experiment.id}
        scene={scene}
        taskFamily={taskFamily}
        label={experiment.simCase.caseId}
        compact
      />
    );
  }
  if (finishedExperiment) {
    return (
      <FinishedExperimentReplay
        experiment={finishedExperiment}
        investigationId={investigationId}
        scene={scene}
        taskFamily={taskFamily}
      />
    );
  }
  return <div className={styles.idle}>No experiment running</div>;
}

function FinishedExperimentReplay({
  experiment,
  investigationId,
  scene,
  taskFamily,
}: {
  experiment: ExperimentWithReplay;
  investigationId: string;
  scene: Record<string, number>;
  taskFamily?: string;
}) {
  const replay = useLoad((c) => c.getReplay(experiment.replayArtifactId), [experiment.replayArtifactId]);
  if (replay.status === "loading") {
    return <div className={styles.idle}>Loading replay…</div>;
  }
  if (replay.status === "error" || !replay.data) {
    return <div className={styles.idle}>Replay unavailable</div>;
  }
  return (
    <CompactReplay
      replay={replay.data}
      investigationId={investigationId}
      scene={scene}
      taskFamily={taskFamily}
      label={experiment.simCase.caseId}
    />
  );
}

function CompactReplay({
  replay,
  investigationId,
  scene,
  taskFamily,
  label,
}: {
  replay: SimRunResult;
  investigationId: string;
  scene: Record<string, number>;
  taskFamily?: string;
  label: string;
}) {
  const clock = useReplayClock(replayDuration(replay.frames), 0, investigationId);
  return (
    <div className={styles.replay} data-testid="env-experiment-replay">
      <ReplayViewer
        replay={replay}
        t={clock.t}
        label={label}
        scene={scene}
        taskFamily={taskFamily as TaskFamily | undefined}
        compact
      />
      <ReplayControls clock={clock} label={`${label} replay`} />
    </div>
  );
}
