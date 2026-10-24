import type { InvestigationWorkspace } from "../services";
import { LiveViewer } from "../viewer/LiveViewer";
import styles from "./EnvLiveSlot.module.css";

type Experiment = InvestigationWorkspace["experiments"][number];

export function EnvLiveSlot({
  compact,
  selected,
  experiment,
  scene,
  onSelectLive,
}: {
  compact: boolean;
  selected: boolean;
  experiment: Experiment | undefined;
  scene: Record<string, number>;
  onSelectLive: (button: HTMLButtonElement) => void;
}) {
  if (compact && !selected) {
    return (
      <button type="button" className={styles.watchLive} onClick={(event) => onSelectLive(event.currentTarget)}>
        Watch live
      </button>
    );
  }
  if (!experiment) return <div className={styles.idle}>No experiment running</div>;
  return (
    <LiveViewer
      key={experiment.id}
      experimentId={experiment.id}
      scene={scene}
      label={experiment.simCase.caseId}
      compact
    />
  );
}
