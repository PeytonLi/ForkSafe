import { useState } from "react";
import { fmtDuration, shortSha } from "../hooks";
import type { InvestigationWorkspace } from "../services";
import { Badge } from "./Panel";
import { human, stateTone } from "./tone";
import styles from "./EnvironmentGrid.module.css";

const TIMELINE_CAP = 6;

export function EnvironmentGrid({ workspace: w }: { workspace: InvestigationWorkspace }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  if (!w.environments.length)
    return <p className={styles.empty} data-testid="empty-state">No environments have been provisioned for this investigation yet.</p>;
  return (
    <div className={styles.grid} data-testid="environment-grid">
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
        return (
          <article key={e.id} className={styles.tile} data-testid={`env-tile-${e.index + 1}`} aria-labelledby={`env-${e.id}`}>
            <header className={styles.tileHead}>
              <h3 id={`env-${e.id}`}>Env {e.index + 1}</h3>
              <Badge tone={stateTone(e.state)}>{human(e.state)}</Badge>
            </header>
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
            <button type="button" aria-expanded={open} aria-controls={`tl-${e.id}`} onClick={() => { setOpenId(open ? null : e.id); setShowAll(false); }}>
              {open ? "Hide timeline" : "Experiment timeline"}
            </button>
            {open && (
              <div id={`tl-${e.id}`} className={styles.timeline}>
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
            )}
          </article>
        );
      })}
    </div>
  );
}
