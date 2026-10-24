import type { KeyboardEvent } from "react";
import { SPEEDS, type ReplayClock } from "./useReplayClock";
import styles from "./ReplayControls.module.css";

interface Marker {
  tSec: number;
  label: string;
}

export function ReplayControls({ clock, markers = [], label = "Replay" }: { clock: ReplayClock; markers?: Marker[]; label?: string }) {
  const { t, setT, playing, toggle, speed, setSpeed, durationSec } = clock;
  const onKey = (e: KeyboardEvent) => {
    if (e.key === " " || e.key === "k") {
      e.preventDefault();
      toggle();
    }
  };
  return (
    <div className={styles.controls} onKeyDown={onKey} role="group" aria-label={`${label} controls`}>
      <button type="button" className={styles.play} onClick={toggle} aria-pressed={playing} data-testid="play-toggle">
        {playing ? "Pause" : "Play"}
      </button>
      <div className={styles.track}>
        <input
          type="range"
          min={0}
          max={durationSec}
          step={0.1}
          value={t}
          onChange={(e) => setT(Number(e.target.value))}
          aria-label={`${label} time`}
          aria-valuetext={`${t.toFixed(1)} of ${durationSec.toFixed(1)} seconds`}
          data-testid="replay-scrubber"
        />
        {markers.map((m) => (
          <button
            key={m.label + m.tSec}
            type="button"
            className={styles.marker}
            style={{ left: `${durationSec ? (m.tSec / durationSec) * 100 : 0}%` }}
            onClick={() => setT(m.tSec)}
            title={`${m.label} at ${m.tSec.toFixed(1)} s`}
            aria-label={`Jump to ${m.label} at ${m.tSec.toFixed(1)} s`}
          />
        ))}
      </div>
      <span className={styles.time} aria-live="off">
        {t.toFixed(1)} / {durationSec.toFixed(1)} s
      </span>
      <label className={styles.speed}>
        Speed
        <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))} data-testid="replay-speed">
          {SPEEDS.map((s) => (
            <option key={s} value={s}>
              {s}×
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
