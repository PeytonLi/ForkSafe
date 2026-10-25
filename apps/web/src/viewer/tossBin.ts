import * as THREE from "three";
import { TOSS_BIN_DEFAULTS } from "@forksafe/contracts";
import { mjToThreePos, mjToThreeQuat, type SampledBody } from "./transform";

export function makeTossBin(wallHeight = TOSS_BIN_DEFAULTS.binWallHeight): THREE.Group {
  const [halfX, halfZ] = TOSS_BIN_DEFAULTS.binHalfExtents;
  const wallThickness = TOSS_BIN_DEFAULTS.binWallHalfThickness;
  const group = new THREE.Group();
  group.visible = false;
  const material = new THREE.MeshStandardMaterial({
    color: "#627f91",
    roughness: 0.72,
    metalness: 0.04,
  });
  const addBox = (
    name: string,
    width: number,
    height: number,
    depth: number,
    x: number,
    y: number,
    z: number,
  ) => {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(width, height, depth),
      material,
    );
    mesh.name = name;
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  };
  const floorHalfThickness = 0.005;
  addBox(
    "bin_floor",
    halfX * 2,
    floorHalfThickness * 2,
    halfZ * 2,
    0,
    floorHalfThickness,
    0,
  );
  addBox(
    "bin_wall_px",
    wallThickness,
    wallHeight,
    halfZ * 2,
    halfX - wallThickness / 2,
    wallHeight / 2,
    0,
  );
  addBox(
    "bin_wall_nx",
    wallThickness,
    wallHeight,
    halfZ * 2,
    -halfX + wallThickness / 2,
    wallHeight / 2,
    0,
  );
  addBox(
    "bin_wall_py",
    halfX * 2 - 2 * wallThickness,
    wallHeight,
    wallThickness,
    0,
    wallHeight / 2,
    halfZ - wallThickness / 2,
  );
  addBox(
    "bin_wall_ny",
    halfX * 2 - 2 * wallThickness,
    wallHeight,
    wallThickness,
    0,
    wallHeight / 2,
    -halfZ + wallThickness / 2,
  );
  return group;
}

export function placeTossBin(group: THREE.Group, body?: SampledBody): void {
  group.visible = !!body;
  if (!body) return;
  group.position.set(...mjToThreePos(body.pos));
  group.quaternion.set(...mjToThreeQuat(body.quat));
}

export function setTossBinHeight(group: THREE.Group, wallHeight: number): void {
  for (const child of group.children) {
    if (!child.name.startsWith("bin_wall_")) continue;
    child.scale.y = wallHeight / TOSS_BIN_DEFAULTS.binWallHeight;
    child.position.y = wallHeight / 2;
  }
}
