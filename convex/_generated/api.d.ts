/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as artifacts from "../artifacts.js";
import type * as crons from "../crons.js";
import type * as daytonaPool from "../daytonaPool.js";
import type * as dispatchers_elastic from "../dispatchers/elastic.js";
import type * as dispatchers_jira from "../dispatchers/jira.js";
import type * as health from "../health.js";
import type * as http from "../http.js";
import type * as investigations from "../investigations.js";
import type * as lib_auth from "../lib/auth.js";
import type * as lib_commandPolicy from "../lib/commandPolicy.js";
import type * as lib_constants from "../lib/constants.js";
import type * as lib_handoff from "../lib/handoff.js";
import type * as lib_leasing from "../lib/leasing.js";
import type * as lib_reservations from "../lib/reservations.js";
import type * as lib_validators from "../lib/validators.js";
import type * as outbox from "../outbox.js";
import type * as reconcile from "../reconcile.js";
import type * as sandboxActions from "../sandboxActions.js";
import type * as sandboxData from "../sandboxData.js";
import type * as sandboxes from "../sandboxes.js";
import type * as workers from "../workers.js";
import type * as workflows from "../workflows.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  artifacts: typeof artifacts;
  crons: typeof crons;
  daytonaPool: typeof daytonaPool;
  "dispatchers/elastic": typeof dispatchers_elastic;
  "dispatchers/jira": typeof dispatchers_jira;
  health: typeof health;
  http: typeof http;
  investigations: typeof investigations;
  "lib/auth": typeof lib_auth;
  "lib/commandPolicy": typeof lib_commandPolicy;
  "lib/constants": typeof lib_constants;
  "lib/handoff": typeof lib_handoff;
  "lib/leasing": typeof lib_leasing;
  "lib/reservations": typeof lib_reservations;
  "lib/validators": typeof lib_validators;
  outbox: typeof outbox;
  reconcile: typeof reconcile;
  sandboxActions: typeof sandboxActions;
  sandboxData: typeof sandboxData;
  sandboxes: typeof sandboxes;
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
  workflow: import("@convex-dev/workflow/_generated/component.js").ComponentApi<"workflow">;
  daytonaPool: import("@convex-dev/workpool/_generated/component.js").ComponentApi<"daytonaPool">;
  outboxPool: import("@convex-dev/workpool/_generated/component.js").ComponentApi<"outboxPool">;
};
