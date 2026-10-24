import type { ControllerChoiceValue } from "../services";
import { SegThumb } from "./SegThumb";
import { useLoad } from "../hooks";
import styles from "./ControllerChoice.module.css";

// Mounted by the scene editor (CapturePanel) — capture lane owns placement.
export const CONTROLLER_CHOICE_DEFAULT: ControllerChoiceValue = "approved";

export function ControllerChoice({
  value,
  onChange,
  taskFamily,
}: {
  value: ControllerChoiceValue;
  onChange: (value: ControllerChoiceValue) => void;
  taskFamily?: string;
}) {
  const current = useLoad((c) => c.getCurrentController(taskFamily), [taskFamily]);
  const approved = current.status === "ready" ? current.data.approved : null;
  if (!approved) return <p className={styles.note}>Uses the original baseline (no approved fix yet)</p>;
  return (
    <div className={`seg ${styles.choice}`} role="group" aria-label="Controller choice">
      <SegThumb active={value} />
      <button type="button" aria-pressed={value === "approved"} onClick={() => onChange("approved")}>
        Latest approved (v{approved.version})
      </button>
      <button type="button" aria-pressed={value === "baseline"} onClick={() => onChange("baseline")}>
        Original baseline (v1)
      </button>
    </div>
  );
}
