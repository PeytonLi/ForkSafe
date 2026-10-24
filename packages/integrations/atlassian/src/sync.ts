import {
  CandidateId,
  EvaluationStatus,
  Investigation,
  OperationId,
  OutboxEntry,
} from "@forksafe/contracts";
import { z } from "zod";
import { adfDoc, adfParagraph, adfToPlainText } from "./adf.js";
import type { JiraClient, JiraWorkflowMapping } from "./jira.js";

export const JiraSyncInput = z.object({
  operationId: OperationId,
  projectKey: z.string().min(1),
  investigation: Investigation,
  summary: z.object({
    activeEnvironments: z.number().int().nonnegative(),
    findingsCount: z.number().int().nonnegative(),
    candidatesCount: z.number().int().nonnegative(),
    bestEvaluation: z
      .object({
        candidateId: CandidateId,
        controllerSha256: z.string().regex(/^[0-9a-f]{64}$/),
        status: EvaluationStatus,
        allRequiredPassed: z.boolean(),
        passedCases: z.number().int().nonnegative(),
        totalCases: z.number().int().nonnegative(),
      })
      .optional(),
  }),
  investigationUrl: z.string().url().optional(),
  workflow: z
    .object({
      readyForReview: z.object({ statusNames: z.array(z.string()) }).optional(),
      accepted: z.object({ statusNames: z.array(z.string()) }).optional(),
    })
    .optional(),
});
export type JiraSyncInput = z.infer<typeof JiraSyncInput>;

export function investigationLabel(id: string): string {
  return `forksafe-inv-${id}`;
}

export function remoteLinkGlobalId(id: string): string {
  return `forksafe:investigation:${id}`;
}

export function opMarker(opId: OperationId): string {
  return `[forksafe-op:${opId}]`;
}

export const JIRA_ISSUE_PROPERTY = "forksafe.investigation";

export function jiraSyncIdempotencyKey(id: string): string {
  return `jira_sync:${id}`;
}

export function isReadyForReview(input: JiraSyncInput): boolean {
  return (
    input.investigation.state === "awaiting_review" &&
    input.summary.bestEvaluation?.status === "passed" &&
    input.summary.bestEvaluation.allRequiredPassed
  );
}

export type JiraSyncTransition =
  | { applied: true; transitionId: string; name: string }
  | { applied: false; reason: string; available?: string[] };

export type JiraSyncResult = {
  issueKey: string;
  issueId: string;
  created: boolean;
  reconciled: boolean;
  commentAdded: boolean;
  remoteLinkUpserted: boolean;
  propertyUpdated: boolean;
  transition: JiraSyncTransition;
  duplicates: string[];
};

export async function syncInvestigationToJira(
  client: JiraClient,
  unparsed: JiraSyncInput,
): Promise<JiraSyncResult> {
  const input = JiraSyncInput.parse(unparsed);
  const label = investigationLabel(input.investigation.id);
  const duplicates: string[] = [];
  let issue: { id: string; key: string };
  let created = false;
  let reconciled = false;
  if (input.investigation.jiraIssueKey) {
    const existing = await client.getIssue(input.investigation.jiraIssueKey, [
      "status",
      "labels",
    ]);
    issue = { id: existing.id, key: existing.key };
    if (!existing.fields?.labels?.includes(label)) {
      await client.updateIssue(issue.key, { addLabels: [label] });
    }
  } else {
    const found = await client.searchJql(
      `project = "${input.projectKey}" AND labels = "${label}" ORDER BY created ASC`,
      ["status", "labels"],
    );
    if (found.length > 0) {
      issue = { id: found[0]!.id, key: found[0]!.key };
      duplicates.push(...found.slice(1).map((item) => item.key));
      reconciled = true;
    } else {
      issue = await client.createIssue({
        projectKey: input.projectKey,
        summary: input.investigation.title,
        description: adfDoc(
          adfParagraph(`ForkSafe investigation ${input.investigation.id}`),
        ),
        labels: [label],
      });
      created = true;
    }
  }

  const issueState = await client.getIssue(issue.key, ["status", "labels"]);
  if (!issueState.fields?.labels?.includes(label)) {
    await client.updateIssue(issue.key, { addLabels: [label] });
  }

  let remoteLinkUpserted = false;
  if (input.investigationUrl) {
    await client.upsertRemoteLink(issue.key, {
      globalId: remoteLinkGlobalId(input.investigation.id),
      url: input.investigationUrl,
      title: "ForkSafe investigation",
      summary: input.investigation.title,
    });
    remoteLinkUpserted = true;
  }

  const marker = opMarker(input.operationId);
  const existingComments = await client.listComments(issue.key);
  const alreadyCommented = existingComments.some((comment) =>
    adfToPlainText((comment as { body?: unknown }).body ?? comment).includes(marker),
  );
  let commentAdded = false;
  if (!alreadyCommented) {
    const paragraphs = [
      `Investigation state: ${input.investigation.state}`,
      `Active environments: ${input.summary.activeEnvironments}`,
      `Findings: ${input.summary.findingsCount}`,
      `Candidates: ${input.summary.candidatesCount}`,
    ];
    const best = input.summary.bestEvaluation;
    if (best) {
      paragraphs.push(
        `Best evaluation: candidate ${best.candidateId}; status ${best.status}; all required passed ${best.allRequiredPassed}; cases ${best.passedCases}/${best.totalCases}; controller SHA-256 ${best.controllerSha256}`,
      );
    }
    paragraphs.push(marker);
    await client.addComment(
      issue.key,
      adfDoc(...paragraphs.map((text) => adfParagraph(text))),
    );
    commentAdded = true;
  }

  const priorProperty = (await client.getIssueProperty(
    issue.key,
    JIRA_ISSUE_PROPERTY,
  )) as { lastOperationId?: string } | null;
  let propertyUpdated = false;
  if (priorProperty?.lastOperationId !== input.operationId) {
    await client.setIssueProperty(issue.key, JIRA_ISSUE_PROPERTY, {
      investigationId: input.investigation.id,
      lastOperationId: input.operationId,
      investigationUpdatedAtMs: input.investigation.updatedAtMs,
    });
    propertyUpdated = true;
  }

  const transition = await updateWorkflow(client, issue.key, issueState, input);
  return {
    issueKey: issue.key,
    issueId: issue.id,
    created,
    reconciled,
    commentAdded,
    remoteLinkUpserted,
    propertyUpdated,
    transition,
    duplicates,
  };
}

export async function syncFromOutbox(
  client: JiraClient,
  entry: OutboxEntry,
): Promise<JiraSyncResult> {
  if (entry.destination !== "jira_sync") {
    throw new Error(`Outbox destination must be jira_sync, received ${entry.destination}.`);
  }
  const input = JiraSyncInput.parse(entry.payload);
  if (input.operationId !== entry.operationId) {
    throw new Error("Outbox operationId does not match its Jira sync payload.");
  }
  return syncInvestigationToJira(client, input);
}

async function updateWorkflow(
  client: JiraClient,
  issueKey: string,
  issue: { fields?: { status?: { name?: string } } },
  input: JiraSyncInput,
): Promise<JiraSyncTransition> {
  const mapping: JiraWorkflowMapping["readyForReview"] =
    input.workflow?.readyForReview;
  if (!mapping) return { applied: false, reason: "not_configured" };
  if (!isReadyForReview(input)) {
    return { applied: false, reason: "evidence_incomplete" };
  }
  const matches = (name: string | undefined) =>
    name !== undefined &&
    mapping.statusNames.some((candidate) => candidate.toLowerCase() === name.toLowerCase());
  const currentStatus = issue.fields?.status?.name;
  if (matches(currentStatus)) {
    return { applied: false, reason: "already_in_status" };
  }
  const transitions = await client.getTransitions(issueKey);
  const available = transitions.flatMap((item) =>
    [item.name, item.to?.name].filter((name): name is string => Boolean(name)),
  );
  const transition = transitions.find(
    (item) => matches(item.name) || matches(item.to?.name),
  );
  if (!transition) {
    return { applied: false, reason: "no_matching_transition", available };
  }
  await client.transitionIssue(issueKey, transition.id);
  return {
    applied: true,
    transitionId: transition.id,
    name: transition.to?.name ?? transition.name,
  };
}
