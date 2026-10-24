import { useState, type FormEvent } from "react";
import { useClient } from "../hooks";
import { useBrowserAccess } from "../services/browserAccess";
import { Icon } from "./Icon";
import styles from "./AuthControls.module.css";

export function AuthControls({ labelClassName = "" }: { labelClassName?: string }) {
  const client = useClient();
  const access = useBrowserAccess();
  const [signUp, setSignUp] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (client.source.kind === "fixture") return null;
  const submitPassword = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    data.set("flow", signUp ? "signUp" : "signIn");
    setBusy(true); setError("");
    try { await access.signIn(data); } catch { setError("Sign in failed. Check your credentials and, for sign-up, your invite code."); }
    finally { setBusy(false); }
  };
  const submitInvite = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const code = String(new FormData(event.currentTarget).get("inviteCode") ?? "");
    setBusy(true); setError("");
    try { await access.redeemInvite(code); access.close(); } catch { setError("Invite code was not accepted."); }
    finally { setBusy(false); }
  };
  const continueWithGoogle = () => {
    setBusy(true); setError("");
    void access.signInWithGoogle()
      .catch(() => setError("Google sign-in failed. Try again."))
      .finally(() => setBusy(false));
  };
  const pendingInvite = access.authenticated && access.verified && !access.accessGranted;
  return <section aria-label="Account" className={styles.account}>
    {access.authenticated ? <div className={styles.row}>
        <Icon name="user" className={styles.icon} />
        <span data-testid="signed-in" className={`${styles.status} ${labelClassName}`}>
          {pendingInvite ? "Invite required" : access.verified ? (access.email ?? "Signed in (server verified)") : "Verifying session…"}
        </span>
        {pendingInvite && <button type="button" className={`${styles.quiet} ${labelClassName}`} onClick={access.showSignIn}>Enter invite</button>}
        <button type="button" className={`${styles.quiet} ${labelClassName}`} onClick={() => { void access.signOut().catch(() => setError("Sign out failed. Please retry.")); }}>Sign out</button>
      </div>
      : <button type="button" className={styles.signIn} onClick={access.showSignIn}><Icon name="user" className={styles.icon} /><span className={labelClassName}>Sign in</span></button>}
    {access.open && pendingInvite && <form onSubmit={submitInvite} aria-label="Invite code" className={styles.form}>
      <h2>Enter invite code</h2>
      <p className={styles.note}>{access.email ? `${access.email} is signed in with Google.` : "Your Google account is signed in."} The invite lets this account open private investigations.</p>
      <label>Invite code <input name="inviteCode" type="password" autoComplete="off" required /></label>
      <button type="submit" className="primary" disabled={busy}>{busy ? "Please wait…" : "Use invite"}</button>
      <div className={styles.formActions}>
        <button type="button" onClick={access.close}>Close</button>
      </div>
    </form>}
    {access.open && !access.authenticated && <form onSubmit={submitPassword} aria-label={signUp ? "Sign up" : "Sign in"} className={styles.form}>
      <h2>{signUp ? "Sign up" : "Sign in"}</h2>
      <button type="button" className="primary" disabled={busy} onClick={continueWithGoogle}>{busy ? "Please wait…" : "Continue with Google"}</button>
      <p className={styles.divider}>or use email</p>
      <label>Email <input name="email" type="email" autoComplete="email" required /></label>
      <label>Password <input name="password" type="password" minLength={8} autoComplete={signUp ? "new-password" : "current-password"} required /></label>
      {signUp && <label>Invite code <input name="inviteCode" type="password" autoComplete="off" required /></label>}
      <button type="submit" className="primary" disabled={busy}>{busy ? "Please wait…" : signUp ? "Create account" : "Sign in to account"}</button>
      <div className={styles.formActions}>
        <button type="button" onClick={() => { setSignUp(!signUp); setError(""); }}>{signUp ? "Use existing account" : "Create an account"}</button>
        <button type="button" onClick={access.close}>Close</button>
      </div>
    </form>}
    {error && <p role="alert" className={styles.error}>{error}</p>}
  </section>;
}
