import type { Finding } from "@forksafe/contracts";
import { useState } from "react";
import { shortId, useNarrow } from "../hooks";
import type { InvestigationWorkspace } from "../services";
import { human } from "./tone";
import styles from "./InfluenceGraph.module.css";

const ENV_COLORS = ["#337681", "#8a5a9e", "#b06a2c", "#3a8055", "#5767b0"];
export const envColor = (index: number) => ENV_COLORS[index % ENV_COLORS.length]!;

export interface InfluenceEdge { findingId: string; candidateId: string; crossEnvironment: boolean }

/** finding_use edges: which findings each candidate declared it was based on. */
export function influenceEdges(w: InvestigationWorkspace, findings: Finding[]): InfluenceEdge[] {
  const byId = new Map(findings.map((f) => [f.id, f]));
  return w.candidates.flatMap((c) =>
    c.basedOnFindings.flatMap((fid) => {
      const f = byId.get(fid);
      return f ? [{ findingId: fid, candidateId: c.id, crossEnvironment: f.environmentId !== c.environmentId }] : [];
    }),
  );
}

const SHORT_KIND: Record<string, string> = {
  collision_frame: "Collision",
  limit_violation: "Limit hit",
  behavioral_note: "Behavior note",
  candidate_hypothesis: "Hypothesis",
  cross_environment_pattern: "Cross-env pattern",
};
const ROW = 44;
const PAD = 26;

export function InfluenceGraph({ w, findings }: { w: InvestigationWorkspace; findings: Finding[] }) {
  const edges = influenceEdges(w, findings);
  const narrow = useNarrow();
  const W = narrow ? 360 : 640;
  const [hot, setHot] = useState<string | null>(null);
  const envIndex = new Map(w.environments.map((e) => [e.id, e.index]));
  const used = findings.filter((f) => edges.some((e) => e.findingId === f.id))
    .sort((a, b) => (envIndex.get(a.environmentId) ?? 0) - (envIndex.get(b.environmentId) ?? 0) || a.createdAtMs - b.createdAtMs);
  if (!w.candidates.length || !edges.length) {
    return <p className={styles.empty} data-testid="influence-empty">No fix has said which findings it used yet. Once a fix is submitted, this shows which environment's discoveries it built on.</p>;
  }
  const height = PAD * 2 + Math.max(used.length, w.candidates.length) * ROW;
  const fy = (i: number) => PAD + (i + 0.5) * ((height - PAD * 2) / used.length);
  const cy = (i: number) => PAD + (i + 0.5) * ((height - PAD * 2) / w.candidates.length);
  const fx = narrow ? 120 : 270;
  const cx = narrow ? 250 : W - 150;
  const isHot = (e: InfluenceEdge) => !hot || hot === e.findingId || hot === e.candidateId;
  const cross = edges.filter((e) => e.crossEnvironment).length;
  return (
    <figure className={styles.figure} data-testid="influence-graph">
      <svg viewBox={`0 0 ${W} ${height}`} role="img" aria-labelledby="influence-title influence-desc" className={styles.svg}>
        <title id="influence-title">Which findings each fix used</title>
        <desc id="influence-desc">{edges.length} links; {cross} cross from another environment.</desc>
        {edges.map((e) => {
          const fi = used.findIndex((f) => f.id === e.findingId);
          const ci = w.candidates.findIndex((c) => c.id === e.candidateId);
          const y1 = fy(fi);
          const y2 = cy(ci);
          const mid = (fx + cx) / 2;
          return (
            <path
              key={`${e.findingId}-${e.candidateId}`}
              d={`M ${fx + 8} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${cx - 8} ${y2}`}
              className={`${styles.edge} ${e.crossEnvironment ? styles.cross : ""} ${isHot(e) ? "" : styles.dim}`}
              data-testid="influence-edge"
              data-cross={e.crossEnvironment}
            />
          );
        })}
        {used.map((f, i) => {
          const idx = envIndex.get(f.environmentId) ?? 0;
          return (
            <g key={f.id} className={`${styles.node} ${hot && hot !== f.id && !edges.some((e) => e.findingId === f.id && e.candidateId === hot) ? styles.dim : ""}`} tabIndex={0} role="button"
              aria-label={`Finding ${shortId(f.id)} from Env ${idx + 1}: ${f.summary}`}
              onMouseEnter={() => setHot(f.id)} onMouseLeave={() => setHot(null)} onFocus={() => setHot(f.id)} onBlur={() => setHot(null)}>
              <circle cx={fx} cy={fy(i)} r={8} fill={envColor(idx)} />
              <text x={fx - 16} y={fy(i) - 3} textAnchor="end" className={styles.label}>{narrow ? `Env ${idx + 1}` : `Env ${idx + 1} · ${human(f.kind)}`}</text>
              <text x={fx - 16} y={fy(i) + 12} textAnchor="end" className={styles.sub}>{narrow ? SHORT_KIND[f.kind] ?? human(f.kind) : `finding ${shortId(f.id)}`}</text>
            </g>
          );
        })}
        {w.candidates.map((c, i) => {
          const idx = envIndex.get(c.environmentId) ?? 0;
          return (
            <g key={c.id} className={styles.node} tabIndex={0} role="button"
              aria-label={`Fix ${shortId(c.id)} from Env ${idx + 1}, used ${edges.filter((e) => e.candidateId === c.id).length} findings`}
              onMouseEnter={() => setHot(c.id)} onMouseLeave={() => setHot(null)} onFocus={() => setHot(c.id)} onBlur={() => setHot(null)}>
              <rect x={cx - 9} y={cy(i) - 9} width={18} height={18} rx={4} fill="#fff" stroke={envColor(idx)} strokeWidth={3} />
              <text x={cx + 18} y={cy(i) - 3} className={styles.label}>Fix {narrow ? shortId(c.id).slice(0, 4) : shortId(c.id)}</text>
              <text x={cx + 18} y={cy(i) + 12} className={styles.sub}>from Env {idx + 1}</text>
            </g>
          );
        })}
      </svg>
      <figcaption className={styles.caption}>
        <span><i className={styles.keySolid} /> Same environment</span>
        <span><i className={styles.keyDashed} /> Shared from another environment</span>
        <span>{cross} of {edges.length} links crossed environments.</span>
      </figcaption>
    </figure>
  );
}
