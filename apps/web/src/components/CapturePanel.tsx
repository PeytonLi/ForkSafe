import { useMemo, useState, type FormEvent } from "react";
import { SIM } from "@forksafe/contracts";
import { shortSha, useClient, useLoad } from "../hooks";
import type { CaptureOutcome, InvestigationWorkspace } from "../services";
import { ReplayControls } from "../viewer/ReplayControls";
import { ReplayViewer } from "../viewer/ReplayViewer";
import { replayDuration } from "../viewer/transform";
import { useReplayClock } from "../viewer/useReplayClock";
import { Badge, Panel } from "./Panel";
import { human, stateTone } from "./tone";
import styles from "./CapturePanel.module.css";

export function CapturePanel({ workspace }: { workspace: InvestigationWorkspace }) {
  const inv = workspace.investigation;
  const baseline = workspace.experiments.find((e) => e.id === inv.baselineExperimentId);
  const replayId = baseline?.replayArtifactId;
  const replay = useLoad((c) => (replayId ? c.getReplay(replayId) : Promise.resolve(null)), [replayId]);

  return (
    <div className={styles.grid}>
      <Panel
        title="Baseline replay"
        headingLevel={3}
        state={replay}
        isEmpty={(r) => r === null}
        empty="This baseline has no recorded replay artifact yet."
        testId="baseline-replay"
      >
        {(r) => <BaselineReplay replay={r!} scene={inv.baselineCase.sceneOverrides} />}
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
                <dd>{baseline.failureKinds.map(human).join(", ")}</dd>
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
        </section>
        <SceneEditor scene={inv.baselineCase.sceneOverrides} seed={inv.baselineCase.seed} envs={inv.requestedEnvironments} />
      </div>
    </div>
  );
}

function BaselineReplay({ replay, scene }: { replay: NonNullable<Awaited<ReturnType<ReturnType<typeof useClient>["getReplay"]>>>; scene: Record<string, number> }) {
  const clock = useReplayClock(replayDuration(replay.frames));
  const markers = replay.firstFailure ? [{ tSec: replay.firstFailure.tSec, label: human(replay.firstFailure.kind) }] : [];
  return (
    <div>
      <ReplayViewer replay={replay} t={clock.t} label="Original controller" scene={scene} />
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

const FIELDS: [string, string, number][] = [
  ["divider_x", "Divider x (m)", 0.005],
  ["divider_y", "Divider y (m)", 0.005],
  ["divider_height", "Divider height (m)", 0.005],
  ["cube_start_x", "Cube start x (m)", 0.005],
  ["cube_start_y", "Cube start y (m)", 0.005],
  ["target_x", "Target x (m)", 0.005],
  ["target_y", "Target y (m)", 0.005],
];

/** Named parameters change between runs only; recording goes through the client. */
function SceneEditor({ scene, seed, envs }: { scene: Record<string, number>; seed: number; envs: number }) {
  const client = useClient();
  const [draft, setDraft] = useState<Record<string, number>>(() => ({ ...scene }));
  const [draftSeed, setDraftSeed] = useState(seed);
  const [envCount, setEnvCount] = useState(envs);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<CaptureOutcome | { error: string } | null>(null);
  const changed = useMemo(() => FIELDS.filter(([k]) => draft[k] !== scene[k]).map(([k]) => k), [draft, scene]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setOutcome(null);
    try {
      setOutcome(
        await client.requestCapture({ title: `Capture seed ${draftSeed}`, seed: draftSeed, sceneOverrides: draft, requestedEnvironments: envCount }),
      );
    } catch (err) {
      setOutcome({ error: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className={styles.card} onSubmit={submit} aria-labelledby="editor-h" data-testid="scene-editor">
      <h3 id="editor-h">Scenario editor</h3>
      <p className={styles.note}>
        Edit named parameters, then record a new baseline run. Timeout {SIM.timeoutSec} s, completion radius {SIM.completionRadiusM * 1000} mm.
      </p>
      <div className={styles.fields}>
        {FIELDS.map(([k, label, step]) => (
          <label key={k} className={styles.field}>
            <span>{label}</span>
            <input
              type="number"
              step={step}
              value={draft[k] ?? ""}
              onChange={(e) => setDraft((d) => ({ ...d, [k]: Number(e.target.value) }))}
            />
          </label>
        ))}
        <label className={styles.field}>
          <span>Seed</span>
          <input type="number" min={0} step={1} value={draftSeed} onChange={(e) => setDraftSeed(Math.max(0, Math.round(Number(e.target.value))))} />
        </label>
        <label className={styles.field}>
          <span>Environments (1–10)</span>
          <input type="number" min={1} max={10} value={envCount} onChange={(e) => setEnvCount(Math.min(10, Math.max(1, Math.round(Number(e.target.value)))))} />
        </label>
      </div>
      <div className={styles.actions}>
        <button type="submit" className="primary" disabled={busy}>
          {busy ? "Requesting…" : "Record baseline run"}
        </button>
        {changed.length > 0 && <span className={styles.note}>{changed.length} parameter(s) changed</span>}
      </div>
      {outcome && (
        <p role="status" className={"error" in outcome || !outcome.accepted ? styles.warn : styles.ok} data-testid="capture-outcome">
          {"error" in outcome
            ? `Request failed: ${outcome.error}`
            : outcome.accepted
              ? `Capture accepted as investigation ${outcome.investigationId.slice(0, 8)}.`
              : `Not recorded (${human(outcome.mode)}): ${outcome.reason}`}
        </p>
      )}
    </form>
  );
}
