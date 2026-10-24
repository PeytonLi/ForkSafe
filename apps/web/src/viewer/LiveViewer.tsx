import { useEffect, useMemo, useRef, useState } from "react";
import type { SimRunResult } from "@forksafe/contracts";
import { useClient } from "../hooks";
import type { LiveStreamSnapshot } from "../services/types";
import { Badge } from "../components/Panel";
import { LiveBuffer, type LivePlaybackState } from "./liveBuffer";
import { ReplayViewer } from "./ReplayViewer";
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

  return (
    <div ref={wrapperRef} className={styles.liveViewer} data-testid="live-viewer" data-state={snapshot.status}>
      {snapshot.status === "waiting" && <p className={styles.status} role="status">Waiting for the sandbox to start…</p>}
      {snapshot.status === "streaming" && (
        <div className={styles.statusBar}>
          <Badge tone={snapshot.mode === "fixture" ? "amber" : "green"}>
            {snapshot.mode === "fixture" ? "Fixture stream" : "Live"}
          </Badge>
          {playback.lagSec > 1 && <button type="button" className={styles.skip} onClick={() => {
            buffer.skipToLatest();
            setPlayback({ t: buffer.t, state: "playing", lagSec: buffer.lagSec });
          }}>Skip to latest</button>}
        </div>
      )}
      {snapshot.status === "unavailable" && (
        <p className={styles.status} role="status">Live view isn't available for this run. The full replay will appear here when it finishes.</p>
      )}
      {snapshot.status === "finished" && <p className={styles.status} role="status">Full replay ready.</p>}
      {visible && replay ? (
        <ReplayViewer replay={replay} t={playback.t} label={label} scene={scene} compact={compact} />
      ) : (
        <div className={styles.canvasPlaceholder} aria-hidden="true" />
      )}
      {snapshot.status === "streaming" && playback.state === "buffering" && (
        <span className={styles.buffering} role="status">Buffering</span>
      )}
    </div>
  );
}
