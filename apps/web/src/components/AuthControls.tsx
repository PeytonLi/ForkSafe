import { useState, type FormEvent } from "react";
import { useClient } from "../hooks";
import { useBrowserAccess } from "../services/browserAccess";

export function AuthControls() {
  const client = useClient();
  const access = useBrowserAccess();
  const [signUp, setSignUp] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (client.source.kind === "fixture") return null;
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    data.set("flow", signUp ? "signUp" : "signIn");
    setBusy(true); setError("");
    try { await access.signIn(data); } catch { setError("Sign in failed. Check your credentials and, for sign-up, your invite code."); }
    finally { setBusy(false); }
  };
  return <section aria-label="Account">
    {access.authenticated ? <><span data-testid="signed-in">{access.verified ? "Signed in (server verified)" : "Verifying session…"}</span> <button type="button" onClick={() => { void access.signOut().catch(() => setError("Sign out failed. Please retry.")); }}>Sign out</button></>
      : <button type="button" onClick={access.showSignIn}>Sign in</button>}
    {access.open && !access.authenticated && <form onSubmit={submit} aria-label={signUp ? "Sign up" : "Sign in"}>
      <h2>{signUp ? "Sign up" : "Sign in"}</h2>
      <label>Email <input name="email" type="email" autoComplete="email" required /></label>
      <label>Password <input name="password" type="password" minLength={8} autoComplete={signUp ? "new-password" : "current-password"} required /></label>
      {signUp && <label>Invite code <input name="inviteCode" type="password" autoComplete="off" required /></label>}
      <button type="submit" className="primary" disabled={busy}>{busy ? "Please wait…" : signUp ? "Create account" : "Sign in to account"}</button>
      <button type="button" onClick={() => { setSignUp(!signUp); setError(""); }}>{signUp ? "Use existing account" : "Create an account"}</button>
      <button type="button" onClick={access.close}>Close</button>
    </form>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
