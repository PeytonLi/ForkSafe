import ResolverModule from "@forge/resolver";
import { backendFromEnv } from "./backend.js";
import { createHandlers, type ForgeContext } from "./handlers.js";

const ResolverClass =
  (ResolverModule as unknown as { default?: typeof ResolverModule }).default ??
  ResolverModule;
const resolver = new ResolverClass();
const backend = backendFromEnv();
const handlers = createHandlers(backend);

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
