import { useEffect, useRef, useState } from "react";
import type { IntegrationReadiness } from "@forksafe/contracts";
import { useLoad } from "../hooks";
import { errorCode } from "../services";
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
  const available = integrations.filter((r) => r.mode === "live" || r.mode === "local").length;
  const blocked = integrations.filter((r) => r.mode === "blocked").length;
  const notBuilt = integrations.filter((r) => r.mode === "not_implemented").length;
  const groups: { label: string; modes: IntegrationReadiness["mode"][] }[] = [
    { label: "Live", modes: ["live", "local"] },
    { label: "Blocked", modes: ["blocked"] },
    { label: "Not implemented", modes: ["not_implemented"] },
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
        aria-label={`${fixture ? "Showing recorded fixture data, not live results" : "Web data status"}; ${available} live, ${blocked} blocked, ${notBuilt} not built. Open integration details`}
        onClick={() => setOpen((wasOpen) => !wasOpen)}
      >
        <span className={styles.statusDot} aria-hidden="true" />
        <span>{fixture ? "Fixture data" : `${human(src.mode)} data`}</span>
        <span className={styles.count}>· {available} live</span>
        <span className={styles.count}>· {blocked} blocked</span>
        {notBuilt > 0 && <span className={styles.count}>· {notBuilt} not built</span>}
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
            <p>{src.detail}</p>
          </div>
          {state.status === "loading" && !state.data && <p className={styles.muted} role="status">Checking integrations…</p>}
          {state.status === "error" && (
            <p className={styles.err} role="alert">
              Readiness unavailable ({errorCode(state.error)}).{" "}
              <button type="button" onClick={state.reload}>Retry</button>
            </p>
          )}
          {groups.map((group) => {
            const entries = integrations.filter((r) => group.modes.includes(r.mode));
            if (!entries.length) return null;
            return (
              <section key={group.label} className={styles.group} aria-label={group.label}>
                <h3>{group.label}<span>{entries.length}</span></h3>
                <ul>
                  {entries.map((r) => (
                    <li key={r.name} data-testid={`readiness-${r.name}`} data-mode={r.mode}>
                      <div className={styles.integrationTitle}>
                        <strong>{integrationLabel(r.name)}</strong>
                        <Badge tone={modeTone[r.mode]}>{human(r.mode)}</Badge>
                      </div>
                      <p>{r.detail ?? "No additional detail."}</p>
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
