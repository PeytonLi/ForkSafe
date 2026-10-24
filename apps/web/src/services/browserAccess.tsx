import { ConvexAuthProvider, useAuthActions } from "@convex-dev/auth/react";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { ConvexForkSafeClient } from "./convexClient";
import type { ForkSafeClient } from "./types";

export const mayWrite = (kind: string, authenticated: boolean, accessGranted = true) =>
  kind === "fixture" || (authenticated && accessGranted);

type Viewer = { subject: string; email: string | null; accessGranted: boolean } | null;
const viewerQuery = makeFunctionReference<"query", {}, Viewer>("auth:viewer");
const redeemInviteMutation = makeFunctionReference<"mutation", { inviteCode: string }, { ok: boolean }>("auth:redeemInvite");

const Access = createContext({
  canWrite: true,
  authenticated: false,
  verified: false,
  accessGranted: true,
  email: null as string | null,
  open: false,
  showSignIn: () => {},
  close: () => {},
  signIn: async (_data: FormData) => {},
  signInWithGoogle: async () => {},
  redeemInvite: async (_code: string) => {},
  signOut: async () => {},
});
export const useBrowserAccess = () => useContext(Access);

function Session({ children }: { children: ReactNode }) {
  const { isAuthenticated } = useConvexAuth();
  const viewer = useQuery(viewerQuery);
  const redeem = useMutation(redeemInviteMutation);
  const actions = useAuthActions();
  const [open, setOpen] = useState(false);
  const [epoch, setEpoch] = useState(0);
  const granted = useRef<boolean | null>(null);
  useEffect(() => {
    if (viewer?.accessGranted === undefined) return;
    if (granted.current === false && viewer.accessGranted) setEpoch((value) => value + 1);
    granted.current = viewer.accessGranted;
  }, [viewer?.accessGranted]);
  useEffect(() => {
    if (isAuthenticated && viewer?.accessGranted === false) setOpen(true);
  }, [isAuthenticated, viewer?.accessGranted]);
  const accessGranted = viewer?.accessGranted === true;
  return <Access.Provider value={{
    canWrite: mayWrite("convex", isAuthenticated, accessGranted),
    authenticated: isAuthenticated,
    verified: !!viewer,
    accessGranted,
    email: viewer?.email ?? null,
    open,
    showSignIn: () => setOpen(true),
    close: () => setOpen(false),
    signIn: async (data) => { await actions.signIn("password", data); setOpen(false); },
    signInWithGoogle: async () => {
      const redirectTo = `${window.location.pathname}${window.location.search}${window.location.hash}` || "/";
      await actions.signIn("auth0", { redirectTo });
    },
    redeemInvite: async (code) => {
      const result = await redeem({ inviteCode: code });
      if (!result.ok) throw new Error("Invalid invite code");
    },
    signOut: async () => { await actions.signOut(); setOpen(false); },
  }}><div key={`${isAuthenticated ? "signed-in" : "signed-out"}-${epoch}`}>{children}</div></Access.Provider>;
}

export function BrowserAccessProvider({ client, children }: { client: ForkSafeClient; children: ReactNode }) {
  return client instanceof ConvexForkSafeClient
    ? <ConvexAuthProvider client={client.react}><Session>{children}</Session></ConvexAuthProvider>
    : <>{children}</>;
}
