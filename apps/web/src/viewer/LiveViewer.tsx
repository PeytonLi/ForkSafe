import { useEffect, useMemo, useRef, useState } from "react";
import type { SimRunResult } from "@forksafe/contracts";
import { useClient } from "../hooks";
import type { LiveStreamSnapshot } from "../services/types";
import { Badge } from "../components/Panel";
import { LiveBuffer, type LivePlaybackState } from "./liveBuffer";
import { ReplayViewer } from "./ReplayViewer";
import { sampleAt } from "./transform";
import replayStyles from "./ReplayViewer.module.css";
import styles from "./LiveViewer.module.css";

interface LiveViewerProps {
  experimentId: string;
  scene: Record<string, number>;
  label: string;
  compact?: boolean;
  onFinished?: (replayArtifactId: string | undefined, atSec: number) => void;
  onProgress?: (atSec: number) => void;
}

export function LiveViewer({ experimentId, scene, label, compact = false, onFinished, onProgress }: LiveViewerProps) {
  const client = useClient();
  const clientMode = client.source.mode === "fixture" ? "fixture" : client.source.mode === "local" ? "local" : "live";
  const wrapperRef = useRef<HTMLDivElement>(null);
  const finishedRef = useRef(false);
  const buffer = useMemo(() => new LiveBuffer(), [experimentId]);
  const [snapshot, setSnapshot] = useState<LiveStreamSnapshot>({
    mode: clientMode,
    status: "waiting",
    chunks: [],
  });
  const [visible, setVisible] = useState(true);
  const [playback, setPlayback] = useState<{ t: number; state: LivePlaybackState; lagSec: number }>({
    t: 0,
    state: "buffering",
    lagSec: 0,
  });

  useEffect(() => {
    finishedRef.current = false;
    setSnapshot({ mode: clientMode, status: "waiting", chunks: [] });
    setPlayback({ t: 0, state: "buffering", lagSec: 0 });
    return client.watchLive(experimentId, (next) => {
      buffer.push(next.chunks);
      setSnapshot(next);
      setPlayback((current) => ({ ...current, lagSec: buffer.lagSec }));
    });
  }, [buffer, client, clientMode, experimentId]);

  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) => setVisible(!!entry?.isIntersecting));
    observer.observe(wrapper);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible || snapshot.status !== "streaming") return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const next = buffer.advance(Math.max(0, (now - last) / 1000));
      last = now;
      setPlayback({ t: next.t, state: next.state, lagSec: buffer.lagSec });
      onProgress?.(next.t);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [buffer, onProgress, snapshot.status, visible]);

  useEffect(() => {
    if (snapshot.status !== "finished" || finishedRef.current) return;
    finishedRef.current = true;
    onFinished?.(snapshot.replayArtifactId, buffer.t);
  }, [buffer, onFinished, snapshot.replayArtifactId, snapshot.status]);

  const frames = buffer.frames;
  const replay = useMemo<SimRunResult | null>(() => frames.length ? ({
    experimentId,
    completed: false,
    failureKinds: [],
    frames,
    engineVersion: "live stream",
    assetsSha256: "0".repeat(64),
    controllerSha256: "0".repeat(64),
  }) : null, [experimentId, frames]);
  const sample = replay ? sampleAt(replay.frames, playback.t) : undefined;
  const badge = snapshot.status === "waiting"
    ? { tone: "gray" as const, text: "Waiting for sandbox" }
    : snapshot.status === "unavailable"
      ? { tone: "gray" as const, text: "Live view unavailable" }
      : snapshot.status === "finished"
        ? { tone: "gray" as const, text: "Finished" }
        : playback.state === "buffering"
          ? { tone: "gray" as const, text: "Buffering" }
          : snapshot.mode === "fixture"
            ? { tone: "amber" as const, text: "Fixture stream" }
            : { tone: "green" as const, text: "Live" };
  const showSkip = snapshot.status === "streaming" && playback.lagSec > 1;
  const captionExtra = (
    <span className={styles.captionExtra}>
      <Badge tone={badge.tone}>{badge.text}</Badge>
      {showSkip && (
        <button
          type="button"
          className={styles.skip}
          onClick={() => {
            buffer.skipToLatest();
            setPlayback({ t: buffer.t, state: "playing", lagSec: buffer.lagSec });
          }}
        >
          Skip to latest
        </button>
      )}
    </span>
  );

  return (
    <div ref={wrapperRef} className={styles.liveViewer} data-testid="live-viewer" data-state={snapshot.status}>
      {visible && replay ? (
        <ReplayViewer replay={replay} t={playback.t} label={label} scene={scene} compact={compact} captionExtra={captionExtra} />
      ) : (
        <figure className={replayStyles.viewer}>
          <div className={replayStyles.canvasWrap}>
            {snapshot.status === "unavailable" && !replay && (
              <div className={styles.canvasPlaceholder} role="status">
                The full replay will appear here when the run finishes.
              </div>
            )}
          </div>
          <figcaption className={replayStyles.caption}>
            <strong>{label}</strong>
            {replay && (
              <span data-testid="frame-readout">
                t={sample?.tSec.toFixed(2) ?? "0.00"} s · frame {sample ? sample.frameIndex + 1 : 0}/{replay.frames.length}
              </span>
            )}
            {!compact && replay && (
              sample?.contacts[0] ? (
                <span className={replayStyles.contact}>
                  Contact {sample.contacts[0].a}↔{sample.contacts[0].b} {(sample.contacts[0].depthM * 1000).toFixed(1)} mm
                </span>
              ) : (
                <span className={replayStyles.muted}>{sample?.attached ? "Cube grasped" : "No contact"}</span>
              )
            )}
            {captionExtra}
          </figcaption>
        </figure>
      )}
    </div>
  );
}
