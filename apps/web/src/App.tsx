import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { ReadinessStrip } from "./components/ReadinessStrip";
import { InvestigationView } from "./components/InvestigationView";
import { HealthPage } from "./components/HealthPage";
import { Overview } from "./components/Overview";
import { Sidebar } from "./components/Sidebar";
import { CommandPalette } from "./components/CommandPalette";
import { BrandMark, Icon } from "./components/Icon";
import { human } from "./components/tone";
import { routeHref, useClient, useCompact, useHashRoute, useLoad, type Route } from "./hooks";
import { TABS, activeSection, sectionLabel } from "./sections";
import styles from "./App.module.css";

const COLLAPSE_KEY = "forksafe.sidebar.collapsed";
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function App() {
  const [route, go] = useHashRoute();
  const client = useClient();
  const compact = useCompact();
  const investigations = useLoad((c) => c.listInvestigations(), [client]);
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(COLLAPSE_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [drawer, setDrawer] = useState<"open" | "closing" | null>(null);
  const [palette, setPalette] = useState(false);
  const menuRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLDivElement>(null);
  const paletteReturn = useRef<HTMLElement | null>(null);

  const toggleCollapsed = () =>
    setCollapsed((c) => {
      try {
        localStorage.setItem(COLLAPSE_KEY, c ? "0" : "1");
      } catch {
        /* storage unavailable */
      }
      return !c;
    });

  const finishDrawer = useCallback(() => {
    setDrawer(null);
    requestAnimationFrame(() => menuRef.current?.focus());
  }, []);
  const closeDrawer = useCallback(() => {
    if (reducedMotion()) setDrawer((d) => (d === "open" ? (finishDrawer(), null) : d));
    else setDrawer((d) => (d === "open" ? "closing" : d));
  }, [finishDrawer]);
  useEffect(() => {
    if (drawer === "open") drawerRef.current?.querySelector<HTMLElement>("[data-drawer-close]")?.focus();
  }, [drawer]);
  useEffect(() => {
    if (!compact) setDrawer(null);
  }, [compact]);
  const routeKey = `${route.page ?? ""}|${route.investigationId ?? ""}|${route.tab}`;
  useEffect(() => {
    closeDrawer();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeKey]);

  const openPalette = useCallback(() => {
    paletteReturn.current = document.activeElement as HTMLElement | null;
    setPalette(true);
  }, []);
  const closePalette = useCallback(() => {
    setPalette(false);
    const back = paletteReturn.current;
    requestAnimationFrame(() => {
      if (back && back.isConnected) back.focus();
      else (document.getElementById("main") as HTMLElement | null)?.focus();
    });
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (palette) closePalette();
        else openPalette();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [palette, openPalette, closePalette]);

  const onDrawerKey = (e: ReactKeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      closeDrawer();
      return;
    }
    if (e.key !== "Tab" || !drawerRef.current) return;
    const items = [...drawerRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null);
    if (!items.length) return;
    const first = items[0]!;
    const last = items[items.length - 1]!;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const items = investigations.data ?? [];
  const current = items.find((i) => i.id === route.investigationId);
  const page = route.page === "health" ? "health" : route.investigationId ? "investigation" : "home";
  const sidebarProps = { route, go, investigations, onSearch: openPalette };

  return (
    <div className={styles.app} data-collapsed={(!compact && collapsed) || undefined}>
      <a href="#main" className={styles.skip}>Skip to content</a>

      {!compact && (
        <aside className={styles.sidebar} aria-label="Sidebar">
          <Sidebar {...sidebarProps} collapsed={collapsed} onToggleCollapsed={toggleCollapsed} />
        </aside>
      )}

      {compact && drawer && (
        <div className={styles.drawerLayer} data-state={drawer}>
          <div className={styles.backdrop} onClick={closeDrawer} aria-hidden="true" />
          <div
            ref={drawerRef}
            className={styles.drawer}
            role="dialog"
            aria-modal="true"
            aria-label="Menu"
            onKeyDown={onDrawerKey}
            onAnimationEnd={(e) => {
              if (e.target === e.currentTarget && drawer === "closing") finishDrawer();
            }}
          >
            <Sidebar {...sidebarProps} collapsed={false} onClose={closeDrawer} />
          </div>
        </div>
      )}

      <div className={styles.column}>
        <header className={styles.topbar}>
          <div className={styles.topInner}>
            {compact ? (
              <div className={styles.mobileBrand}>
                <button ref={menuRef} type="button" className={styles.menuButton} onClick={() => setDrawer("open")} aria-label="Open menu" aria-expanded={drawer === "open"}>
                  <Icon name="menu" />
                </button>
                <a href="#/" className={styles.brand} aria-label="ForkSafe home">
                  <BrandMark className={styles.mark} />
                  <span>ForkSafe</span>
                </a>
              </div>
            ) : (
              <nav aria-label="Breadcrumb" className={styles.crumbs}>
                <ol>
                  {page === "investigation" ? (
                    <>
                      <li className={styles.crumbQuiet}>Investigations</li>
                      <li>
                        <a href={routeHref({ investigationId: route.investigationId, tab: "capture" })} className={styles.crumbLink} title={current?.title}>
                          {current?.title ?? "Investigation"}
                        </a>
                      </li>
                      <li aria-current="page">{sectionLabel(route.tab)}</li>
                    </>
                  ) : (
                    <>
                      <li className={styles.crumbQuiet}>Workspace</li>
                      <li aria-current="page">{page === "health" ? "Service health" : "Overview"}</li>
                    </>
                  )}
                </ol>
              </nav>
            )}
            <ReadinessStrip clientSource={client.source} />
          </div>
        </header>

        <main id="main" className={styles.main} tabIndex={-1}>
          {compact && page !== "health" && items.length > 0 && (
            <div className={styles.mobileNav}>
              <label className={styles.mobileSelect}>
                <span>Investigation</span>
                <select value={route.investigationId ?? ""} onChange={(e) => e.target.value && go({ investigationId: e.target.value, tab: "capture" })} aria-label="Switch investigation">
                  <option value="" disabled>Choose an investigation</option>
                  {items.map((i) => <option key={i.id} value={i.id}>{i.title} · {human(i.state)}</option>)}
                </select>
              </label>
              {page === "investigation" && (
                <label className={styles.mobileSelect}>
                  <span>Section</span>
                  <select value={activeSection(route.tab)} onChange={(e) => go({ investigationId: route.investigationId, tab: e.target.value })} aria-label="Investigation sections">
                    {TABS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
                  </select>
                </label>
              )}
            </div>
          )}
          <div key={`${page}|${route.investigationId ?? ""}`} className={`${styles.content} page-enter`}>
            {page === "health" ? (
              <HealthPage />
            ) : page === "investigation" ? (
              <InvestigationView
                key={route.investigationId}
                id={route.investigationId!}
                tab={route.tab}
                focus={route.focus}
                onTab={(tab, focus) => go({ investigationId: route.investigationId, tab, focus } satisfies Route)}
              />
            ) : (
              <Overview investigations={investigations} />
            )}
          </div>
        </main>
      </div>

      {palette && <CommandPalette route={route} investigations={items} go={go} onClose={closePalette} />}
    </div>
  );
}
