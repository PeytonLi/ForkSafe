import { fmtAgo, routeHref, type AsyncState } from "../hooks";
import type { InvestigationListItem } from "../services";
import { human, stateTone } from "./tone";
import { Badge } from "./Panel";
import styles from "./Overview.module.css";

const STEPS = [
  {
    title: "Capture a failure",
    body: "Start with the moment your robot went off course.",
    icon: <><rect x="5" y="5" width="22" height="22" rx="6" /><path d="M10 20l4-5 3 3 5-7M10 23h12" /></>,
  },
  {
    title: "Let agents investigate",
    body: "Different approaches run side by side and share evidence.",
    icon: <><circle cx="16" cy="7" r="3" /><circle cx="8" cy="24" r="3" /><circle cx="24" cy="24" r="3" /><path d="M16 10v6M16 16 9 21M16 16l7 5" /></>,
  },
  {
    title: "Review a verified fix",
    body: "See how a candidate performs before you approve it.",
    icon: <><path d="M16 3.5 26 7v7.5c0 6.4-4.2 10.7-10 14-5.8-3.3-10-7.6-10-14V7l10-3.5Z" /><path d="m11 16 3.2 3.2 6.8-7" /></>,
  },
];

export function Overview({ investigations }: { investigations: AsyncState<InvestigationListItem[]> }) {
  const recent = [...(investigations.data ?? [])].sort((a, b) => (b.updatedAtMs ?? 0) - (a.updatedAtMs ?? 0)).slice(0, 5);
  return (
    <div className={styles.overview}>
      <header className={styles.hero}>
        <h1>Let’s work out what went wrong.</h1>
        <p>ForkSafe brings robot failures, agent discoveries, and verified repairs together, so you can approve a fix you trust.</p>
      </header>

      <section aria-labelledby="how-it-works">
        <h2 id="how-it-works" className={styles.sectionTitle}>How it works</h2>
        <ol className={styles.steps}>
          {STEPS.map((s, i) => (
            <li key={s.title} className={styles.step}>
              <span className={styles.stepIcon}>
                <svg viewBox="0 0 32 32" aria-hidden="true">{s.icon}</svg>
              </span>
              <div>
                <h3><span className={styles.stepNumber}>{i + 1}.</span> {s.title}</h3>
                <p>{s.body}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section aria-labelledby="recent">
        <h2 id="recent" className={styles.sectionTitle}>Recent investigations</h2>
        {investigations.status === "loading" && !investigations.data ? (
          <p className={styles.quiet} role="status">Loading investigations…</p>
        ) : investigations.status === "error" && !investigations.data ? (
          <p className={styles.quiet} role="alert">We couldn’t load investigations right now.</p>
        ) : recent.length === 0 ? (
          <p className={styles.quiet}>No investigations yet. Capture a failure to start one.</p>
        ) : (
          <ul className={styles.recent}>
            {recent.map((i) => (
              <li key={i.id}>
                <a className={styles.recentRow} href={routeHref({ investigationId: i.id, tab: "capture" })}>
                  <span className={styles.recentTitle}>{i.title}</span>
                  <span className={styles.recentMeta}>
                    {i.requestedEnvironments != null && <span>{i.requestedEnvironments} environments</span>}
                    {i.updatedAtMs != null && <span>Updated {fmtAgo(i.updatedAtMs)}</span>}
                  </span>
                  <Badge tone={stateTone(i.state)}>{human(i.state)}</Badge>
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
