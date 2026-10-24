import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import type { SimRunResult, TaskFamily } from "@forksafe/contracts";
import { resolveScene, type ResolvedScene } from "../scene";
import { mjToThreePos, mjToThreeQuat, sampleAt, type Sample } from "./transform";
import styles from "./ReplayViewer.module.css";

const CHAIN = ["link0", "link1", "link4", "link6", "hand"] as const;

interface Scene3D {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  links: THREE.Mesh[];
  joints: THREE.Mesh[];
  hand: THREE.Mesh;
  cube: THREE.Mesh;
  divider: THREE.Mesh;
  gapLeft: THREE.Mesh;
  gapRight: THREE.Mesh;
  target: THREE.Mesh;
  contact: THREE.Mesh;
  ghost: ArmParts & { group: THREE.Group };
  paths: THREE.Group;
}

interface ArmParts {
  links: THREE.Mesh[];
  joints: THREE.Mesh[];
  hand: THREE.Mesh;
}

export const GHOST_COLOR = "#d9733b";
export const PATH_COLOR = "#337681";

function ghostArm(s: THREE.Scene): ArmParts & { group: THREE.Group } {
  const group = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({
    color: GHOST_COLOR,
    transparent: true,
    opacity: 0.3,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });
  const links = CHAIN.slice(1).map(() => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.04, 1, 16), mat);
    m.renderOrder = 2;
    group.add(m);
    return m;
  });
  const joints = CHAIN.map(() => {
    const m = new THREE.Mesh(new THREE.SphereGeometry(0.045, 16, 10), mat);
    m.renderOrder = 2;
    group.add(m);
    return m;
  });
  const hand = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.05, 0.16), mat);
  hand.renderOrder = 2;
  group.add(hand);
  group.renderOrder = 2;
  group.visible = false;
  s.add(group);
  return { group, links, joints, hand };
}

function build(canvas: HTMLCanvasElement): Scene3D {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(0x000000, 0);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  const s = new THREE.Scene();
  s.background = null;
  const camera = new THREE.PerspectiveCamera(40, 1, 0.01, 20);
  camera.position.set(1.45, 0.85, 0.95);
  camera.lookAt(0.35, 0.12, 0);
  s.add(new THREE.HemisphereLight("#ffffff", "#d1d8df", 1.75));
  s.add(new THREE.AmbientLight("#eff5fb", 0.38));
  const sun = new THREE.DirectionalLight("#fff8ed", 1.45);
  sun.position.set(1, 2, 1);
  sun.castShadow = true;
  sun.shadow.mapSize.set(512, 512);
  sun.shadow.camera.left = -1.4;
  sun.shadow.camera.right = 1.4;
  sun.shadow.camera.top = 1.4;
  sun.shadow.camera.bottom = -1.4;
  sun.shadow.bias = -0.0002;
  sun.shadow.radius = 5;
  s.add(sun);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshStandardMaterial({ color: "#ffffff", roughness: 1, transparent: true, opacity: 0.74 }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(0.4, 0, 0);
  floor.receiveShadow = true;
  s.add(floor);
  const grid = new THREE.GridHelper(2, 20, "#b9cbd5", "#dce6e7");
  grid.position.set(0.4, 0.001, 0);
  s.add(grid);

  const linkMat = new THREE.MeshStandardMaterial({ color: "#eef0f3", roughness: 0.5 });
  const jointMat = new THREE.MeshStandardMaterial({ color: "#3b4250" });
  const links = CHAIN.slice(1).map(() => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.04, 1, 20), linkMat);
    s.add(m);
    return m;
  });
  const joints = CHAIN.map(() => {
    const m = new THREE.Mesh(new THREE.SphereGeometry(0.045, 20, 12), jointMat);
    s.add(m);
    return m;
  });
  const hand = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.05, 0.16), jointMat);
  s.add(hand);
  const cube = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 0.05), new THREE.MeshStandardMaterial({ color: "#2563eb" }));
  s.add(cube);
  const wallMat = new THREE.MeshStandardMaterial({ color: "#8a94a6", transparent: true, opacity: 0.85 });
  const divider = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), wallMat);
  s.add(divider);
  const gapLeft = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), wallMat);
  const gapRight = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), wallMat);
  s.add(gapLeft, gapRight);
  const target = new THREE.Mesh(
    new THREE.CylinderGeometry(1, 1, 1, 32),
    new THREE.MeshStandardMaterial({ color: "#16a34a", transparent: true, opacity: 0.55 }),
  );
  s.add(target);
  const contact = new THREE.Mesh(new THREE.SphereGeometry(0.018, 16, 10), new THREE.MeshBasicMaterial({ color: "#dc2626" }));
  s.add(contact);
  for (const object of s.children) {
    if (object instanceof THREE.Mesh && object !== floor) object.castShadow = true;
  }
  const ghost = ghostArm(s);
  const paths = new THREE.Group();
  s.add(paths);
  return { renderer, scene: s, camera, links, joints, hand, cube, divider, gapLeft, gapRight, target, contact, ghost, paths };
}

const v = (p: [number, number, number]) => new THREE.Vector3(...mjToThreePos(p));

function place(smp: Sample, mesh: THREE.Object3D, name: string) {
  const b = smp.bodies.get(name);
  mesh.visible = !!b;
  if (!b) return;
  mesh.position.copy(v(b.pos));
  mesh.quaternion.set(...mjToThreeQuat(b.quat));
}

function poseArm(parts: ArmParts, smp: Sample) {
  const pts = CHAIN.map((n) => smp.bodies.get(n)?.pos);
  pts.forEach((p, i) => {
    parts.joints[i]!.visible = !!p;
    if (p) parts.joints[i]!.position.copy(v(p));
  });
  for (let i = 0; i < parts.links.length; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const m = parts.links[i]!;
    m.visible = !!(a && b);
    if (!a || !b) continue;
    const va = v(a);
    const vb = v(b);
    m.position.copy(va.clone().add(vb).multiplyScalar(0.5));
    m.scale.set(1, va.distanceTo(vb), 1);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), vb.clone().sub(va).normalize());
  }
  place(smp, parts.hand, "hand");
}

/** Gripper (hand body) path over the whole replay, in Three.js coordinates. */
export function gripperPath(replay: SimRunResult): THREE.Vector3[] {
  return replay.frames.flatMap((f) => {
    const hand = f.bodies.find((b) => b.name === "hand");
    return hand ? [v(hand.pos as [number, number, number])] : [];
  });
}

function setPaths(s3: Scene3D, replay: SimRunResult, ghost: SimRunResult | undefined) {
  for (const child of [...s3.paths.children]) {
    s3.paths.remove(child);
    (child as THREE.Line).geometry.dispose();
  }
  if (!ghost) return;
  const own = new THREE.Line(new THREE.BufferGeometry().setFromPoints(gripperPath(replay)), new THREE.LineBasicMaterial({ color: PATH_COLOR }));
  const ghostLine = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(gripperPath(ghost)),
    new THREE.LineDashedMaterial({ color: GHOST_COLOR, dashSize: 0.025, gapSize: 0.018, transparent: true, opacity: 0.9 }),
  );
  ghostLine.computeLineDistances();
  s3.paths.add(own, ghostLine);
}

function setStaticScene(s3: Scene3D, scene: ResolvedScene) {
  const placeFloorObject = (mesh: THREE.Mesh, x: number, y: number, z: number, length: number, height: number, thickness: number) => {
    mesh.visible = true;
    mesh.position.set(x, y + height / 2, z);
    mesh.scale.set(length, height, thickness);
  };
  s3.cube.visible = true;
  s3.cube.position.set(scene.cubeStart[0], scene.cubeStart[2], scene.cubeStart[1]);
  s3.target.visible = true;
  s3.target.position.set(scene.target[0], scene.target[2], scene.target[1]);
  s3.target.scale.set(0.12, 0.003, 0.12);
  if (scene.kind === "divider_pick_place") {
    placeFloorObject(
      s3.divider,
      scene.dividerCenter[0],
      0,
      scene.dividerCenter[1],
      scene.dividerHalfLength * 2,
      scene.dividerHeight,
      scene.dividerHalfThickness * 2,
    );
    s3.gapLeft.visible = false;
    s3.gapRight.visible = false;
  } else {
    s3.divider.visible = false;
    const [wallStart, wallEnd] = scene.wallSpanX;
    const gapLeft = scene.gapCenter[0] - scene.gapWidth / 2;
    const gapRight = scene.gapCenter[0] + scene.gapWidth / 2;
    placeFloorObject(s3.gapLeft, (wallStart + gapLeft) / 2, 0, scene.gapCenter[1], gapLeft - wallStart, scene.wallHeight, scene.wallHalfThickness * 2);
    placeFloorObject(s3.gapRight, (gapRight + wallEnd) / 2, 0, scene.gapCenter[1], wallEnd - gapRight, scene.wallHeight, scene.wallHalfThickness * 2);
  }
}

function apply(s3: Scene3D, replay: SimRunResult | undefined, t: number, ghost: SimRunResult | undefined, scene: ResolvedScene) {
  setStaticScene(s3, scene);
  if (!replay) {
    s3.links.forEach((mesh) => (mesh.visible = false));
    s3.joints.forEach((mesh) => (mesh.visible = false));
    s3.hand.visible = false;
    s3.ghost.group.visible = false;
    s3.paths.visible = false;
    s3.contact.visible = false;
    return;
  }
  const smp = sampleAt(replay.frames, t);
  if (!smp) return;
  poseArm(s3, smp);
  const gs = ghost ? sampleAt(ghost.frames, t) : undefined;
  s3.ghost.group.visible = !!gs;
  s3.paths.visible = !!gs;
  if (gs) poseArm(s3.ghost, gs);
  const cube = smp.bodies.get("cube");
  if (cube) place(smp, s3.cube, "cube");
  const divider = smp.bodies.get("divider");
  if (divider) place(smp, s3.divider, "divider");
  const gapLeft = smp.bodies.get("gap_wall_left");
  if (gapLeft) place(smp, s3.gapLeft, "gap_wall_left");
  const gapRight = smp.bodies.get("gap_wall_right");
  if (gapRight) place(smp, s3.gapRight, "gap_wall_right");
  const target = smp.bodies.get("target");
  if (target) place(smp, s3.target, "target");
  const hit = smp.contacts.find((c) => c.a === "cube" || c.b === "cube");
  s3.contact.visible = !!hit;
  if (hit) s3.contact.position.copy(s3.cube.position).add(new THREE.Vector3(0, 0, -0.03));
  (s3.cube.material as THREE.MeshStandardMaterial).color.set(hit ? "#dc2626" : "#2563eb");
}

interface Props {
  replay?: SimRunResult;
  t?: number;
  label?: string;
  scene?: Record<string, number>;
  taskFamily?: TaskFamily;
  compact?: boolean;
  captionExtra?: ReactNode;
  /** Original (failing) run drawn as a translucent ghost on the same clock. */
  ghost?: SimRunResult;
}

/** Renders sampled authoritative state; it never runs physics or scores. */
export function ReplayViewer({
  replay,
  t = 0,
  label = "Scene preview",
  scene: overrides = {},
  taskFamily,
  compact = false,
  ghost,
  captionExtra,
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const s3Ref = useRef<Scene3D | null>(null);
  const [webglError, setWebglError] = useState<string | null>(null);
  const [viewerReady, setViewerReady] = useState(0);
  const resolvedScene = useMemo(() => resolveScene(taskFamily, overrides), [taskFamily, overrides]);
  const smp = replay ? sampleAt(replay.frames, t) : undefined;

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    let disposed = false;
    let teardown = () => {};
    // Let the caption and status paint before the synchronous WebGL setup,
    // which can block the page thread for several seconds on software GL.
    const handle = window.setTimeout(() => {
      if (disposed) return;
      const canvas = document.createElement("canvas");
      canvas.className = styles.canvas!;
      canvas.setAttribute("aria-label", `${label}, 3D view`);
      canvas.setAttribute("role", "img");
      wrap.appendChild(canvas);
      let s3: Scene3D;
      try {
        s3 = build(canvas);
      } catch (e) {
        canvas.remove();
        setWebglError((e as Error).message || "WebGL unavailable");
        return;
      }
      if (disposed) {
        s3.renderer.dispose();
        s3.renderer.forceContextLoss();
        canvas.remove();
        return;
      }
      s3Ref.current = s3;
      const resize = () => {
        const w = Math.max(1, wrap.clientWidth);
        const h = Math.max(1, Math.round(w * 0.62));
        s3.renderer.setSize(w, h, false);
        s3.camera.aspect = w / h;
        s3.camera.updateProjectionMatrix();
        s3.renderer.render(s3.scene, s3.camera);
        canvas.dataset.rendered = "true";
      };
      const ro = new ResizeObserver(resize);
      ro.observe(wrap);
      resize();
      teardown = () => {
        ro.disconnect();
        s3.renderer.dispose();
        s3.renderer.forceContextLoss();
        s3Ref.current = null;
        canvas.remove();
      };
      setViewerReady((n) => n + 1);
    }, 0);
    return () => {
      disposed = true;
      window.clearTimeout(handle);
      teardown();
    };
  }, [label]);

  useEffect(() => {
    const s3 = s3Ref.current;
    if (!s3) return;
    setStaticScene(s3, resolvedScene);
    s3.renderer.render(s3.scene, s3.camera);
  }, [resolvedScene, viewerReady, webglError]);

  useEffect(() => {
    const s3 = s3Ref.current;
    if (!s3) return;
    if (replay) setPaths(s3, replay, ghost);
    else {
      for (const child of [...s3.paths.children]) {
        s3.paths.remove(child);
        (child as THREE.Line).geometry.dispose();
      }
    }
  }, [replay, ghost, viewerReady, webglError]);

  useEffect(() => {
    const s3 = s3Ref.current;
    if (!s3) return;
    apply(s3, replay, t, ghost, resolvedScene);
    s3.renderer.render(s3.scene, s3.camera);
  }, [replay, t, ghost, resolvedScene, viewerReady, webglError]);
  const ghostSample = ghost ? sampleAt(ghost.frames, t) : undefined;

  const contact = replay ? smp?.contacts[0] : undefined;
  return (
    <figure className={`${styles.viewer} ${compact ? styles.compact : ""}`} data-testid={replay ? "replay-viewer" : "scene-preview"} data-label={label} data-scene-kind={resolvedScene.kind} data-ghost={ghost ? "on" : "off"} data-ghost-t={ghostSample?.tSec.toFixed(2)}>
      <div ref={wrapRef} className={styles.canvasWrap}>
        {webglError ? (
          <div className={styles.fallback} role="note">
            3D view unavailable ({webglError}). {replay ? "Frame data is still shown below." : "The static scene preview is unavailable."}
          </div>
        ) : null}
      </div>
      <figcaption className={styles.caption}>
        <strong>{label}</strong>
        {replay && <span data-testid="frame-readout">
          t={smp?.tSec.toFixed(2) ?? "0.00"} s · frame {smp ? smp.frameIndex + 1 : 0}/{replay.frames.length}
        </span>}
        {!replay && <span data-testid="scene-preview-summary">
          {resolvedScene.kind === "push_through_gap"
            ? `Gap width: ${resolvedScene.gapWidth.toFixed(2)} m`
            : `Divider height: ${resolvedScene.dividerHeight.toFixed(2)} m`}
        </span>}
        {!compact && replay && contact ? (
          <span className={styles.contact}>
            Contact {contact.a}↔{contact.b} {(contact.depthM * 1000).toFixed(1)} mm
          </span>
        ) : !compact && replay ? (
          <span className={styles.muted}>{smp?.attached ? "Cube grasped" : "No contact"}</span>
        ) : null}
        {captionExtra}
      </figcaption>
    </figure>
  );
}
