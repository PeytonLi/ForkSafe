import { ConvexAuthProvider, useAuthActions } from "@convex-dev/auth/react";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { ConvexForkSafeClient } from "./convexClient";
import type { ForkSafeClient } from "./types";

export type MemberRole = "lead" | "operator" | "reviewer";

export const mayWrite = (kind: string, authenticated: boolean, accessGranted = true) =>
  kind === "fixture" || (authenticated && accessGranted);

export function seatAllows(role: MemberRole, action: "operate" | "review"): boolean {
  if (action === "operate") return role === "lead" || role === "operator";
  return role === "lead" || role === "reviewer";
}

const ROLE_KEY = "forksafe.memberRole";

function asRole(role: string | null | undefined): MemberRole {
  return role === "operator" || role === "reviewer" ? role : "lead";
}

function storedRole(): MemberRole {
  try {
    return asRole(localStorage.getItem(ROLE_KEY));
  } catch {
    return "lead";
  }
}

type Viewer = { subject: string; email: string | null; accessGranted: boolean; memberRole?: MemberRole } | null;
const viewerQuery = makeFunctionReference<"query", {}, Viewer>("auth:viewer");
const redeemInviteMutation = makeFunctionReference<"mutation", { inviteCode: string }, { ok: boolean }>("auth:redeemInvite");
const setMemberRoleMutation = makeFunctionReference<"mutation", { role: MemberRole; email?: string }, { memberRole: MemberRole }>("auth:setMemberRole");

type AccessValue = {
  canWrite: boolean;
  canOperate: boolean;
  canReview: boolean;
  role: MemberRole;
  setRole: (role: MemberRole) => Promise<void>;
  assignRole: (email: string, role: MemberRole) => Promise<void>;
  authenticated: boolean;
  verified: boolean;
  accessGranted: boolean;
  email: string | null;
  open: boolean;
  showSignIn: () => void;
  close: () => void;
  signIn: (data: FormData) => Promise<void>;
  signInWithGoogle: () => Promise<void>;
  redeemInvite: (code: string) => Promise<void>;
  signOut: () => Promise<void>;
};

const signedOut = {
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
};

const Access = createContext<AccessValue>({
  canWrite: true,
  canOperate: true,
  canReview: true,
  role: "lead",
  setRole: async () => {},
  assignRole: async () => {},
  ...signedOut,
});
export const useBrowserAccess = () => useContext(Access);

function seats(canWrite: boolean, role: MemberRole) {
  return {
    canOperate: canWrite && seatAllows(role, "operate"),
    canReview: canWrite && seatAllows(role, "review"),
  };
}

function Session({ children }: { children: ReactNode }) {
  const { isAuthenticated } = useConvexAuth();
  const viewer = useQuery(viewerQuery);
  const redeem = useMutation(redeemInviteMutation);
  const setMemberRole = useMutation(setMemberRoleMutation);
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
  const canWrite = mayWrite("convex", isAuthenticated, accessGranted);
  const role = asRole(viewer?.memberRole);
  return <Access.Provider value={{
    canWrite,
    ...seats(canWrite, role),
    role,
    setRole: async (next) => { await setMemberRole({ role: next }); },
    assignRole: async (email, next) => { await setMemberRole({ role: next, email }); },
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

function FixtureAccess({ children }: { children: ReactNode }) {
  const [role, setRoleState] = useState<MemberRole>(storedRole);
  const canWrite = mayWrite("fixture", false);
  const setRole = async (next: MemberRole) => {
    try { localStorage.setItem(ROLE_KEY, next); } catch { /* private browsing */ }
    setRoleState(next);
  };
  return <Access.Provider value={{
    canWrite,
    ...seats(canWrite, role),
    role,
    setRole,
    assignRole: async () => { throw new Error("No account with that email"); },
    ...signedOut,
  }}>{children}</Access.Provider>;
}

export function BrowserAccessProvider({ client, children }: { client: ForkSafeClient; children: ReactNode }) {
  return client instanceof ConvexForkSafeClient
    ? <ConvexAuthProvider client={client.react}><Session>{children}</Session></ConvexAuthProvider>
    : <FixtureAccess>{children}</FixtureAccess>;
}
