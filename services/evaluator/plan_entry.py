from __future__ import annotations

import argparse
import importlib.util
import json
import os
import sys
import traceback
from pathlib import Path

DENIED_IMPORTS = frozenset(
    {
        "simulator",
        "evaluator",
        "ctypes",
        "_ctypes",
        "socket",
        "_socket",
        "ssl",
        "_ssl",
        "subprocess",
        "_posixsubprocess",
        "multiprocessing",
        "gc",
        "urllib",
        "http",
        "asyncio",
    }
)
DENIED_EVENTS = frozenset(
    {
        "subprocess.Popen",
        "os.system",
        "os.exec",
        "os.posix_spawn",
        "os.spawn",
        "os.fork",
        "os.forkpty",
        "pty.spawn",
        "ctypes.dlopen",
        "ctypes.dlsym",
        "ctypes.cdata",
        "os.kill",
        "os.killpg",
        "signal.pthread_kill",
    }
)
MUTATING_EVENTS = frozenset(
    {
        "os.remove",
        "os.rename",
        "os.rmdir",
        "os.mkdir",
        "os.chmod",
        "os.chown",
        "os.symlink",
        "os.link",
        "os.truncate",
        "os.utime",
    }
)


def _arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--workdir", required=True, type=Path)
    parser.add_argument("--controller", required=True, type=Path)
    parser.add_argument("--require-netns", action="store_true")
    parser.add_argument("--test-audit-hook-only", action="store_true", help=argparse.SUPPRESS)
    return parser.parse_args()


def _realpath(path: str | bytes | os.PathLike[str] | os.PathLike[bytes]) -> str:
    return os.path.realpath(os.fsdecode(path))


def _is_within(path: str, root: str) -> bool:
    try:
        return os.path.commonpath((path, root)) == root
    except ValueError:
        return False


def _audit_hook(workdir: Path) -> None:
    allowed_read_roots = tuple(
        os.path.realpath(path)
        for path in {
            str(workdir),
            sys.prefix,
            sys.base_prefix,
            sys.exec_prefix,
            sys.base_exec_prefix,
        }
    )
    allowed_devices = frozenset({"/dev/null", "/dev/urandom"})

    def allowed_path(raw_path: object) -> bool:
        if not isinstance(raw_path, (str, bytes, os.PathLike)):
            return False
        try:
            path = _realpath(raw_path)
        except (OSError, TypeError, ValueError):
            return False
        return path in allowed_devices or any(
            _is_within(path, root) for root in allowed_read_roots
        )

    def hook(event: str, args: tuple[object, ...]) -> None:
        if event in DENIED_EVENTS or event.startswith("socket."):
            raise PermissionError(f"blocked audit event: {event}")
        if event == "import":
            name = args[0] if args else ""
            if isinstance(name, str) and name.partition(".")[0] in DENIED_IMPORTS:
                raise PermissionError(f"blocked import: {name.partition('.')[0]}")
        elif event == "open":
            path = args[0] if args else None
            if isinstance(path, int):
                return
            if not isinstance(path, (str, bytes, os.PathLike)):
                raise PermissionError("blocked open path")
            mode = args[1] if len(args) > 1 else None
            flags = args[2] if len(args) > 2 else 0
            writing = isinstance(mode, str) and any(char in mode for char in "wax+")
            if isinstance(flags, int):
                write_flags = (
                    os.O_WRONLY
                    | os.O_RDWR
                    | os.O_CREAT
                    | os.O_TRUNC
                    | os.O_APPEND
                )
                writing = writing or bool(flags & write_flags)
            try:
                resolved = _realpath(path)
            except (OSError, TypeError, ValueError):
                raise PermissionError("blocked open path") from None
            root = os.path.realpath(workdir)
            if writing:
                permitted = _is_within(resolved, root)
            else:
                permitted = resolved in {"/dev/null", "/dev/urandom"} or any(
                    _is_within(resolved, allowed_root)
                    for allowed_root in allowed_read_roots
                )
            if not permitted:
                raise PermissionError(f"blocked file access: {resolved}")
        elif event == "os.chdir":
            if not args or not allowed_path(args[0]):
                raise PermissionError("blocked chdir outside workdir")
            resolved = _realpath(args[0])  # type: ignore[arg-type]
            if not _is_within(resolved, os.path.realpath(workdir)):
                raise PermissionError("blocked chdir outside workdir")
        elif event in {"os.listdir", "os.scandir"}:
            path = args[0] if args else None
            if not allowed_path(path):
                raise PermissionError(f"blocked directory listing: {event}")
        elif event in MUTATING_EVENTS or event.startswith("shutil."):
            paths = [
                arg
                for arg in args[:2]
                if isinstance(arg, (str, bytes, os.PathLike))
            ]
            if not paths or any(not allowed_path(path) for path in paths):
                raise PermissionError(f"blocked filesystem mutation: {event}")
            if any(
                not _is_within(_realpath(path), os.path.realpath(workdir))
                for path in paths
            ):
                raise PermissionError(f"blocked filesystem mutation: {event}")

    sys.addaudithook(hook)


def main() -> int:
    args = _arguments()
    workdir = args.workdir.resolve()
    controller = args.controller.resolve()
    if not _is_within(str(controller), str(workdir)):
        print("controller must be inside workdir", file=sys.stderr)
        return 1

    if not args.test_audit_hook_only:
        try:
            os.unshare(os.CLONE_NEWUSER | os.CLONE_NEWNET)
        except (AttributeError, OSError) as exc:
            if args.require_netns:
                print(f"required network namespace unavailable: {type(exc).__name__}", file=sys.stderr)
                return 70

    envelope_fd = os.dup(1)
    os.dup2(2, 1)
    try:
        controller_input = json.loads(sys.stdin.read())
    except Exception as exc:  # noqa: BLE001
        print(f"invalid controller input: {type(exc).__name__}", file=sys.stderr)
        return 1

    try:
        import math  # noqa: F401

        import mujoco  # noqa: F401
        import numpy  # noqa: F401

        for cached_name in tuple(sys.modules):
            if cached_name.partition(".")[0] in DENIED_IMPORTS:
                sys.modules.pop(cached_name, None)
        _audit_hook(workdir)
        spec = importlib.util.spec_from_file_location("forksafe_candidate", controller)
        if spec is None or spec.loader is None:
            raise ImportError("could not load candidate controller")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        plan = module.plan(controller_input)
        payload = json.dumps({"plan": plan}, allow_nan=True, separators=(",", ":")).encode()
        remaining = memoryview(payload)
        while remaining:
            written = os.write(envelope_fd, remaining)
            if written <= 0:
                raise OSError("plan envelope write failed")
            remaining = remaining[written:]
        return 0
    except BaseException:  # noqa: BLE001
        error = traceback.format_exc()[-2000:]
        sys.stderr.write(error)
        sys.stderr.flush()
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
