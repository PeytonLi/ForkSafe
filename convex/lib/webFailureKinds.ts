import { FailureKind } from "@forksafe/contracts";

const known = new Set<string>(FailureKind.options);

/** The workspace contract only accepts simulator failure kinds. A capture
 *  rejection such as controller_sha_mismatch is stored on the experiment too;
 *  show it as invalid_run so the page can load. */
export function webFailureKinds(kinds: readonly string[] | undefined): string[] {
  return (kinds ?? []).map((kind) => known.has(kind) ? kind : "invalid_run");
}
