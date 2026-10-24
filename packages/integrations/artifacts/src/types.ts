import type { ArtifactRef } from "@forksafe/contracts";

export type ArtifactMetadata = {
  kind: ArtifactRef["kind"];
  investigationId: string;
  attemptId?: string;
  visibility?: "internal" | "withheld";
};

export type ArtifactInput = {
  bytes: Uint8Array;
  meta: ArtifactMetadata;
};

export interface ArtifactStore {
  put(bytes: Uint8Array, meta: ArtifactMetadata): Promise<ArtifactRef>;
  get(idOrRef: string | ArtifactRef): Promise<Uint8Array>;
  delete?(idOrRef: string | ArtifactRef): Promise<void>;
}

export type ArtifactChunk = {
  bytes: Uint8Array;
  index: number;
  total: number;
  groupSha256: string;
};
