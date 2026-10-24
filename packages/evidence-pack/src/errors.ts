export type EvidencePackErrorCode =
  | "invalid_bundle"
  | "hash_mismatch"
  | "review_version_mismatch"
  | "reference_error"
  | "evaluation_inconsistent"
  | "mode_mismatch"
  | "input_too_large";

/** Typed refusal. `issues` are already redacted and never contain bundle
 *  values beyond ids/paths, so they are safe to log. */
export class EvidencePackError extends Error {
  readonly code: EvidencePackErrorCode;
  readonly issues: readonly string[];
  constructor(code: EvidencePackErrorCode, issues: readonly string[]) {
    super(`evidence pack refused (${code}): ${issues.slice(0, 5).join("; ")}${issues.length > 5 ? ` (+${issues.length - 5} more)` : ""}`);
    this.name = "EvidencePackError";
    this.code = code;
    this.issues = issues;
  }
}
