import { useState } from "react";
import { DEFAULT_TASK_FAMILY, TASK_FAMILIES, TASK_FAMILY_SPECS, validateSceneOverrides, type TaskFamily } from "@forksafe/contracts";
import { changedOverrides, defaultOverride } from "../scene";
import { useClient } from "../hooks";
import type { FailureSearchOutcome } from "../services";
import { useBrowserAccess } from "../services/browserAccess";
import { human } from "./tone";
import { ReplayViewer } from "../viewer/ReplayViewer";
import { SceneFields } from "./SceneFields";
import { SegThumb } from "./SegThumb";
import styles from "./NewSimulation.module.css";

export function NewSimulation({ onAccepted }: { onAccepted: (investigationId: string) => void }) {
  const client = useClient();
  const access = useBrowserAccess();
  const [step, setStep] = useState(1);
  const [taskFamily, setTaskFamily] = useState<TaskFamily>(DEFAULT_TASK_FAMILY);
  const [overrides, setOverrides] = useState<Record<string, number>>(() => defaultOverride(DEFAULT_TASK_FAMILY));
  const [seed, setSeed] = useState(1);
  const [environments, setEnvironments] = useState(1);
  const [title, setTitle] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchResult, setSearchResult] = useState<FailureSearchOutcome | null>(null);
  const [starting, setStarting] = useState(false);
  const [startResult, setStartResult] = useState<{ mode: string; reason: string } | null>(null);

  const validation = validateSceneOverrides(taskFamily, overrides);
  const seedValid = Number.isInteger(seed) && seed >= 0;
  const defaultTitle = `${TASK_FAMILY_SPECS[taskFamily].title} – custom scene`;

  const chooseFamily = (family: TaskFamily) => {
    setTaskFamily(family);
    setOverrides(defaultOverride(family));
    setSearchResult(null);
    setStartResult(null);
  };

  const findFailure = async () => {
    setSearching(true);
    setSearchResult(null);
    try {
      const result = await client.findFailure(taskFamily);
      setSearchResult(result);
      if (result.found) {
        setOverrides({ ...defaultOverride(taskFamily), ...result.sceneOverrides });
        setSeed(result.seed);
      }
    } catch (error) {
      setSearchResult({ mode: "blocked", found: false, samples: 0, failures: 0, reason: (error as Error).message });
    } finally {
      setSearching(false);
    }
  };

  const start = async () => {
    if (!access.canWrite) {
      access.showSignIn();
      return;
    }
    if (!validation.ok || !seedValid) return;
    setStarting(true);
    setStartResult(null);
    try {
      const result = await client.requestCapture({
        title: (title.trim() || defaultTitle).slice(0, 200),
        seed,
        sceneOverrides: changedOverrides(taskFamily, overrides),
        requestedEnvironments: environments,
        taskFamily,
      });
      if (result.accepted) {
        onAccepted(result.investigationId);
      } else {
        setStartResult({ mode: result.mode, reason: result.reason });
      }
    } catch (error) {
      setStartResult({ mode: "blocked", reason: (error as Error).message });
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className={styles.page} data-testid="new-simulation">
      <header className={styles.header}>
        <span className={styles.eyebrow}>New investigation</span>
        <h1>New simulation</h1>
        <p>Choose a robot task, set the scene, and start agents on a recorded failure.</p>
      </header>
      <div className={styles.stepHeader}>
        <span>Step {step} of 3</span>
        <div className={styles.stepTrack} aria-hidden="true">
          {[1, 2, 3].map((number) => <span key={number} data-active={number <= step || undefined} />)}
        </div>
      </div>

      {step === 1 && (
        <section aria-labelledby="task-heading" className={styles.card}>
          <h2 id="task-heading">Pick a task</h2>
          <fieldset className={styles.taskChoices}>
            <legend className="visually-hidden">Task family</legend>
            {TASK_FAMILIES.map((family) => {
              const spec = TASK_FAMILY_SPECS[family];
              return (
                <label className={styles.taskCard} data-selected={taskFamily === family || undefined} key={family}>
                  <input type="radio" name="taskFamily" value={family} checked={taskFamily === family} onChange={() => chooseFamily(family)} />
                  <span className={styles.taskCopy}>
                    <strong>{spec.title}</strong>
                    <span>{spec.description}</span>
                  </span>
                </label>
              );
            })}
          </fieldset>
          <div className={styles.actions}>
            <button type="button" className="primary" onClick={() => setStep(2)}>Next</button>
          </div>
        </section>
      )}

      {step === 2 && (
        <section aria-labelledby="scene-heading" className={styles.card}>
          <h2 id="scene-heading">Set up the scene</h2>
          <p className={styles.description}>{TASK_FAMILY_SPECS[taskFamily].description}</p>
          <div className={styles.sceneLayout}>
            <div className={styles.scenePreview}>
              <ReplayViewer taskFamily={taskFamily} scene={overrides} />
            </div>
            <div className={styles.sceneControls}>
              <SceneFields
                taskFamily={taskFamily}
                values={overrides}
                onChange={(key, value) => setOverrides((current) => ({ ...current, [key]: value }))}
                seed={seed}
                onSeedChange={setSeed}
                environments={environments}
                onEnvironmentsChange={setEnvironments}
                showEnvironments={false}
                onReset={() => {
                  setOverrides(defaultOverride(taskFamily));
                  setSeed(1);
                  setEnvironments(1);
                  setSearchResult(null);
                }}
              />
              {!validation.ok && <p className={styles.validation} role="alert">{validation.reason}</p>}
              {!seedValid && <p className={styles.validation} role="alert">Seed must be a non-negative integer.</p>}
              <div className={styles.searchRow}>
                <button type="button" onClick={findFailure} disabled={searching}>
                  {searching ? "Searching…" : "Find a failure for me"}
                </button>
                {searchResult && (
                  <p className={styles.searchResult} role="status" data-testid="find-failure-result" data-found={searchResult.found || undefined}>
                    {searchResult.found
                      ? `Found a failing scene: ${human(searchResult.failureKind ?? "failure")}.`
                      : `${searchResult.mode === "fixture" ? "Fixture: " : ""}${searchResult.reason}`}
                  </p>
                )}
              </div>
              <div className={styles.actions}>
                <button type="button" onClick={() => setStep(1)}>Back</button>
                <button type="button" className="primary" disabled={!validation.ok || !seedValid} onClick={() => setStep(3)}>Next</button>
              </div>
            </div>
          </div>
        </section>
      )}

      {step === 3 && (
        <section aria-labelledby="agents-heading" className={styles.card}>
          <h2 id="agents-heading">Agents</h2>
          <p className={styles.description}>Your agents will explore this scene in {environments} environment{environments === 1 ? "" : "s"}.</p>
          <fieldset className={styles.environmentFieldset}>
            <legend>Agent environments</legend>
            <div className={`seg seg-fill ${styles.environmentSegments}`} role="group" aria-label="Environment count">
              <SegThumb active={environments} />
              {[1, 2, 3, 4].map((count) => (
                <button
                  type="button"
                  key={count}
                  aria-pressed={environments === count}
                  onClick={() => setEnvironments(count)}
                >
                  {count}
                </button>
              ))}
            </div>
          </fieldset>
          <label className={styles.titleField}>
            <span>Investigation name</span>
            <input
              type="text"
              maxLength={200}
              value={title || defaultTitle}
              onChange={(event) => setTitle(event.currentTarget.value)}
              aria-label="Investigation name"
            />
          </label>
          <div className={styles.summary}>
            <strong>{TASK_FAMILY_SPECS[taskFamily].title}</strong>
            <span>Seed {seed} · {environments} agent environment{environments === 1 ? "" : "s"}</span>
            <span>{Object.keys(changedOverrides(taskFamily, overrides)).length} scene setting(s) changed from default</span>
          </div>
          {!validation.ok && <p className={styles.validation} role="alert">{validation.reason}</p>}
          <div className={styles.actions}>
            <button type="button" onClick={() => setStep(2)}>Back</button>
            <button type="button" className="primary" onClick={start} disabled={starting || !validation.ok || !seedValid}>
              {!access.canWrite ? "Sign in to start" : starting ? "Starting…" : "Start"}
            </button>
          </div>
          {startResult && (
            <p className={styles.refusal} role="status" data-testid="start-refusal">
              {startResult.mode === "fixture" ? "Fixture: " : `${human(startResult.mode)}: `}{startResult.reason}
            </p>
          )}
        </section>
      )}
    </div>
  );
}
