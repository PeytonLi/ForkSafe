import { useState } from "react";
import { fmtAgo, fmtTime, useClient, useLoad, useNarrow, type AsyncState } from "../hooks";
import { errorCode, type PipelineHealth, type WebIntegrationReadiness } from "../services";
import { Badge } from "./Panel";
import { integrationLabel, readinessGroup, readinessTone, type ReadinessGroup } from "./ReadinessStrip";
import { modeTone } from "./tone";
import styles from "./HealthPage.module.css";

const GROUP_LABEL: Record<ReadinessGroup, string> = {
  live: "Live",
  configured: "Configured",
  blocked: "Blocked",
  not_implemented: "Not implemented",
  fixture: "Fixture",
};

/** What each service does for people, in plain words. */
const PURPOSE: Record<string, string> = {
  convex: "Keeps investigations, jobs and reviews in order.",
  spacetimedb: "Lets agents share findings with each other as they work.",
  daytona: "Starts the sandboxes where experiments run.",
  factory: "Runs the agents that investigate and propose fixes.",
  simulator: "Records new baseline failures in physics.",
  evaluator: "Checks every fix against the public and withheld test cases.",
  artifact_store: "Stores replays, logs and controller files.",
  elastic: "Powers evidence search.",
  elastic_agent_builder: "Answers “Why did this fail?” questions.",
  atlassian_jira: "Keeps the matching Jira issue up to date.",
  atlassian_confluence: "Links evidence packs from Confluence.",
};

/** What stops working when the service is down. */
const IMPACT: Record<string, string> = {
  convex: "Investigations can't be saved, started or reviewed.",
  spacetimedb: "Agents can't share findings, so environments work alone.",
  daytona: "New environments can't start, so experiments won't run.",
  factory: "Agents can't investigate or propose fixes.",
  simulator: "New baseline failures can't be recorded.",
  evaluator: "Fixes can't be checked, so nothing can be reviewed.",
  artifact_store: "Replays and logs can't be saved or opened.",
  elastic: "Evidence search is unavailable.",
  elastic_agent_builder: "“Why did this fail?” can't answer questions.",
  atlassian_jira: "Jira issues won't be updated.",
  atlassian_confluence: "Confluence pages won't get evidence links.",
};

export function healthNote(r: WebIntegrationReadiness): string {
  const purpose = PURPOSE[r.name] ?? "";
  const impact = IMPACT[r.name] ?? "Some features may not work.";
  switch (readinessGroup(r)) {
    case "live": return purpose;
    case "configured": return `${purpose} It's set up, but this app hasn't tested the connection yet.`;
    case "blocked": return `${impact} ${r.probed ? "The service didn't respond." : "Some setup is missing."}`;
    case "not_implemented": return `Not switched on yet. ${impact}`;
    case "fixture": return `Using recorded examples instead of the real service. ${impact}`;
  }
}

type Filter = "all" | "attention" | "working";
const needsAttention = (r: WebIntegrationReadiness) => ["blocked", "not_implemented", "fixture"].includes(readinessGroup(r));

export function HealthPage() {
  const client = useClient();
  const readiness = useLoad((c) => c.getReadiness(), []);
  const pipeline = useLoad((c) => c.getPipelineHealth(), []);
  const [filter, setFilter] = useState<Filter>("all");
  const items = readiness.data ?? [];
  const attention = items.filter(needsAttention);
  const working = items.filter((r) => !needsAttention(r));
  const shown = filter === "attention" ? attention : filter === "working" ? working : items;
  const filters: [Filter, string, number][] = [["all", "All", items.length], ["attention", "Needs attention", attention.length], ["working", "Working", working.length]];

  return (
    <section className={styles.page} aria-labelledby="health-h" data-testid="health-page">
      <header className={styles.head}>
        <div className={styles.headContent}>
          <div className={styles.titleRow}>
            <h1 id="health-h">How everything is running</h1>
            <button
              type="button"
              className={styles.refresh}
              onClick={() => { readiness.reload(); pipeline.reload(); }}
              disabled={readiness.status === "loading"}
              data-testid="health-refresh"
            >
              {readiness.status === "loading" ? "Checking…" : "Check again"}
            </button>
          </div>
          <p>{client.source.kind === "fixture" ? "This app is showing recorded examples, so nothing here is a live result." : "Each service ForkSafe depends on, and what it means for your investigations."}</p>
        </div>
      </header>

      <div className={styles.layout}>
        <div className={styles.services}>
          <div className={styles.filters} role="group" aria-label="Show services">
            {filters.map(([key, label, n]) => (
              <button key={key} type="button" aria-pressed={filter === key} className={filter === key ? styles.filterActive : styles.filter} onClick={() => setFilter(key)}>
                {label} <span className={styles.count}>{n}</span>
              </button>
            ))}
          </div>
          {readiness.status === "error" && !readiness.data ? (
            <p role="alert" className={styles.err}>We couldn't check the services ({errorCode(readiness.error)}). <button type="button" onClick={readiness.reload}>Try again</button></p>
          ) : readiness.status === "loading" && !readiness.data ? (
            <p role="status" className={styles.muted}>Checking services…</p>
          ) : shown.length === 0 ? (
            <p className={styles.muted} data-testid="health-empty">{filter === "attention" ? "Nothing needs attention right now." : "No services to show."}</p>
          ) : (
            <ul className={styles.grid} aria-label="Services">
              {shown.map((r) => <ServiceCard key={r.name} r={r} />)}
            </ul>
          )}
        </div>
        <PipelineCard state={pipeline} />
      </div>
    </section>
  );
}

function ServiceCard({ r }: { r: WebIntegrationReadiness }) {
  const group = readinessGroup(r);
  const narrow = useNarrow();
  const [open, setOpen] = useState(false);
  const head = (
    <>
      <h2>{integrationLabel(r.name)}</h2>
      <Badge tone={readinessTone(r)}>{GROUP_LABEL[group]}</Badge>
    </>
  );
  if (narrow && !open) {
    return (
      <li className={styles.card} data-testid={`health-${r.name}`} data-group={group} data-expanded="false">
        <button type="button" className={styles.cardToggle} aria-expanded={false} onClick={() => setOpen(true)}>{head}</button>
      </li>
    );
  }
  return (
    <li className={styles.card} data-testid={`health-${r.name}`} data-group={group} data-expanded={narrow ? "true" : undefined}>
      {narrow ? <button type="button" className={styles.cardToggle} aria-expanded onClick={() => setOpen(false)}>{head}</button> : <div className={styles.cardHead}>{head}</div>}
      <p className={styles.note}>{healthNote(r)}</p>
      <div className={styles.cardFoot}>
        <time dateTime={new Date(r.checkedAtMs).toISOString()} title={fmtTime(r.checkedAtMs)}>Checked {fmtAgo(r.checkedAtMs)}</time>
        {r.detail && (
          <details className={styles.details}>
            <summary>Details</summary>
            <code>{r.detail}</code>
          </details>
        )}
      </div>
    </li>
  );
}

function PipelineCard({ state }: { state: AsyncState<PipelineHealth> }) {
  const p = state.data;
  const code = state.status === "error" ? errorCode(state.error) : null;
  return (
    <aside className={styles.pipeline} aria-labelledby="pipeline-h" data-testid="pipeline-card">
      <div className={styles.cardHead}>
        <h2 id="pipeline-h">Pipeline</h2>
        {p && <Badge tone={modeTone[p.mode]}>{p.mode === "fixture" ? "Fixture" : p.mode === "live" ? "Live" : p.mode}</Badge>}
      </div>
      {code && !p ? (
        <p className={styles.note} role="status" data-testid="pipeline-unavailable">
          {code === "permission_denied" ? "Sign in to see pipeline numbers." : code === "not_found" ? "Pipeline numbers aren't published on this deployment yet." : "Pipeline numbers are unavailable right now."}
        </p>
      ) : !p ? (
        <p className={styles.muted} role="status">Loading pipeline…</p>
      ) : (
        <>
          <dl className={styles.stats}>
            <div><dt>Sandboxes in use</dt><dd data-testid="pipeline-sandboxes">{p.activeSandboxes} <span>of {p.sandboxCap}</span></dd></div>
            <div><dt>Runners connected</dt><dd data-testid="pipeline-runners">{p.runners}</dd></div>
            <div><dt>Waiting to sync</dt><dd data-testid="pipeline-backlog">{p.outboxBacklog}</dd></div>
            <div className={p.outboxDead > 0 ? styles.statBad : undefined}><dt>Failed to sync</dt><dd data-testid="pipeline-dead">{p.outboxDead}</dd></div>
          </dl>
          <p className={styles.note}>
            {p.outboxDead > 0 ? `${p.outboxDead} update${p.outboxDead === 1 ? "" : "s"} to Elastic or Jira gave up after retrying and need${p.outboxDead === 1 ? "s" : ""} an operator.` : p.outboxBacklog > 0 ? "Some updates to Elastic or Jira are still on their way." : "All updates to Elastic and Jira have been delivered."}
          </p>
          <time className={styles.muted} dateTime={new Date(p.checkedAtMs).toISOString()} title={fmtTime(p.checkedAtMs)}>Checked {fmtAgo(p.checkedAtMs)}</time>
        </>
      )}
    </aside>
  );
}
