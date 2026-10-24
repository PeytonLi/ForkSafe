import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { ForkSafeClient } from "./services";

const Ctx = createContext<ForkSafeClient | null>(null);

export function ClientProvider({ client, children }: { client: ForkSafeClient; children: ReactNode }) {
  return <Ctx.Provider value={client}>{children}</Ctx.Provider>;
}

export function useClient(): ForkSafeClient {
  const c = useContext(Ctx);
  if (!c) throw new Error("ForkSafe client missing");
  return c;
}

export type AsyncState<T> =
  | { status: "loading"; data?: T }
  | { status: "ready"; data: T }
  | { status: "error"; error: unknown; data?: T };

/** Loads through the client and re-fetches when the investigation changes. */
export function useLoad<T>(
  load: (c: ForkSafeClient) => Promise<T>,
  deps: unknown[],
  subscribeTo?: string,
): AsyncState<T> & { reload: () => void } {
  const client = useClient();
  const [state, setState] = useState<AsyncState<T>>({ status: "loading" });
  const [nonce, setNonce] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;
  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let live = true;
    setState((s) => ({ status: "loading", data: s.data }));
    loadRef.current(client).then(
      (data) => live && setState({ status: "ready", data }),
      (error) => live && setState((s) => ({ status: "error", error, data: s.data })),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, nonce, ...deps]);

  useEffect(() => {
    if (!subscribeTo) return;
    return client.subscribe(subscribeTo, reload);
  }, [client, subscribeTo, reload]);

  return { ...state, reload };
}

export interface Route {
  investigationId?: string;
  tab: string;
  /** Optional row to bring into view inside the tab (e.g. a cited finding). */
  focus?: string;
  page?: "health";
}

export function parseHash(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean).map((p) => decodeURIComponent(p));
  if (parts[0] === "health") return { tab: "", page: "health" };
  if (parts[0] === "investigations" && parts[1]) return { investigationId: parts[1], tab: parts[2] ?? "capture", focus: parts[3] };
  return { tab: "" };
}

export function routeHref(r: Route): string {
  if (r.page === "health") return "#/health";
  if (!r.investigationId) return "#/";
  const tail = r.focus ? `/${encodeURIComponent(r.focus)}` : "";
  return `#/investigations/${encodeURIComponent(r.investigationId)}/${r.tab || "capture"}${tail}`;
}

export function useHashRoute(): [Route, (r: Route) => void] {
  const [route, setRoute] = useState(() => parseHash(location.hash));
  useEffect(() => {
    const on = () => setRoute(parseHash(location.hash));
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const go = useCallback((r: Route) => {
    location.hash = routeHref(r);
  }, []);
  return [route, go];
}

export const shortId = (id: string) => id.slice(0, 8);
export const shortSha = (sha: string) => sha.slice(0, 12);
export const fmtDuration = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
};
export const fmtTime = (ms: number) => new Date(ms).toISOString().replace("T", " ").slice(0, 16) + " UTC";
/** "just now", "4 min ago", "3 h ago", "2 days ago" relative to `now`. */
export const fmtAgo = (ms: number, now = Date.now()) => {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} h ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? "" : "s"} ago`;
};
