import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { readReplaySeek, subscribeReplaySeek } from "./replaySeek";

export const SPEEDS = [0.25, 0.5, 1, 2] as const;

/** One clock shared by every pane that should stay in sync.
 *  When investigationId is set, a citation seek moves the playhead and does not start playback. */
export function useReplayClock(durationSec: number, initialT = 0, investigationId?: string) {
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

  const appliedSeek = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (!investigationId) return;
    const apply = (seek: { citationId: string; tSec: number }) => {
      const key = `${seek.citationId}:${seek.tSec}`;
      if (appliedSeek.current === key || seek.tSec > durationSec) return;
      appliedSeek.current = key;
      setT(seek.tSec);
    };
    const pending = readReplaySeek(investigationId);
    if (pending) apply(pending);
    return subscribeReplaySeek(investigationId, apply);
  }, [investigationId, durationSec, setT]);

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

/** Same clock, with the open investigation bound so a citation seek applies on mount. */
export function useInvestigationReplayClock(investigationId: string, durationSec: number, initialT = 0) {
  return useReplayClock(durationSec, initialT, investigationId);
}

export type ReplayClock = ReturnType<typeof useReplayClock>;
