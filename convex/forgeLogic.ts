import {
  fitFromAuthorizationHeader,
  normalizeForgeInstallationId,
  verifyForgeInvocationToken,
  type ForgeInvocationContext,
} from "../packages/integrations/atlassian/src/index.js";

export type ForgeRequestEnvironment = Record<string, string | undefined>;
export type ForgeAuthResult =
  | { ok: true; context: ForgeInvocationContext }
  | { ok: false; status: 401 | 403 | 503; error: string };

export async function authenticateForgeRequest(
  authorization: string | undefined,
  env: ForgeRequestEnvironment,
  verify: (token: string, appId: string) => Promise<ForgeInvocationContext> =
    (token, appId) => verifyForgeInvocationToken(token, { appId }),
): Promise<ForgeAuthResult> {
  let context: ForgeInvocationContext;
  try {
    context = await verify(
      fitFromAuthorizationHeader(authorization),
      env.FORGE_APP_ID ?? "66bb7292-9ddc-4529-aa0f-db7b15fc667a",
    );
  } catch {
    return { ok: false, status: 401, error: "unauthorized" };
  }

  const allowlist = env.FORGE_ALLOWED_INSTALLATION_IDS
    ?.split(",")
    .map((value) => normalizeForgeInstallationId(value.trim()))
    .filter(Boolean);
  if (!allowlist?.length || !env.ATLASSIAN_PROJECT_KEY) {
    return { ok: false, status: 503, error: "forge_not_configured" };
  }
  if (!allowlist.includes(normalizeForgeInstallationId(context.installationId))) {
    return { ok: false, status: 403, error: "forbidden" };
  }
  return { ok: true, context };
}

export function authorizeForgeContext(
  context: ForgeInvocationContext,
  body: Record<string, unknown>,
  projectKey: string | undefined,
  investigation?: { jiraIssueKey?: string },
  { skipIssueCheck = false }: { skipIssueCheck?: boolean } = {},
): { ok: true } | { ok: false; status: 403 | 503; error: string } {
  if (!projectKey) return { ok: false, status: 503, error: "forge_not_configured" };
  const bodyProject = typeof body.projectKey === "string" ? body.projectKey : undefined;
  const expectedProject = bodyProject ?? context.projectKey;
  if (!expectedProject || expectedProject !== projectKey) {
    return { ok: false, status: 403, error: "forbidden" };
  }
  if (context.projectKey && context.projectKey !== projectKey) {
    return { ok: false, status: 403, error: "forbidden" };
  }
  if (bodyProject && context.projectKey && bodyProject !== context.projectKey) {
    return { ok: false, status: 403, error: "forbidden" };
  }

  const review = body.review && typeof body.review === "object"
    ? body.review as Record<string, unknown>
    : undefined;
  const bodyIssue = investigation
    ? investigation.jiraIssueKey
    : typeof body.issueKey === "string"
      ? body.issueKey
      : typeof review?.jiraIssueKey === "string"
        ? review.jiraIssueKey
        : undefined;
  if (!skipIssueCheck && context.issueKey && (!bodyIssue || bodyIssue !== context.issueKey)) {
    return { ok: false, status: 403, error: "forbidden" };
  }
  return { ok: true };
}

export function sameStoredReview(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): boolean {
  return [
    "id",
    "investigationId",
    "candidateId",
    "evaluationId",
    "controllerSha256",
    "decision",
    "reviewerIdentity",
    "notes",
    "jiraIssueKey",
  ].every((key) => (left[key] ?? undefined) === (right[key] ?? undefined));
}

export function authorizeReviewIdentity(
  context: ForgeInvocationContext,
  review: { reviewerIdentity: string },
): { ok: true; reviewerIdentity: string } | { ok: false; status: 401 | 403; error: string } {
  if (!context.principal) return { ok: false, status: 401, error: "unauthorized" };
  const reviewerIdentity = `atlassian:${context.principal}`;
  if (review.reviewerIdentity !== reviewerIdentity) return { ok: false, status: 403, error: "forbidden" };
  return { ok: true, reviewerIdentity };
}
