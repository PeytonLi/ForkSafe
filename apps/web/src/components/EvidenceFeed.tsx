import { useState } from "react";
import { fmtTime, shortId, useLoad } from "../hooks";
import type { InvestigationWorkspace } from "../services";
import { Badge, Panel } from "./Panel";
import { human } from "./tone";
import styles from "./EvidenceFeed.module.css";

const PAGE = 5;

/** Shared findings (SpacetimeDB evidence) with provenance per environment. */
export function EvidenceFeed({ workspace: w }: { workspace: InvestigationWorkspace }) {
  const id = w.investigation.id;
  const state = useLoad((c) => c.listFindings(id), [id], id);
  const [env, setEnv] = useState<string>("all");
  const [limit, setLimit] = useState(PAGE);
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
        <label className={styles.filter}>
          Found by
          <select value={env} onChange={(e) => { setEnv(e.target.value); setLimit(PAGE); }}>
            <option value="all">All environments</option>
            {w.environments.map((e) => (
              <option key={e.id} value={e.id}>Env {e.index + 1}</option>
            ))}
          </select>
        </label>
      }
    >
      {(findings) => {
        const filtered = env === "all" ? findings : findings.filter((f) => f.environmentId === env);
        return (
          <>
            <ul className={styles.list}>
              {filtered.slice(0, limit).map((f) => (
                <li key={f.id} className={styles.item} data-testid="finding">
                  <div className={styles.badges}>
                    <Badge tone="blue" title={`Environment ${f.environmentId}`}>Env {envIndex.get(f.environmentId) ?? "?"}</Badge>
                    <Badge tone="gray">{human(f.kind)}</Badge>
                    <Badge tone="gray" title="Canonical record store">SpacetimeDB · {w.sessions.find((s) => s.id === f.sessionId)?.mode ?? "unknown"}</Badge>
                  </div>
                  <p className={styles.summary}>{f.summary}</p>
                  <ul className={styles.evidence}>
                    {f.evidence.map((ev, i) => (
                      <li key={i}>
                        {human(ev.kind)}
                        {ev.experimentId && <> · exp {shortId(ev.experimentId)}</>}
                        {Object.keys(ev.locator).length > 0 && <> · <code>{JSON.stringify(ev.locator)}</code></>}
                        {ev.excerpt && <pre className={styles.excerpt}>{ev.excerpt}</pre>}
                      </li>
                    ))}
                  </ul>
                  <span className={styles.time}>
                    {fmtTime(f.createdAtMs)} · finding {shortId(f.id)}
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
