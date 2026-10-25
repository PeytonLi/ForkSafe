import { useEffect, useState, type FormEvent } from "react";
import { useClient } from "../hooks";
import { useBrowserAccess, type MemberRole } from "../services/browserAccess";
import styles from "./MemberRoleControl.module.css";

const SEATS: { role: MemberRole; label: string }[] = [
  { role: "lead", label: "Lead" },
  { role: "operator", label: "Operator" },
  { role: "reviewer", label: "Reviewer" },
];

function seatError(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("No account with that email")) return "No account with that email";
  if (message.toLowerCase().includes("unauthorized")) return "You cannot change that seat.";
  return fallback;
}

export function MemberRoleControl() {
  const client = useClient();
  const access = useBrowserAccess();
  const [email, setEmail] = useState("");
  const [assignSeat, setAssignSeat] = useState<MemberRole>("reviewer");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [pending, setPending] = useState<MemberRole | null>(null);
  useEffect(() => { setPending(null); }, [access.role]);
  if (client.source.kind === "convex" && (!access.authenticated || !access.accessGranted)) return null;
  const convex = client.source.kind === "convex";
  const role = pending ?? access.role;
  const canChangeOwnSeat = !convex || access.role === "lead";

  const choose = async (next: MemberRole) => {
    if (next === role || saving) return;
    setError("");
    setPending(next);
    setSaving(true);
    try {
      await access.setRole(next);
    } catch (caught) {
      setPending(null);
      setError(seatError(caught, "Could not change seat."));
    } finally {
      setSaving(false);
    }
  };

  const assign = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextEmail = email.trim();
    if (!nextEmail || saving) return;
    setError("");
    setSaving(true);
    try {
      await access.assignRole(nextEmail, assignSeat);
      setEmail("");
    } catch (caught) {
      setError(seatError(caught, "Could not assign seat."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <fieldset className={styles.seat} data-testid="member-role" aria-describedby="member-role-help" disabled={saving}>
      <legend>Seat</legend>
      <div className={styles.options}>
        {SEATS.map(({ role: seat, label }) => (
          <label key={seat} className={styles.option}>
            <input type="radio" name="member-role" value={seat} checked={role === seat} disabled={!canChangeOwnSeat} onChange={() => { void choose(seat); }} />
            {label}
          </label>
        ))}
      </div>
      <p id="member-role-help" className={styles.help}>
        Operator runs investigations. Reviewer can only accept or refuse a controller hash. Lead does both.
        {convex && access.role !== "lead" ? " A lead assigns seats." : ""}
      </p>
      {access.role === "lead" && (
        <form className={styles.assign} onSubmit={(event) => { void assign(event); }}>
          <label>
            Assign a seat to an email
            <input type="email" value={email} autoComplete="off" onChange={(event) => setEmail(event.target.value)} required />
          </label>
          <label>
            Seat
            <select value={assignSeat} onChange={(event) => setAssignSeat(event.target.value as MemberRole)}>
              {SEATS.map(({ role: seat, label }) => <option key={seat} value={seat}>{label}</option>)}
            </select>
          </label>
          <button type="submit" disabled={saving || email.trim() === ""}>Assign</button>
        </form>
      )}
      {error && <p role="alert" className={styles.error}>{error}</p>}
    </fieldset>
  );
}
