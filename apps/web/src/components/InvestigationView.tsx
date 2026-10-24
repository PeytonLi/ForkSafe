import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { fmtTime, shortId, useClient, useLoad } from "../hooks";
import { errorCode } from "../services";
import { CapturePanel } from "./CapturePanel";
import { ComparePanel } from "./ComparePanel";
import { EnvironmentGrid } from "./EnvironmentGrid";
import { EvidenceFeed } from "./EvidenceFeed";
import { Badge, Panel } from "./Panel";
import { human, stateTone } from "./tone";
import styles from "./InvestigationView.module.css";

const TABS = [
  ["capture", "Baseline capture"],
  ["environments", "Environments"],
  ["evidence", "Evidence"],
  ["compare", "Compare & review"],
] as const;
const RUNNING = ["capturing", "admitted", "searching", "evaluating"];

export function InvestigationView({ id, tab, onTab }: { id: string; tab: string; onTab: (t: string) => void }) {
  const client = useClient();
  const ws = useLoad((c) => c.getWorkspace(id), [id], id);
  const [cancelErr, setCancelErr] = useState<string | null>(null);
  const [cancelBusy, setCancelBusy] = useState(false);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const active = TABS.some(([k]) => k === tab) ? tab : "capture";

  useEffect(() => {
    if (window.matchMedia("(max-width: 560px)").matches) return;
    const behavior = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
    tabRefs.current[TABS.findIndex(([key]) => key === active)]?.scrollIntoView({ behavior, block: "nearest", inline: "start" });
  }, [active]);

  const onTabKey = (e: KeyboardEvent, i: number) => {
    const n = e.key === "ArrowRight" ? i + 1 : e.key === "ArrowLeft" ? i - 1 : e.key === "Home" ? 0 : e.key === "End" ? TABS.length - 1 : null;
    if (n === null) return;
    e.preventDefault();
    const j = (n + TABS.length) % TABS.length;
    tabRefs.current[j]?.focus();
    onTab(TABS[j]![0]);
  };

  const cancel = async () => {
    if (!confirm("Cancel this investigation? Running experiments will be stopped and partial evidence kept.")) return;
    setCancelBusy(true);
    setCancelErr(null);
    try {
      await client.cancelInvestigation(id);
    } catch (e) {
      setCancelErr(`${errorCode(e)}: ${(e as Error).message}`);
    } finally {
      setCancelBusy(false);
    }
  };

  return (
    <Panel title="Investigation workspace" state={ws} showHeading={false} bare testId="investigation-view">
      {(w) => {
        const inv = w.investigation;
        const running = RUNNING.includes(inv.state);
        return (
          <div className={styles.wrap}>
            <div className={styles.head}>
              <div className={styles.titleBlock}>
                <h1 className={styles.title} data-testid="investigation-title">{inv.title}</h1>
                <div className={styles.meta}>
                  <Badge tone={stateTone(inv.state)}>{human(inv.state)}</Badge>
                  {w.cancellation === "requested" && <Badge tone="amber">cancellation pending</Badge>}
                  <span className={styles.id}>id {shortId(inv.id)}</span>
                  <span>{inv.requestedEnvironments} environments</span>
                  {inv.jiraIssueKey && <span>Jira {inv.jiraIssueKey}</span>}
                  <span>updated {fmtTime(inv.updatedAtMs)}</span>
                </div>
              </div>
              {running && (
                <button type="button" className="danger" onClick={cancel} disabled={cancelBusy || w.cancellation !== "none"} data-testid="cancel-investigation">
                  {w.cancellation === "requested" ? "Cancelling…" : "Cancel investigation"}
                </button>
              )}
            </div>
            {cancelErr && <p role="alert" className={styles.err}>Cancel failed: {cancelErr}</p>}
            <label className={styles.mobileTabSelect}>
              <span className="visually-hidden">Investigation sections</span>
              <select value={active} onChange={(e) => onTab(e.target.value)} aria-label="Investigation sections">
                {TABS.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
              </select>
            </label>
            <div role="tablist" aria-label="Investigation sections" className={styles.tabs}>
              {TABS.map(([k, label], i) => (
                <button
                  key={k}
                  ref={(el) => {
                    tabRefs.current[i] = el;
                  }}
                  role="tab"
                  type="button"
                  id={`tab-${k}`}
                  aria-selected={active === k}
                  aria-controls={`tabpanel-${k}`}
                  tabIndex={active === k ? 0 : -1}
                  className={active === k ? styles.tabActive : styles.tab}
                  onClick={() => onTab(k)}
                  onKeyDown={(e) => onTabKey(e, i)}
                >
                  {label}
                </button>
              ))}
            </div>
            <div role="tabpanel" id={`tabpanel-${active}`} aria-labelledby={`tab-${active}`} className={styles.tabPanel}>
              {active === "capture" && <CapturePanel workspace={w} />}
              {active === "environments" && <EnvironmentGrid workspace={w} />}
              {active === "evidence" && <EvidenceFeed workspace={w} />}
              {active === "compare" && <ComparePanel workspace={w} />}
            </div>
          </div>
        );
      }}
    </Panel>
  );
}
