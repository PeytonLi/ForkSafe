import { useState } from "react";
import { fmtDuration, shortSha, useCompact } from "../hooks";
import type { InvestigationWorkspace } from "../services";
import { Badge } from "./Panel";
import { EnvLiveSlot } from "./EnvLiveSlot";
import { SegThumb } from "./SegThumb";
import { human, stateTone } from "./tone";
import styles from "./EnvironmentGrid.module.css";

const TIMELINE_CAP = 6;

export function EnvironmentGrid({ workspace: w }: { workspace: InvestigationWorkspace }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [selectedLiveEnv, setSelectedLiveEnv] = useState(w.environments[0]?.id);
  const compact = useCompact();
  if (!w.environments.length)
    return <p className={styles.empty} data-testid="empty-state">No environments have been provisioned for this investigation yet.</p>;
  const selected = w.environments.find((e) => e.id === selectedLiveEnv) ?? w.environments[0]!;
  return (
    <div className={styles.environmentContent} data-testid="environment-grid">
      {compact && (
        <div className={`seg ${styles.liveSwitcher}`} role="tablist" aria-label="Live environments">
          <SegThumb active={selected.id} />
          {w.environments.map((environment) => (
            <button
              key={environment.id}
              type="button"
              role="tab"
              aria-selected={selected.id === environment.id}
              onClick={() => setSelectedLiveEnv(environment.id)}
            >
              Env {environment.index + 1}
            </button>
          ))}
        </div>
      )}
      <div className={styles.grid}>
      {w.environments.map((e) => {
        const sessions = w.sessions.filter((s) => s.environmentId === e.id);
        const exps = w.experiments.filter((x) => x.environmentId === e.id).sort((a, b) => b.startedAtMs - a.startedAtMs);
        const current = exps.find((x) => x.status === "running" || x.status === "queued");
        const cands = w.candidates.filter((c) => c.environmentId === e.id);
        const activeAgents = sessions.filter((s) => s.state === "streaming" || s.state === "idle").length;
        const tokens = sessions.reduce((n, s) => n + s.tokenUsage.inputTokens + s.tokenUsage.outputTokens, 0);
        const unknown = sessions.some((s) => !s.tokenUsage.usageKnown);
        const elapsed = e.startedAtMs ? (e.closedAtMs ?? w.asOfMs) - e.startedAtMs : undefined;
        const open = openId === e.id;
        const shown = showAll && open ? exps : exps.slice(0, TIMELINE_CAP);
        const maxSessions = e.budgets.maxFactorySessions;
        const usedSessions = Math.min(sessions.length, maxSessions);
        const experimentCount = Math.min(exps.length, e.budgets.maxExperiments);
        return (
          <article key={e.id} className={styles.tile} data-testid={`env-tile-${e.index + 1}`} aria-labelledby={`env-${e.id}`}>
            <header className={styles.tileHead}>
              <h3 id={`env-${e.id}`}>Env {e.index + 1}</h3>
              <Badge tone={stateTone(e.state)}>{human(e.state)}</Badge>
            </header>
            <EnvLiveSlot
              compact={compact}
              selected={selected.id === e.id}
              experiment={current}
              scene={w.investigation.baselineCase.sceneOverrides}
              onSelectLive={(button) => {
                setSelectedLiveEnv(e.id);
                button.closest("article")?.scrollIntoView({
                  behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
                  block: "nearest",
                });
              }}
            />
            <dl className={styles.stats}>
              <dt>Agents</dt>
              <dd>{activeAgents} active / {sessions.length}</dd>
              <dt>Current</dt>
              <dd>{current ? current.simCase.caseId : "idle"}</dd>
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
            <button type="button" className={styles.timelineToggle} aria-expanded={open} aria-controls={`tl-${e.id}`} onClick={() => { setOpenId(open ? null : e.id); setShowAll(false); }}>
              <span>{open ? "Timeline" : "Timeline"} <span aria-hidden="true">{open ? "▾" : "▸"}</span></span>
              <span>{exps.length} experiments</span>
            </button>
            <div id={`tl-${e.id}`} className={`${styles.timelineRegion} ${open ? styles.timelineOpen : ""}`} aria-hidden={!open} inert={!open}>
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
          </article>
        );
      })}
      </div>
    </div>
  );
}
