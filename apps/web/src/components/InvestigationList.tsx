import { useLoad } from "../hooks";
import { Panel } from "./Panel";
import { human, stateTone } from "./tone";
import styles from "./InvestigationList.module.css";

export function InvestigationList({ selectedId, onSelect }: { selectedId?: string; onSelect: (id: string) => void }) {
  const state = useLoad((c) => c.listInvestigations(), []);
  return (
    <Panel title="Investigations" state={state} isEmpty={(d) => d.length === 0} empty="No investigations yet. Capture a failure to start one." testId="investigation-list">
      {(items) => (
        <>
          <ul className={styles.list}>
            {items.map((i) => (
              <li key={i.id}>
                <button
                  type="button"
                  className={`${styles.item} ${i.id === selectedId ? styles.selected : ""}`}
                  aria-current={i.id === selectedId ? "page" : undefined}
                  onClick={() => onSelect(i.id)}
                >
                  <span className={styles.itemTitle}>{i.title}</span>
                  <span className={styles.itemStatus}>
                    <span
                      className={styles.statusDot}
                      data-tone={stateTone(i.state)}
                      data-pulse={["running", "searching"].includes(i.state) || undefined}
                      aria-hidden="true"
                    />
                    <span>{human(i.state)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <label className={styles.mobileSelect}>
            <span className="visually-hidden">Switch investigation</span>
            <select value={selectedId ?? ""} onChange={(e) => e.target.value && onSelect(e.target.value)} aria-label="Switch investigation">
              <option value="" disabled>Choose an investigation</option>
              {items.map((i) => <option key={i.id} value={i.id}>{i.title} · {human(i.state)}</option>)}
            </select>
          </label>
        </>
      )}
    </Panel>
  );
}
