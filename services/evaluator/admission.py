from __future__ import annotations

import hashlib
import json
import os
import re
import stat
import tarfile
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from types import MappingProxyType

from evaluator.errors import CandidateIntegrityError
from evaluator.signing import canonical_bytes

_COMPONENT = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
_MANIFEST = "forksafe-bundle.json"
_CONTROLLER = "task_controller.py"
_MAX_CONTROLLER = 200_000
_MAX_ASSET = 1024 * 1024
_MAX_TOTAL = 4 * 1024 * 1024
_MAX_FILES = 32
_MAX_MEMBERS = 64
_MAX_DEPTH = 4


class AdmissionError(CandidateIntegrityError):
    def __init__(self, reason: str, message: str | None = None):
        self.reason = reason
        super().__init__(message or reason.replace("_", " "))


@dataclass(frozen=True)
class AdmittedBundle:
    files: Mapping[str, bytes]
    controller_sha256: str
    bundle_sha256: str
    manifest_entries: tuple[dict[str, object], ...]


def _reject(reason: str, message: str | None = None) -> None:
    raise AdmissionError(reason, message)


def _read_regular(path: Path, info: os.stat_result, limit: int) -> bytes:
    if stat.S_ISLNK(info.st_mode):
        _reject("symlink")
    if not stat.S_ISREG(info.st_mode):
        _reject("special_file")
    if info.st_nlink != 1:
        _reject("hardlink")
    if info.st_size > limit:
        _reject("file_too_large")
    fd = -1
    try:
        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
        fd = os.open(path, flags)
        opened = os.fstat(fd)
        if (opened.st_dev, opened.st_ino) != (info.st_dev, info.st_ino):
            _reject("unreadable")
        if stat.S_ISLNK(opened.st_mode):
            _reject("symlink")
        if not stat.S_ISREG(opened.st_mode):
            _reject("special_file")
        if opened.st_nlink != 1:
            _reject("hardlink")
        if opened.st_size > limit:
            _reject("file_too_large")
        chunks: list[bytes] = []
        remaining = limit + 1
        while remaining:
            chunk = os.read(fd, min(65536, remaining))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        result = b"".join(chunks)
        if len(result) > limit:
            _reject("file_too_large")
        return result
    except AdmissionError:
        raise
    except OSError as exc:
        _reject("unreadable", "bundle file is unreadable")
        raise AssertionError from exc
    finally:
        if fd >= 0:
            os.close(fd)


def _path_name(name: str, *, directory: bool = False) -> str:
    if name.startswith("/"):
        _reject("absolute_path")
    name = name.removeprefix("./")
    if "\\" in name or "\x00" in name:
        _reject("invalid_path")
    raw_parts = name.rstrip("/").split("/")
    if any(part == ".." for part in raw_parts):
        _reject("path_traversal")
    if not name or any(part in {"", "."} for part in raw_parts):
        _reject("invalid_path")
    if len(raw_parts) > _MAX_DEPTH:
        _reject("invalid_path")
    if any(not _COMPONENT.fullmatch(part) for part in raw_parts):
        _reject("invalid_path")
    if not directory and name.endswith("/"):
        _reject("invalid_path")
    return "/".join(raw_parts)


def _directory_files(root: Path) -> dict[str, bytes]:
    try:
        root_info = root.lstat()
    except OSError as exc:
        _reject("unreadable", "bundle directory is unavailable")
        raise AssertionError from exc
    if stat.S_ISLNK(root_info.st_mode):
        _reject("symlink")
    if not stat.S_ISDIR(root_info.st_mode):
        _reject("special_file")
    result: dict[str, bytes] = {}

    def visit(directory: Path, relative: tuple[str, ...]) -> None:
        if len(relative) >= _MAX_DEPTH:
            try:
                with os.scandir(directory) as entries:
                    if next(entries, None) is not None:
                        _reject("invalid_path")
            except AdmissionError:
                raise
            except OSError as exc:
                _reject("unreadable", "bundle directory is unreadable")
                raise AssertionError from exc
            return
        try:
            with os.scandir(directory) as entries:
                children = sorted(entries, key=lambda entry: entry.name)
        except OSError as exc:
            _reject("unreadable", "bundle directory is unreadable")
            raise AssertionError from exc
        for entry in children:
            name = _path_name("/".join((*relative, entry.name)))
            try:
                info = entry.stat(follow_symlinks=False)
            except OSError as exc:
                _reject("unreadable", "bundle entry is unreadable")
                raise AssertionError from exc
            if stat.S_ISLNK(info.st_mode):
                _reject("symlink")
            if stat.S_ISDIR(info.st_mode):
                visit(Path(entry.path), (*relative, entry.name))
                continue
            if not stat.S_ISREG(info.st_mode):
                _reject("special_file")
            if info.st_nlink != 1:
                _reject("hardlink")
            if name in result:
                _reject("duplicate_path")
            if len(result) >= _MAX_FILES:
                _reject("too_many_files")
            limit = _MAX_CONTROLLER if name == _CONTROLLER else _MAX_ASSET
            result[name] = _read_regular(Path(entry.path), info, limit)
    visit(root, ())
    return result


def _tar_files(path: Path) -> dict[str, bytes]:
    result: dict[str, bytes] = {}
    names: set[str] = set()
    try:
        with tarfile.open(path, mode="r:*") as archive:
            members = archive.getmembers()
            if len(members) > _MAX_MEMBERS:
                _reject("too_many_files")
            for member in members:
                if member.issym() or member.islnk():
                    _reject("symlink" if member.issym() else "hardlink")
                if not (member.isdir() or member.isfile()):
                    _reject("special_file")
                name = _path_name(member.name, directory=member.isdir())
                if name in names:
                    _reject("duplicate_path")
                names.add(name)
                if member.isdir():
                    continue
                if member.size < 0:
                    _reject("bad_bundle_manifest", "tar member has invalid size")
                if name == _CONTROLLER:
                    limit = _MAX_CONTROLLER
                else:
                    limit = _MAX_ASSET
                if member.size > limit:
                    _reject("file_too_large")
                if len(result) >= _MAX_FILES:
                    _reject("too_many_files")
                stream = archive.extractfile(member)
                if stream is None:
                    _reject("unreadable", "tar member is unreadable")
                chunks: list[bytes] = []
                remaining = limit + 1
                while remaining:
                    chunk = stream.read(min(65536, remaining))
                    if not chunk:
                        break
                    chunks.append(chunk)
                    remaining -= len(chunk)
                contents = b"".join(chunks)
                if len(contents) != member.size or len(contents) > limit:
                    _reject("unreadable", "tar member size does not match its header")
                result[name] = contents
    except AdmissionError:
        raise
    except (OSError, tarfile.TarError, EOFError) as exc:
        _reject("unreadable", "bundle archive is unreadable")
        raise AssertionError from exc
    return result


def _validate_bundle(files: dict[str, bytes]) -> AdmittedBundle:
    if _CONTROLLER not in files:
        _reject("missing_entry")
    total = sum(map(len, files.values()))
    if total > _MAX_TOTAL:
        _reject("bundle_too_large")
    raw_manifest = files.get(_MANIFEST)
    declared_assets: list[dict[str, object]] = []
    if raw_manifest is None:
        if set(files) != {_CONTROLLER}:
            _reject("undeclared_path")
    else:
        try:
            manifest = json.loads(raw_manifest)
            if (
                not isinstance(manifest, dict)
                or manifest.get("schema") != "forksafe.candidate_bundle.v1"
                or manifest.get("entry") != _CONTROLLER
                or not isinstance(manifest.get("assets"), list)
            ):
                _reject("bad_bundle_manifest")
            seen_assets: set[str] = set()
            for item in manifest["assets"]:
                if (
                    not isinstance(item, dict)
                    or set(item) != {"path", "sha256", "bytes"}
                    or not isinstance(item["path"], str)
                    or not isinstance(item["sha256"], str)
                    or not re.fullmatch(r"[0-9a-f]{64}", item["sha256"])
                    or type(item["bytes"]) is not int
                    or item["bytes"] < 0
                ):
                    _reject("bad_bundle_manifest")
                asset_path = _path_name(item["path"])
                if (
                    not asset_path.startswith("assets/")
                    or PurePosixPath(asset_path).suffix not in {".json", ".txt", ".csv"}
                    or asset_path in seen_assets
                ):
                    _reject("bad_bundle_manifest")
                seen_assets.add(asset_path)
                declared_assets.append(
                    {"path": asset_path, "sha256": item["sha256"], "bytes": item["bytes"]}
                )
        except AdmissionError:
            raise
        except (KeyError, TypeError, ValueError, json.JSONDecodeError):
            _reject("bad_bundle_manifest")
        expected = {_CONTROLLER, _MANIFEST, *(entry["path"] for entry in declared_assets)}
        actual = set(files)
        if _CONTROLLER not in actual:
            _reject("missing_entry")
        missing_assets = {entry["path"] for entry in declared_assets} - actual
        if missing_assets:
            _reject("missing_declared_asset")
        if actual - expected:
            _reject("undeclared_path")
        for entry in declared_assets:
            data = files[str(entry["path"])]
            if len(data) > _MAX_ASSET:
                _reject("file_too_large")
            if len(data) != entry["bytes"] or hashlib.sha256(data).hexdigest() != entry["sha256"]:
                _reject("asset_hash_mismatch")
    if len(files) > _MAX_FILES:
        _reject("too_many_files")
    entries = tuple(
        {
            "path": path,
            "sha256": hashlib.sha256(data).hexdigest(),
            "bytes": len(data),
        }
        for path, data in sorted(files.items())
    )
    bundle_sha = hashlib.sha256(canonical_bytes(list(entries))).hexdigest()
    return AdmittedBundle(
        MappingProxyType(dict(files)),
        hashlib.sha256(files[_CONTROLLER]).hexdigest(),
        bundle_sha,
        entries,
    )


def admit(path: Path) -> AdmittedBundle:
    try:
        info = path.lstat()
    except OSError as exc:
        _reject("unreadable", "candidate path is unavailable")
        raise AssertionError from exc
    if stat.S_ISLNK(info.st_mode):
        _reject("symlink")
    if stat.S_ISDIR(info.st_mode):
        files = _directory_files(path)
    elif stat.S_ISREG(info.st_mode):
        if info.st_nlink != 1:
            _reject("hardlink")
        if tarfile.is_tarfile(path):
            files = _tar_files(path)
        else:
            data = _read_regular(path, info, _MAX_CONTROLLER)
            files = {_CONTROLLER: data}
    else:
        _reject("special_file")
    if len(files) > _MAX_FILES:
        _reject("too_many_files")
    if sum(map(len, files.values())) > _MAX_TOTAL:
        _reject("bundle_too_large")
    return _validate_bundle(files)


def materialize(bundle: AdmittedBundle, dest_dir: Path) -> Path:
    try:
        dest_dir.mkdir(mode=0o700, parents=False, exist_ok=False)
        for relative, contents in bundle.files.items():
            target = dest_dir.joinpath(*PurePosixPath(relative).parts)
            target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
            fd = os.open(target, flags, 0o600)
            with os.fdopen(fd, "wb") as handle:
                handle.write(contents)
    except OSError as exc:
        raise CandidateIntegrityError("could not materialize candidate bundle") from exc
    return dest_dir
