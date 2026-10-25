import { useState } from "react";
import type { TaskFamily } from "@forksafe/contracts";
import { RECORDED_MODEL_LABEL, pickShrinkKey, recordedSceneFails, shrinkRecordedControl } from "./recordedFailureModel";
import styles from "./FailureMinimizer.module.css";

const NOT_A_FAILURE = "This recorded model does not call the current scene a failure, so there is nothing to shrink.";

type Notice =
  | { kind: "none" }
  | { kind: "not-failure" }
  | { kind: "reason"; text: string; signature: string }
  | { kind: "shrunk"; key: string; from: number; to: number };

function formatValue(value: number): string {
  return value.toFixed(5);
}

export function FailureMinimizer({
  taskFamily,
  overrides,
  seed,
  onApply,
}: {
  taskFamily: TaskFamily;
  overrides: Record<string, number>;
  seed: number;
  onApply: (overrides: Record<string, number>) => void;
}) {
  const [notice, setNotice] = useState<Notice>({ kind: "none" });
  const signature = JSON.stringify(overrides);

  const shrink = () => {
    if (!recordedSceneFails(taskFamily, overrides)) {
      setNotice({ kind: "not-failure" });
      return;
    }
    const key = pickShrinkKey(taskFamily, overrides);
    const result = shrinkRecordedControl(taskFamily, overrides, key);
    if ("reason" in result) {
      setNotice(result.reason === "not-failure"
        ? { kind: "not-failure" }
        : { kind: "reason", text: result.reason, signature });
      return;
    }
    onApply({ ...overrides, [key]: result.value });
    setNotice({ kind: "shrunk", key, from: result.from, to: result.value });
  };

  const current = notice.kind === "shrunk" ? overrides[notice.key] : undefined;
  const showShrink = notice.kind === "shrunk" && (current === notice.to || current === notice.from);
  const showReason = notice.kind === "reason" && notice.signature === signature;
  const showNotFailure = notice.kind === "not-failure" && !recordedSceneFails(taskFamily, overrides);

  return (
    <section className={styles.root} data-seed={seed} data-testid="failure-minimizer">
      <p className={styles.note}>{RECORDED_MODEL_LABEL}</p>
      <button type="button" onClick={shrink}>Shrink this failure</button>
      {showNotFailure && <p className={styles.note} role="status">{NOT_A_FAILURE}</p>}
      {showReason && notice.kind === "reason" && <p className={styles.note} role="status">{notice.text}</p>}
      {showShrink && notice.kind === "shrunk" && (
        <p className={styles.result} role="status">
          {notice.key} from {formatValue(notice.from)} to {formatValue(notice.to)}
        </p>
      )}
    </section>
  );
}
