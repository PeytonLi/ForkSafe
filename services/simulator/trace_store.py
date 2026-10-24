from __future__ import annotations

import hashlib
import json
import math
import os
import re
import tempfile
from pathlib import Path
from typing import Any

MAX_CHUNK_BYTES = 8 * 1024 * 1024
TRACE_CHUNK_SCHEMA = "forksafe.trace-chunk/v1"
TRACE_MANIFEST_SCHEMA = "forksafe.trace-manifest/v1"
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")


class TraceChunkError(ValueError):
    pass


class TraceIntegrityError(ValueError):
    pass


def _canonical_bytes(value: Any) -> bytes:
    try:
        return json.dumps(
            value,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=True,
            allow_nan=False,
        ).encode("utf-8")
    except (TypeError, ValueError) as exc:
        raise TraceChunkError(f"trace contains a non-JSON value: {exc}") from exc


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _write_content_addressed(path: Path, content: bytes, digest: str) -> None:
    if path.exists():
        try:
            if _sha256(path.read_bytes()) == digest:
                return
        except OSError:
            pass
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def _frame_chunk(start: int, frames: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "schema": TRACE_CHUNK_SCHEMA,
        "frameStart": start,
        "frameEnd": start + len(frames),
        "frames": frames,
    }


def export_trace(
    trace: dict[str, Any],
    out_dir: Path,
    max_chunk_bytes: int = MAX_CHUNK_BYTES,
) -> dict[str, Any]:
    if not isinstance(trace, dict) or not isinstance(trace.get("frames"), list):
        raise TraceChunkError("trace must contain a frames list")
    if (
        not isinstance(max_chunk_bytes, int)
        or isinstance(max_chunk_bytes, bool)
        or max_chunk_bytes <= 0
    ):
        raise TraceChunkError("max_chunk_bytes must be a positive integer")
    if any(not isinstance(frame, dict) for frame in trace["frames"]):
        raise TraceChunkError("trace frames must be objects")
    for index, frame in enumerate(trace["frames"]):
        time_value = frame.get("tSec")
        if (
            isinstance(time_value, bool)
            or not isinstance(time_value, (int, float))
            or not math.isfinite(time_value)
        ):
            raise TraceChunkError(f"frame {index} has an invalid tSec")
    out_dir = Path(out_dir)
    chunk_dir = out_dir / "trace-chunks"
    chunk_dir.mkdir(parents=True, exist_ok=True)
    frames = trace["frames"]
    header = {key: value for key, value in trace.items() if key != "frames"}
    header_bytes = _canonical_bytes(header)
    if len(header_bytes) > max_chunk_bytes:
        raise TraceChunkError("trace header exceeds max_chunk_bytes")
    header_sha = _sha256(header_bytes)
    _write_content_addressed(chunk_dir / f"{header_sha}.json", header_bytes, header_sha)

    chunk_entries: list[dict[str, Any]] = []
    frame_hashes: list[tuple[str, int]] = []
    current: list[dict[str, Any]] = []
    start = 0
    for index, frame in enumerate(frames):
        candidate = current + [frame]
        candidate_bytes = _canonical_bytes(_frame_chunk(start, candidate))
        if len(candidate_bytes) > max_chunk_bytes:
            if not current:
                raise TraceChunkError(f"frame {index} exceeds max_chunk_bytes")
            _store_frame_chunk(
                chunk_dir,
                chunk_entries,
                frame_hashes,
                start,
                current,
            )
            start = index
            current = [frame]
            candidate_bytes = _canonical_bytes(_frame_chunk(start, current))
            if len(candidate_bytes) > max_chunk_bytes:
                raise TraceChunkError(f"frame {index} exceeds max_chunk_bytes")
        else:
            current = candidate
    if current:
        _store_frame_chunk(
            chunk_dir,
            chunk_entries,
            frame_hashes,
            start,
            current,
        )

    full_trace_sha = _sha256(_canonical_bytes(trace))
    manifest = {
        "schema": TRACE_MANIFEST_SCHEMA,
        "maxChunkBytes": max_chunk_bytes,
        "frameCount": len(frames),
        "header": {
            "role": "header",
            "sha256": header_sha,
            "bytes": len(header_bytes),
        },
        "chunks": chunk_entries,
        "traceSha256": full_trace_sha,
    }
    manifest_bytes = _canonical_bytes(manifest)
    manifest_path = out_dir / "trace-manifest.json"
    _write_atomic(manifest_path, manifest_bytes)
    total_bytes = len(manifest_bytes) + len(header_bytes) + sum(
        size for _, size in frame_hashes
    )
    return {
        "manifestSha256": _sha256(manifest_bytes),
        "manifestPath": "trace-manifest.json",
        "chunkDir": "trace-chunks",
        "chunkCount": len(chunk_entries),
        "frameCount": len(frames),
        "totalBytes": total_bytes,
    }


def _store_frame_chunk(
    chunk_dir: Path,
    entries: list[dict[str, Any]],
    stored_hashes: list[tuple[str, int]],
    start: int,
    frames: list[dict[str, Any]],
) -> None:
    chunk = _frame_chunk(start, frames)
    content = _canonical_bytes(chunk)
    digest = _sha256(content)
    _write_content_addressed(chunk_dir / f"{digest}.json", content, digest)
    end = start + len(frames)
    entries.append(
        {
            "index": len(entries),
            "sha256": digest,
            "bytes": len(content),
            "frameStart": start,
            "frameEnd": end,
            "tStartSec": frames[0]["tSec"],
            "tEndSec": frames[-1]["tSec"],
        }
    )
    stored_hashes.append((digest, len(content)))


def _write_atomic(path: Path, content: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def _read_json(path: Path, label: str, chunk_index: int | None = None) -> tuple[dict[str, Any], bytes]:
    try:
        content = path.read_bytes()
        value = json.loads(content)
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        name = "header" if chunk_index is None else f"chunk {chunk_index}"
        raise TraceIntegrityError(f"could not read {name} {label}") from exc
    if not isinstance(value, dict):
        name = "header" if chunk_index is None else f"chunk {chunk_index}"
        raise TraceIntegrityError(f"malformed {name} {label}")
    return value, content


def _manifest_digest(value: Any, name: str) -> str:
    if not isinstance(value, str) or _SHA256_RE.fullmatch(value) is None:
        raise TraceIntegrityError(f"invalid {name} sha256")
    return value


def read_trace(
    out_dir: Path, expected_manifest_sha256: str | None = None
) -> dict[str, Any]:
    out_dir = Path(out_dir)
    manifest_path = out_dir / "trace-manifest.json"
    try:
        manifest_bytes = manifest_path.read_bytes()
        manifest = json.loads(manifest_bytes)
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise TraceIntegrityError("could not read trace manifest") from exc
    if not isinstance(manifest, dict):
        raise TraceIntegrityError("malformed trace manifest")
    actual_manifest_sha = _sha256(manifest_bytes)
    if (
        expected_manifest_sha256 is not None
        and actual_manifest_sha != expected_manifest_sha256
    ):
        raise TraceIntegrityError("trace manifest sha256 mismatch")
    if manifest_bytes != _canonical_bytes_for_read(manifest, "manifest"):
        raise TraceIntegrityError("trace manifest is not canonical JSON")
    if manifest.get("schema") != TRACE_MANIFEST_SCHEMA:
        raise TraceIntegrityError("unsupported trace manifest schema")
    if set(manifest) != {
        "schema",
        "maxChunkBytes",
        "frameCount",
        "header",
        "chunks",
        "traceSha256",
    }:
        raise TraceIntegrityError("malformed trace manifest fields")
    cap = manifest["maxChunkBytes"]
    frame_count = manifest["frameCount"]
    chunks = manifest["chunks"]
    if (
        not isinstance(cap, int)
        or isinstance(cap, bool)
        or cap <= 0
        or not isinstance(frame_count, int)
        or frame_count < 0
        or not isinstance(chunks, list)
    ):
        raise TraceIntegrityError("malformed trace manifest values")
    header_manifest = manifest["header"]
    if (
        not isinstance(header_manifest, dict)
        or set(header_manifest) != {"role", "sha256", "bytes"}
        or header_manifest["role"] != "header"
    ):
        raise TraceIntegrityError("malformed header manifest entry")
    header_sha = _manifest_digest(header_manifest["sha256"], "header")
    if not isinstance(header_manifest["bytes"], int):
        raise TraceIntegrityError("malformed header byte length")
    header_path = out_dir / "trace-chunks" / f"{header_sha}.json"
    header, header_bytes = _read_json(header_path, "header")
    if (
        _sha256(header_bytes) != header_sha
        or len(header_bytes) != header_manifest["bytes"]
        or len(header_bytes) > cap
        or header_bytes != _canonical_bytes_for_read(header, "header")
    ):
        raise TraceIntegrityError("header integrity check failed")
    if "frames" in header:
        raise TraceIntegrityError("header chunk contains frames")

    frames: list[Any] = []
    next_start = 0
    if frame_count == 0 and chunks:
        raise TraceIntegrityError("zero-frame trace has frame chunks")
    for index, entry in enumerate(chunks):
        try:
            if not isinstance(entry, dict) or set(entry) != {
                "index",
                "sha256",
                "bytes",
                "frameStart",
                "frameEnd",
                "tStartSec",
                "tEndSec",
            }:
                raise TraceIntegrityError(f"malformed chunk {index} manifest entry")
            if entry["index"] != index:
                raise TraceIntegrityError(f"chunk {index} index mismatch")
            digest = _manifest_digest(entry["sha256"], f"chunk {index}")
            start, end, byte_count = (
                entry["frameStart"],
                entry["frameEnd"],
                entry["bytes"],
            )
            if (
                not isinstance(start, int)
                or not isinstance(end, int)
                or not isinstance(byte_count, int)
                or start != next_start
                or end <= start
                or end > frame_count
            ):
                raise TraceIntegrityError(f"chunk {index} range is not contiguous")
            chunk_path = out_dir / "trace-chunks" / f"{digest}.json"
            chunk, content = _read_json(chunk_path, "frame chunk", index)
            if (
                _sha256(content) != digest
                or len(content) != byte_count
                or len(content) > cap
                or content != _canonical_bytes_for_read(chunk, f"chunk {index}")
            ):
                raise TraceIntegrityError(f"chunk {index} integrity check failed")
            if (
                set(chunk) != {"schema", "frameStart", "frameEnd", "frames"}
                or chunk.get("schema") != TRACE_CHUNK_SCHEMA
                or chunk.get("frameStart") != start
                or chunk.get("frameEnd") != end
                or not isinstance(chunk.get("frames"), list)
                or len(chunk["frames"]) != end - start
            ):
                raise TraceIntegrityError(f"chunk {index} range or schema mismatch")
            if (
                not chunk["frames"]
                or chunk["frames"][0].get("tSec") != entry["tStartSec"]
                or chunk["frames"][-1].get("tSec") != entry["tEndSec"]
            ):
                raise TraceIntegrityError(f"chunk {index} time range mismatch")
            frames.extend(chunk["frames"])
            next_start = end
        except TraceIntegrityError:
            raise
        except (KeyError, TypeError, AttributeError, ValueError) as exc:
            raise TraceIntegrityError(f"malformed chunk {index}") from exc
    if next_start != frame_count or len(frames) != frame_count:
        raise TraceIntegrityError("frame chunks do not cover the declared range")
    trace = {**header, "frames": frames}
    expected_trace_sha = _manifest_digest(manifest["traceSha256"], "trace")
    if _sha256(_canonical_bytes_for_read(trace, "trace")) != expected_trace_sha:
        raise TraceIntegrityError("reassembled trace sha256 mismatch")
    return trace


def _canonical_bytes_for_read(value: Any, label: str) -> bytes:
    try:
        return json.dumps(
            value,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=True,
            allow_nan=False,
        ).encode("utf-8")
    except (TypeError, ValueError) as exc:
        raise TraceIntegrityError(f"malformed {label} JSON values") from exc
