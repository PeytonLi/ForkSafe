import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { DEFAULT_TASK_FAMILY, SIM, TASK_FAMILY_SPECS, validateSceneOverrides, type TaskFamily } from "@forksafe/contracts";
import { shortSha, useClient, useHashRoute, useLoad } from "../hooks";
import type { CaptureOutcome, InvestigationWorkspace } from "../services";
import { ReplayControls } from "../viewer/ReplayControls";
import { ReplayViewer } from "../viewer/ReplayViewer";
import { replayDuration } from "../viewer/transform";
import { useReplayClock } from "../viewer/useReplayClock";
import { Badge, Panel } from "./Panel";
import { human, stateTone, words } from "./tone";
import styles from "./CapturePanel.module.css";
import { useBrowserAccess } from "../services/browserAccess";
import { changedOverrides, defaultOverride } from "../scene";
import { SceneFields } from "./SceneFields";
import { CaptureProgress } from "./CaptureProgress";

export function CapturePanel({ workspace }: { workspace: InvestigationWorkspace }) {
  const inv = workspace.investigation;
  const baseline = workspace.experiments.find((e) => e.id === inv.baselineExperimentId);
  const replayId = baseline?.replayArtifactId;
  const replay = useLoad((c) => (replayId ? c.getReplay(replayId) : Promise.resolve(null)), [replayId]);
  const [editorOpen, setEditorOpen] = useState(false);

  return (
    <>
    <CaptureProgress workspace={workspace} />
    <div className={styles.grid}>
      <Panel
        title="Baseline replay"
        headingLevel={3}
        state={replay}
        isEmpty={(r) => r === null}
        empty="This baseline has no recorded replay artifact yet."
        testId="baseline-replay"
      >
        {(r) => <BaselineReplay replay={r!} scene={inv.baselineCase.sceneOverrides} taskFamily={inv.baselineCase.taskFamily} />}
      </Panel>
      <div className={styles.side}>
        <section className={styles.card} aria-labelledby="baseline-h">
          <h3 id="baseline-h">Captured failure</h3>
          <dl className={styles.dl}>
            <dt>Case</dt>
            <dd>{inv.baselineCase.caseId}</dd>
            <dt>Seed</dt>
            <dd data-testid="baseline-seed">{inv.baselineCase.seed}</dd>
            <dt>Result</dt>
            <dd>{baseline ? <Badge tone={stateTone(baseline.status)}>{human(baseline.status)}</Badge> : "missing"}</dd>
            {baseline?.failureKinds.length ? (
              <>
                <dt>Failure</dt>
                <dd>{baseline.failureKinds.map(words).join(", ")}</dd>
              </>
            ) : null}
            <dt>Controller</dt>
            <dd><code title={baseline?.controllerSha256}>{baseline ? shortSha(baseline.controllerSha256) : "—"}</code></dd>
            <dt>Scene assets</dt>
            <dd><code title={baseline?.assetsSha256}>{baseline ? shortSha(baseline.assetsSha256) : "—"}</code></dd>
            <dt>Engine</dt>
            <dd>{baseline?.engineVersion ?? "—"}</dd>
          </dl>
          {inv.baselineCase.description && <p className={styles.note}>{inv.baselineCase.description}</p>}
          <footer className={styles.cardFooter}>
            <SceneEditor
              scene={inv.baselineCase.sceneOverrides}
              taskFamily={inv.baselineCase.taskFamily}
              seed={inv.baselineCase.seed}
              envs={inv.requestedEnvironments}
              open={editorOpen}
              onOpen={() => setEditorOpen(true)}
              onClose={() => setEditorOpen(false)}
            />
          </footer>
        </section>
      </div>
    </div>
    </>
  );
}

function BaselineReplay({ replay, scene, taskFamily }: { replay: NonNullable<Awaited<ReturnType<ReturnType<typeof useClient>["getReplay"]>>>; scene: Record<string, number>; taskFamily?: string }) {
  const clock = useReplayClock(replayDuration(replay.frames));
  const markers = replay.firstFailure ? [{ tSec: replay.firstFailure.tSec, label: human(replay.firstFailure.kind) }] : [];
  return (
    <div>
      <ReplayViewer replay={replay} t={clock.t} label="Original controller" scene={scene} taskFamily={taskFamily as TaskFamily | undefined} />
      <ReplayControls clock={clock} markers={markers} label="Baseline replay" />
      {replay.firstFailure && (
        <p className={styles.failure}>
          <span>First failure at <strong>{replay.firstFailure.tSec.toFixed(1)} s</strong>: {replay.firstFailure.detail}</span>{" "}
          <button type="button" onClick={() => clock.setT(replay.firstFailure!.tSec)}>Jump to failure</button>
        </p>
      )}
    </div>
  );
}

/** Named parameters change between runs only; recording goes through the client. */
function SceneEditor({ scene, taskFamily: taskFamilyInput, seed, envs, open, onOpen, onClose }: { scene: Record<string, number>; taskFamily?: string; seed: number; envs: number; open: boolean; onOpen: () => void; onClose: () => void }) {
  const client = useClient();
  const access = useBrowserAccess();
  const [taskFamily] = useState<TaskFamily>(() => taskFamilyInput === "push_through_gap" ? "push_through_gap" : DEFAULT_TASK_FAMILY);
  const legacy = Object.keys(scene).some((key) => ["divider_x", "divider_y", "divider_height", "divider_length", "cube_start_x", "cube_start_y", "target_x", "target_y"].includes(key));
  const [draft, setDraft] = useState<Record<string, number>>(() => defaultOverride(taskFamily));
  const [draftSeed, setDraftSeed] = useState(seed);
  const [envCount, setEnvCount] = useState(Math.min(4, Math.max(1, envs)));
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<CaptureOutcome | { error: string } | null>(null);
  const [, go] = useHashRoute();
  const validation = validateSceneOverrides(taskFamily, draft);
  const seedValid = Number.isInteger(draftSeed) && draftSeed >= 0;
  const sheetRef = useRef<HTMLElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const changed = useMemo(() => Object.keys(changedOverrides(taskFamily, draft)), [draft, taskFamily]);

  useEffect(() => {
    if (!open) return;
    openerRef.current = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    sheetRef.current?.querySelector<HTMLInputElement>("input")?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      openerRef.current?.focus();
    };
  }, [open]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!access.canWrite) { access.showSignIn(); return; }
    if (!validation.ok || !seedValid) return;
    setBusy(true);
    setOutcome(null);
    try {
      const result = await client.requestCapture({
        title: `Capture seed ${draftSeed}`,
        seed: draftSeed,
        sceneOverrides: changedOverrides(taskFamily, draft),
        requestedEnvironments: envCount,
        taskFamily,
      });
      setOutcome(result);
      if (result.accepted) go({ investigationId: result.investigationId, tab: "capture" });
    } catch (err) {
      setOutcome({ error: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const onSheetKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== "Tab" || !sheetRef.current) return;
    const focusable = Array.from(sheetRef.current.querySelectorAll<HTMLElement>("button, input, textarea, select, [tabindex]:not([tabindex='-1'])"));
    if (!focusable.length) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  if (!open) {
    return <button type="button" className={styles.editScenario} onClick={onOpen} data-testid="open-scenario">Edit scenario</button>;
  }

  return (
    <div className={styles.sheetBackdrop} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <section className={styles.sheet} role="dialog" aria-modal="true" aria-labelledby="editor-h" ref={sheetRef} onKeyDown={onSheetKeyDown} data-testid="scenario-sheet">
        <header className={styles.sheetHead}>
          <div>
            <span className={styles.sheetEyebrow}>Baseline settings</span>
            <h2 id="editor-h">Edit scenario</h2>
          </div>
          <button type="button" className={styles.closeSheet} onClick={onClose} aria-label="Close scenario editor">×</button>
        </header>
        <p className={styles.note}>{TASK_FAMILY_SPECS[taskFamily].description} Timeout {SIM.timeoutSec} s; completion radius {SIM.completionRadiusM * 1000} mm.</p>
        <form onSubmit={submit} data-testid="scene-editor">
          <SceneFields
            taskFamily={taskFamily}
            values={draft}
            onChange={(key, value) => setDraft((current) => ({ ...current, [key]: value }))}
            seed={draftSeed}
            onSeedChange={setDraftSeed}
            environments={envCount}
            onEnvironmentsChange={setEnvCount}
            onReset={() => {
              setDraft(defaultOverride(taskFamily));
              setDraftSeed(0);
              setEnvCount(1);
              setOutcome(null);
            }}
            legacy={legacy}
          />
          <ReplayViewer taskFamily={taskFamily} scene={draft} />
          {!validation.ok && <p className={styles.warn} role="alert">{validation.reason}</p>}
          {!seedValid && <p className={styles.warn} role="alert">Seed must be a non-negative integer.</p>}
          <div className={styles.actions}>
            <button type={access.canWrite ? "submit" : "button"} onClick={access.canWrite ? undefined : access.showSignIn} className="primary" disabled={busy || !validation.ok || !seedValid}>
              {!access.canWrite ? "Sign in to capture" : busy ? "Requesting…" : "Record baseline run"}
            </button>
            <button type="button" onClick={onClose}>Cancel</button>
            {changed.length > 0 && <span className={styles.note}>{changed.length} parameter(s) changed</span>}
          </div>
        </form>
        {outcome && (
          <p role="status" className={"error" in outcome || !outcome.accepted ? styles.warn : styles.ok} data-testid="capture-outcome">
            {"error" in outcome
              ? `Request failed: ${outcome.error}`
              : outcome.accepted
                ? `Capture accepted as investigation ${outcome.investigationId.slice(0, 8)}.`
                : `Not recorded (${human(outcome.mode)}): ${outcome.reason}`}
          </p>
        )}
      </section>
    </div>
  );
}
