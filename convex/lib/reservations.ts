export type ReservationKind = "environment_job" | "sandbox" | "model_turn";
export type ReservationStatus = "active" | "released" | "retained_ambiguous" | "expired";

export function decideReserve(
  kind: ReservationKind,
  activeCount: number,
  limit: number,
): { ok: true } | { ok: false; reason: "capacity_exhausted" } {
  if (activeCount >= limit) return { ok: false, reason: "capacity_exhausted" };
  return { ok: true };
}

export function decideModelTurnReserve(
  activeCount: number,
  activeForSession: number,
  globalLimit = 4,
  sessionLimit = 1,
): { ok: true } | { ok: false; reason: "global_capacity_exhausted" | "session_capacity_exhausted" } {
  if (activeForSession >= sessionLimit) return { ok: false, reason: "session_capacity_exhausted" };
  if (activeCount >= globalLimit) return { ok: false, reason: "global_capacity_exhausted" };
  return { ok: true };
}

export function countsTowardCapacity(status: ReservationStatus): boolean {
  return status === "active" || status === "retained_ambiguous";
}

export function reservationStatusAfterSandboxOperation(
  operationStatus: string,
  currentStatus: ReservationStatus,
): ReservationStatus {
  if (operationStatus === "terminated") return "released";
  if (operationStatus === "ambiguous_create" || operationStatus === "ambiguous_terminate") {
    return "retained_ambiguous";
  }
  return currentStatus;
}
