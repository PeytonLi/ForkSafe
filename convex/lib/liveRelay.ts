export type RelayChunk = {
  seq: number;
  final: boolean;
  frames: Record<string, unknown>[];
};

export function isStreamFlagUnsupported(output: string): boolean {
  return output.includes("unrecognized arguments") && output.includes("--stream-dir");
}

export const LIVE_CHUNK_READER_PYTHON = [
  "import json,pathlib,sys",
  "directory=pathlib.Path(sys.argv[1]); start=int(sys.argv[2]); used=0",
  "for n in range(start,start+120):",
  " path=directory/(\"chunk-%05d.json\" % n)",
  " if not path.exists(): break",
  " chunk=json.loads(path.read_text())",
  " frames=[]",
  " for frame in chunk.get(\"frames\",[]):",
  "  frames.append({\"tSec\":frame.get(\"tSec\",0),\"bodies\":frame.get(\"bodies\",[]),\"contacts\":frame.get(\"contacts\",[]),\"cubePos\":frame.get(\"cubePos\",[0,0,0]),\"attached\":bool(frame.get(\"attached\",False)),\"qpos\":[],\"qvel\":[],\"ctrl\":[]})",
  " line=json.dumps({\"seq\":chunk[\"seq\"],\"final\":bool(chunk.get(\"final\",False)),\"frames\":frames},separators=(\",\",\":\"))",
  " size=len(line.encode(\"utf-8\"))+1",
  " if used+size>48000: break",
  " print(line); used+=size",
  " if chunk.get(\"final\",False): break",
].join("\n");

export function parseChunkLines(output: string): RelayChunk[] {
  const lines = output.split("\n");
  if (!output.endsWith("\n")) lines.pop();
  const chunks: RelayChunk[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (!value || typeof value !== "object") continue;
    const chunk = value as Partial<RelayChunk>;
    if (!Number.isInteger(chunk.seq) || (chunk.seq ?? -1) < 0 || typeof chunk.final !== "boolean" || !Array.isArray(chunk.frames)) continue;
    chunks.push({
      seq: chunk.seq!,
      final: chunk.final,
      frames: chunk.frames.filter((frame): frame is Record<string, unknown> => !!frame && typeof frame === "object" && !Array.isArray(frame)),
    });
  }
  return chunks;
}
