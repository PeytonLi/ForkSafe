import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useMutation, useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { useClient } from "../hooks";
import styles from "./EnvironmentGrid.module.css";

const HYPOTHESIS_MAX = 280;

const listHypotheses = makeFunctionReference<
  "query",
  { investigationId: string },
  { environmentId: string; hypothesis: string; updatedAtMs: number }[]
>("environmentHypotheses:listForInvestigation");

const setHypothesis = makeFunctionReference<
  "mutation",
  { investigationId: string; environmentId: string; hypothesis: string },
  { environmentId: string; hypothesis: string; updatedAtMs: number } | null
>("environmentHypotheses:set");

export function hypothesisStorageKey(investigationId: string, environmentId: string) {
  return `forksafe.hypothesis.${investigationId}.${environmentId}`;
}

function readHypothesis(key: string, initial: string) {
  try {
    const stored = localStorage.getItem(key);
    return stored === null ? initial : stored;
  } catch {
    return initial;
  }
}

function writeHypothesis(key: string, hypothesis: string) {
  try {
    if (hypothesis) localStorage.setItem(key, hypothesis);
    else localStorage.removeItem(key);
  } catch {
    // Fixture mode still renders when storage is blocked.
  }
}

/** Convex hooks stay in this child. Fixture mode has no Convex provider, so it never mounts. */
function ConvexHypothesisSync({
  investigationId,
  environmentId,
  pending,
  onServer,
  onError,
}: {
  investigationId: string;
  environmentId: string;
  pending: { text: string; n: number } | null;
  onServer: (hypothesis: string, force?: boolean) => void;
  onError: (message: string | null) => void;
}) {
  const rows = useQuery(listHypotheses, { investigationId });
  const saveHypothesis = useMutation(setHypothesis);
  const hydrated = useRef(false);
  const sent = useRef(0);

  useEffect(() => {
    if (hydrated.current || rows === undefined) return;
    hydrated.current = true;
    const row = rows.find((item) => item.environmentId === environmentId);
    onServer(row?.hypothesis ?? "");
  }, [rows, environmentId, onServer]);

  useEffect(() => {
    if (!pending || pending.n === sent.current) return;
    sent.current = pending.n;
    let live = true;
    void saveHypothesis({ investigationId, environmentId, hypothesis: pending.text })
      .then((row) => { if (live) onServer(row?.hypothesis ?? "", true); })
      .catch(() => { if (live) onError("The server did not keep this hypothesis."); });
    return () => {
      live = false;
    };
  }, [pending, investigationId, environmentId, saveHypothesis, onError]);

  return null;
}

export function HypothesisEditor({
  investigationId,
  environmentId,
  initial,
}: {
  investigationId: string;
  environmentId: string;
  initial: string;
}) {
  const client = useClient();
  const convex = client.source.kind === "convex";
  const key = hypothesisStorageKey(investigationId, environmentId);
  const [draft, setDraft] = useState(() => readHypothesis(key, initial));
  const [saved, setSaved] = useState(() => readHypothesis(key, initial));
  const [pending, setPending] = useState<{ text: string; n: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const edited = useRef(false);
  const inputId = useId();
  const hintId = useId();

  const applyServer = useCallback((hypothesis: string, force = false) => {
    if (edited.current && !force) return;
    const next = hypothesis.trim().slice(0, HYPOTHESIS_MAX);
    edited.current = false;
    setDraft(next);
    setSaved(next);
    writeHypothesis(key, next);
  }, [key]);

  const save = (event: FormEvent) => {
    event.preventDefault();
    const next = draft.trim().slice(0, HYPOTHESIS_MAX);
    setDraft(next);
    setError(null);
    if (!convex) {
      edited.current = false;
      setSaved(next);
      writeHypothesis(key, next);
      return;
    }
    setPending((current) => ({ text: next, n: (current?.n ?? 0) + 1 }));
  };

  return (
    <section className={styles.hypothesis} aria-label="Environment hypothesis">
      {saved ? <p className={styles.hypothesisSaved} data-testid="saved-hypothesis">{saved}</p> : null}
      <form className={styles.hypothesisForm} onSubmit={save}>
        <label className={styles.hypothesisLabel} htmlFor={inputId}>Hypothesis</label>
        <input
          id={inputId}
          type="text"
          maxLength={HYPOTHESIS_MAX}
          value={draft}
          autoComplete="off"
          onChange={(event) => { edited.current = true; setDraft(event.target.value); }}
          aria-describedby={hintId}
        />
        <button type="submit">Save hypothesis</button>
        <p id={hintId} className={styles.hypothesisHint}>Pinned to this environment only. It does not change scores or the other environments.</p>
        {error ? <p className={styles.hypothesisError} role="alert">{error}</p> : null}
      </form>
      {convex ? (
        <ConvexHypothesisSync
          investigationId={investigationId}
          environmentId={environmentId}
          pending={pending}
          onServer={applyServer}
          onError={setError}
        />
      ) : null}
    </section>
  );
}
