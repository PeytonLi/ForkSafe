import { useState } from "react";
import { useClient, useLoad } from "../hooks";
import { errorCode } from "../services";
import { Badge } from "./Panel";
import { human, modeTone } from "./tone";
import styles from "./ReadinessStrip.module.css";

/** Every integration's honest mode, plus where the web app reads data from. */
export function ReadinessStrip() {
  const client = useClient();
  const state = useLoad((c) => c.getReadiness(), []);
  const [open, setOpen] = useState(false);
  const src = client.source;
  return (
    <section className={styles.strip} aria-label="Integration readiness" data-testid="readiness-strip">
      <div className={styles.row}>
        <span className={styles.item} title={src.detail} data-testid="readiness-web-data">
          <span>Web data</span>
          <Badge tone={modeTone[src.mode]}>{src.kind === "fixture" ? "fixture" : src.mode}</Badge>
        </span>
        {state.status === "loading" && !state.data && <span className={styles.muted} role="status">Checking integrations…</span>}
        {state.status === "error" && (
          <span className={styles.err} role="alert">
            Readiness unavailable ({errorCode(state.error)}).{" "}
            <button type="button" onClick={state.reload}>Retry</button>
          </span>
        )}
        {state.data?.map((r) => (
          <span key={r.name} className={styles.item} title={r.detail} data-testid={`readiness-${r.name}`} data-mode={r.mode}>
            <span>{integrationLabel(r.name)}</span>
            <Badge tone={modeTone[r.mode]}>{human(r.mode)}</Badge>
          </span>
        ))}
        {state.data && (
          <button type="button" className={styles.toggle} aria-expanded={open} aria-controls="readiness-detail" onClick={() => setOpen((o) => !o)}>
            {open ? "Hide details" : "Details"}
          </button>
        )}
      </div>
      {open && state.data && (
        <ul id="readiness-detail" className={styles.detail}>
          <li>
            <strong>Web data</strong>: {src.detail}
          </li>
          {state.data.map((r) => (
            <li key={r.name}>
              <strong>{integrationLabel(r.name)}</strong> ({human(r.mode)}): {r.detail ?? "no detail"}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const LABELS: Record<string, string> = {
  convex: "Convex",
  spacetimedb: "SpacetimeDB",
  daytona: "Daytona",
  factory: "Factory",
  elastic: "Elastic",
  elastic_agent_builder: "Elastic Agent Builder",
  atlassian_jira: "Jira",
  atlassian_confluence: "Confluence",
  artifact_store: "Artifact store",
  simulator: "Simulator",
  evaluator: "Evaluator",
};

function integrationLabel(name: string): string {
  return LABELS[name] ?? human(name);
}
