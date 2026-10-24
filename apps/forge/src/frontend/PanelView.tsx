import React from "react";
import {
  Button,
  CodeBlock,
  Heading,
  Label,
  Link,
  Lozenge,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  ModalTitle,
  ModalTransition,
  RadioGroup,
  SectionMessage,
  Spinner,
  Stack,
  Text,
  TextArea,
} from "@forge/react";
import type { ReviewDecision } from "@forksafe/contracts";
import type { PanelData } from "@forksafe/integrations-atlassian";
import {
  approveBlockedReason,
  dataSourceLabel,
  friendlyError,
  shortSha,
  statusLabel,
  verdict,
  type CandidateEvaluation,
} from "./panel-model";

type ResolverResult<T> =
  | { ok: true; mode: string; data: T }
  | { ok: false; code: string; message: string };

export type ReviewDetails = {
  candidateId: string;
  controllerSha256: string;
  changedFunctions: string[];
  rationale?: string;
  evaluation: {
    id: string;
    suite: "public" | "withheld";
    status: string;
    allRequiredPassed: boolean;
    passedCases: number;
    failedCases: number;
    totalCases: number;
    failedCaseIds?: string[];
  };
  evidencePackUrl?: string;
};

export type PanelViewProps = {
  result?: ResolverResult<PanelData>;
  reviewDetails?: ResolverResult<ReviewDetails>;
  selectedCandidateId: string;
  decision: ReviewDecision;
  notes: string;
  reviewResult?: ResolverResult<{ reviewId: string; recorded: boolean }>;
  submittingReview: boolean;
  confirmingReview: boolean;
  investigationNote: string;
  extraEnvironments?: number;
  investigationResult?: ResolverResult<{ requestId: string; accepted: boolean }>;
  submittingInvestigation: boolean;
  onSelectCandidate(candidateId: string): void;
  onDecisionChange(decision: ReviewDecision): void;
  onNotesChange(notes: string): void;
  onSubmitReview(): void;
  onConfirmReview(): void;
  onCloseReviewConfirmation(): void;
  onInvestigationNoteChange(note: string): void;
  onExtraEnvironmentsChange(value?: number): void;
  onRequestInvestigation(): void;
};

export function PanelView(props: PanelViewProps) {
  const data = props.result?.ok ? props.result.data : undefined;
  if (!props.result) return <Spinner label="Loading your ForkSafe investigation" />;
  if (!props.result.ok) {
    const title =
      props.result.code === "unauthorized" || props.result.code === "unauthenticated"
        ? "Sign-in needed"
        : props.result.code === "forbidden"
          ? "Access needed"
          : "We couldn't load this issue";
    return (
      <SectionMessage appearance="error" title={title}>
        <Text>{friendlyError(props.result.code)}</Text>
      </SectionMessage>
    );
  }
  if (!data?.investigation) {
    return (
      <Stack space="space.200">
        <Heading as="h2">ForkSafe investigation</Heading>
        <SectionMessage appearance="information">
          <Text>
            No ForkSafe investigation is linked to this issue yet. Use the Start
            ForkSafe investigation action.
          </Text>
        </SectionMessage>
      </Stack>
    );
  }

  const investigation = data.investigation;
  const candidates = data.candidates.filter(({ evaluation }) => evaluation);
  const selected = data.candidates.find(
    ({ candidate }) => candidate.id === props.selectedCandidateId,
  );
  const selectedEvaluation = selected?.evaluation as CandidateEvaluation | null | undefined;
  const blockedReason = approveBlockedReason(selectedEvaluation);
  const evidencePackUrl =
    (props.reviewDetails?.ok && props.reviewDetails.data.evidencePackUrl) ||
    data.links.evidencePackUrl;
  const candidateInvestigationUrl =
    data.links.investigationUrl ?? data.links.webAppUrl;
  const investigationUrl = candidateInvestigationUrl?.startsWith("https://")
    ? candidateInvestigationUrl
    : undefined;
  const requestError =
    props.investigationResult && !props.investigationResult.ok
      ? props.investigationResult
      : undefined;

  return (
    <Stack space="space.300">
      <Stack space="space.100">
        <Heading as="h2">{investigation.title}</Heading>
        <Lozenge appearance="inprogress">
          {statusLabel(investigation.state)}
        </Lozenge>
        <Text>{dataSourceLabel(data.mode)}</Text>
      </Stack>

      {data.candidates.map((item) => {
        if (!item.evaluation) return null;
        const summary = verdict(item);
        return (
          <Stack key={item.candidate.id} space="space.100">
            <Heading as="h3">Candidate {shortSha(item.candidate.controllerSha256)}</Heading>
            <SectionMessage
              appearance={summary.passed ? "success" : "warning"}
              title={summary.label}
            >
              <Stack space="space.100">
                {summary.suites.map((suite, index) => (
                  <Stack key={`${suite.suite}-${index}`} space="space.050">
                    <Text>
                      {suite.suite === "withheld" ? "Withheld checks" : "Public checks"}:{" "}
                      {suite.passedCases} of {suite.totalCases} passed
                      {suite.failedCases > 0
                        ? `, ${suite.failedCases} failed`
                        : ""}
                    </Text>
                    {suite.suite === "public" &&
                      suite.failedCaseIds &&
                      suite.failedCaseIds.length > 0 && (
                        <Text>
                          Failed cases: {suite.failedCaseIds.join(", ")}
                        </Text>
                      )}
                  </Stack>
                ))}
              </Stack>
            </SectionMessage>
            <Text>Controller SHA-256: {shortSha(item.candidate.controllerSha256)}</Text>
            <Text>Select the full SHA-256 below to copy it.</Text>
            <CodeBlock text={item.candidate.controllerSha256} language="text" />
          </Stack>
        );
      })}

      {data.findings && data.findings.length > 0 && (
        <Stack space="space.100">
          <Heading as="h3">Findings and evidence</Heading>
          {data.findings.map((finding) => (
            <Stack key={finding.id} space="space.050">
              <Text>{finding.summary}</Text>
              <Text>
                {finding.kind} ·{" "}
                {finding.citations
                  .map((citation) =>
                    [
                      citation.kind,
                      citation.artifactId
                        ? `artifact ${shortSha(citation.artifactId)}`
                        : undefined,
                      citation.experimentId
                        ? `experiment ${shortSha(citation.experimentId)}`
                        : undefined,
                    ]
                      .filter(Boolean)
                      .join(" · "),
                  )
                  .join("; ")}
              </Text>
            </Stack>
          ))}
        </Stack>
      )}

      <Stack space="space.100">
        {investigationUrl && (
          <Link href={investigationUrl} openNewTab>
            Open in ForkSafe
          </Link>
        )}
        {evidencePackUrl && (
          <Link href={evidencePackUrl} openNewTab>
            Download evidence pack
          </Link>
        )}
      </Stack>

      {candidates.length === 0 ? (
        <Text>No evaluated candidates are ready for review yet.</Text>
      ) : (
        <Stack space="space.200">
          <Heading as="h3">Review a candidate</Heading>
          <RadioGroup
            name="review-candidate"
            aria-labelledby="review-candidate-label"
            value={props.selectedCandidateId}
            onChange={(event) =>
              props.onSelectCandidate(String(event.target.value ?? ""))
            }
            options={candidates.map(({ candidate }) => ({
              name: candidate.id,
              value: candidate.id,
              label: `${shortSha(candidate.controllerSha256)} · ${candidate.status}`,
            }))}
          />
          {selected && selectedEvaluation && (
            <>
              <Text>
                This review will record SHA-256 {selected.candidate.controllerSha256}{" "}
                and evaluation {selectedEvaluation.id}.
              </Text>
              <RadioGroup
                name="review-decision"
                aria-labelledby="review-decision-label"
                value={props.decision}
                onChange={(event) =>
                  props.onDecisionChange(
                    String(event.target.value) as ReviewDecision,
                  )
                }
                options={[
                  { name: "approved", value: "approved", label: "Approve" },
                  {
                    name: "needs_changes",
                    value: "needs_changes",
                    label: "Request changes",
                  },
                  { name: "rejected", value: "rejected", label: "Reject" },
                ]}
              />
              {props.decision === "approved" && blockedReason && (
                <SectionMessage appearance="warning" title="Approval unavailable">
                  <Text>{blockedReason}</Text>
                </SectionMessage>
              )}
              <Label id="review-notes-label" labelFor="review-notes">
                Review note
              </Label>
              <TextArea
                name="review-notes"
                id="review-notes"
                value={props.notes}
                isRequired
                maxLength={4000}
                aria-labelledby="review-notes-label"
                onChange={(event) =>
                  props.onNotesChange(String(event.target.value ?? ""))
                }
              />
              <Button
                appearance="primary"
                isDisabled={
                  props.submittingReview ||
                  props.notes.trim().length === 0 ||
                  (props.decision === "approved" && Boolean(blockedReason))
                }
                onClick={props.onSubmitReview}
              >
                {props.submittingReview ? "Submitting…" : "Review and submit"}
              </Button>
            </>
          )}
          {props.reviewResult && (
          <SectionMessage
              appearance={props.reviewResult.ok ? "success" : "error"}
              title={props.reviewResult.ok ? "Review recorded" : "Review not submitted"}
            >
              <Text>
                {props.reviewResult.ok
                  ? `Review ${props.reviewResult.data.recorded ? "recorded" : "received"} for ${props.reviewResult.data.reviewId}.`
                  : friendlyError(props.reviewResult.code)}
              </Text>
            </SectionMessage>
          )}
          {props.reviewDetails && !props.reviewDetails.ok && (
            <SectionMessage appearance="error" title="Review details unavailable">
              <Text>{friendlyError(props.reviewDetails.code)}</Text>
            </SectionMessage>
          )}
        </Stack>
      )}

      <Stack space="space.100">
        <Heading as="h3">Ask for more investigation</Heading>
        <Label
          id="investigation-request-note-label"
          labelFor="investigation-request-note"
        >
          What should ForkSafe investigate?
        </Label>
        <TextArea
          name="investigation-request-note"
          id="investigation-request-note"
          value={props.investigationNote}
          isRequired
          maxLength={500}
          aria-labelledby="investigation-request-note-label"
          onChange={(event) =>
            props.onInvestigationNoteChange(String(event.target.value ?? ""))
          }
        />
        <RadioGroup
          name="extra-environments"
          aria-labelledby="extra-environments-label"
          value={props.extraEnvironments === undefined
            ? "none"
            : String(props.extraEnvironments)}
          onChange={(event) => {
            const value = String(event.target.value ?? "none");
            const parsed = value === "none" ? undefined : Number(value);
            props.onExtraEnvironmentsChange(parsed);
          }}
          options={[
            { name: "none", value: "none", label: "No extra environments" },
            { name: "one", value: "1", label: "1 extra environment" },
            { name: "two", value: "2", label: "2 extra environments" },
            { name: "three", value: "3", label: "3 extra environments" },
          ]}
        />
        <Button
          appearance="default"
          isDisabled={
            props.submittingInvestigation ||
            props.investigationNote.trim().length === 0
          }
          onClick={props.onRequestInvestigation}
        >
          {props.submittingInvestigation ? "Sending request…" : "Request investigation"}
        </Button>
        {requestError && (
          <SectionMessage
            appearance={
              requestError.code === "not_available_yet" ? "information" : "error"
            }
            title={
              requestError.code === "not_available_yet"
                ? "Not available yet"
                : "Request not sent"
            }
          >
            <Text>{friendlyError(requestError.code)}</Text>
          </SectionMessage>
        )}
        {props.investigationResult?.ok && (
          <SectionMessage appearance="success" title="Request sent">
            <Text>ForkSafe received your request for more investigation.</Text>
          </SectionMessage>
        )}
      </Stack>

      <ModalTransition>
        {props.confirmingReview && selected && selectedEvaluation && (
          <Modal
            title="Confirm review"
            onClose={props.onCloseReviewConfirmation}
            width="medium"
          >
            <ModalHeader>
              <ModalTitle>Record this review?</ModalTitle>
            </ModalHeader>
            <ModalBody>
              <Stack space="space.100">
                <Text>
                  Decision:{" "}
                  {props.decision === "needs_changes"
                    ? "Request changes"
                    : props.decision === "approved"
                      ? "Approve"
                      : "Reject"}
                </Text>
                <Text>SHA-256: {selected.candidate.controllerSha256}</Text>
                <Text>Evaluation: {selectedEvaluation.id}</Text>
              </Stack>
            </ModalBody>
            <ModalFooter>
              <Button onClick={props.onCloseReviewConfirmation}>Go back</Button>
              <Button
                appearance="primary"
                isDisabled={props.submittingReview}
                onClick={props.onConfirmReview}
              >
                {props.submittingReview ? "Submitting…" : "Confirm review"}
              </Button>
            </ModalFooter>
          </Modal>
        )}
      </ModalTransition>
    </Stack>
  );
}

export type { ResolverResult };
