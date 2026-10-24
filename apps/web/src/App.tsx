import { InvestigationList } from "./components/InvestigationList";
import { InvestigationView } from "./components/InvestigationView";
import { ReadinessStrip } from "./components/ReadinessStrip";
import { useClient, useHashRoute } from "./hooks";
import styles from "./App.module.css";
import { AuthControls } from "./components/AuthControls";

export function App() {
  const [route, go] = useHashRoute();
  const client = useClient();
  return (
    <div className={styles.app}>
      <a href="#main" className={styles.skip}>Skip to content</a>
      <header className={styles.top}>
        <div className={styles.brandRow}>
          <a href="#/" className={styles.brand}>ForkSafe</a>
          <span className={styles.tag}>Robot failure investigations</span>
          {client.source.kind === "fixture" && (
            <span className={styles.fixtureNote} data-testid="fixture-banner">
              Showing recorded fixture data, not live results
            </span>
          )}
        </div>
      </header>
      <AuthControls />
      <ReadinessStrip />
      <div className={styles.body}>
        <nav className={styles.nav} aria-label="Investigations">
          <InvestigationList selectedId={route.investigationId} onSelect={(id) => go({ investigationId: id, tab: "capture" })} />
        </nav>
        <main id="main" className={styles.main} tabIndex={-1}>
          {route.investigationId ? (
            <InvestigationView key={route.investigationId} id={route.investigationId} tab={route.tab} onTab={(tab) => go({ investigationId: route.investigationId, tab })} />
          ) : (
            <div className={styles.welcome}>
              <h1>Pick an investigation</h1>
              <p>Each investigation starts from one captured robot failure. Open one to see its baseline replay, the environments working on it, shared evidence, and candidate repairs ready for review.</p>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
