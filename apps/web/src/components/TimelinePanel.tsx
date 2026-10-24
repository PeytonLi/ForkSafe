import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { fmtTime, shortId, useLoad, useNarrow } from "../hooks";
import type { HandoffEvent, InvestigationWorkspace } from "../services";
import { Panel } from "./Panel";
import { human, words } from "./tone";
import styles from "./TimelinePanel.module.css";

type Row = "stages" | "agents" | "experiments" | "fixes" | "checks";
const ROWS: [Row, string][] = [["stages", "Handoffs"], ["agents", "Agents"], ["experiments", "Experiments"], ["fixes", "Fixes"], ["checks", "Checks"]];
type Tone = "ok" | "bad" | "run" | "neutral";

export interface Mark {
  id: string;
  envId: string;
  row: Row;
  startMs: number;
  endMs?: number;
  tone: Tone;
  title: string;
  detail: string;
}

const STAGE_WORDS: Record<HandoffEvent["stage"], string> = {
  admission_reserved: "reserved",
  grant_installed: "permission granted",
  work_started: "started",
  artifacts_persisted: "files saved",
  evidence_committed: "evidence shared",
  completion_acknowledged: "finished",
};

const expTone = (s: string): Tone => (s === "succeeded" ? "ok" : s === "running" || s === "queued" ? "run" : s === "cancelled" ? "neutral" : "bad");

/** Every timeline mark, derived only from recorded workspace rows and handoffs. */
export function buildMarks(w: InvestigationWorkspace, handoffs: HandoffEvent[]): Mark[] {
  const marks: Mark[] = [];
  const envOf = new Map(w.candidates.map((c) => [c.id, c.environmentId]));
  const byJob = new Map<string, HandoffEvent[]>();
  for (const h of handoffs) if (h.environmentId) byJob.set(h.jobId, [...(byJob.get(h.jobId) ?? []), h]);
  for (const [jobId, hs] of byJob) {
    const sorted = [...hs].sort((a, b) => a.atMs - b.atMs);
    const last = sorted[sorted.length - 1]!;
    const done = sorted.some((h) => h.stage === "completion_acknowledged");
    marks.push({
      id: `job-${jobId}`, envId: last.environmentId!, row: "stages", startMs: sorted[0]!.atMs, endMs: last.atMs,
      tone: sorted.some((h) => h.stale) ? "bad" : done ? "ok" : "run",
      title: `${human(last.jobKind)} job ${shortId(jobId)}`,
      detail: `${sorted.map((h) => STAGE_WORDS[h.stage] + (h.stale ? " (stale)" : "")).join(" → ")}${done ? "" : " → in progress"}`,
    });
  }
  for (const s of w.sessions) {
    marks.push({
      id: s.id, envId: s.environmentId, row: "agents", startMs: s.createdAtMs, endMs: s.closedAtMs ?? w.asOfMs,
      tone: s.state === "error" ? "bad" : s.closedAtMs ? "neutral" : "run",
      title: `Agent session ${shortId(s.id)}`,
      detail: `${human(s.state)}${s.closedAtMs ? "" : ", still running"} · ${(s.tokenUsage.inputTokens + s.tokenUsage.outputTokens).toLocaleString()} tokens`,
    });
  }
  for (const x of w.experiments) {
    if (!x.environmentId) continue;
    marks.push({
      id: x.id, envId: x.environmentId, row: "experiments", startMs: x.startedAtMs, endMs: x.finishedAtMs,
      tone: expTone(x.status),
      title: `Experiment ${shortId(x.id)}`,
      detail: `${human(x.status)}${x.failureKinds.length ? `: ${x.failureKinds.map(words).join(", ")}` : ""}`,
    });
  }
  for (const c of w.candidates) {
    marks.push({
      id: c.id, envId: c.environmentId, row: "fixes", startMs: c.submittedAtMs, tone: c.status === "rejected" ? "bad" : "ok",
      title: `Fix ${shortId(c.id)} submitted`,
      detail: `${human(c.status)} · changed ${c.changedFunctions.join(", ") || "nothing"}`,
    });
  }
  for (const e of w.evaluations) {
    const envId = envOf.get(e.candidateId);
    if (!envId) continue;
    const passed = e.cases.filter((c) => c.status === "passed").length;
    marks.push({
      id: e.id, envId, row: "checks", startMs: e.createdAtMs, tone: e.status === "passed" ? "ok" : e.status === "running" || e.status === "queued" ? "run" : "bad",
      title: `${e.suite === "public" ? "Public" : "Withheld"} check for fix ${shortId(e.candidateId)}`,
      detail: `${passed}/${e.cases.length} cases passed`,
    });
  }
  return marks.sort((a, b) => a.startMs - b.startMs);
}

export function TimelinePanel({ workspace: w, focus }: { workspace: InvestigationWorkspace; focus?: string }) {
  const id = w.investigation.id;
  const handoffs = useLoad((c) => c.listHandoffs(id), [id], id);
  const narrow = useNarrow();
  const state = handoffs.status === "error"
    ? { status: "ready" as const, data: [] as HandoffEvent[] }
    : handoffs;
  return (
    <Panel title="Timeline" headingLevel={3} state={state} testId="timeline" isEmpty={() => w.environments.length === 0} empty="No environments have started yet.">
      {(hs) => {
        const marks = buildMarks(w, hs);
        return (
          <>
            {handoffs.status === "error" && <p className={styles.note} role="status">Handoff steps aren't available here yet, so only sessions, experiments, fixes and checks are shown.</p>}
            {narrow ? <TimelineList w={w} marks={marks} focus={focus} /> : <TimelineChart w={w} marks={marks} focus={focus} />}
          </>
        );
      }}
    </Panel>
  );
}

function TimelineChart({ w, marks, focus }: { w: InvestigationWorkspace; marks: Mark[]; focus?: string }) {
  const t0 = Math.min(...marks.map((m) => m.startMs), ...w.environments.flatMap((e) => (e.startedAtMs ? [e.startedAtMs] : [])));
  const t1 = Math.max(t0 + 1, ...marks.map((m) => m.endMs ?? m.startMs));
  const pct = (ms: number) => ((ms - t0) / (t1 - t0)) * 100;
  const order = useMemo(() => w.environments.flatMap((e) => ROWS.flatMap(([row]) => marks.filter((m) => m.envId === e.id && m.row === row))), [w.environments, marks]);
  const initial = Math.max(0, focus ? order.findIndex((m) => m.id === focus) : 0);
  const [active, setActive] = useState(initial);
  const [hover, setHover] = useState<number | null>(null);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  useEffect(() => {
    if (focus && order[initial]?.id === focus) refs.current[initial]?.focus({ preventScroll: false });
  }, [focus, initial, order]);
  const shown = order[hover ?? active];
  const move = (e: KeyboardEvent, i: number) => {
    const next = e.key === "ArrowRight" || e.key === "ArrowDown" ? i + 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? i - 1 : e.key === "Home" ? 0 : e.key === "End" ? order.length - 1 : null;
    if (next === null) return;
    e.preventDefault();
    const j = Math.min(order.length - 1, Math.max(0, next));
    setActive(j);
    refs.current[j]?.focus();
  };
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((u) => t0 + u * (t1 - t0));
  return (
    <div className={styles.chartWrap} data-testid="timeline-chart">
      <Legend />
      <div className={styles.axis} aria-hidden="true">
        <span />
        <div className={styles.ticks}>{ticks.map((t, i) => <span key={i} style={{ left: `${i * 25}%` }}>{fmtClock(t)}</span>)}</div>
      </div>
      <div role="toolbar" aria-label="Timeline events. Use the arrow keys to move between events." aria-orientation="horizontal" className={styles.lanes}>
        {w.environments.map((env) => (
          <section key={env.id} className={styles.lane} aria-label={`Env ${env.index + 1}`} data-testid={`timeline-lane-${env.index + 1}`}>
            <h4 className={styles.laneTitle}>Env {env.index + 1}</h4>
            <div className={styles.rows}>
              {ROWS.map(([row, label]) => (
                <div key={row} className={styles.row}>
                  <span className={styles.rowLabel}>{label}</span>
                  <div className={styles.track}>
                    {order.map((m, i) => {
                      if (m.envId !== env.id || m.row !== row) return null;
                      const bar = m.endMs !== undefined && (row === "agents" || row === "stages");
                      const left = pct(m.startMs);
                      const width = bar ? Math.max(0.8, pct(m.endMs!) - left) : 0;
                      return (
                        <button
                          key={m.id}
                          ref={(el) => { refs.current[i] = el; }}
                          type="button"
                          tabIndex={i === active ? 0 : -1}
                          className={`${bar ? styles.bar : row === "fixes" ? styles.diamond : row === "checks" ? styles.square : styles.dot} ${styles[m.tone]} ${i === active ? styles.selected : ""}`}
                          style={bar ? { left: `${left}%`, width: `${width}%` } : { left: `${left}%` }}
                          aria-label={`${m.title}, ${fmtTime(m.startMs)}. ${m.detail}`}
                          aria-pressed={i === active}
                          data-testid={`mark-${m.id}`}
                          onClick={() => setActive(i)}
                          onFocus={() => setActive(i)}
                          onMouseEnter={() => setHover(i)}
                          onMouseLeave={() => setHover(null)}
                          onKeyDown={(e) => move(e, i)}
                        />
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
      <div className={styles.readout} role="status" aria-live="polite" data-testid="timeline-readout">
        {shown ? <><strong>{shown.title}</strong><span>{fmtTime(shown.startMs)}{shown.endMs && shown.endMs !== shown.startMs ? ` → ${fmtClock(shown.endMs)}` : ""}</span><span className={styles.readoutDetail}>{shown.detail}</span></> : "No events yet."}
      </div>
    </div>
  );
}

function TimelineList({ w, marks, focus }: { w: InvestigationWorkspace; marks: Mark[]; focus?: string }) {
  const focused = marks.find((m) => m.id === focus);
  const [envId, setEnvId] = useState(focused?.envId ?? w.environments[0]?.id);
  const [steps, setSteps] = useState(focused?.row === "stages");
  const [all, setAll] = useState(false);
  const envMarks = marks.filter((m) => m.envId === envId && (steps || m.row !== "stages"));
  const focusAt = focused ? envMarks.findIndex((m) => m.id === focused.id) : -1;
  const cap = Math.max(LIST_CAP, focusAt + 1);
  const items = all ? envMarks : envMarks.slice(0, cap);
  useEffect(() => {
    if (focused) document.getElementById(`tl-${focused.id}`)?.focus();
  }, [focused]);
  return (
    <div data-testid="timeline-list">
      <div className={styles.envPicker} role="group" aria-label="Environment">
        {w.environments.map((e) => (
          <button key={e.id} type="button" aria-pressed={envId === e.id} className={envId === e.id ? styles.envActive : styles.env} onClick={() => { setEnvId(e.id); setAll(false); }}>
            Env {e.index + 1}
          </button>
        ))}
      </div>
      <Legend />
      <label className={styles.stepsToggle}>
        <input type="checkbox" checked={steps} onChange={(e) => setSteps(e.target.checked)} /> Include handoff steps
      </label>
      {items.length === 0 ? <p className={styles.note}>Nothing has happened in this environment yet.</p> : (
        <ol className={styles.list}>
          {items.map((m) => (
            <li key={m.id} id={`tl-${m.id}`} tabIndex={-1} className={`${styles.listItem} ${m.id === focus ? styles.listFocus : ""}`}>
              <span className={`${styles.listMark} ${styles[m.tone]} ${m.row === "fixes" ? styles.diamondMini : m.row === "checks" ? styles.squareMini : ""}`} aria-hidden="true" />
              <div className={styles.listBody}>
                <strong>{m.title}</strong>
                <span>{fmtClock(m.startMs)} · {ROWS.find(([r]) => r === m.row)![1]}</span>
                <span className={styles.readoutDetail}>{m.detail}</span>
              </div>
            </li>
          ))}
        </ol>
      )}
      {envMarks.length > items.length && (
        <button type="button" className={styles.more} onClick={() => setAll(true)} data-testid="timeline-more">Show all {envMarks.length} events</button>
      )}
    </div>
  );
}

const LIST_CAP = 8;

function Legend() {
  return (
    <ul className={styles.legend} aria-label="Legend">
      <li><span className={`${styles.legendSwatch} ${styles.ok}`} />Passed or finished</li>
      <li><span className={`${styles.legendSwatch} ${styles.bad}`} />Failed</li>
      <li><span className={`${styles.legendSwatch} ${styles.run}`} />Running</li>
      <li><span className={`${styles.legendSwatch} ${styles.diamondMini} ${styles.ok}`} />Fix</li>
      <li><span className={`${styles.legendSwatch} ${styles.squareMini} ${styles.ok}`} />Check</li>
    </ul>
  );
}

const fmtClock = (ms: number) => new Date(ms).toISOString().slice(11, 16);
