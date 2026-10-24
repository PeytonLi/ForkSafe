/// <reference types="vite/client" />
interface ImportMetaEnv {
  readonly VITE_CONVEX_URL?: string;
  /** "fixture" forces the recorded fixture adapter even when Convex is set. */
  readonly VITE_FORKSAFE_DATA?: string;
}
