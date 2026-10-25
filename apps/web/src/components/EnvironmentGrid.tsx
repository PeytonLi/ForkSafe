import { useState, type KeyboardEvent } from "react";
import { fmtDuration, shortId, shortSha, useLoad } from "../hooks";
import type { InvestigationWorkspace } from "../services";
import { Badge } from "./Panel";
import { EnvLiveSlot } from "./EnvLiveSlot";
import { environmentExchange } from "./environmentExchange";
import { HypothesisEditor } from "./HypothesisEditor";
import { SegThumb } from "./SegThumb";
import { human, stateTone } from "./tone";
import styles from "./EnvironmentGrid.module.css";

const TIMELINE_CAP = 6;

function FindingText({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const long = text.length > 220;
  return (
    <div className={styles.finding}>
      <p className={!expanded && long ? styles.findingClamp : undefined}>{text}</p>
      {long && (
        <button type="button" className={styles.findingMore} aria-expanded={expanded} onClick={() => setExpanded((v) => !v)}>
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}

export function EnvironmentGrid({ workspace: w }: { workspace: InvestigationWorkspace }) {
  const [timelineOpen, setTimelineOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [selectedId, setSelectedId] = useState(w.environments[0]?.id);
  const findingsState = useLoad((c) => c.listFindings(w.investigation.id), [w.investigation.id], w.investigation.id);
  const findings = findingsState.data ?? [];
  if (!w.environments.length)
    return <p className={styles.empty} data-testid="empty-state">No environments have been provisioned for this investigation yet.</p>;
  const selected = w.environments.find((e) => e.id === selectedId) ?? w.environments[0]!;
  const select = (id: string) => {
    setSelectedId(id);
    setTimelineOpen(false);
    setShowAll(false);
  };
  const onTabKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    const dir = event.key === "ArrowRight" ? 1 : -1;
    const index = w.environments.findIndex((e) => e.id === selected.id);
    const next = w.environments[(index + dir + w.environments.length) % w.environments.length];
    if (!next) return;
    event.preventDefault();
    select(next.id);
    document.getElementById(`envtab-${next.id}`)?.focus();
  };
  const e = selected;
  const sessions = w.sessions.filter((s) => s.environmentId === e.id);
  const exps = w.experiments.filter((x) => x.environmentId === e.id).sort((a, b) => b.startedAtMs - a.startedAtMs);
  const current = exps.find((x) => x.status === "running" || x.status === "queued");
  const finished = !current
    ? exps.find((x): x is typeof x & { replayArtifactId: string } => Boolean(x.replayArtifactId))
    : undefined;
  const cands = w.candidates.filter((c) => c.environmentId === e.id);
  const activeAgents = sessions.filter((s) => s.state === "streaming" || s.state === "idle").length;
  const tokens = sessions.reduce((n, s) => n + s.tokenUsage.inputTokens + s.tokenUsage.outputTokens, 0);
  const unknown = sessions.some((s) => !s.tokenUsage.usageKnown);
  const elapsed = e.startedAtMs ? (e.closedAtMs ?? w.asOfMs) - e.startedAtMs : undefined;
  const shown = showAll ? exps : exps.slice(0, TIMELINE_CAP);
  const maxSessions = e.budgets.maxFactorySessions;
  const usedSessions = Math.min(sessions.length, maxSessions);
  const experimentCount = Math.min(exps.length, e.budgets.maxExperiments);
  const exchange = environmentExchange(e.id, w, findings);
  const shownFindings = exchange.authored.slice(0, 3);
  return (
    <div className={styles.environmentContent} data-testid="environment-grid">
      {w.environments.length > 1 && (
        <div className={`seg ${styles.liveSwitcher}`} role="tablist" aria-label="Live environments" onKeyDown={onTabKeyDown}>
          <SegThumb active={selected.id} />
          {w.environments.map((environment) => (
            <button
              key={environment.id}
              type="button"
              role="tab"
              id={`envtab-${environment.id}`}
              aria-selected={selected.id === environment.id}
              aria-controls={`envpanel-${environment.id}`}
              aria-label={`Env ${environment.index + 1}, ${human(environment.state)}`}
              onClick={() => select(environment.id)}
            >
              <span className={styles.envDot} data-tone={stateTone(environment.state)} aria-hidden="true" />
              Env {environment.index + 1}
            </button>
          ))}
        </div>
      )}
      <article
        key={e.id}
        className={styles.tile}
        data-testid={`env-tile-${e.index + 1}`}
        role="tabpanel"
        id={`envpanel-${e.id}`}
        aria-labelledby={`envtab-${e.id}`}
      >
        <header className={styles.tileHead}>
          <h3 id={`env-${e.id}`}>Env {e.index + 1}</h3>
          <Badge tone={stateTone(e.state)}>{human(e.state)}</Badge>
        </header>
        <div className={styles.tileBody}>
          <div className={styles.stage}>
            <EnvLiveSlot
              experiment={current}
              finishedExperiment={finished}
              investigationId={w.investigation.id}
              scene={w.investigation.baselineCase.sceneOverrides}
              taskFamily={w.investigation.baselineCase.taskFamily}
            />
          </div>
          <div className={styles.details}>
            <dl className={styles.stats}>
              <dt>Agents</dt>
              <dd>{activeAgents} active / {sessions.length}</dd>
              <dt>Current</dt>
              <dd>{current ? current.simCase.caseId : "idle"}</dd>
              {e.sceneVariant && (
                <>
                  <dt>Scene</dt>
                  <dd>
                    {e.index > 0 && e.sceneVariant.description
                      ? e.sceneVariant.description
                      : `seed ${e.sceneVariant.seed} · ${e.sceneVariant.caseId}`}
                  </dd>
                </>
              )}
              <dt>Elapsed</dt>
              <dd>{elapsed !== undefined ? fmtDuration(elapsed) : "not started"}</dd>
              <dt>Experiments</dt>
              <dd>{exps.length} / {e.budgets.maxExperiments}</dd>
              <dt>Model usage</dt>
              <dd>
                {tokens.toLocaleString()} tokens{unknown && <span className={styles.warn} title="At least one session did not report usage; not counted as zero"> + unknown</span>}
              </dd>
              <dt>Candidates</dt>
              <dd>{cands.length} / {e.budgets.maxCandidates}</dd>
              <dt>Sandbox</dt>
              <dd>{e.daytonaSandbox ? `${e.daytonaSandbox.provider}:${e.daytonaSandbox.id}` : "pending"}</dd>
            </dl>
            <div className={styles.budget}>
              <div className={styles.progressLabel}><span>Experiments</span><strong>{exps.length}/{e.budgets.maxExperiments}</strong></div>
              <div className={styles.progressTrack} role="progressbar" aria-label={`Experiment budget for Env ${e.index + 1}`} aria-valuemin={0} aria-valuemax={e.budgets.maxExperiments} aria-valuenow={experimentCount}>
                <span style={{ width: `${e.budgets.maxExperiments ? (experimentCount / e.budgets.maxExperiments) * 100 : 0}%` }} />
              </div>
              <div className={styles.progressLabel}><span>Agent session budget</span><strong>{usedSessions}/{maxSessions}</strong></div>
              <div className={styles.progressTrack} role="progressbar" aria-label={`Agent session budget for Env ${e.index + 1}`} aria-valuemin={0} aria-valuemax={maxSessions} aria-valuenow={usedSessions}>
                <span className={styles.sessionProgress} style={{ width: `${maxSessions ? (usedSessions / maxSessions) * 100 : 0}%` }} />
              </div>
            </div>
            {shownFindings.length > 0 && (
              <section className={styles.exchange} aria-label={`Findings from Env ${e.index + 1}`}>
                <h4>Findings from this environment</h4>
                <ul className={styles.findings}>
                  {shownFindings.map((finding) => {
                    const cites = exchange.citedBy.filter((cite) => cite.findingId === finding.id);
                    return (
                      <li key={finding.id}>
                        <FindingText text={finding.summary} />
                        {cites.length > 0 && (
                          <ul className={styles.cites}>
                            {cites.map((cite) => (
                              <li key={`${cite.candidateId}:${cite.findingId}`}>
                                Env {cite.environmentIndex + 1} used this <code>{shortId(cite.findingId)}</code>
                              </li>
                            ))}
                          </ul>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </section>
            )}
            <HypothesisEditor investigationId={w.investigation.id} environmentId={e.id} initial="" />
            <button type="button" className={styles.timelineToggle} aria-expanded={timelineOpen} aria-controls={`tl-${e.id}`} onClick={() => { setTimelineOpen(!timelineOpen); setShowAll(false); }}>
              <span>Timeline <span aria-hidden="true">{timelineOpen ? "▾" : "▸"}</span></span>
              <span>{exps.length} experiments</span>
            </button>
            <div id={`tl-${e.id}`} className={`${styles.timelineRegion} ${timelineOpen ? styles.timelineOpen : ""}`} aria-hidden={!timelineOpen} inert={!timelineOpen}>
              <div className={styles.timeline}>
                {exps.length === 0 ? (
                  <p className={styles.empty}>No experiments yet.</p>
                ) : (
                  <ol>
                    {shown.map((x) => (
                      <li key={x.id}>
                        <Badge tone={stateTone(x.status)}>{human(x.status)}</Badge>
                        <span className={styles.case}>{x.simCase.caseId}</span>
                        <code title={x.controllerSha256}>{shortSha(x.controllerSha256)}</code>
                        {x.changedFunctions.length > 0 && <span className={styles.fn}>{x.changedFunctions.join(", ")}</span>}
                      </li>
                    ))}
                  </ol>
                )}
                {exps.length > TIMELINE_CAP && (
                  <button type="button" onClick={() => setShowAll((s) => !s)}>
                    {showAll ? "Show fewer" : `Show all ${exps.length}`}
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      </article>
    </div>
  );
}
