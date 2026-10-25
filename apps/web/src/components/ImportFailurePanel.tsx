import { useState } from "react";
import type { ImportedFailure } from "../../../../packages/contracts/src/importedFailure.js";
import { combineImportedFailure, readImportedControllerFile, readImportedSceneFile } from "./importFailure";
import styles from "./ImportFailurePanel.module.css";

const IDLE_STATUS = "Choose a scene JSON file and a Python controller.";
const RUNNING_STATUS = "Imported controller will be the one that runs";

export function ImportFailurePanel({
  onImport,
  onClear,
  active,
}: {
  onImport: (value: ImportedFailure) => void;
  onClear: () => void;
  active: boolean;
}) {
  const [sceneFile, setSceneFile] = useState<File | null>(null);
  const [controllerFile, setControllerFile] = useState<File | null>(null);
  const [status, setStatus] = useState(IDLE_STATUS);

  const useFiles = async () => {
    if (!sceneFile || !controllerFile) {
      setStatus(IDLE_STATUS);
      return;
    }
    const scene = await readImportedSceneFile(sceneFile);
    if (!scene.ok) {
      setStatus(scene.reason);
      return;
    }
    const controller = await readImportedControllerFile(controllerFile);
    if (!controller.ok) {
      setStatus(controller.reason);
      return;
    }
    const combined = combineImportedFailure(scene.value, controller.source);
    if (!combined.ok) {
      setStatus(combined.reason);
      return;
    }
    onImport(combined.value);
    setStatus(RUNNING_STATUS);
  };

  return (
    <div className={styles.panel} data-testid="import-failure">
      <label className={styles.field}>
        <span>Scene JSON</span>
        <input
          type="file"
          accept=".json,application/json"
          onChange={(event) => setSceneFile(event.currentTarget.files?.[0] ?? null)}
        />
      </label>
      <label className={styles.field}>
        <span>Controller Python</span>
        <input
          type="file"
          accept=".py"
          onChange={(event) => setControllerFile(event.currentTarget.files?.[0] ?? null)}
        />
      </label>
      <div className={styles.actions}>
        <button type="button" onClick={() => void useFiles()}>Use these files</button>
        {active && <button type="button" onClick={onClear}>Use the stock controller</button>}
      </div>
      <p className={styles.status} role="status">{status === IDLE_STATUS && active ? RUNNING_STATUS : status}</p>
    </div>
  );
}
