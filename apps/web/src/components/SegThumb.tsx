import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";

/** Sliding white thumb for a `.seg` segmented control; place it as the group's first child. */
export function SegThumb({ active }: { active: unknown }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [style, setStyle] = useState<CSSProperties>({ opacity: 0, transition: "none" });
  const placed = useRef(false);
  useLayoutEffect(() => {
    const group = ref.current?.parentElement;
    if (!group) return;
    const measure = () => {
      const el = group.querySelector<HTMLElement>('[aria-selected="true"], [aria-pressed="true"]');
      if (!el || el.offsetWidth === 0) return setStyle({ opacity: 0, transition: "none" });
      const next: CSSProperties = { width: el.offsetWidth, height: el.offsetHeight, transform: `translate(${el.offsetLeft}px, ${el.offsetTop}px)`, opacity: 1 };
      setStyle(placed.current ? next : { ...next, transition: "none" });
      placed.current = true;
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(group);
    return () => ro.disconnect();
  }, [active]);
  return <span ref={ref} className="seg-thumb" style={style} aria-hidden="true" />;
}
