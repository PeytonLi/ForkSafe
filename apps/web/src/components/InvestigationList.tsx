import { useLoad } from "../hooks";
import { Badge, Panel } from "./Panel";
import { human, stateTone } from "./tone";
import styles from "./InvestigationList.module.css";

export function InvestigationList({ selectedId, onSelect }: { selectedId?: string; onSelect: (id: string) => void }) {
  const state = useLoad((c) => c.listInvestigations(), []);
  return (
    <Panel title="Investigations" state={state} isEmpty={(d) => d.length === 0} empty="No investigations yet. Capture a failure to start one." testId="investigation-list">
      {(items) => (
        <ul className={styles.list}>
          {items.map((i) => (
            <li key={i.id}>
              <button
                type="button"
                className={`${styles.item} ${i.id === selectedId ? styles.selected : ""}`}
                aria-current={i.id === selectedId ? "page" : undefined}
                onClick={() => onSelect(i.id)}
              >
                <span className={styles.title}>{i.title}</span>
                <Badge tone={stateTone(i.state)}>{human(i.state)}</Badge>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
