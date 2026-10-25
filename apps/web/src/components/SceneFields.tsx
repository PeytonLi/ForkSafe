import type { ReactNode } from "react";
import { SCENE_OVERRIDE_RANGES, TASK_FAMILY_SPECS, type SceneOverrideKey, type TaskFamily } from "@forksafe/contracts";
import styles from "./SceneFields.module.css";

const FIELD_GROUPS: Record<TaskFamily, { label: string; keys: SceneOverrideKey[] }[]> = {
  divider_pick_place: [
    { label: "Divider", keys: ["dividerDx", "dividerDy", "dividerHeight"] },
    { label: "Cube", keys: ["cubeDx", "cubeDy"] },
    { label: "Target", keys: ["targetDx", "targetDy"] },
  ],
  push_through_gap: [
    { label: "Gap", keys: ["gapDx", "gapWidth"] },
    { label: "Cube", keys: ["cubeDx", "cubeDy"] },
    { label: "Target", keys: ["targetDx", "targetDy"] },
  ],
  bin_drop: [
    { label: "Bin", keys: ["binDx", "binDy", "binWidth"] },
    { label: "Cube", keys: ["cubeDx", "cubeDy"] },
  ],
};

interface Props {
  taskFamily: TaskFamily;
  values: Record<string, number>;
  onChange: (key: string, value: number) => void;
  seed: number;
  onSeedChange: (seed: number) => void;
  environments: number;
  onEnvironmentsChange: (count: number) => void;
  onReset: () => void;
  showEnvironments?: boolean;
  stretchGroups?: boolean;
  legacy?: boolean;
  preview?: ReactNode;
}

export function formatSceneValue(key: string, value: number): string {
  if (!Number.isFinite(value)) return "";
  const digits = ["dividerHeight", "gapWidth", "binWidth", "speedScale"].includes(key) ? 2 : 3;
  return value.toFixed(digits);
}

export function SceneFields({
  taskFamily,
  values,
  onChange,
  seed,
  onSeedChange,
  environments,
  onEnvironmentsChange,
  onReset,
  showEnvironments = true,
  stretchGroups = false,
  legacy,
  preview,
}: Props) {
  const keys = TASK_FAMILY_SPECS[taskFamily].overrideKeys;
  const speedScale = values.speedScale ?? 1;
  return (
    <div className={styles.fields} data-stretch-groups={stretchGroups || undefined}>
      {preview && <div className={styles.preview}>{preview}</div>}
      {legacy && <p className={styles.legacy}>This recorded example uses an older scene format, so the editor starts from the standard scene.</p>}
      {FIELD_GROUPS[taskFamily].map((group) => (
        <fieldset className={styles.group} key={group.label}>
          <legend>{group.label}</legend>
          {group.keys.map((key) => {
            if (!keys.some((sceneKey) => sceneKey === key)) return null;
            const range = SCENE_OVERRIDE_RANGES[key];
            const value = values[key] ?? 0;
            const clamp = () => {
              const next = Number.isFinite(value) ? Math.min(range.max, Math.max(range.min, value)) : range.min;
              onChange(key, Number(next.toFixed(5)));
            };
            return (
              <label className={styles.field} key={key}>
                <span className={styles.label}>{range.label}</span>
                <span className={styles.inputRow}>
                  <input
                    className={styles.slider}
                    type="range"
                    aria-label={range.label}
                    min={range.min}
                    max={range.max}
                    step={range.step}
                    value={Number.isFinite(value) ? value : range.min}
                    onChange={(event) => onChange(key, Number(event.currentTarget.value))}
                  />
                  <input
                    className={styles.number}
                    type="number"
                    aria-label={`${range.label} value`}
                    min={range.min}
                    max={range.max}
                    step={range.step}
                    value={formatSceneValue(key, value)}
                    onChange={(event) => onChange(key, event.currentTarget.value === "" ? Number.NaN : Number(event.currentTarget.value))}
                    onBlur={clamp}
                  />
                  <span className={styles.unit}>{range.unit}</span>
                </span>
              </label>
            );
          })}
        </fieldset>
      ))}
      <fieldset className={styles.group}>
        <legend>Run</legend>
        <label className={styles.field}>
          <span className={styles.label}>{SCENE_OVERRIDE_RANGES.speedScale.label}</span>
          <span className={styles.inputRow}>
            <input
              className={styles.slider}
              type="range"
              aria-label={SCENE_OVERRIDE_RANGES.speedScale.label}
              min={SCENE_OVERRIDE_RANGES.speedScale.min}
              max={SCENE_OVERRIDE_RANGES.speedScale.max}
              step={SCENE_OVERRIDE_RANGES.speedScale.step}
              value={values.speedScale ?? 1}
              onChange={(event) => onChange("speedScale", Number(event.currentTarget.value))}
            />
            <input
              className={styles.number}
              type="number"
              aria-label={`${SCENE_OVERRIDE_RANGES.speedScale.label} value`}
              min={SCENE_OVERRIDE_RANGES.speedScale.min}
              max={SCENE_OVERRIDE_RANGES.speedScale.max}
              step={SCENE_OVERRIDE_RANGES.speedScale.step}
              value={formatSceneValue("speedScale", speedScale)}
              onChange={(event) => onChange("speedScale", event.currentTarget.value === "" ? Number.NaN : Number(event.currentTarget.value))}
              onBlur={() => {
                const current = speedScale;
                onChange("speedScale", Number((Number.isFinite(current) ? Math.min(2, Math.max(0.5, current)) : 1).toFixed(5)));
              }}
            />
            <span className={styles.unit}>×</span>
          </span>
        </label>
        <label className={styles.field}>
          <span className={styles.label}>Seed</span>
          <input
            className={styles.runInput}
            type="number"
            min={0}
            step={1}
            value={Number.isFinite(seed) ? seed : ""}
            onChange={(event) => onSeedChange(event.currentTarget.value === "" ? Number.NaN : Math.max(0, Math.round(Number(event.currentTarget.value))))}
            onBlur={() => onSeedChange(Number.isFinite(seed) ? Math.max(0, Math.round(seed)) : 0)}
          />
        </label>
        {showEnvironments && (
          <label className={styles.field}>
            <span className={styles.label}>Agent environments (1–4)</span>
            <input
              className={styles.runInput}
              type="number"
              min={1}
              max={4}
              step={1}
              value={environments}
              onChange={(event) => onEnvironmentsChange(Math.min(4, Math.max(1, Math.round(Number(event.currentTarget.value) || 1))))}
            />
          </label>
        )}
        <button type="button" className={styles.reset} onClick={onReset}>Reset</button>
      </fieldset>
    </div>
  );
}
