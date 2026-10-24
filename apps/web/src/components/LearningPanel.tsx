import { useState } from "react";
import { routeHref, shortSha, useClient, useLoad } from "../hooks";
import type { InvestigationWorkspace, LearningExperimentSummary, LearningView } from "../services";
import { useBrowserAccess } from "../services/browserAccess";
import { SyncedReplays } from "./ComparePanel";
import { Icon } from "./Icon";
import { Badge, Panel } from "./Panel";
import { outcomeSentence } from "./learning";
import { human } from "./tone";
import styles from "./LearningPanel.module.css";

export function LearningPanel({ workspace }: { workspace: InvestigationWorkspace }) {
  const id = workspace.investigation.id;
  const client = useClient();
  const access = useBrowserAccess();
  const state = useLoad((c) => c.getLearning(id), [id], id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const retry = async () => {
    if (!access.canWrite) { access.showSignIn(); return; }
    setBusy(true);
    setError(null);
    try {
      const result = await client.retryWithImprovedController(id);
      if (!result.accepted) setError(result.reason);
      else state.reload();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel title="What we learned" state={state} testId="learning-panel">
      {(view) => (
        <div className={styles.wrap}>
          <section className={styles.card} aria-labelledby="lineage-heading">
            <h3 id="lineage-heading">Controller history</h3>
            <ol className={styles.lineage} data-testid="controller-lineage">
              {view.lineage.map((entry, index) => (
                <li className={styles.step} key={`${entry.version}-${entry.controllerSha256}`}>
                  {index > 0 && <span className={styles.arrow} aria-hidden="true">→</span>}
                  <span className={`${styles.chip} ${entry.version === view.current?.version ? styles.current : ""}`}>
                    <span className={styles.stepLabel}>
                      {entry.version === 1 ? "Baseline" : entry.investigationId
                        ? <a className={styles.link} href={routeHref({ investigationId: entry.investigationId, tab: "compare" })}>{entry.label}</a>
                        : entry.label}
                    </span>{" "}
                    <span className={styles.version}>v{entry.version}</span>
                  </span>
                </li>
              ))}
            </ol>
            <p className={styles.thisRun} data-testid="this-run-controller">
              This run used {view.thisRun.version ? `v${view.thisRun.version}` : "an unrecorded controller"}
              {view.thisRun.controllerSha256 ? <> (<code>{shortSha(view.thisRun.controllerSha256)}</code>)</> : ""}.
            </p>
          </section>

          <section className={styles.card} aria-labelledby="retry-heading">
            <h3 id="retry-heading">Try the fix on this exact scene</h3>
            {view.retry.available ? (
              <button type="button" data-testid="retry-improved" disabled={busy} onClick={retry}>
                {!access.canWrite ? "Sign in to retry" : busy ? "Starting retry…" : "Retry with improved controller"}
              </button>
            ) : <p className={styles.muted} data-testid="retry-unavailable">{view.retry.reason}</p>}
            {error && <p role="alert" className={styles.error}>{error}</p>}
            {view.retry.latest && !["completed", "failed"].includes(view.retry.latest.state) && (
              <p role="status">Rerunning the same scene and seed with v{view.retry.latest.controllerVersion} in a fresh sandbox…</p>
            )}
            {view.retry.latest?.before && view.retry.latest.after && (
              <>
                {view.retry.latest.recorded && client.source.kind === "fixture" && (
                  <p><Badge tone="amber">Recorded fixture, not a live rerun</Badge></p>
                )}
                <p className={styles.outcome} data-testid="retry-outcome">
                  {outcomeSentence(view.retry.latest.before, view.retry.latest.after)}
                </p>
                <RetryReplays
                  before={view.retry.latest.before}
                  after={view.retry.latest.after}
                  scene={workspace.investigation.baselineCase.sceneOverrides}
                />
              </>
            )}
          </section>

          <section className={styles.card} aria-labelledby="hints-heading">
            {view.priorHints.length ? (
              <details className={styles.disclosure}>
                <summary id="hints-heading">
                  <span>Hints from earlier runs ({view.priorHints.length})</span>
                  <Icon name="chevronRight" className={styles.chevron} />
                </summary>
                <p className={styles.muted}>Shared with agents as hints, not as facts.</p>
                <ul className={styles.hints}>
                  {view.priorHints.map((hint) => (
                    <li key={`${hint.sourceInvestigationId}-${hint.findingId}`}>
                      <strong>{hint.sourceTitle}</strong>: {hint.summary}
                      {hint.used && <Badge tone="blue">used</Badge>}
                    </li>
                  ))}
                </ul>
              </details>
            ) : (
              <>
                <h3 id="hints-heading">Hints from earlier runs</h3>
                <p className={styles.muted} data-testid="no-hints">No hints yet. Hints appear after a fix is approved.</p>
              </>
            )}
          </section>
        </div>
      )}
    </Panel>
  );
}

function RetryReplays({ before, after, scene }: { before: LearningExperimentSummary; after: LearningExperimentSummary; scene: Record<string, number> }) {
  const replayState = useLoad(async (client) => {
    if (!before.replayArtifactId || !after.replayArtifactId) return null;
    const [original, repaired] = await Promise.all([client.getReplay(before.replayArtifactId), client.getReplay(after.replayArtifactId)]);
    return { original, repaired };
  }, [before.replayArtifactId, after.replayArtifactId]);
  return (
    <Panel title="Before and after replay" headingLevel={3} state={replayState}>
      {(replays) => replays ? <SyncedReplays original={replays.original} candidate={replays.repaired} scene={scene} labels={{ before: "Before", after: "After" }} compact /> : <p className={styles.muted}>Replay artifacts are not available yet.</p>}
    </Panel>
  );
}
