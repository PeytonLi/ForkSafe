/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as agentTools from "../agentTools.js";
import type * as artifacts from "../artifacts.js";
import type * as auth from "../auth.js";
import type * as bridge from "../bridge.js";
import type * as bundles from "../bundles.js";
import type * as candidates from "../candidates.js";
import type * as capture from "../capture.js";
import type * as crons from "../crons.js";
import type * as daytonaPool from "../daytonaPool.js";
import type * as demo from "../demo.js";
import type * as dispatchers_elastic from "../dispatchers/elastic.js";
import type * as dispatchers_elasticData from "../dispatchers/elasticData.js";
import type * as dispatchers_jira from "../dispatchers/jira.js";
import type * as dispatchers_spacetime from "../dispatchers/spacetime.js";
import type * as evaluation from "../evaluation.js";
import type * as evaluationReconcile from "../evaluationReconcile.js";
import type * as evidence from "../evidence.js";
import type * as execution from "../execution.js";
import type * as forge from "../forge.js";
import type * as forgeData from "../forgeData.js";
import type * as forgeLogic from "../forgeLogic.js";
import type * as forgeProtocolExt from "../forgeProtocolExt.js";
import type * as grants from "../grants.js";
import type * as health from "../health.js";
import type * as http from "../http.js";
import type * as investigations from "../investigations.js";
import type * as learning from "../learning.js";
import type * as lib_auth from "../lib/auth.js";
import type * as lib_commandPolicy from "../lib/commandPolicy.js";
import type * as lib_constants from "../lib/constants.js";
import type * as lib_controllerDiff from "../lib/controllerDiff.js";
import type * as lib_evaluatorBackend from "../lib/evaluatorBackend.js";
import type * as lib_experimentStatus from "../lib/experimentStatus.js";
import type * as lib_handoff from "../lib/handoff.js";
import type * as lib_jobOps from "../lib/jobOps.js";
import type * as lib_leasing from "../lib/leasing.js";
import type * as lib_reservations from "../lib/reservations.js";
import type * as lib_runnerAuth from "../lib/runnerAuth.js";
import type * as lib_runnerCredentials from "../lib/runnerCredentials.js";
import type * as lib_sandboxReconcile from "../lib/sandboxReconcile.js";
import type * as lib_signedEvaluation from "../lib/signedEvaluation.js";
import type * as lib_spacetime from "../lib/spacetime.js";
import type * as lib_tracing from "../lib/tracing.js";
import type * as lib_unifiedDiff from "../lib/unifiedDiff.js";
import type * as lib_validators from "../lib/validators.js";
import type * as lib_webAccess from "../lib/webAccess.js";
import type * as outbox from "../outbox.js";
import type * as outboxIngest from "../outboxIngest.js";
import type * as readiness from "../readiness.js";
import type * as reconcile from "../reconcile.js";
import type * as reviews from "../reviews.js";
import type * as runnerControl from "../runnerControl.js";
import type * as runnerHttp from "../runnerHttp.js";
import type * as runnerPool from "../runnerPool.js";
import type * as sandboxActions from "../sandboxActions.js";
import type * as sandboxData from "../sandboxData.js";
import type * as sandboxes from "../sandboxes.js";
import type * as web_ask from "../web/ask.js";
import type * as web_askData from "../web/askData.js";
import type * as web_askPolicy from "../web/askPolicy.js";
import type * as web_elasticAgent from "../web/elasticAgent.js";
import type * as web_health from "../web/health.js";
import type * as web_timeline from "../web/timeline.js";
import type * as workers from "../workers.js";
import type * as workflows from "../workflows.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  agentTools: typeof agentTools;
  artifacts: typeof artifacts;
  auth: typeof auth;
  bridge: typeof bridge;
  bundles: typeof bundles;
  candidates: typeof candidates;
  capture: typeof capture;
  crons: typeof crons;
  daytonaPool: typeof daytonaPool;
  demo: typeof demo;
  "dispatchers/elastic": typeof dispatchers_elastic;
  "dispatchers/elasticData": typeof dispatchers_elasticData;
  "dispatchers/jira": typeof dispatchers_jira;
  "dispatchers/spacetime": typeof dispatchers_spacetime;
  evaluation: typeof evaluation;
  evaluationReconcile: typeof evaluationReconcile;
  evidence: typeof evidence;
  execution: typeof execution;
  forge: typeof forge;
  forgeData: typeof forgeData;
  forgeLogic: typeof forgeLogic;
  forgeProtocolExt: typeof forgeProtocolExt;
  grants: typeof grants;
  health: typeof health;
  http: typeof http;
  investigations: typeof investigations;
  learning: typeof learning;
  "lib/auth": typeof lib_auth;
  "lib/commandPolicy": typeof lib_commandPolicy;
  "lib/constants": typeof lib_constants;
  "lib/controllerDiff": typeof lib_controllerDiff;
  "lib/evaluatorBackend": typeof lib_evaluatorBackend;
  "lib/experimentStatus": typeof lib_experimentStatus;
  "lib/handoff": typeof lib_handoff;
  "lib/jobOps": typeof lib_jobOps;
  "lib/leasing": typeof lib_leasing;
  "lib/reservations": typeof lib_reservations;
  "lib/runnerAuth": typeof lib_runnerAuth;
  "lib/runnerCredentials": typeof lib_runnerCredentials;
  "lib/sandboxReconcile": typeof lib_sandboxReconcile;
  "lib/signedEvaluation": typeof lib_signedEvaluation;
  "lib/spacetime": typeof lib_spacetime;
  "lib/tracing": typeof lib_tracing;
  "lib/unifiedDiff": typeof lib_unifiedDiff;
  "lib/validators": typeof lib_validators;
  "lib/webAccess": typeof lib_webAccess;
  outbox: typeof outbox;
  outboxIngest: typeof outboxIngest;
  readiness: typeof readiness;
  reconcile: typeof reconcile;
  reviews: typeof reviews;
  runnerControl: typeof runnerControl;
  runnerHttp: typeof runnerHttp;
  runnerPool: typeof runnerPool;
  sandboxActions: typeof sandboxActions;
  sandboxData: typeof sandboxData;
  sandboxes: typeof sandboxes;
  "web/ask": typeof web_ask;
  "web/askData": typeof web_askData;
  "web/askPolicy": typeof web_askPolicy;
  "web/elasticAgent": typeof web_elasticAgent;
  "web/health": typeof web_health;
  "web/timeline": typeof web_timeline;
  workers: typeof workers;
  workflows: typeof workflows;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  staticHosting: import("@convex-dev/static-hosting/_generated/component.js").ComponentApi<"staticHosting">;
  workflow: import("@convex-dev/workflow/_generated/component.js").ComponentApi<"workflow">;
  daytonaPool: import("@convex-dev/workpool/_generated/component.js").ComponentApi<"daytonaPool">;
  outboxPool: import("@convex-dev/workpool/_generated/component.js").ComponentApi<"outboxPool">;
};
