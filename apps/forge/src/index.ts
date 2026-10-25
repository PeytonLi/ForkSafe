import ResolverModule from "@forge/resolver";
import api, { route } from "@forge/api";
import { backendFromEnv } from "./backend.js";
import { createHandlers, type ForgeContext } from "./handlers.js";

const ResolverClass =
  (ResolverModule as unknown as { default?: typeof ResolverModule }).default ??
  ResolverModule;
const resolver = new ResolverClass();
const backend = backendFromEnv();

async function fetchIssueLabels(issueKey: string): Promise<string[]> {
  const response = await api
    .asApp()
    .requestJira(route`/rest/api/3/issue/${issueKey}?fields=labels`);
  if (!response.ok) throw new Error(`jira_issue_lookup_${response.status}`);
  const body = (await response.json()) as { fields?: { labels?: string[] } };
  return body.fields?.labels ?? [];
}

const handlers = createHandlers(backend, { fetchIssueLabels });

const resolverNames = [
  "getPanel",
  "startInvestigation",
  "submitReview",
  "getReviewDetails",
  "requestMoreInvestigation",
];

resolver.define("getPanel", ({ payload, context }) =>
  handlers.getPanel({ payload, context: context as ForgeContext }),
);
resolver.define("startInvestigation", ({ payload, context }) =>
  handlers.startInvestigation({ payload, context: context as ForgeContext }),
);
resolver.define("submitReview", ({ payload, context }) =>
  handlers.submitReview({ payload, context: context as ForgeContext }),
);
resolver.define("getReviewDetails", ({ payload, context }) =>
  handlers.getReviewDetails({ payload, context: context as ForgeContext }),
);
resolver.define("requestMoreInvestigation", ({ payload, context }) =>
  handlers.requestMoreInvestigation({
    payload,
    context: context as ForgeContext,
  }),
);

export const handler = resolver.getDefinitions();

export async function issueCreated(event: unknown) {
  const result = await handlers.issueCreated(event);
  console.log("forksafe issueCreated", JSON.stringify(result));
  return result;
}

export async function selfcheck() {
  const panelResult = await handlers.getPanel({ payload: {}, context: {} });
  return {
    statusCode: 200,
    headers: { "Content-Type": ["application/json"] },
    body: JSON.stringify({
      app: "forksafe-forge",
      resolvers: resolverNames,
      panelWithoutIssue: panelResult.ok ? "unexpected_success" : panelResult.code,
      backendMode: backend.mode,
    }),
  };
}
