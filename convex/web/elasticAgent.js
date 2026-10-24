"use node";
// Re-exports the Elastic evidence agent (packages/integrations/elastic) for
// convex/web/ask.ts. Kept as JS so Convex's typecheck reads elasticAgent.d.ts
// instead of the package's `.ts`-specifier sources; esbuild bundles the source.
export { AgentBuilder } from "../../packages/integrations/elastic/src/agentBuilder.ts";
export { agentBuilderReadiness } from "../../packages/integrations/elastic/src/config.ts";
export { toDocuments } from "../../packages/integrations/elastic/src/indexer.ts";
