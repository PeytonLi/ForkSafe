import React, { useEffect, useState } from "react";
import { invoke } from "@forge/bridge";
import ForgeReconciler from "@forge/react";
import type { ReviewDecision } from "@forksafe/contracts";
import type { PanelData } from "@forksafe/integrations-atlassian";
import {
  PanelView,
  type ResolverResult,
  type ReviewDetails,
} from "./PanelView";

type ReviewResponse = { reviewId: string; recorded: boolean };
type InvestigationRequestResponse = { requestId: string; accepted: boolean };

function Panel() {
  const [result, setResult] = useState<ResolverResult<PanelData>>();
  const [reviewDetails, setReviewDetails] =
    useState<ResolverResult<ReviewDetails>>();
  const [selectedCandidateId, setSelectedCandidateId] = useState("");
  const [decision, setDecision] = useState<ReviewDecision>("approved");
  const [notes, setNotes] = useState("");
  const [submitKey, setSubmitKey] = useState(() => globalThis.crypto.randomUUID());
  const [reviewResult, setReviewResult] =
    useState<ResolverResult<ReviewResponse>>();
  const [submittingReview, setSubmittingReview] = useState(false);
  const [confirmingReview, setConfirmingReview] = useState(false);
  const [investigationNote, setInvestigationNote] = useState("");
  const [extraEnvironments, setExtraEnvironments] = useState<number>();
  const [requestSubmitKey, setRequestSubmitKey] = useState(() =>
    globalThis.crypto.randomUUID(),
  );
  const [investigationResult, setInvestigationResult] =
    useState<ResolverResult<InvestigationRequestResponse>>();
  const [submittingInvestigation, setSubmittingInvestigation] = useState(false);

  useEffect(() => {
    let active = true;
    void invoke<ResolverResult<PanelData>>("getPanel")
      .then((response) => {
        if (!active) return;
        const panelResult = invokeResult(response);
        setResult(panelResult);
        if (panelResult.ok) {
          const defaultCandidate =
            panelResult.data.underReview?.candidateId ??
            panelResult.data.candidates.find(({ evaluation }) => evaluation)
              ?.candidate.id ??
            "";
          setSelectedCandidateId(defaultCandidate);
        }
      })
      .catch(() => {
        if (active) {
          setResult({
            ok: false,
            code: "backend_error",
            message: "ForkSafe couldn't load this issue. Try again shortly.",
          });
        }
      });
    return () => {
      active = false;
    };
  }, []);

  const investigationId =
    result?.ok && result.data.investigation
      ? result.data.investigation.id
      : undefined;

  useEffect(() => {
    if (!investigationId || !selectedCandidateId) {
      setReviewDetails(undefined);
      return;
    }
    const candidate = result?.ok
      ? result.data.candidates.find(
          (item) => item.candidate.id === selectedCandidateId,
        )
      : undefined;
    if (!candidate?.evaluation) {
      setReviewDetails(undefined);
      return;
    }
    let active = true;
    setReviewDetails(undefined);
    void invoke<ResolverResult<ReviewDetails>>("getReviewDetails", {
      investigationId,
      candidateId: candidate.candidate.id,
      evaluationId: candidate.evaluation.id,
    })
      .then((response) => {
        if (active) setReviewDetails(invokeResult(response));
      })
      .catch(() => {
        if (active) {
          setReviewDetails({
            ok: false,
            code: "backend_error",
            message: "Review details could not be loaded.",
          });
        }
      });
    return () => {
      active = false;
    };
  }, [investigationId, selectedCandidateId, result]);

  function updateCandidate(candidateId: string) {
    if (candidateId === selectedCandidateId) return;
    setSelectedCandidateId(candidateId);
    setSubmitKey(globalThis.crypto.randomUUID());
    setReviewResult(undefined);
  }

  function updateDecision(nextDecision: ReviewDecision) {
    if (nextDecision === decision) return;
    setDecision(nextDecision);
    setSubmitKey(globalThis.crypto.randomUUID());
    setReviewResult(undefined);
  }

  function updateNotes(nextNotes: string) {
    if (nextNotes === notes) return;
    setNotes(nextNotes);
    setSubmitKey(globalThis.crypto.randomUUID());
    setReviewResult(undefined);
  }

  async function confirmReview() {
    const panel = result?.ok ? result.data : undefined;
    const candidate = panel?.candidates.find(
      (item) => item.candidate.id === selectedCandidateId,
    );
    if (!panel?.investigation || !candidate?.evaluation) return;
    setSubmittingReview(true);
    setReviewResult(undefined);
    try {
      const response = await invoke<ResolverResult<ReviewResponse>>(
        "submitReview",
        {
          investigationId: panel.investigation.id,
          candidateId: candidate.candidate.id,
          evaluationId: candidate.evaluation.id,
          controllerSha256: candidate.candidate.controllerSha256,
          decision,
          notes,
          submitKey,
        },
      );
      setReviewResult(invokeResult(response));
    } catch {
      setReviewResult({
        ok: false,
        code: "backend_error",
        message: "The review could not be submitted.",
      });
    } finally {
      setSubmittingReview(false);
      setConfirmingReview(false);
    }
  }

  function updateInvestigationNote(note: string) {
    if (note === investigationNote) return;
    setInvestigationNote(note);
    setRequestSubmitKey(globalThis.crypto.randomUUID());
    setInvestigationResult(undefined);
  }

  function updateExtraEnvironments(value?: number) {
    if (value === extraEnvironments) return;
    setExtraEnvironments(value);
    setRequestSubmitKey(globalThis.crypto.randomUUID());
    setInvestigationResult(undefined);
  }

  async function requestInvestigation() {
    if (!investigationId) return;
    setSubmittingInvestigation(true);
    setInvestigationResult(undefined);
    try {
      const response = await invoke<
        ResolverResult<InvestigationRequestResponse>
      >("requestMoreInvestigation", {
        investigationId,
        note: investigationNote,
        ...(extraEnvironments === undefined ? {} : { extraEnvironments }),
        submitKey: requestSubmitKey,
      });
      setInvestigationResult(invokeResult(response));
    } catch {
      setInvestigationResult({
        ok: false,
        code: "backend_error",
        message: "The request could not be sent.",
      });
    } finally {
      setSubmittingInvestigation(false);
    }
  }

  return (
    <PanelView
      result={result}
      reviewDetails={reviewDetails}
      selectedCandidateId={selectedCandidateId}
      decision={decision}
      notes={notes}
      reviewResult={reviewResult}
      submittingReview={submittingReview}
      confirmingReview={confirmingReview}
      investigationNote={investigationNote}
      extraEnvironments={extraEnvironments}
      investigationResult={investigationResult}
      submittingInvestigation={submittingInvestigation}
      onSelectCandidate={updateCandidate}
      onDecisionChange={updateDecision}
      onNotesChange={updateNotes}
      onSubmitReview={() => setConfirmingReview(true)}
      onConfirmReview={() => void confirmReview()}
      onCloseReviewConfirmation={() => setConfirmingReview(false)}
      onInvestigationNoteChange={updateInvestigationNote}
      onExtraEnvironmentsChange={updateExtraEnvironments}
      onRequestInvestigation={() => void requestInvestigation()}
    />
  );
}

function invokeResult<T>(response: T | { body: T }): T {
  return response !== null && typeof response === "object" && "body" in response
    ? (response.body as T)
    : (response as T);
}

ForgeReconciler.render(<Panel />);
