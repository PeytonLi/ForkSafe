import { useEffect, useState } from "react";
import { InfluenceGraph } from "./InfluenceGraph";
import { fmtTime, shortId, useLoad } from "../hooks";
import type { InvestigationWorkspace } from "../services";
import { Badge, Panel } from "./Panel";
import { SegThumb } from "./SegThumb";
import { human } from "./tone";
import styles from "./EvidenceFeed.module.css";

const PAGE = 5;

/** Shared findings (SpacetimeDB evidence) with provenance per environment. */
export function EvidenceFeed({ workspace: w, focus }: { workspace: InvestigationWorkspace; focus?: string }) {
  const id = w.investigation.id;
  const state = useLoad((c) => c.listFindings(id), [id], id);
  const [env, setEnv] = useState<string>("all");
  const [limit, setLimit] = useState(PAGE);
  const [view, setView] = useState<"list" | "influence">("list");
  const focusIndex = focus && state.data ? state.data.findIndex((f) => f.id === focus) : -1;
  useEffect(() => {
    if (focusIndex < 0) return;
    setView("list");
    setEnv("all");
    setLimit((l) => Math.max(l, focusIndex + 1));
  }, [focusIndex]);
  useEffect(() => {
    if (focusIndex < 0 || view !== "list") return;
    const el = document.getElementById(`finding-${focus}`);
    if (!el) return;
    const behavior = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
    el.scrollIntoView({ behavior, block: "center" });
    el.focus({ preventScroll: true });
  }, [focus, focusIndex, view, limit, env]);
  const envIndex = new Map(w.environments.map((e) => [e.id, e.index + 1]));
  return (
    <Panel
      title="Shared evidence"
      headingLevel={3}
      state={state}
      isEmpty={(d) => d.length === 0}
      empty="No findings published yet. Environments post findings here as they investigate."
      testId="evidence-feed"
      actions={
        <div className={styles.actions}>
        <div className={`seg ${styles.filters}`} role="group" aria-label="Evidence view">
          <SegThumb active={view} />
          <button type="button" aria-pressed={view === "list"} onClick={() => setView("list")}>List</button>
          <button type="button" aria-pressed={view === "influence"} onClick={() => setView("influence")} data-testid="influence-toggle">How fixes used it</button>
        </div>
        {view === "list" && (w.environments.length <= 5 ? (
          <div className={`seg ${styles.filters}`} role="group" aria-label="Filter evidence by environment">
            <SegThumb active={env} />
            <button type="button" aria-pressed={env === "all"} onClick={() => { setEnv("all"); setLimit(PAGE); }}>All</button>
            {w.environments.map((e) => (
              <button key={e.id} type="button" aria-pressed={env === e.id} onClick={() => { setEnv(e.id); setLimit(PAGE); }}>
                Env {e.index + 1}
              </button>
            ))}
          </div>
        ) : (
          <label className={styles.selectFilter}>
            Found by
            <select value={env} onChange={(e) => { setEnv(e.target.value); setLimit(PAGE); }}>
              <option value="all">All environments</option>
              {w.environments.map((e) => (
                <option key={e.id} value={e.id}>Env {e.index + 1}</option>
              ))}
            </select>
          </label>
        ))}
        </div>
      }
    >
      {(findings) => {
        if (view === "influence") return <InfluenceGraph w={w} findings={findings} />;
        const filtered = env === "all" ? findings : findings.filter((f) => f.environmentId === env);
        return (
          <>
            <ul className={styles.list}>
              {filtered.slice(0, limit).map((f) => (
                <li key={f.id} id={`finding-${f.id}`} tabIndex={-1} className={`${styles.item} ${f.id === focus ? styles.focused : ""}`} data-testid="finding" data-finding-id={f.id}>
                  <div className={styles.badges}>
                    <Badge tone="blue" title={`Environment ${f.environmentId}`}>Env {envIndex.get(f.environmentId) ?? "?"}</Badge>
                    <Badge tone="gray">{human(f.kind)}</Badge>
                  </div>
                  <p className={styles.summary}>{f.summary}</p>
                  <ul className={styles.evidence}>
                    {f.evidence.map((ev, i) => (
                      <li key={i}>
                        {human(ev.kind)}
                        {ev.experimentId && <> · exp {shortId(ev.experimentId)}</>}
                        {Object.keys(ev.locator).length > 0 && <> · <span className={styles.provenance}>{formatLocator(ev.locator)}</span></>}
                        {ev.excerpt && <pre className={styles.excerpt}>{ev.excerpt}</pre>}
                      </li>
                    ))}
                  </ul>
                  <span className={styles.time}>
                    {fmtTime(f.createdAtMs)} · finding {shortId(f.id)}
                  </span>
                  <span className={styles.sourceLine} title="Canonical record store">
                    <span className={styles.sourceDot} aria-hidden="true" />
                    SpacetimeDB · {w.sessions.find((s) => s.id === f.sessionId)?.mode ?? "unknown"}
                  </span>
                </li>
              ))}
            </ul>
            {filtered.length === 0 && <p className={styles.time}>No findings from this environment.</p>}
            {filtered.length > limit && (
              <button type="button" onClick={() => setLimit((l) => l + PAGE)}>
                Show more ({filtered.length - limit} left)
              </button>
            )}
          </>
        );
      }}
    </Panel>
  );
}

function formatLocator(locator: Record<string, unknown>): string {
  const labels: Record<string, string> = {
    frameRange: "frames",
    frameIndex: "frame",
    lineRange: "lines",
    lineStart: "line",
    lineEnd: "line",
    filePath: "file",
  };
  return Object.entries(locator).map(([key, value]) => {
    const label = labels[key] ?? key.replace(/[A-Z]/g, (letter) => ` ${letter.toLowerCase()}`);
    if (Array.isArray(value) && value.length === 2 && value.every((part) => typeof part === "number")) {
      return `${label} ${value[0]}–${value[1]}`;
    }
    if (Array.isArray(value)) return `${label} ${value.map(String).join(", ")}`;
    if (value && typeof value === "object") {
      const parts = Object.entries(value as Record<string, unknown>).map(([nestedKey, nestedValue]) => `${nestedKey.replace(/[A-Z]/g, (letter) => ` ${letter.toLowerCase()}`)} ${String(nestedValue)}`);
      return `${label}: ${parts.join(", ")}`;
    }
    return `${label} ${String(value)}`;
  }).join(" · ");
}
