export type MemberRole = "lead" | "operator" | "reviewer";

/** Absent, missing user, or an unknown string stays a lead so a bad value cannot lock the account out. */
export function roleOf(user: { memberRole?: string } | null | undefined): MemberRole {
  const role = user?.memberRole;
  return role === "operator" || role === "reviewer" || role === "lead" ? role : "lead";
}

export function mayOperate(role: MemberRole): boolean {
  return role === "lead" || role === "operator";
}

export function mayReview(role: MemberRole): boolean {
  return role === "lead" || role === "reviewer";
}
