import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { Route } from "../hooks";
import type { InvestigationListItem } from "../services";
import { TABS } from "../sections";
import { Icon, SECTION_ICONS, type IconName } from "./Icon";
import { human, stateTone } from "./tone";
import styles from "./CommandPalette.module.css";

interface Item { id: string; group: string; label: string; hint?: string; icon?: IconName; tone?: string; route: Route }

export function CommandPalette({ route, investigations, go, onClose }: { route: Route; investigations: InvestigationListItem[]; go: (r: Route) => void; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const uid = useId();

  const all = useMemo<Item[]>(() => {
    const open = investigations.find((i) => i.id === route.investigationId);
    const items: Item[] = [
      { id: "home", group: "Go to", label: "Overview", icon: "home", route: { tab: "capture" } },
      { id: "health", group: "Go to", label: "Service health", icon: "health", route: { tab: "capture", page: "health" } },
    ];
    if (open) for (const [k, label] of TABS) items.push({ id: `s-${k}`, group: `In “${open.title}”`, label, icon: SECTION_ICONS[k], route: { investigationId: open.id, tab: k } });
    for (const i of investigations) items.push({ id: `i-${i.id}`, group: "Investigations", label: i.title, hint: human(i.state), tone: stateTone(i.state), route: { investigationId: i.id, tab: "capture" } });
    return items;
  }, [investigations, route.investigationId]);

  const results = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return words.length ? all.filter((it) => words.every((w) => `${it.label} ${it.group} ${it.hint ?? ""}`.toLowerCase().includes(w))) : all;
  }, [all, query]);

  useEffect(() => setIndex(0), [query]);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${index}"]`)?.scrollIntoView({ block: "nearest" });
  }, [index]);

  const choose = (it?: Item) => {
    if (!it) return;
    onClose();
    go(it.route);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const d = e.key === "ArrowDown" ? 1 : -1;
      setIndex((i) => (results.length ? (i + d + results.length) % results.length : 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(results[index]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (e.key === "Tab") {
      e.preventDefault();
    }
  };

  let lastGroup = "";
  return (
    <div className={styles.layer}>
      <div className={styles.backdrop} onPointerDown={onClose} aria-hidden="true" />
      <div role="dialog" aria-modal="true" aria-label="Search" className={styles.panel} onKeyDown={onKey}>
        <div className={styles.inputRow}>
          <Icon name="search" className={styles.searchIcon} />
          <input
            ref={inputRef}
            className={styles.input}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search pages, investigations, and sections"
            aria-label="Search"
            role="combobox"
            aria-expanded="true"
            aria-controls={`${uid}-list`}
            aria-activedescendant={results[index] ? `${uid}-${results[index]!.id}` : undefined}
            aria-autocomplete="list"
            autoComplete="off"
            spellCheck={false}
          />
          <kbd className={styles.kbd}>Esc</kbd>
        </div>
        <ul ref={listRef} id={`${uid}-list`} role="listbox" aria-label="Results" className={styles.list}>
          {results.map((it, i) => {
            const head = it.group !== lastGroup ? it.group : null;
            lastGroup = it.group;
            return (
              <li key={it.id} role="presentation">
                {head && <div className={styles.group} role="presentation">{head}</div>}
                <div
                  id={`${uid}-${it.id}`}
                  role="option"
                  aria-selected={i === index}
                  data-index={i}
                  className={styles.option}
                  onPointerMove={() => setIndex(i)}
                  onClick={() => choose(it)}
                >
                  {it.icon ? <Icon name={it.icon} className={styles.icon} /> : <span className={styles.dot} data-tone={it.tone} aria-hidden="true" />}
                  <span className={styles.label}>{it.label}</span>
                  {it.hint && <span className={styles.hint}>{it.hint}</span>}
                  {i === index && <Icon name="enter" className={styles.enter} />}
                </div>
              </li>
            );
          })}
          {results.length === 0 && <li className={styles.empty} role="presentation">Nothing matches “{query}”.</li>}
        </ul>
        <div className={styles.footer} aria-hidden="true">
          <span><kbd>↑</kbd><kbd>↓</kbd> to move</span>
          <span><kbd>Enter</kbd> to open</span>
          <span><kbd>Esc</kbd> to close</span>
        </div>
      </div>
    </div>
  );
}
