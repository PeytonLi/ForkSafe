import { useEffect, useRef, useState, type FormEvent } from "react";
import { useClient } from "../hooks";
import { useBrowserAccess } from "../services/browserAccess";
import { Icon } from "./Icon";
import styles from "./AuthControls.module.css";

export function AuthControls() {
  const client = useClient();
  const access = useBrowserAccess();
  const accountRef = useRef<HTMLElement>(null);
  const [signUp, setSignUp] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  useEffect(() => {
    if (!access.open) return;
    const onPointer = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && accountRef.current?.contains(target)) return;
      access.close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") access.close();
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [access.open, access.close]);
  if (client.source.kind === "fixture") return null;
  const submitPassword = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    data.set("flow", signUp ? "signUp" : "signIn");
    setBusy(true); setError("");
    try { await access.signIn(data); } catch { setError("Sign in failed. Check your credentials and, for sign-up, your access code."); }
    finally { setBusy(false); }
  };
  const submitInvite = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const code = String(new FormData(event.currentTarget).get("inviteCode") ?? "");
    setBusy(true); setError("");
    try { await access.redeemInvite(code); access.close(); } catch { setError("Access code was not accepted."); }
    finally { setBusy(false); }
  };
  const continueWithGoogle = () => {
    setBusy(true); setError("");
    void access.signInWithGoogle()
      .catch(() => setError("Google sign-in failed. Try again."))
      .finally(() => setBusy(false));
  };
  const pendingInvite = access.authenticated && access.verified && !access.accessGranted && !access.workspace;
  const triggerLabel = !access.authenticated
    ? "Sign in"
    : !access.verified
      ? "Verifying…"
      : (access.workspace?.name ?? access.email ?? "Account");
  return <section aria-label="Account" className={styles.account} ref={accountRef}>
    <button
      type="button"
      className={styles.trigger}
      aria-expanded={access.open}
      aria-haspopup="dialog"
      onClick={() => (access.open ? access.close() : access.showSignIn())}
    >
      <Icon name="user" className={styles.icon} />
      <span className={styles.triggerLabel} data-testid={access.authenticated ? "signed-in" : undefined}>{triggerLabel}</span>
    </button>
    {access.open && pendingInvite && <form onSubmit={submitInvite} aria-label="Access code" className={styles.menu}>
      <h2>Access code</h2>
      <p className={styles.note}>Enter a workspace invite, or the original access code for the shared investigations.</p>
      <label>Access code <input name="inviteCode" type="password" autoComplete="off" required /></label>
      <button type="submit" className="primary" disabled={busy}>{busy ? "Please wait…" : "Unlock workspace"}</button>
      <button type="button" className={styles.textButton} onClick={() => { void access.signOut().catch(() => setError("Sign out failed. Please retry.")); }}>Sign out</button>
      {error && <p role="alert" className={styles.error}>{error}</p>}
    </form>}
    {access.open && access.authenticated && !pendingInvite && <div className={styles.menu} role="dialog" aria-label="Account menu">
      <h2>{access.workspace?.name ?? "Your workspace"}</h2>
      <p className={styles.note}>{access.email ?? "Signed in"}. Simulations you start stay in this workspace. An invite adds someone here only.</p>
      <button type="button" className="primary" disabled={busy} onClick={() => {
        setBusy(true); setError("");
        void access.createInvite().then(setInviteCode).catch(() => setError("Could not create an invite.")).finally(() => setBusy(false));
      }}>{busy ? "Please wait…" : "Invite someone"}</button>
      {inviteCode && <p className={styles.code} data-testid="workspace-invite">{inviteCode}</p>}
      <form onSubmit={submitInvite}>
        <label>Join with a code <input name="inviteCode" type="text" autoComplete="off" required /></label>
        <button type="submit" disabled={busy}>Join workspace</button>
      </form>
      <button type="button" className={styles.textButton} onClick={() => { void access.signOut().catch(() => setError("Sign out failed. Please retry.")); }}>Sign out</button>
      {error && <p role="alert" className={styles.error}>{error}</p>}
    </div>}
    {access.open && !access.authenticated && <form onSubmit={submitPassword} aria-label={signUp ? "Sign up" : "Sign in"} className={styles.menu}>
      <h2>{signUp ? "Create account" : "Sign in"}</h2>
      <button type="button" className="primary" disabled={busy} onClick={continueWithGoogle}>{busy ? "Please wait…" : "Continue with Google"}</button>
      <p className={styles.divider}>or use email</p>
      <label>Email <input name="email" type="email" autoComplete="email" required /></label>
      <label>Password <input name="password" type="password" minLength={8} autoComplete={signUp ? "new-password" : "current-password"} required /></label>
      {signUp && <label>Access code <input name="inviteCode" type="password" autoComplete="off" required /></label>}
      <button type="submit" className="primary" disabled={busy}>{busy ? "Please wait…" : signUp ? "Create account" : "Sign in"}</button>
      <button type="button" className={styles.textButton} onClick={() => { setSignUp(!signUp); setError(""); }}>{signUp ? "Use an existing account" : "Create an account"}</button>
      {error && <p role="alert" className={styles.error}>{error}</p>}
    </form>}
  </section>;
}
