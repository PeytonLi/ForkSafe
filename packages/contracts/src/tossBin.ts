export const TOSS_INTO_BIN = "toss_into_bin" as const;

export const TOSS_BIN_OVERRIDES = [
  { key: "objectDx", label: "Object x offset", kind: "delta", min: -0.08, max: 0.08, default: 0, step: 0.01, unit: "m" },
  { key: "objectDy", label: "Object y offset", kind: "delta", min: -0.08, max: 0.08, default: 0, step: 0.01, unit: "m" },
  { key: "binDx", label: "Bin distance", kind: "delta", min: -0.15, max: 0.15, default: 0, step: 0.01, unit: "m" },
  { key: "binDy", label: "Bin y offset", kind: "delta", min: -0.2, max: 0.2, default: 0, step: 0.01, unit: "m" },
  { key: "binWallHeight", label: "Bin wall height", kind: "value", min: 0.03, max: 0.15, default: 0.08, step: 0.01, unit: "m" },
  { key: "objectMass", label: "Object mass", kind: "value", min: 0.01, max: 0.5, default: 0.05, step: 0.01, unit: "kg" },
  { key: "speedScale", label: "Speed scale", kind: "value", min: 0.5, max: 1.5, default: 1, step: 0.05, unit: "×" },
] as const;

export const TOSS_BIN_DEFAULTS = {
  binHalfExtents: [0.1, 0.1] as const,
  binWallHalfThickness: 0.005,
  binWallHeight: 0.08,
  objectHalfSize: 0.02,
  objectMass: 0.05,
  binCenter: [0.86, 0] as const,
};
