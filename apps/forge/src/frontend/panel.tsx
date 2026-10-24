import React, { useEffect, useState } from "react";
import { invoke } from "@forge/bridge";
import ForgeReconciler, {
  Button,
  DynamicTable,
  Heading,
  Label,
  Link,
  Lozenge,
  SectionMessage,
  Select,
  Spinner,
  Stack,
  Text,
  TextArea,
} from "@forge/react";
import type { ReviewDecision } from "@forksafe/contracts";
import type { PanelData } from "@forksafe/integrations-atlassian";

type ResolverResult<T> =
  | { ok: true; mode: string; data: T }
  | { ok: false; code: string; message: string };

function Panel() {
  const [result, setResult] = useState<ResolverResult<PanelData>>();
  const [decision, setDecision] = useState<ReviewDecision>("approved");
  const [notes, setNotes] = useState("");
  const [reviewResult, setReviewResult] = useState<ResolverResult<{
    reviewId: string;
    recorded: boolean;
  }>>();
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    void invoke<ResolverResult<PanelData>>("getPanel").then((response) =>
      setResult(invokeResult(response)),
    );
  }, []);

  async function submitReview() {
    const data = result?.ok ? result.data : undefined;
    if (!data?.investigation || !data.underReview) return;
    setSubmitting(true);
    setReviewResult(undefined);
    try {
      const response = await invoke<
          ResolverResult<{ reviewId: string; recorded: boolean }>
        >("submitReview", {
          investigationId: data.investigation.id,
          candidateId: data.underReview.candidateId,
          evaluationId: data.underReview.evaluationId,
          controllerSha256: data.underReview.controllerSha256,
          decision,
          notes,
        });
      setReviewResult(invokeResult(response));
    } catch {
      setReviewResult({
        ok: false,
        code: "backend_error",
        message: "The review could not be submitted.",
      });
    } finally {
      setSubmitting(false);
    }
  }

  if (!result) return <Spinner label="Loading ForkSafe investigation" />;
  if (!result.ok) {
    return (
      <SectionMessage appearance="error" title={result.code}>
        <Text>{result.message}</Text>
      </SectionMessage>
    );
  }

  const data = result.data;
  const candidateRows = data.candidates.map(({ candidate, evaluation, passedCases, totalCases }) => ({
    key: candidate.id,
    cells: [
      { key: "candidate", content: candidate.id.slice(0, 8) },
      { key: "sha", content: candidate.controllerSha256.slice(0, 12) },
      { key: "status", content: candidate.status },
      { key: "cases", content: `${passedCases}/${totalCases}` },
      {
        key: "median",
        content: evaluation?.medianCompletionTimeSec === undefined
          ? "—"
          : `${evaluation.medianCompletionTimeSec.toFixed(1)} s`,
      },
    ],
  }));
  const tableHead = {
    cells: [
      { key: "candidate", content: "Candidate" },
      { key: "sha", content: "SHA-256" },
      { key: "status", content: "Status" },
      { key: "cases", content: "Passed / total" },
      { key: "median", content: "Median" },
    ],
  };

  return (
    <Stack space="space.200">
      <Stack alignInline="start" space="space.100">
        <Heading as="h2">ForkSafe investigation</Heading>
        <Lozenge>{data.mode}</Lozenge>
      </Stack>
      {data.mode !== "live" && (
        <SectionMessage appearance="information">
          <Text>Fixture data — not a live investigation</Text>
        </SectionMessage>
      )}
      <Heading as="h3">Integration readiness</Heading>
      {data.readiness.map((item) => (
        <Text key={item.name}>
          {item.name}: {item.mode}
          {item.detail ? ` — ${item.detail}` : ""}
        </Text>
      ))}

      {!data.investigation ? (
        <SectionMessage appearance="information">
          <Text>Use the issue action &apos;Start ForkSafe investigation&apos;.</Text>
        </SectionMessage>
      ) : (
        <>
          <Heading as="h3">{data.investigation.title}</Heading>
          <Text>State: {data.investigation.state}</Text>
          <Text>Environments requested: {data.investigation.requestedEnvironments}</Text>
          <Text>Findings: {data.findingsCount}</Text>
          <Text>Environments</Text>
          {data.environments.map((environment) => (
            <Text key={environment.id}>
              Environment {environment.index}: {environment.state}
            </Text>
          ))}
          <Text>Candidates</Text>
          {candidateRows.length > 0 ? (
            <DynamicTable head={tableHead} rows={candidateRows} rowsPerPage={10} />
          ) : (
            <Text>No candidates have been submitted.</Text>
          )}
          {data.requirements && (
            <Text>
              Requirements page {data.requirements.pageId}, version {data.requirements.version}
              {" — "}{data.requirements.checkedRules} checked rules,{" "}
              {data.requirements.humanReviewItems} human review items
            </Text>
          )}
          {data.links.investigationUrl && (
            <Link href={data.links.investigationUrl}>Open investigation</Link>
          )}
          {data.links.reportUrl && <Link href={data.links.reportUrl}>Open report</Link>}
          {data.underReview && (
            <Stack space="space.100">
              <Heading as="h3">Review candidate</Heading>
              <Text>Full controller SHA-256: {data.underReview.controllerSha256}</Text>
              <Label labelFor="review-decision">Decision</Label>
              <Select
                inputId="review-decision"
                name="review-decision"
                value={{ label: decision, value: decision }}
                options={[
                  { label: "Approve", value: "approved" },
                  { label: "Reject", value: "rejected" },
                  { label: "Needs changes", value: "needs_changes" },
                ]}
                onChange={(option) =>
                  setDecision(option?.value as ReviewDecision)
                }
              />
              <Label labelFor="review-notes">Review notes</Label>
              <TextArea
                id="review-notes"
                name="review-notes"
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
              />
              <Button
                appearance="primary"
                isDisabled={submitting}
                onClick={submitReview}
              >
                {submitting ? "Submitting…" : "Submit review"}
              </Button>
              {reviewResult && (
                <SectionMessage
                  appearance={reviewResult.ok ? "success" : "error"}
                  title={reviewResult.ok ? "Review result" : reviewResult.code}
                >
                  <Text>
                    {reviewResult.ok
                      ? `Review ${reviewResult.data.reviewId} recorded: ${reviewResult.data.recorded}.`
                      : reviewResult.message}
                  </Text>
                </SectionMessage>
              )}
            </Stack>
          )}
        </>
      )}
    </Stack>
  );
}

function invokeResult<T>(response: T | { body: T }): T {
  return response !== null &&
    typeof response === "object" &&
    "body" in response
    ? response.body as T
    : response as T;
}

ForgeReconciler.render(<Panel />);
