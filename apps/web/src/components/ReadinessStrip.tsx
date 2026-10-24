import { useEffect, useRef, useState } from "react";
import { useLoad } from "../hooks";
import { errorCode, type WebIntegrationReadiness } from "../services";
import { Badge } from "./Panel";
import { human, modeTone } from "./tone";
import styles from "./ReadinessStrip.module.css";

/** Every integration's honest mode, plus where the web app reads data from. */
export function ReadinessStrip({ clientSource }: { clientSource: { kind: string; mode: "live" | "local" | "fixture" | "blocked" | "not_implemented"; detail: string } }) {
  const state = useLoad((c) => c.getReadiness(), []);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const src = clientSource;
  const integrations = state.data ?? [];
  const count = (group: ReadinessGroup) => integrations.filter((r) => readinessGroup(r) === group).length;
  const live = count("live");
  const configured = count("configured");
  const blocked = count("blocked");
  const notBuilt = count("not_implemented");
  const fixtureCount = count("fixture");
  const groups: { id: ReadinessGroup; label: string }[] = [
    { id: "live", label: "Live" },
    { id: "configured", label: "Configured" },
    { id: "blocked", label: "Blocked" },
    { id: "not_implemented", label: "Not built" },
    { id: "fixture", label: "Fixture" },
  ];

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeEscape);
    };
  }, [open]);

  const fixture = src.kind === "fixture";
  return (
    <div className={styles.statusWrap} ref={wrapRef} data-testid="readiness-strip">
      <button
        type="button"
        className={`${styles.statusButton} ${fixture ? styles.fixture : styles.connected}`}
        ref={triggerRef}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls="readiness-detail"
        aria-label={`${fixture ? "Showing recorded fixture data, not live results" : "Web data status"}; ${live} live, ${configured} configured, ${blocked} blocked, ${notBuilt} not built${fixtureCount ? `, ${fixtureCount} fixture` : ""}. Open integration details`}
        onClick={() => setOpen((wasOpen) => !wasOpen)}
      >
        <span className={styles.statusDot} aria-hidden="true" />
        <span>{fixture ? "Fixture data" : `${human(src.mode)} data`}</span>
        <span className={styles.count}>· {live} live</span>
        <span className={`${styles.count} ${styles.configuredFull}`}>· {configured} configured</span>
        <span className={`${styles.count} ${styles.configuredShort}`}>· {configured} set</span>
        <span className={styles.count}>· {blocked} blocked</span>
        {notBuilt > 0 && <span className={styles.count}>· {notBuilt} not built</span>}
        {fixtureCount > 0 && <span className={styles.count}>· {fixtureCount} fixture</span>}
        <svg className={`${styles.chevron} ${open ? styles.chevronOpen : ""}`} viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg>
      </button>
      {open && (
        <section id="readiness-detail" className={styles.popover} role="dialog" aria-label="Integration status">
          <header className={styles.popoverHead}>
            <div>
              <h2>What’s connected</h2>
              <p>{fixture ? "Showing recorded fixture data, not live results." : "Web data status and connected services."}</p>
            </div>
            <button type="button" className={styles.close} aria-label="Close integration status" onClick={() => setOpen(false)}>×</button>
          </header>
          <div className={styles.source} data-testid="readiness-web-data" data-mode={src.mode}>
            <div className={styles.integrationTitle}><strong>Web data</strong><Badge tone={modeTone[src.mode]}>{fixture ? "fixture" : src.mode}</Badge></div>
            <p className={styles.plainDetail}>{fixture ? "Showing recorded investigation examples." : "Project data comes from the connected workspace."}</p>
            <code className={styles.technicalDetail}>{src.detail}</code>
          </div>
          {state.status === "loading" && !state.data && <p className={styles.muted} role="status">Checking integrations…</p>}
          {state.status === "error" && (
            <p className={styles.err} role="alert">
              Readiness unavailable ({errorCode(state.error)}).{" "}
              <button type="button" onClick={state.reload}>Retry</button>
            </p>
          )}
          {groups.map((group) => {
            const entries = integrations.filter((r) => readinessGroup(r) === group.id);
            if (!entries.length) return null;
            return (
              <section key={group.label} className={styles.group} aria-label={group.label}>
                <h3>{group.label}<span>{entries.length}</span></h3>
                <ul>
                  {entries.map((r) => (
                    <li key={r.name} data-testid={`readiness-${r.name}`} data-mode={r.mode} data-probed={r.probed}>
                      <div className={styles.integrationTitle}>
                        <strong>{integrationLabel(r.name)}</strong>
                        <Badge tone={readinessTone(r)}>{group.label === "Not built" ? "Not implemented" : group.label}</Badge>
                      </div>
                      <p className={styles.plainDetail}>{integrationSummary(r)}</p>
                      <code className={styles.technicalDetail}>{r.detail ?? "No additional detail."}</code>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </section>
      )}
    </div>
  );
}

type ReadinessGroup = "live" | "configured" | "blocked" | "not_implemented" | "fixture";

function readinessGroup(r: WebIntegrationReadiness): ReadinessGroup {
  if (r.mode === "blocked") return "blocked";
  if (r.mode === "not_implemented") return "not_implemented";
  if (r.mode === "fixture") return "fixture";
  return r.probed ? "live" : "configured";
}

function readinessTone(r: WebIntegrationReadiness) {
  return readinessGroup(r) === "configured" ? "blue" : modeTone[r.mode];
}

function integrationSummary(r: WebIntegrationReadiness): string {
  const group = readinessGroup(r);
  if (group === "blocked") return r.probed ? "The service could not be reached." : "Required setup is missing.";
  if (group === "configured") return "Credentials are present, but this service has not been tested by the web app.";
  if (group === "not_implemented") return "This connection is not enabled yet.";
  if (group === "fixture") return "Using recorded fixture data.";
  return r.mode === "local" ? "The local service is responding." : "The service is responding.";
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
