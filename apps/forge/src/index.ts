import Resolver from "@forge/resolver";
import { backendFromEnv } from "./backend.js";
import { createHandlers, type ForgeContext } from "./handlers.js";

const resolver = new Resolver();
const handlers = createHandlers(backendFromEnv());

resolver.define("getPanel", ({ payload, context }) =>
  handlers.getPanel({ payload, context: context as ForgeContext }),
);
resolver.define("startInvestigation", ({ payload, context }) =>
  handlers.startInvestigation({ payload, context: context as ForgeContext }),
);
resolver.define("submitReview", ({ payload, context }) =>
  handlers.submitReview({ payload, context: context as ForgeContext }),
);

export const handler = resolver.getDefinitions();
