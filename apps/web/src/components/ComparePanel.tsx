import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type { CandidateEvaluation, ControllerCandidate, ReviewDecision, SimRunResult } from "@forksafe/contracts";
import { fmtTime, shortId, shortSha, useClient, useLoad } from "../hooks";
import { FIXTURE_REVIEWER, errorCode, type InvestigationWorkspace } from "../services";
import { ReplayControls } from "../viewer/ReplayControls";
import { ReplayViewer } from "../viewer/ReplayViewer";
import { replayDuration } from "../viewer/transform";
import { useReplayClock } from "../viewer/useReplayClock";
import { Badge, Panel } from "./Panel";
import { SegThumb } from "./SegThumb";
import { human, stateTone, words } from "./tone";
import styles from "./ComparePanel.module.css";
import { useBrowserAccess } from "../services/browserAccess";

const DETAIL_TABS = [
  ["replay", "Replay"],
  ["results", "Results"],
  ["change", "Change"],
  ["review", "Review"],
] as const;

export function ComparePanel({ workspace: w }: { workspace: InvestigationWorkspace }) {
  const access = useBrowserAccess();
  const [selected, setSelected] = useState<string | undefined>(w.candidates[0]?.id);
  if (!w.candidates.length)
    return <div><p className={styles.muted} data-testid="empty-state">No candidates submitted yet. Environments submit exact controller versions here once they find a repair.</p>{!access.canWrite && <button type="button" onClick={access.showSignIn}>Sign in to review</button>}</div>;
  const cand = w.candidates.find((c) => c.id === selected) ?? w.candidates[0]!;
  return (
    <div className={styles.wrap}>
      <div role="radiogroup" aria-label="Candidate" className={styles.picker}>
        {w.candidates.map((c) => {
          const evs = w.evaluations.filter((e) => e.candidateId === c.id);
          const ok = evs.length > 0 && evs.every((e) => e.allRequiredPassed);
          return (
            <label key={c.id} className={c.id === cand.id ? styles.pickActive : styles.pick}>
              <input type="radio" name="candidate" value={c.id} checked={c.id === cand.id} onChange={() => setSelected(c.id)} />
              <span className={styles.pickContent}>
                <span className={styles.pickTitle}>
                  Candidate {shortId(c.id)} · Env {(w.environments.find((e) => e.id === c.environmentId)?.index ?? 0) + 1}
                </span>
                <Badge tone={evs.length === 0 ? "gray" : ok ? "green" : "red"}>{evs.length === 0 ? "Not evaluated" : ok ? "All required passed" : "Failed cases"}</Badge>
              </span>
            </label>
          );
        })}
      </div>
      <CandidateDetail key={cand.id} w={w} cand={cand} />
    </div>
  );
}

function CandidateDetail({ w, cand }: { w: InvestigationWorkspace; cand: ControllerCandidate }) {
  const inv = w.investigation;
  const baseline = w.experiments.find((e) => e.id === inv.baselineExperimentId);
  const baseArt = baseline?.replayArtifactId;
  const replays = useLoad(
    async (c) => {
      const [original, candidate] = await Promise.all([
        baseArt ? c.getReplay(baseArt) : Promise.reject(new Error("Baseline has no replay artifact")),
        c.getReplayForCandidate(cand.id),
      ]);
      return { original, candidate };
    },
    [baseArt, cand.id],
  );
  const diff = useLoad((c) => c.getCandidateDiff(cand.id), [cand.id]);
  const evals = w.evaluations.filter((e) => e.candidateId === cand.id);
  const [active, setActive] = useState<(typeof DETAIL_TABS)[number][0]>("replay");
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  useEffect(() => {
    const behavior = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
    tabRefs.current[DETAIL_TABS.findIndex(([key]) => key === active)]?.scrollIntoView({ behavior, block: "nearest", inline: "start" });
  }, [active]);
  const onTabKey = (e: KeyboardEvent, i: number) => {
    const next = e.key === "ArrowRight" ? i + 1 : e.key === "ArrowLeft" ? i - 1 : e.key === "Home" ? 0 : e.key === "End" ? DETAIL_TABS.length - 1 : null;
    if (next === null) return;
    e.preventDefault();
    const index = (next + DETAIL_TABS.length) % DETAIL_TABS.length;
    tabRefs.current[index]?.focus();
    setActive(DETAIL_TABS[index]![0]);
  };
  return (
    <div className={styles.detail}>
      <div role="tablist" aria-label="Candidate details" className={`seg seg-fill ${styles.subTabs}`} data-testid="compare-subtabs">
        <SegThumb active={active} />
        {DETAIL_TABS.map(([key, label], i) => (
          <button
            key={key}
            type="button"
            role="tab"
            id={`compare-tab-${key}`}
            aria-selected={active === key}
            aria-controls={`compare-panel-${key}`}
            tabIndex={active === key ? 0 : -1}
            ref={(el) => { tabRefs.current[i] = el; }}
            onClick={() => setActive(key)}
            onKeyDown={(e) => onTabKey(e, i)}
          >
            {label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`compare-panel-${active}`} aria-labelledby={`compare-tab-${active}`} className={styles.subTabPanel} data-testid={`compare-panel-content-${active}`}>
        {active === "replay" && (
          <Panel title="Synchronized replay" headingLevel={3} state={replays} testId="comparison-replay">
            {(r) => <SyncedReplays original={r.original} candidate={r.candidate} scene={inv.baselineCase.sceneOverrides} />}
          </Panel>
        )}
        {active === "results" && (
          <section className={styles.card} aria-labelledby="cases-h">
            <h3 id="cases-h">Evaluation results</h3>
            {evals.length === 0 ? <p className={styles.muted}>Not evaluated yet.</p> : (
              <div className={styles.resultsGrid}>
                {evals.map((e) => <CaseTable key={e.id} ev={e} />)}
              </div>
            )}
          </section>
        )}
        {active === "change" && (
          <section className={styles.card} aria-labelledby="cand-h">
            <h3 id="cand-h">What changed</h3>
            <dl className={styles.dl}>
              <dt>Candidate</dt>
              <dd><code data-testid="candidate-sha">{cand.controllerSha256}</code></dd>
              <dt>Original</dt>
              <dd><code>{baseline?.controllerSha256 ?? "—"}</code></dd>
              <dt>Status</dt>
              <dd><Badge tone={stateTone(cand.status)}>{human(cand.status)}</Badge></dd>
              <dt>Changed functions</dt>
              <dd data-testid="changed-functions">{cand.changedFunctions.map((f) => <code key={f} className={styles.fn}>{f}</code>)}</dd>
              <dt>Submitted</dt>
              <dd>{fmtTime(cand.submittedAtMs)}</dd>
            </dl>
            {cand.rationale && <p className={styles.muted}>{cand.rationale}</p>}
            <details className={styles.diff}>
              <summary>Exact diff</summary>
              {diff.status === "error" ? (
                <p role="alert" className={styles.err}>Diff unavailable: {(diff.error as Error).message}</p>
              ) : diff.data === undefined ? (
                <p role="status" className={styles.muted}>Loading diff…</p>
              ) : (
                <pre data-testid="candidate-diff">
                  {diff.data.split("\n").map((line, i) => (
                    <span key={i} className={line.startsWith("+") && !line.startsWith("+++") ? styles.add : line.startsWith("-") && !line.startsWith("---") ? styles.del : undefined}>
                      {line + "\n"}
                    </span>
                  ))}
                </pre>
              )}
            </details>
          </section>
        )}
        {active === "review" && <ReviewForm w={w} cand={cand} evals={evals} />}
      </div>
    </div>
  );
}

function SyncedReplays({ original, candidate, scene }: { original: SimRunResult; candidate: SimRunResult; scene: Record<string, number> }) {
  const clock = useReplayClock(Math.max(replayDuration(original.frames), replayDuration(candidate.frames)));
  const markers = [
    ...(original.firstFailure ? [{ tSec: original.firstFailure.tSec, label: `original ${human(original.firstFailure.kind)}` }] : []),
    ...(candidate.firstFailure ? [{ tSec: candidate.firstFailure.tSec, label: `candidate ${human(candidate.firstFailure.kind)}` }] : []),
  ];
  const outcome = (r: SimRunResult) =>
    r.completed ? `Completed in ${r.completionTimeSec?.toFixed(1) ?? "?"} s` : `Failed: ${r.failureKinds.map(words).join(", ") || "incomplete"}`;
  const [ghost, setGhost] = useState(true);
  return (
    <div>
      <div className={styles.ghostBar}>
        <button type="button" className={ghost ? styles.ghostOn : styles.ghostOff} aria-pressed={ghost} onClick={() => setGhost((g) => !g)} data-testid="ghost-toggle">
          <span className={styles.switch} aria-hidden="true"><span /></span>
          Show the original run as a ghost
        </button>
        {ghost && (
          <ul className={styles.ghostLegend} aria-label="Ghost legend" data-testid="ghost-legend">
            <li><i className={styles.keyArm} aria-hidden="true" />Repaired arm</li>
            <li><i className={styles.keyGhost} aria-hidden="true" />Original arm (ghost)</li>
            <li><i className={styles.keyPath} aria-hidden="true" />Repaired gripper path</li>
            <li><i className={styles.keyGhostPath} aria-hidden="true" />Original gripper path</li>
          </ul>
        )}
      </div>
      <div className={styles.panes}>
        <div>
          <ReplayViewer replay={original} t={clock.t} label="Original" scene={scene} />
          <p className={styles.outcome}><Badge tone={original.completed ? "green" : "red"}>{outcome(original)}</Badge></p>
        </div>
        <div>
          <ReplayViewer replay={candidate} t={clock.t} label="Repaired candidate" scene={scene} ghost={ghost ? original : undefined} />
          <p className={styles.outcome}><Badge tone={candidate.completed ? "green" : "red"}>{outcome(candidate)}</Badge></p>
        </div>
      </div>
      <ReplayControls clock={clock} markers={markers} label="Comparison replay" />
    </div>
  );
}

function CaseTable({ ev }: { ev: CandidateEvaluation }) {
  const [all, setAll] = useState(false);
  const passed = ev.cases.filter((c) => c.status === "passed").length;
  const rows = all ? ev.cases : ev.cases.slice(0, 5);
  return (
    <div className={styles.suite} data-testid={`suite-${ev.suite}`}>
      <p className={styles.suiteHead}>
        <strong>{ev.suite === "public" ? "Public suite" : "Withheld suite"}</strong>
        <Badge tone={ev.allRequiredPassed ? "green" : "red"}>{passed}/{ev.cases.length} passed</Badge>
        {ev.medianCompletionTimeSec !== undefined && <span className={styles.muted}>median {ev.medianCompletionTimeSec.toFixed(2)} s</span>}
      </p>
      <div className={styles.tableWrap}>
        <table>
          <thead>
            <tr><th scope="col">Case</th><th scope="col">Result</th><th scope="col">Time</th><th scope="col">Failures</th></tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.caseId}>
                <td>{c.caseId}</td>
                <td><Badge tone={stateTone(c.status)}>{human(c.status)}</Badge></td>
                <td>{c.completionTimeSec !== undefined ? `${c.completionTimeSec.toFixed(2)} s` : "—"}</td>
                <td>{c.failureKinds.map(words).join(", ") || "none"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {ev.cases.length > 5 && (
        <button type="button" onClick={() => setAll((a) => !a)}>{all ? "Show fewer" : `Show all ${ev.cases.length} cases`}</button>
      )}
    </div>
  );
}

const DECISIONS: [ReviewDecision, string][] = [
  ["approved", "Approve for engineering review"],
  ["needs_changes", "Needs changes"],
  ["rejected", "Reject"],
];

const DECISION_DETAILS: Record<ReviewDecision, string> = {
  approved: "Accept this version for engineering review; it does not deploy to hardware.",
  needs_changes: "Ask the team to make another change before review.",
  rejected: "Do not advance this candidate.",
};

/** Review binds to the exact evaluated controllerSha256 and evaluation id. */
function ReviewForm({ w, cand, evals }: { w: InvestigationWorkspace; cand: ControllerCandidate; evals: CandidateEvaluation[] }) {
  const client = useClient();
  const access = useBrowserAccess();
  const final = evals.find((e) => e.suite === "withheld") ?? evals.find((e) => e.suite === "public");
  const existing = w.reviews.filter((r) => r.candidateId === cand.id).sort((a, b) => b.createdAtMs - a.createdAtMs);
  const [decision, setDecision] = useState<ReviewDecision | "">("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const reviewable = !!final && w.investigation.state === "awaiting_review";

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!access.canWrite) { access.showSignIn(); return; }
    if (!final || !decision) return;
    setBusy(true);
    setErr(null);
    try {
      await client.submitReview({
        investigationId: w.investigation.id,
        candidateId: cand.id,
        evaluationId: final.id,
        controllerSha256: cand.controllerSha256,
        decision,
        notes: notes.trim() || undefined,
      });
      setNotes("");
      setDecision("");
    } catch (e2) {
      setErr(errorCode(e2) === "permission_denied" ? `You are not a reviewer for this project: ${(e2 as Error).message}` : (e2 as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={styles.card} aria-labelledby="review-h" data-testid="review-panel">
      <h3 id="review-h">Human review</h3>
      <p className={styles.muted}>
        Reviewing controller <code>{shortSha(cand.controllerSha256)}</code>
        {final ? <> evaluated by {final.suite} suite run {shortId(final.id)}</> : null}. Approval accepts this exact version for engineering review; it never deploys to hardware.
        {client.source.kind === "fixture" && <> Signed as <strong>{FIXTURE_REVIEWER}</strong>; stored in this browser only.</>}
      </p>
      {existing.length > 0 && (
        <ul className={styles.reviews} data-testid="review-history">
          {existing.map((r) => (
            <li key={r.id}>
              <Badge tone={stateTone(r.decision)}>{human(r.decision)}</Badge> by {r.reviewerIdentity} for <code>{shortSha(r.controllerSha256)}</code> · {fmtTime(r.createdAtMs)}
              {r.notes && <span className={styles.muted}> — {r.notes}</span>}
            </li>
          ))}
        </ul>
      )}
      {!access.canWrite ? <button type="button" onClick={access.showSignIn}>Sign in to review</button> : !reviewable ? (
        <p className={styles.muted} data-testid="review-unavailable">
          {final ? `Review opens when the investigation is awaiting review (currently ${human(w.investigation.state)}).` : "Review needs a completed evaluation for this exact candidate."}
        </p>
      ) : (
        <form onSubmit={submit} className={styles.form}>
          <fieldset className={styles.decisions} role="radiogroup" aria-labelledby="decision-legend">
            <legend id="decision-legend">Decision</legend>
            {DECISIONS.map(([d, label]) => (
              <label key={d} className={`${styles.decision} ${decision === d ? styles.decisionSelected : ""}`}>
                <input type="radio" name="decision" value={d} checked={decision === d} aria-label={label} onChange={() => setDecision(d)} />
                <span className={styles.decisionText}>
                  <strong>{label}</strong>
                  <span>{DECISION_DETAILS[d]}</span>
                </span>
              </label>
            ))}
          </fieldset>
          <label className={styles.notes}>
            Notes (optional)
            <textarea value={notes} maxLength={4000} rows={2} onChange={(e) => setNotes(e.target.value)} />
          </label>
          {!decision && <p className={styles.reviewHelper} id="review-help">Choose a decision to enable your review.</p>}
          <button type="submit" className={`primary ${styles.reviewSubmit}`} disabled={!decision || busy} aria-describedby={!decision ? "review-help" : undefined} data-testid="submit-review">
            {busy ? "Recording…" : "Record review"}
          </button>
          {err && <p role="alert" className={styles.err}>{err}</p>}
        </form>
      )}
    </section>
  );
}
