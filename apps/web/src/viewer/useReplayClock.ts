import { useCallback, useEffect, useRef, useState } from "react";

export const SPEEDS = [0.25, 0.5, 1, 2] as const;

/** One clock shared by every pane that should stay in sync. */
export function useReplayClock(durationSec: number, initialT = 0) {
  const [t, setTState] = useState(initialT);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<number>(1);
  const tRef = useRef(initialT);
  const setT = useCallback(
    (v: number) => {
      const c = Math.min(Math.max(v, 0), durationSec);
      tRef.current = c;
      setTState(c);
    },
    [durationSec],
  );

  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const next = tRef.current + ((now - last) / 1000) * speed;
      last = now;
      if (next >= durationSec) {
        setT(durationSec);
        setPlaying(false);
        return;
      }
      setT(next);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed, durationSec, setT]);

  const toggle = useCallback(() => {
    setPlaying((p) => {
      if (!p && tRef.current >= durationSec) setT(0);
      return !p;
    });
  }, [durationSec, setT]);

  return { t, setT, playing, toggle, speed, setSpeed, durationSec };
}
export type ReplayClock = ReturnType<typeof useReplayClock>;
