import { InvestigationList } from "./components/InvestigationList";
import { InvestigationView } from "./components/InvestigationView";
import { ReadinessStrip } from "./components/ReadinessStrip";
import { AuthControls } from "./components/AuthControls";
import { useClient, useHashRoute } from "./hooks";
import styles from "./App.module.css";

export function App() {
  const [route, go] = useHashRoute();
  const client = useClient();
  return (
    <div className={styles.app}>
      <a href="#main" className={styles.skip}>Skip to content</a>
      <header className={styles.top}>
        <div className={styles.brandRow}>
          <a href="#/" className={styles.brand} aria-label="ForkSafe home">
            <svg className={styles.mark} viewBox="0 0 32 32" aria-hidden="true">
              <path d="M16 2.8 27 7v8.2c0 7-4.6 11.5-11 14-6.4-2.5-11-7-11-14V7l11-4.2Z" />
              <path d="M10 17.1h4.1l2-5.1 2.1 8 1.8-4.2H24" />
              <circle cx="10" cy="17.1" r="1" />
            </svg>
            <span>ForkSafe</span>
          </a>
          <span className={styles.tag}>Robot failure investigations</span>
          <ReadinessStrip clientSource={client.source} />
        </div>
      </header>
      <AuthControls />
      <div className={styles.body}>
        <nav className={styles.nav} aria-label="Investigations">
          <InvestigationList selectedId={route.investigationId} onSelect={(id) => go({ investigationId: id, tab: "capture" })} />
        </nav>
        <main id="main" className={styles.main} tabIndex={-1}>
          {route.investigationId ? (
            <InvestigationView key={route.investigationId} id={route.investigationId} tab={route.tab} onTab={(tab) => go({ investigationId: route.investigationId, tab })} />
          ) : (
            <div className={styles.welcome}>
              <div className={styles.welcomeIntro}>
                <span className={styles.eyebrow}>From failure to a fix you can trust</span>
                <h1>Let’s work out what went wrong.</h1>
                <p>ForkSafe brings robot failures, agent discoveries, and verified repairs together in one clear place.</p>
              </div>
              <h2 className={styles.stepsTitle}>How it works</h2>
              <ol className={styles.steps}>
                <li className={styles.step}>
                  <span className={styles.stepIcon}>
                    <svg viewBox="0 0 32 32" aria-hidden="true"><rect x="5" y="5" width="22" height="22" rx="6" /><path d="M10 20l4-5 3 3 5-7M10 23h12" /></svg>
                  </span>
                  <span className={styles.stepNumber}>01</span>
                  <h3>Capture a failure</h3>
                  <p>Start with the moment your robot went off course.</p>
                </li>
                <li className={styles.step}>
                  <span className={styles.stepIcon}>
                    <svg viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="7" r="3" /><circle cx="8" cy="24" r="3" /><circle cx="24" cy="24" r="3" /><path d="M16 10v6M16 16 9 21M16 16l7 5" /></svg>
                  </span>
                  <span className={styles.stepNumber}>02</span>
                  <h3>Let agents investigate</h3>
                  <p>Different approaches run side by side and share evidence.</p>
                </li>
                <li className={styles.step}>
                  <span className={styles.stepIcon}>
                    <svg viewBox="0 0 32 32" aria-hidden="true"><path d="M16 3.5 26 7v7.5c0 6.4-4.2 10.7-10 14-5.8-3.3-10-7.6-10-14V7l10-3.5Z" /><path d="m11 16 3.2 3.2 6.8-7" /></svg>
                  </span>
                  <span className={styles.stepNumber}>03</span>
                  <h3>Review a verified fix</h3>
                  <p>See how a candidate performs before you approve it.</p>
                </li>
              </ol>
              <p className={styles.welcomeFoot}>Choose an investigation to pick up where the team left off.</p>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
