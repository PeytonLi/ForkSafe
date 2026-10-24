import { useId, useRef, useState, type FormEvent } from "react";
import { routeHref, shortId, useClient } from "../hooks";
import { errorCode, QUESTION_MAX, SUGGESTED_QUESTIONS, withheldReason, type EvidenceAnswer, type EvidenceCitation, type InvestigationWorkspace } from "../services";
import { useBrowserAccess } from "../services/browserAccess";
import { Badge } from "./Panel";
import styles from "./AskPanel.module.css";

type Result = { question: string; answer: EvidenceAnswer } | { question: string; error: string };

/** "Why did this fail?": investigation-scoped questions to the evidence agent. */
export function AskPanel({ workspace: w }: { workspace: InvestigationWorkspace }) {
  const client = useClient();
  const access = useBrowserAccess();
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const hintId = useId();
  const envIndex = new Map(w.environments.map((e) => [e.id, e.index + 1]));
  const signedOut = client.source.kind !== "fixture" && !access.authenticated;

  const ask = async (text: string) => {
    if (signedOut) { access.showSignIn(); return; }
    if (busy || !text.trim()) return;
    setBusy(true);
    try {
      setResult({ question: text.trim(), answer: await client.askEvidence(w.investigation.id, text) });
    } catch (e) {
      const code = errorCode(e);
      const message = code === "out_of_scope" || code === "invalid_input" ? (e as Error).message
        : code === "permission_denied" ? "Sign in to ask about this investigation."
          : "The evidence agent didn't answer. Please try again in a moment.";
      setResult({ question: text.trim(), error: message });
    } finally {
      setBusy(false);
    }
  };
  const submit = (e: FormEvent) => { e.preventDefault(); void ask(question); };

  return (
    <section className={styles.wrap} aria-labelledby="ask-h" data-testid="ask-panel">
      <div className={styles.intro}>
        <h2 id="ask-h">Why did this fail?</h2>
        <p>Ask about this investigation. Answers only use evidence the environments recorded, with links to each source. They never change scores.</p>
      </div>
      <form className={styles.form} onSubmit={submit}>
        <label className="visually-hidden" htmlFor="ask-input">Your question</label>
        <textarea
          id="ask-input"
          ref={inputRef}
          rows={2}
          maxLength={QUESTION_MAX}
          value={question}
          placeholder="For example: why did the cube hit the divider?"
          aria-describedby={hintId}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void ask(question); } }}
          data-testid="ask-input"
        />
        <button type="submit" className="primary" disabled={busy || (!signedOut && question.trim().length < 3)} data-testid="ask-submit">
          {signedOut ? "Sign in to ask" : busy ? "Looking…" : "Ask"}
        </button>
        <p id={hintId} className={styles.hint}>Press Enter to ask, Shift+Enter for a new line.</p>
      </form>
      <div className={styles.suggestions} role="group" aria-label="Suggested questions">
        {SUGGESTED_QUESTIONS.map((s) => (
          <button key={s} type="button" className={styles.suggestion} disabled={busy} onClick={() => { setQuestion(s); void ask(s); }}>
            {s}
          </button>
        ))}
      </div>
      <div aria-live="polite" className={styles.live}>
        {busy && <p className={styles.thinking} role="status">Reading the evidence…</p>}
        {!busy && result && <AnswerCard result={result} investigationId={w.investigation.id} envIndex={envIndex} onRetry={() => inputRef.current?.focus()} />}
      </div>
    </section>
  );
}

function AnswerCard({ result, investigationId, envIndex, onRetry }: { result: Result; investigationId: string; envIndex: Map<string, number>; onRetry: () => void }) {
  if ("error" in result) {
    return (
      <div className={styles.answerWarn} role="alert" data-testid="ask-error">
        <p>{result.error}</p>
        <button type="button" onClick={onRetry}>Edit question</button>
      </div>
    );
  }
  const a = result.answer;
  const head = (
    <header className={styles.answerHead}>
      <span className={styles.youAsked}>You asked: <q>{result.question}</q></span>
      <Badge tone={a.mode === "live" ? "green" : a.mode === "fixture" ? "amber" : a.mode === "blocked" ? "red" : "gray"}>
        {a.mode === "live" ? "Elastic agent" : a.mode === "fixture" ? "Fixture" : a.mode === "blocked" ? "Unavailable" : "Fallback"}
      </Badge>
    </header>
  );
  if (!a.enoughEvidence) {
    return (
      <article className={styles.answerSoft} data-testid="ask-not-enough">
        {head}
        <h3>We don't have enough evidence to answer that yet</h3>
        <p>{a.mode === "blocked" ? "The evidence agent isn't reachable right now." : a.reason ?? "None of the recorded findings cover this question."} Try one of the suggested questions, or ask again once the environments have recorded more findings.</p>
        {a.withheld.length > 0 && (
          <>
            <ul className={styles.chips} aria-label="Sources not shown">{a.withheld.map((x) => <WithheldChip key={x.id} id={x.id} reason={x.reason} />)}</ul>
            <Withheld items={a.withheld} />
          </>
        )}
      </article>
    );
  }
  return (
    <article className={styles.answer} data-testid="ask-answer">
      {head}
      <p className={styles.answerText}>{a.answer}</p>
      {a.label && <p className={styles.label}>{a.label}</p>}
      <h3 className={styles.sourcesH}>Sources</h3>
      <ul className={styles.chips} aria-label="Sources">
        {a.citations.map((c) => <CitationChip key={c.id} c={c} investigationId={investigationId} envIndex={envIndex} />)}
        {a.withheld.map((x) => <WithheldChip key={x.id} id={x.id} reason={x.reason} />)}
      </ul>
      {a.withheld.length > 0 && <Withheld items={a.withheld} />}
    </article>
  );
}

function CitationChip({ c, investigationId, envIndex }: { c: EvidenceCitation; investigationId: string; envIndex: Map<string, number> }) {
  const env = c.environmentId ? envIndex.get(c.environmentId) : undefined;
  const href = routeHref({ investigationId, tab: c.docType === "finding" ? "evidence" : "timeline", focus: c.id });
  const kind = c.docType === "finding" ? "Finding" : c.docType === "experiment_result" ? "Experiment" : "Evidence";
  return (
    <li>
      <a className={styles.chip} href={href} title={c.summary} data-testid="citation-chip">
        {env !== undefined && <span className={styles.chipEnv}>Env {env}</span>}
        {kind} {shortId(c.id)}
      </a>
    </li>
  );
}

function WithheldChip({ id, reason }: { id: string; reason: string }) {
  return (
    <li>
      <span className={styles.chipRevoked} data-testid="citation-withheld" aria-label={`Source ${shortId(id)} not shown: it ${withheldReason(reason)}`}>
        <s>Source {shortId(id)}</s>
      </span>
    </li>
  );
}

function Withheld({ items }: { items: { id: string; reason: string }[] }) {
  return (
    <p className={styles.withheldNote} data-testid="withheld-note">
      {items.length === 1 ? "One source isn't shown" : `${items.length} sources aren't shown`} because {items.map((x) => `${shortId(x.id)} ${withheldReason(x.reason)}`).join("; ")}. The answer doesn't rely on {items.length === 1 ? "it" : "them"}.
    </p>
  );
}
