from __future__ import annotations

import json
import os
import selectors
import signal
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from simulator.runner import PlanValidationError, validate_plan

PLAN_ENTRY = Path(__file__).with_name("plan_entry.py")


@dataclass(frozen=True)
class PlanLimits:
    wall_sec: float = 10
    cpu_sec: int = 10
    memory_bytes: int = 1024 * 1024 * 1024
    max_output_bytes: int = 1024 * 1024


@dataclass(frozen=True)
class PlanOutcome:
    ok: bool
    plan: list[dict[str, Any]] | None
    detail: str | None
    wall_sec: float


def probe_isolation() -> dict[str, bool]:
    code = (
        "import json, os\n"
        "ok = False\n"
        "try:\n"
        "    os.unshare(os.CLONE_NEWUSER | os.CLONE_NEWNET)\n"
        "    ok = True\n"
        "except (AttributeError, OSError):\n"
        "    pass\n"
        "print(json.dumps({'netns': ok, 'privilegeDrop': os.geteuid() == 0}))\n"
    )
    try:
        completed = subprocess.run(
            [sys.executable, "-I", "-c", code],
            check=False,
            capture_output=True,
            text=True,
            timeout=5,
            env={"PATH": os.defpath, "PYTHONDONTWRITEBYTECODE": "1"},
        )
        if completed.returncode == 0:
            result = json.loads(completed.stdout)
            return {"netns": bool(result["netns"]), "privilegeDrop": bool(result["privilegeDrop"])}
    except (
        AttributeError,
        OSError,
        subprocess.TimeoutExpired,
        TypeError,
        ValueError,
        KeyError,
        json.JSONDecodeError,
    ):
        pass
    return {"netns": False, "privilegeDrop": os.geteuid() == 0}


def _preexec(limits: PlanLimits) -> None:
    import resource

    resource.setrlimit(resource.RLIMIT_AS, (limits.memory_bytes, limits.memory_bytes))
    resource.setrlimit(resource.RLIMIT_CPU, (limits.cpu_sec, limits.cpu_sec))
    resource.setrlimit(resource.RLIMIT_FSIZE, (16 * 1024 * 1024, 16 * 1024 * 1024))
    resource.setrlimit(resource.RLIMIT_NOFILE, (64, 64))
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    if os.geteuid() == 0:
        os.setgroups([])
        os.setgid(65534)
        os.setuid(65534)


def _kill_process(process: subprocess.Popen[bytes]) -> None:
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass


def _detail(stderr: bytes, returncode: int | None) -> str:
    text = stderr.decode("utf-8", errors="replace")
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    if lines and (":" in lines[-1] or lines[-1].startswith("PermissionError")):
        message = lines[-1]
        for prefix in ("ZeroDivisionError", "PermissionError", "MemoryError", "ValueError", "TypeError"):
            if message.startswith(prefix):
                return f"plan raised {message}"[:300]
    if returncode == -signal.SIGXCPU:
        return "plan process exceeded cpu limit"
    if returncode == -signal.SIGKILL:
        return "plan process terminated by signal"
    if returncode == -signal.SIGSEGV:
        return "plan process exceeded memory limit"
    if returncode == 70:
        return "required network namespace unavailable"
    return "plan process exited without a result"


def run_plan_sandbox(
    controller_path: Path,
    controller_input: dict[str, Any],
    workdir: Path,
    limits: PlanLimits,
    require_netns: bool,
    test_skip_netns: bool = False,
) -> PlanOutcome:
    started = time.perf_counter()
    controller_path = controller_path.resolve()
    workdir = workdir.resolve()
    command = [
        sys.executable,
        "-I",
        str(PLAN_ENTRY),
        "--workdir",
        str(workdir),
        "--controller",
        str(controller_path),
    ]
    if require_netns:
        command.append("--require-netns")
    if test_skip_netns:
        command.append("--test-audit-hook-only")
    environment = {
        "PATH": os.defpath,
        "HOME": str(workdir),
        "TMPDIR": str(workdir),
        "PYTHONDONTWRITEBYTECODE": "1",
        "PYTHONHASHSEED": "0",
        "OPENBLAS_NUM_THREADS": "1",
        "OMP_NUM_THREADS": "1",
        "MKL_NUM_THREADS": "1",
    }
    try:
        workdir.mkdir(parents=True, exist_ok=True)
        if os.geteuid() == 0:
            os.chown(workdir, 65534, 65534)
            os.chown(controller_path, 65534, 65534)
        with tempfile.TemporaryFile() as stderr_file:
            process = subprocess.Popen(
                command,
                cwd=workdir,
                env=environment,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=stderr_file,
                start_new_session=True,
                preexec_fn=lambda: _preexec(limits),  # noqa: PLW1509
            )
            assert process.stdin is not None
            assert process.stdout is not None
            try:
                input_bytes = json.dumps(controller_input, allow_nan=True).encode()
                process.stdin.write(input_bytes)
                process.stdin.close()
            except (BrokenPipeError, OSError):
                pass

            output = bytearray()
            timed_out = False
            too_large = False
            selector = selectors.DefaultSelector()
            selector.register(process.stdout, selectors.EVENT_READ)
            deadline = started + limits.wall_sec
            while selector.get_map() or process.poll() is None:
                remaining = deadline - time.perf_counter()
                if remaining <= 0:
                    timed_out = True
                    _kill_process(process)
                    break
                events = selector.select(min(remaining, 0.05))
                for key, _ in events:
                    chunk = os.read(key.fileobj.fileno(), min(65536, limits.max_output_bytes + 1 - len(output)))
                    if not chunk:
                        selector.unregister(key.fileobj)
                        continue
                    output.extend(chunk)
                    if len(output) > limits.max_output_bytes:
                        too_large = True
                        _kill_process(process)
                        break
                if too_large:
                    break
            if timed_out or too_large:
                _kill_process(process)
            process.wait()
            selector.close()
            stderr_file.seek(0)
            stderr = stderr_file.read(4096)
            wall_sec = time.perf_counter() - started
            if timed_out:
                return PlanOutcome(False, None, "plan process exceeded wall limit", wall_sec)
            if too_large:
                return PlanOutcome(False, None, "plan output exceeded limit", wall_sec)
            if process.returncode != 0:
                return PlanOutcome(False, None, _detail(stderr, process.returncode), wall_sec)
            if not output:
                return PlanOutcome(False, None, "plan process exited without a result", wall_sec)
            try:
                envelope = json.loads(output)
                plan = validate_plan(envelope["plan"])
            except (json.JSONDecodeError, KeyError, TypeError, PlanValidationError) as exc:
                return PlanOutcome(
                    False,
                    None,
                    f"invalid plan result: {type(exc).__name__}"[:300],
                    wall_sec,
                )
            return PlanOutcome(True, plan, None, wall_sec)
    except Exception as exc:  # noqa: BLE001
        return PlanOutcome(
            False,
            None,
            f"plan sandbox failed: {type(exc).__name__}"[:300],
            time.perf_counter() - started,
        )
