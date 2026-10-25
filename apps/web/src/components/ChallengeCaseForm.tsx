import { useEffect, useRef, useState, type FormEvent } from "react";
import { useMutation } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { DEFAULT_TASK_FAMILY, SCENE_DEFAULTS, SCENE_OVERRIDE_RANGES, sceneOverrideRange, TASK_FAMILY_SPECS, isTaskFamily, type SceneOverrideKey } from "@forksafe/contracts";
import { useClient } from "../hooks";
import type { InvestigationWorkspace } from "../services";
import { challengesFor, removeChallenge, saveChallenge, type ChallengeRequest } from "./challengeCase";
import { useBrowserAccess } from "../services/browserAccess";
import styles from "./ChallengeCaseForm.module.css";

const addChallenge = makeFunctionReference<"mutation", {
  investigationId: string;
  candidateId: string;
  seed: number;
  sceneOverrides: Record<string, number>;
  note: string;
}, { caseId: string; status: "pending_physics" }>("challengeRequests:add");

const WAITING = "Waiting for a physics run. This does not pass or fail the candidate.";
const sentChallengeIds = new Set<string>();

function isOverrideKey(key: string): key is SceneOverrideKey {
  return Object.prototype.hasOwnProperty.call(SCENE_OVERRIDE_RANGES, key);
}

function fieldKeys(workspace: InvestigationWorkspace): string[] {
  const present = Object.keys(workspace.investigation.baselineCase.sceneOverrides);
  if (present.length > 0) return present;
  const family = workspace.investigation.baselineCase.taskFamily;
  const known = isTaskFamily(family) ? family : DEFAULT_TASK_FAMILY;
  return [...TASK_FAMILY_SPECS[known].overrideKeys];
}

function initialOverrides(workspace: InvestigationWorkspace): Record<string, number> {
  const baseline = workspace.investigation.baselineCase.sceneOverrides;
  return Object.fromEntries(fieldKeys(workspace).map((key) => {
    const value = baseline[key];
    return [key, typeof value === "number" && Number.isFinite(value) ? value : SCENE_DEFAULTS[key as SceneOverrideKey]];
  }));
}

export function ChallengeCaseForm({ workspace, candidateId }: { workspace: InvestigationWorkspace; candidateId: string }) {
  const client = useClient();
  const access = useBrowserAccess();
  const investigationId = workspace.investigation.id;
  const seed = workspace.investigation.baselineCase.seed;
  const taskFamily = isTaskFamily(workspace.investigation.baselineCase.taskFamily)
    ? workspace.investigation.baselineCase.taskFamily
    : DEFAULT_TASK_FAMILY;
  const keys = fieldKeys(workspace);
  const [note, setNote] = useState("");
  const [overrides, setOverrides] = useState<Record<string, number>>(() => initialOverrides(workspace));
  const [pending, setPending] = useState<ChallengeRequest[]>(() => challengesFor(investigationId).filter((item) => item.candidateId === candidateId));
  const [draft, setDraft] = useState<ChallengeRequest | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = note.trim().slice(0, 280);
    if (!trimmed) {
      setFormError("Write a note for this case.");
      return;
    }
    const createdAtMs = Date.now();
    const request: ChallengeRequest = {
      id: crypto.randomUUID(),
      investigationId,
      candidateId,
      caseId: `challenge-${createdAtMs}`,
      seed,
      sceneOverrides: overrides,
      note: trimmed,
      status: "pending_physics",
      createdAtMs,
    };
    if (access.canOperate === false) {
      setFormError("An operator seat asks for a case. This request was not saved.");
      return;
    }
    saveChallenge(request);
    setPending(challengesFor(investigationId).filter((item) => item.candidateId === candidateId));
    setDraft(client.source.kind === "convex" ? request : null);
    setNote("");
    setFormError(null);
  };

  if (access.canOperate === false) {
    return <p data-testid="challenge-case">An operator seat can ask for another case. Reviewers can accept or refuse the hash on screen.</p>;
  }

  return (
    <form className={styles.form} data-testid="challenge-case" onSubmit={submit}>
      <h3>Ask for a case</h3>
      <label className={styles.field}>
        Note
        <textarea value={note} maxLength={280} rows={3} required onChange={(event) => setNote(event.target.value)} />
      </label>
      <div className={styles.grid}>
        {keys.map((key) => {
          const range = isOverrideKey(key) ? sceneOverrideRange(taskFamily, key) : undefined;
          return (
            <label className={styles.field} key={key}>
              {range?.label ?? key}
              <input
                type="number"
                inputMode="decimal"
                step={range?.step ?? "any"}
                min={range?.min}
                max={range?.max}
                value={Number.isFinite(overrides[key]) ? overrides[key] : 0}
                onChange={(event) => {
                  const next = event.currentTarget.value === "" ? 0 : Number(event.currentTarget.value);
                  setOverrides((current) => ({ ...current, [key]: Number.isFinite(next) ? next : 0 }));
                }}
              />
            </label>
          );
        })}
      </div>
      <p className={styles.note}>Seed {seed}</p>
      <button type="submit" className="primary" disabled={note.trim().length === 0}>Ask for this case</button>
      {formError && <p role="alert">{formError}</p>}
      {client.source.kind === "convex" && (
        <ConvexChallengeBridge
          draft={draft}
          onFailure={(id) => setPending((current) => current.filter((item) => item.id !== id))}
        />
      )}
      {pending.length > 0 && (
        <>
          <ul className={styles.list}>
            {pending.map((item) => <li key={item.id}>{item.caseId}: {item.note}</li>)}
          </ul>
          <p>{WAITING}</p>
        </>
      )}
    </form>
  );
}

function ConvexChallengeBridge({ draft, onFailure }: { draft: ChallengeRequest | null; onFailure: (id: string) => void }) {
  const add = useMutation(addChallenge);
  const [error, setError] = useState<string | null>(null);
  const sent = useRef<string | null>(null);
  useEffect(() => {
    if (!draft || sent.current === draft.id || sentChallengeIds.has(draft.id)) return;
    sent.current = draft.id;
    let live = true;
    setError(null);
    void add({
      investigationId: draft.investigationId,
      candidateId: draft.candidateId,
      seed: draft.seed,
      sceneOverrides: draft.sceneOverrides,
      note: draft.note,
    }).then(() => {
      if (live) sentChallengeIds.add(draft.id);
    }).catch(() => {
      if (!live) return;
      removeChallenge(draft.investigationId, draft.id);
      onFailure(draft.id);
      setError("The server did not store this case. It was not recorded.");
    });
    return () => {
      live = false;
    };
  }, [add, draft, onFailure]);
  return error ? <p role="alert">{error}</p> : null;
}
