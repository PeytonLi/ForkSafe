import { useState } from "react";
import { useBrowserAccess } from "../services/browserAccess";
import { fmtTime, shortId, useClient, useCompact, useLoad } from "../hooks";
import { activeSection, sectionLabel } from "../sections";
import { errorCode } from "../services";
import { CapturePanel } from "./CapturePanel";
import { ComparePanel } from "./ComparePanel";
import { EnvironmentGrid } from "./EnvironmentGrid";
import { EvidenceFeed } from "./EvidenceFeed";
import { AskPanel } from "./AskPanel";
import { TimelinePanel } from "./TimelinePanel";
import { LearningPanel } from "./LearningPanel";
import { Badge, Panel } from "./Panel";
import { human, stateTone } from "./tone";
import styles from "./InvestigationView.module.css";

const RUNNING = ["capturing", "admitted", "searching", "evaluating"];

export function InvestigationView({ id, tab, focus, onTab }: { id: string; tab: string; focus?: string; onTab: (t: string, focus?: string) => void }) {
  const client = useClient();
  const access = useBrowserAccess();
  const ws = useLoad((c) => c.getWorkspace(id), [id], id);
  const [cancelErr, setCancelErr] = useState<string | null>(null);
  const [cancelBusy, setCancelBusy] = useState(false);
  const compact = useCompact();
  const active = activeSection(tab);

  const cancel = async () => {
    if (!access.canWrite) { access.showSignIn(); return; }
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
                  {!access.canWrite ? "Sign in to cancel" : w.cancellation === "requested" ? "Cancelling…" : "Cancel investigation"}
                </button>
              )}
            </div>
            {cancelErr && <p role="alert" className={styles.err}>Cancel failed: {cancelErr}</p>}
            <div
              key={active}
              role="tabpanel"
              id={`tabpanel-${active}`}
              aria-labelledby={compact ? undefined : `tab-${active}`}
              aria-label={compact ? sectionLabel(active) : undefined}
              className={`${styles.tabPanel} page-enter`}
            >
              {active === "capture" && <CapturePanel workspace={w} />}
              {active === "environments" && <EnvironmentGrid workspace={w} />}
              {active === "evidence" && <EvidenceFeed workspace={w} focus={focus} />}
              {active === "ask" && <AskPanel workspace={w} />}
              {active === "timeline" && <TimelinePanel workspace={w} focus={focus} />}
              {active === "compare" && <ComparePanel workspace={w} />}
              {active === "learning" && <LearningPanel workspace={w} />}
            </div>
          </div>
        );
      }}
    </Panel>
  );
}
