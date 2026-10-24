export function deriveCandidateStatus(input: {
  tombstoned: boolean;
  evaluations: readonly { status: string }[];
  reviews: readonly { decision: string }[];
}): "submitted" | "evaluating" | "evaluated" | "rejected" | "withdrawn" {
  if (input.tombstoned) return "withdrawn";
  if (input.reviews.some((review) => review.decision === "rejected")) return "rejected";
  if (input.evaluations.some((evaluation) => ["passed", "failed", "invalid"].includes(evaluation.status))) {
    return "evaluated";
  }
  if (input.evaluations.some((evaluation) => ["queued", "running"].includes(evaluation.status))) {
    return "evaluating";
  }
  return "submitted";
}
