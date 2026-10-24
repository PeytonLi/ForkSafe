import { useEffect, useRef, useState, type FocusEvent, type KeyboardEvent, type PointerEvent } from "react";
import type { AsyncState, Route } from "../hooks";
import { useClient, useIndicator } from "../hooks";
import type { InvestigationListItem } from "../services";
import { TABS, activeSection } from "../sections";
import { AuthControls } from "./AuthControls";
import { BrandMark, Icon, SECTION_ICONS } from "./Icon";
import { human, stateTone } from "./tone";
import pkg from "../../package.json";
import styles from "./Sidebar.module.css";

const VISIBLE = 8;
const PULSE = ["running", "searching", "capturing", "evaluating"];
export const isMac = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

interface Props {
  route: Route;
  go: (r: Route) => void;
  investigations: AsyncState<InvestigationListItem[]> & { reload: () => void };
  collapsed: boolean;
  onToggleCollapsed?: () => void;
  onSearch: () => void;
  /** Set when the sidebar is shown as the mobile drawer. */
  onClose?: () => void;
}

export function Sidebar({ route, go, investigations, collapsed, onToggleCollapsed, onSearch, onClose }: Props) {
  const client = useClient();
  const [showAll, setShowAll] = useState(false);
  const [tip, setTip] = useState<{ text: string; top: number; left: number } | null>(null);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const items = investigations.data ?? [];
  const section = activeSection(route.tab);
  const activeKey = route.page === "health" ? "health" : route.investigationId ? `${route.investigationId}:${section}` : "home";
  const [innerRef, indicator] = useIndicator<HTMLDivElement>('[data-active="true"]', [activeKey, items.length, showAll, collapsed]);

  const capped = showAll ? items : items.slice(0, VISIBLE);
  const selected = items.find((i) => i.id === route.investigationId);
  const shown = selected && !capped.includes(selected) ? [...capped, selected] : capped;

  useEffect(() => {
    if (!collapsed) setTip(null);
  }, [collapsed]);

  const showTip = (e: PointerEvent | FocusEvent) => {
    if (!collapsed) return;
    const el = (e.target as Element).closest<HTMLElement>("[data-tip]");
    if (!el) return setTip(null);
    const r = el.getBoundingClientRect();
    setTip({ text: el.dataset.tip!, top: r.top + r.height / 2, left: r.right + 10 });
  };

  const onTabKey = (e: KeyboardEvent, i: number) => {
    const n = e.key === "ArrowDown" ? i + 1 : e.key === "ArrowUp" ? i - 1 : e.key === "Home" ? 0 : e.key === "End" ? TABS.length - 1 : null;
    if (n === null || !route.investigationId) return;
    e.preventDefault();
    const j = (n + TABS.length) % TABS.length;
    tabRefs.current[j]?.focus();
    go({ investigationId: route.investigationId, tab: TABS[j]![0] });
  };

  return (
    <div className={styles.sidebar} data-collapsed={collapsed || undefined}>
      <div className={styles.brandRow}>
        <a href="#/" className={styles.brand} aria-label="ForkSafe home">
          <BrandMark className={styles.mark} />
          <span className={styles.brandName}>ForkSafe</span>
        </a>
        {onClose ? (
          <button type="button" className={styles.iconButton} onClick={onClose} aria-label="Close menu" data-drawer-close>
            <Icon name="close" />
          </button>
        ) : (
          <button type="button" className={`${styles.iconButton} ${styles.collapse}`} onClick={onToggleCollapsed} aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"} aria-expanded={!collapsed} title={collapsed ? "Expand sidebar" : "Collapse sidebar"}>
            <Icon name="sidebar" />
          </button>
        )}
      </div>

      <div className={styles.searchWrap}>
        <button type="button" className={styles.search} onClick={onSearch} aria-label="Search or jump to" aria-keyshortcuts="Control+K Meta+K" data-tip="Search" onPointerOver={showTip} onPointerLeave={() => setTip(null)} onFocus={showTip} onBlur={() => setTip(null)}>
          <Icon name="search" className={styles.icon} />
          <span className={styles.label}>Search…</span>
          <kbd className={styles.kbd}>{isMac() ? "⌘K" : "Ctrl K"}</kbd>
        </button>
      </div>

      <nav className={styles.scroll} aria-label="Main" onPointerOver={showTip} onPointerLeave={() => setTip(null)} onFocus={showTip} onBlur={() => setTip(null)}>
        <div className={styles.inner} ref={innerRef}>
          <span className={styles.indicator} style={indicator} aria-hidden="true" />
          <h2 className={styles.group}><span className={styles.label}>Workspace</span></h2>
          <ul className={styles.list}>
            <li>
              <a href="#/" className={styles.row} data-active={activeKey === "home"} aria-current={activeKey === "home" ? "page" : undefined} data-tip="Overview">
                <Icon name="home" className={styles.icon} />
                <span className={styles.label}>Overview</span>
              </a>
            </li>
            <li>
              <a href="#/health" className={styles.row} data-active={activeKey === "health"} aria-current={activeKey === "health" ? "page" : undefined} data-tip="Service health">
                <Icon name="health" className={styles.icon} />
                <span className={styles.label}>Service health</span>
              </a>
            </li>
          </ul>

          <h2 className={styles.group}><span className={styles.label}>Investigations</span></h2>
          {investigations.status === "error" && !investigations.data ? (
            <p className={`${styles.note} ${styles.label}`} role="alert">
              Couldn’t load investigations. <button type="button" className={styles.linkButton} onClick={investigations.reload}>Try again</button>
            </p>
          ) : investigations.status === "loading" && !investigations.data ? (
            <div className={styles.skeletons} role="status" aria-label="Loading investigations">
              <span /><span /><span />
            </div>
          ) : items.length === 0 ? (
            <p className={`${styles.note} ${styles.label}`}>No investigations yet. Capture a failure to start one.</p>
          ) : (
            <ul className={styles.list}>
              {shown.map((i) => {
                const open = i.id === route.investigationId;
                return (
                  <li key={i.id}>
                    <button
                      type="button"
                      className={`${styles.row} ${styles.inv}`}
                      data-open={open || undefined}
                      aria-current={open && !route.page ? "true" : undefined}
                      aria-expanded={open}
                      title={collapsed ? undefined : i.title}
                      data-tip={i.title}
                      onClick={() => go({ investigationId: i.id, tab: open ? section : "capture" })}
                    >
                      <span className={styles.dotBox} aria-hidden="true">
                        <span className={styles.dot} data-tone={stateTone(i.state)} data-pulse={PULSE.includes(i.state) || undefined} />
                      </span>
                      <span className={styles.label}>{i.title}</span>
                      <span className="visually-hidden">, {human(i.state)}</span>
                    </button>
                    {open && (
                      <div role="tablist" aria-orientation="vertical" aria-label="Investigation sections" className={styles.tabs}>
                        {TABS.map(([k, label], idx) => (
                          <button
                            key={k}
                            ref={(el) => {
                              tabRefs.current[idx] = el;
                            }}
                            role="tab"
                            type="button"
                            id={`tab-${k}`}
                            aria-selected={section === k}
                            aria-controls={`tabpanel-${k}`}
                            tabIndex={section === k ? 0 : -1}
                            className={styles.row}
                            data-active={!route.page && section === k}
                            data-tip={label}
                            onClick={() => go({ investigationId: i.id, tab: k })}
                            onKeyDown={(e) => onTabKey(e, idx)}
                          >
                            <Icon name={SECTION_ICONS[k]!} className={styles.icon} />
                            <span className={styles.label}>{label}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {items.length > VISIBLE && (
            <button type="button" className={`${styles.row} ${styles.more}`} onClick={() => setShowAll((s) => !s)} aria-expanded={showAll} data-tip={showAll ? "Show fewer" : `Show all (${items.length})`}>
              <Icon name={showAll ? "chevronDown" : "chevronRight"} className={styles.icon} />
              <span className={styles.label}>{showAll ? "Show fewer" : `Show all (${items.length})`}</span>
            </button>
          )}
        </div>
      </nav>

      <footer className={styles.footer}>
        <AuthControls labelClassName={styles.label} />
        <p className={`${styles.meta} ${styles.label}`}>
          <span>v{pkg.version} · {client.source.kind === "fixture" ? "Recorded examples" : "Live workspace"}</span>
          <a href="https://github.com/PeytonLi/ForkSafe" target="_blank" rel="noreferrer">Source<Icon name="external" size={12} /></a>
        </p>
      </footer>

      {collapsed && tip && (
        <span className={styles.tooltip} style={{ top: tip.top, left: tip.left }} aria-hidden="true">{tip.text}</span>
      )}
    </div>
  );
}
