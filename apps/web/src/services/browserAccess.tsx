import { ConvexAuthProvider, useAuthActions } from "@convex-dev/auth/react";
import { useConvexAuth, useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { createContext, useContext, useState, type ReactNode } from "react";
import { ConvexForkSafeClient } from "./convexClient";
import type { ForkSafeClient } from "./types";

export const mayWrite = (kind: string, authenticated: boolean) => kind === "fixture" || authenticated;
const Access = createContext({ canWrite: true, authenticated: false, verified: false, open: false, showSignIn: () => {}, close: () => {}, signIn: async (_data: FormData) => {}, signOut: async () => {} });
export const useBrowserAccess = () => useContext(Access);

function Session({ children }: { children: ReactNode }) {
  const { isAuthenticated } = useConvexAuth();
  const viewer = useQuery(makeFunctionReference<"query", {}, { subject: string } | null>("auth:viewer"));
  const actions = useAuthActions();
  const [open, setOpen] = useState(false);
  return <Access.Provider value={{
    canWrite: mayWrite("convex", isAuthenticated), authenticated: isAuthenticated, verified: !!viewer, open,
    showSignIn: () => setOpen(true), close: () => setOpen(false),
    signIn: async (data) => { await actions.signIn("password", data); setOpen(false); },
    signOut: async () => { await actions.signOut(); setOpen(false); },
  }}><div key={isAuthenticated ? "signed-in" : "signed-out"}>{children}</div></Access.Provider>;
}

export function BrowserAccessProvider({ client, children }: { client: ForkSafeClient; children: ReactNode }) {
  return client instanceof ConvexForkSafeClient
    ? <ConvexAuthProvider client={client.react}><Session>{children}</Session></ConvexAuthProvider>
    : <>{children}</>;
}
