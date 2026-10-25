import { useState } from "react";
import type { DescribeOutcome } from "@forksafe/contracts";
import { compileScenePrompt, DEFAULT_TASK_FAMILY, SCENE_OVERRIDE_RANGES, TASK_FAMILIES, TASK_FAMILY_SPECS, isTaskFamily, validateSceneOverrides, type SceneOverrideKey, type ScenePromptResult, type TaskFamily } from "@forksafe/contracts";
import type { ImportedFailure } from "../../../../packages/contracts/src/importedFailure.js";
import { changedOverrides, defaultOverride } from "../scene";
import { useClient } from "../hooks";
import type { ControllerChoiceValue, FailureSearchOutcome } from "../services";
import { useBrowserAccess } from "../services/browserAccess";
import { sceneActionMessage } from "../services/sceneActionMessage";
import { human } from "./tone";
import { ReplayViewer } from "../viewer/ReplayViewer";
import { ControllerChoice } from "./ControllerChoice";
import { FailureMinimizer } from "./FailureMinimizer";
import { ImportFailurePanel } from "./ImportFailurePanel";
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
  const [controller, setController] = useState<ControllerChoiceValue>("approved");
  const [title, setTitle] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchResult, setSearchResult] = useState<FailureSearchOutcome | null>(null);
  const [starting, setStarting] = useState(false);
  const [startResult, setStartResult] = useState<{ mode: string; reason: string } | null>(null);
  const [scenePrompt, setScenePrompt] = useState("");
  const [scenePromptResult, setScenePromptResult] = useState<ScenePromptResult | null>(null);
  const [importedController, setImportedController] = useState<ImportedFailure | null>(null);
  const [description, setDescription] = useState("");
  const [describing, setDescribing] = useState(false);
  const [described, setDescribed] = useState<DescribeOutcome | null>(null);
  const [describeError, setDescribeError] = useState<string | null>(null);

  const validation = validateSceneOverrides(taskFamily, overrides);
  const seedValid = Number.isInteger(seed) && seed >= 0;
  const canOperate = access.canOperate !== false;
  const defaultTitle = `${TASK_FAMILY_SPECS[taskFamily].title} – custom scene`;

  const chooseFamily = (family: TaskFamily) => {
    setTaskFamily(family);
    setOverrides(defaultOverride(family));
    setSearchResult(null);
    setStartResult(null);
    setScenePrompt("");
    setScenePromptResult(null);
    setDescribed(null);
  };

  const useDescription = async () => {
    if (!access.canWrite) {
      access.showSignIn();
      return;
    }
    setDescribing(true);
    setDescribed(null);
    setDescribeError(null);
    try {
      const result = await client.describeScene(description);
      if (result.status === "matched") {
        chooseFamily(result.taskFamily);
        setOverrides({ ...defaultOverride(result.taskFamily), ...result.overrides });
        setStep(2);
      }
      setDescribed(result);
    } catch {
      setDescribeError("The description couldn't be read just now. Try again, or pick a task below.");
    } finally {
      setDescribing(false);
    }
  };

  const describeNote = described && (
    <p className={styles.searchResult} role="status" data-testid="describe-result">
      <span className={styles.modeBadge}>{described.mode === "fixture" ? "Sample data" : described.mode === "llm" ? "Read by AI" : "Matched by keywords"}</span>
      {described.explanation}
    </p>
  );

  const applyScenePrompt = () => {
    const result = compileScenePrompt(taskFamily, scenePrompt, overrides);
    setScenePromptResult(result);
    setOverrides(result.overrides);
  };

  const findFailure = async () => {
    if (!canOperate) return;
    setSearching(true);
    setSearchResult(null);
    try {
      const result = await client.findFailure(taskFamily, {
        sceneOverrides: changedOverrides(taskFamily, overrides),
        seed,
      });
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
    if (!canOperate || !validation.ok || !seedValid) return;
    setStarting(true);
    setStartResult(null);
    try {
      const result = await client.requestCapture({
        title: (title.trim() || defaultTitle).slice(0, 200),
        seed,
        sceneOverrides: changedOverrides(taskFamily, overrides),
        requestedEnvironments: environments,
        taskFamily,
        controller,
        ...(importedController ? { controllerSource: importedController.controllerSource } : {}),
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
        <>
        <section aria-labelledby="describe-heading" className={styles.card}>
          <h2 id="describe-heading">Describe it <span className={styles.optional}>(optional)</span></h2>
          <form className={styles.describeForm} onSubmit={(event) => { event.preventDefault(); void useDescription(); }}>
            <label htmlFor="describe-input" className="visually-hidden">Describe a robot task</label>
            <textarea id="describe-input" data-testid="describe-input" maxLength={500} rows={2}
              placeholder="For example: a robot pushing a box through a narrow opening, a bit faster than usual"
              value={description} disabled={describing}
              onChange={(event) => { setDescription(event.target.value); setDescribed(null); setDescribeError(null); }} />
            <button type="submit" data-testid="describe-use" disabled={!description.trim() || describing}>{describing ? "Reading…" : "Use this"}</button>
          </form>
          {describeNote}
          {describeError && <p className={styles.refusal} role="alert">{describeError}</p>}
        </section>
        <section aria-labelledby="task-heading" className={styles.card}>
          <h2 id="task-heading">Pick a task</h2>
          <ImportFailurePanel
            active={importedController !== null}
            onClear={() => setImportedController(null)}
            onImport={(value) => {
              if (isTaskFamily(value.taskFamily)) {
                setTaskFamily(value.taskFamily);
                setOverrides({ ...defaultOverride(value.taskFamily), ...value.sceneOverrides });
              }
              setSeed(value.seed);
              if (value.title !== "Imported failure") setTitle(value.title);
              setImportedController(value);
            }}
          />
          <fieldset className={styles.taskChoices}>
            <legend className="visually-hidden">Task family</legend>
            {TASK_FAMILIES.filter((family) => family !== "bin_drop").map((family) => {
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
        </>
      )}

      {step === 2 && (
        <section aria-labelledby="scene-heading" className={styles.card}>
          <h2 id="scene-heading">Set up the scene</h2>
          <p className={styles.description}>{TASK_FAMILY_SPECS[taskFamily].description}</p>
          {describeNote}
          <div className={styles.sceneLayout}>
            <div className={styles.scenePreviewColumn}>
              <div className={styles.scenePreview}>
              <ReplayViewer taskFamily={taskFamily} scene={overrides} />
              </div>
              <div className={styles.searchRow}>
                <button type="button" onClick={findFailure} disabled={searching || (access.canWrite && !canOperate)}>
                  {searching ? "Searching…" : "Find a failure for me"}
                </button>
                {searchResult && (
                  <p className={styles.searchResult} role="status" data-testid="find-failure-result" data-found={searchResult.found || undefined}>
                    {searchResult.found
                      ? `Found a failing scene: ${human(searchResult.failureKind ?? "failure")}.`
                      : (
                        <>
                          <span className={styles.modeBadge}>{sceneActionMessage(searchResult.mode, searchResult.reason, "search").label}</span>
                          {sceneActionMessage(searchResult.mode, searchResult.reason, "search").message}
                        </>
                      )}
                  </p>
                )}
              </div>
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
                stretchGroups
                onReset={() => {
                  setOverrides(defaultOverride(taskFamily));
                  setSeed(1);
                  setEnvironments(1);
                  setSearchResult(null);
                  setScenePrompt("");
                  setScenePromptResult(null);
                }}
              />
              <FailureMinimizer taskFamily={taskFamily} overrides={overrides} seed={seed} onApply={setOverrides} />
              <div className={styles.scenePrompt} data-testid="scene-prompt">
                <label className={styles.titleField}>
                  <span>Describe a scene change</span>
                  <textarea
                    rows={3}
                    value={scenePrompt}
                    placeholder="Move the divider 6 cm closer"
                    onChange={(event) => {
                      setScenePrompt(event.currentTarget.value);
                      setScenePromptResult(null);
                    }}
                  />
                </label>
                <button type="button" onClick={applyScenePrompt}>Apply to the sliders</button>
                {scenePromptResult && (
                  <div className={styles.promptResult} data-testid="scene-prompt-result" aria-live="polite">
                    {scenePromptResult.applied.map((item, index) => (
                      <p className={styles.promptApplied} role="status" key={`${item.key}-${index}`}>
                        {item.label}: {formatPromptValue(item.key, item.value)}
                      </p>
                    ))}
                    {scenePromptResult.refusals.map((refusal) => (
                      <p className={styles.refusal} role="alert" key={refusal}>{refusal}</p>
                    ))}
                  </div>
                )}
              </div>
              {!validation.ok && <p className={styles.validation} role="alert">{validation.reason}</p>}
              {!seedValid && <p className={styles.validation} role="alert">Seed must be a non-negative integer.</p>}
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
          <p className={styles.description}>
            {environments === 1
              ? "This exact scene is what the agent runs."
              : "Environment 1 runs this exact scene. Each extra environment runs the same task with a nearby seed and one setting moved a single step, so the agents are not repeating one layout."}
          </p>
          <ControllerChoice taskFamily={taskFamily} value={controller} onChange={setController} />
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
            <button type="button" className="primary" onClick={start} disabled={starting || !validation.ok || !seedValid || (access.canWrite && !canOperate)}>
              {!access.canWrite ? "Sign in to start" : starting ? "Starting…" : "Start"}
            </button>
          </div>
          {access.canWrite && !canOperate && <p className={styles.refusal} role="status">This seat cannot start a simulation.</p>}
          {startResult && (
            <p className={styles.refusal} role="status" data-testid="start-refusal">
              <span className={styles.modeBadge}>{sceneActionMessage(startResult.mode, startResult.reason, "capture").label}</span>
              {sceneActionMessage(startResult.mode, startResult.reason, "capture").message}
            </p>
          )}
        </section>
      )}
    </div>
  );
}

function formatPromptValue(key: string, value: number): string {
  if (!(key in SCENE_OVERRIDE_RANGES)) return String(value);
  const range = SCENE_OVERRIDE_RANGES[key as SceneOverrideKey];
  const digits = range.unit === "×" ? 2 : 3;
  return `${value.toFixed(digits)} ${range.unit}`;
}
