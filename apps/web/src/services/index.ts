import { ConvexForkSafeClient } from "./convexClient";
import { FixtureClient } from "./fixtureClient";
import type { ForkSafeClient } from "./types";

export * from "./types";
export * from "./errors";
export { FixtureClient, FIXTURE_REVIEWER } from "./fixtureClient";
export { ConvexForkSafeClient, CONVEX_FUNCTIONS, CONVEX_LEARNING_FUNCTIONS } from "./convexClient";

/** Convex when VITE_CONVEX_URL is set (and fixtures not forced), else the
 *  recorded fixture adapter. Components only ever see ForkSafeClient. */
export function createClient(env: ImportMetaEnv = import.meta.env): ForkSafeClient {
  const url = env.VITE_CONVEX_URL;
  if (url && env.VITE_FORKSAFE_DATA !== "fixture") return new ConvexForkSafeClient(url);
  const simulateStream = typeof location !== "undefined" && new URLSearchParams(location.search).has("fixtureStream");
  return new FixtureClient({ simulateStream });
}
export * from "./ask";
export * from "./sceneActionMessage";
