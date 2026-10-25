import { useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { fmtTime, useClient } from "../hooks";
import type { InvestigationWorkspace } from "../services";
import { buildCaseFile, type CaseFileFailure, type CaseFileSuite } from "./caseFile";
import { Badge } from "./Panel";
import { human, stateTone } from "./tone";
import styles from "./CaseFile.module.css";

interface StoredChallenge {
  id: string;
  candidateId: string;
  caseId: string;
  note: string;
  status: "pending_physics";
  sceneOverrides: Record<string, number>;
  seed?: number;
  createdAtMs?: number;
}

const listChallenges = makeFunctionReference<"query", { investigationId: string }, StoredChallenge[]>("challengeRequests:list");

export function CaseFile({ workspace }: { workspace: InvestigationWorkspace }) {
  const client = useClient();
  const file = buildCaseFile(workspace);
  return (
    <div className={styles.column} data-testid="case-file">
      <header className={styles.card}>
        <p className={styles.eyebrow}>Case file</p>
        <h2>{file.title}</h2>
        <p className={styles.meta}>
          <Badge tone={stateTone(file.state)}>{human(file.state)}</Badge>
          <span>Task family {human(file.taskFamily)}</span>
        </p>
        <dl className={styles.dl}>
          <dt>Investigation</dt>
          <dd><code className={styles.hash}>{file.investigationId}</code></dd>
          <dt>Baseline case</dt>
          <dd>{file.baseline.caseId}</dd>
          <dt>Seed</dt>
          <dd>{file.baseline.seed}</dd>
          <dt>Scene overrides</dt>
          <dd>
            {file.baseline.sceneOverrides.length === 0 ? (
              <span className={styles.muted}>None recorded</span>
            ) : (
              <span className={styles.overrides}>
                {file.baseline.sceneOverrides.map(([key, value]) => (
                  <span key={key} className={styles.override}><code>{key}</code> {value}</span>
                ))}
              </span>
            )}
          </dd>
        </dl>
      </header>

      <section className={styles.card} aria-labelledby="case-failure">
        <h3 id="case-failure">Captured failure</h3>
        <Failure failure={file.failure} />
      </section>

      <section className={styles.card} aria-labelledby="case-candidates">
        <h3 id="case-candidates">Candidates</h3>
        {file.candidates.length === 0 ? (
          <p className={styles.muted}>No candidates recorded.</p>
        ) : (
          <ol className={styles.stack}>
            {file.candidates.map((candidate) => (
              <li key={candidate.id} className={styles.block}>
                <h4>Candidate <code>{candidate.id}</code></h4>
                <p className={styles.meta}>
                  <Badge tone={stateTone(candidate.status)}>{human(candidate.status)}</Badge>
                  <span>
                    {candidate.environmentIndex === null
                      ? "Environment index not recorded"
                      : `Environment index ${candidate.environmentIndex}`}
                  </span>
                </p>
                <p className={styles.hashLine}>
                  Controller <code className={styles.hash}>{candidate.controllerSha256}</code>
                </p>
                {candidate.suites.length === 0 ? (
                  <p className={styles.muted}>No evaluation recorded.</p>
                ) : candidate.suites.map((suite, index) => <Suite key={`${suite.suite}-${index}`} suite={suite} />)}
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className={styles.card} aria-labelledby="case-reviews">
        <h3 id="case-reviews">Reviews</h3>
        {file.reviews.length === 0 ? (
          <p className={styles.muted}>No review recorded.</p>
        ) : (
          <ul className={styles.reviews}>
            {file.reviews.map((review, index) => (
              <li key={`${review.controllerSha256}-${review.createdAtMs}-${index}`} className={styles.review}>
                <p className={styles.meta}>
                  <Badge tone={stateTone(review.decision)}>{human(review.decision)}</Badge>
                  <time dateTime={new Date(review.createdAtMs).toISOString()}>{fmtTime(review.createdAtMs)}</time>
                </p>
                <p className={styles.hashLine}>
                  Controller <code className={styles.hash}>{review.controllerSha256}</code>
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={styles.card} aria-labelledby="case-challenges">
        <h3 id="case-challenges">Pending challenges</h3>
        {client.source.kind === "convex"
          ? <ServerChallenges investigationId={file.investigationId} />
          : <ChallengeItems challenges={file.challenges} />}
      </section>

      <section className={styles.card} aria-labelledby="case-limits">
        <h3 id="case-limits">What this result does not prove</h3>
        <ul className={styles.limits}>
          {file.limits.map((limit) => <li key={limit}>{limit}</li>)}
        </ul>
      </section>
    </div>
  );
}

function ChallengeItems({ challenges }: { challenges: StoredChallenge[] }) {
  if (challenges.length === 0) return <p className={styles.muted}>No challenge is waiting for physics.</p>;
  return (
    <ul className={styles.stack}>
      {challenges.map((challenge) => (
        <li key={challenge.id} className={styles.block}>
          <p className={styles.meta}><Badge tone="amber">Waiting for physics</Badge></p>
          <p>
            Case <code>{challenge.caseId}</code> for candidate <code>{challenge.candidateId}</code>
            {challenge.seed !== undefined ? <> · seed {challenge.seed}</> : null}
            {challenge.createdAtMs !== undefined ? <> · <time dateTime={new Date(challenge.createdAtMs).toISOString()}>{fmtTime(challenge.createdAtMs)}</time></> : null}
          </p>
          {challenge.note ? <p className={styles.note}>{challenge.note}</p> : null}
          {Object.keys(challenge.sceneOverrides).length > 0 && (
            <ul className={styles.cases}>
              {Object.entries(challenge.sceneOverrides).map(([key, value]) => (
                <li key={key}><code>{key}</code> {value}</li>
              ))}
            </ul>
          )}
        </li>
      ))}
    </ul>
  );
}

function ServerChallenges({ investigationId }: { investigationId: string }) {
  const rows = useQuery(listChallenges, { investigationId });
  if (rows === undefined) return <p className={styles.muted}>Loading recorded challenges.</p>;
  return <ChallengeItems challenges={rows} />;
}

function Failure({ failure }: { failure: CaseFileFailure }) {
  if (!failure.recorded) return <p className={styles.muted}>{failure.summary}</p>;
  return (
    <>
      <p className={styles.meta}>
        <Badge tone={failure.completed ? "green" : "red"}>{failure.completed ? "Completed" : "Did not complete"}</Badge>
        {failure.kinds.map((kind, index) => (
          <Badge key={`${kind}-${index}`} tone={stateTone(kind)}>{human(kind)}</Badge>
        ))}
      </p>
      <dl className={styles.dl}>
        <dt>Experiment</dt>
        <dd><code className={styles.hash}>{failure.experimentId}</code></dd>
        {failure.completionTimeSec !== undefined && (
          <>
            <dt>Completion time</dt>
            <dd>{failure.completionTimeSec} s</dd>
          </>
        )}
      </dl>
    </>
  );
}

function Suite({ suite }: { suite: CaseFileSuite }) {
  return (
    <div className={styles.suite}>
      <p className={styles.meta}>
        <strong>{human(suite.suite)} suite</strong>
        <Badge tone={suite.allRequiredPassed ? "green" : "red"}>
          {suite.allRequiredPassed ? "All required passed" : "Failed cases"}
        </Badge>
      </p>
      {suite.failureKinds.length > 0 && (
        <p className={styles.note}>Failure kinds: {suite.failureKinds.map((kind) => human(kind)).join(", ")}</p>
      )}
      <ul className={styles.cases}>
        {suite.cases.map((item, index) => (
          <li key={`${item.caseId}-${index}`} className={styles.caseRow}>
            <code>{item.caseId}</code>
            <Badge tone={stateTone(item.status)}>{human(item.status)}</Badge>
            {item.failureKinds.length > 0 && <span>{item.failureKinds.map((kind) => human(kind)).join(", ")}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}
