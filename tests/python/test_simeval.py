from __future__ import annotations

import hashlib
import json
import os
import shutil
import socket
import subprocess
import sys
import textwrap
import threading
import time
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
from uuid import UUID

import pytest
from evaluator.models import CandidateEvaluation
from evaluator.run_candidate import code_tree_sha256, execute_case
from evaluator.sandbox import probe_isolation
from simulator.models import SimCase

ROOT = Path(__file__).resolve().parents[2]
SERVICES = ROOT / "services"
BUILD_SUITES_SPEC = spec_from_file_location("suite_builder", ROOT / "evaluation/build_suites.py")
if BUILD_SUITES_SPEC is None or BUILD_SUITES_SPEC.loader is None:
    raise ImportError("could not load evaluation/build_suites.py")
build_suites = module_from_spec(BUILD_SUITES_SPEC)
BUILD_SUITES_SPEC.loader.exec_module(build_suites)
BASELINE = ROOT / "controllers/baseline/task_controller.py"
REFERENCE = ROOT / "evaluation/reference_controller/task_controller.py"
PUBLIC_MANIFEST = ROOT / "evaluation/public/manifest.json"
WITHHELD_MANIFEST = ROOT / "evaluation/withheld/manifest.json"

BASELINE_PLAN = """
CARRY_HEIGHT = 0.06

def plan(scene):
    cube = scene["cubePos"]
    target = scene["targetPos"]
    return [
        {"skill": "open_gripper"},
        {"skill": "move_to_pose", "pos": [cube[0], cube[1], cube[2] + 0.12], "speed": 0.2},
        {"skill": "move_to_pose", "pos": [cube[0], cube[1], cube[2]], "speed": 0.2},
        {"skill": "close_gripper"},
        {"skill": "move_to_pose", "pos": [cube[0], cube[1], CARRY_HEIGHT], "speed": 0.15},
        {"skill": "move_to_pose", "pos": [target[0], target[1], CARRY_HEIGHT], "speed": 0.15},
        {"skill": "move_to_pose", "pos": target, "speed": 0.2},
        {"skill": "open_gripper"},
        {"skill": "move_to_pose", "pos": [target[0], target[1], target[2] + 0.12], "speed": 0.2},
    ]
"""


def _run_candidate(
    tmp_path: Path,
    *,
    source: str | None = None,
    controller: Path | None = None,
    suite: str = "public",
    case_ids: str | None = "nominal",
    withheld_manifest: Path | None = None,
    consume_withheld: bool = False,
    expected_sha256: str | None = None,
    plan_wall_sec: int = 10,
    plan_cpu_sec: int = 10,
    extra_args: tuple[str, ...] = (),
) -> tuple[subprocess.CompletedProcess[str], dict[str, object], float]:
    if source is not None:
        controller_path = tmp_path / "task_controller.py"
        controller_path.write_text(source, encoding="utf-8")
    else:
        controller_path = controller or BASELINE
    controller_sha = hashlib.sha256(controller_path.read_bytes()).hexdigest()
    output_path = tmp_path / "run.json"
    command = [
        sys.executable,
        "-m",
        "evaluator.run_candidate",
        "--controller",
        str(controller_path),
        "--expected-sha256",
        expected_sha256 or controller_sha,
        "--suite",
        suite,
        "--out",
        str(output_path),
        "--artifacts-dir",
        str(tmp_path / "artifacts"),
        "--work-dir",
        str(tmp_path / "workers"),
        "--plan-wall-sec",
        str(plan_wall_sec),
        "--plan-cpu-sec",
        str(plan_cpu_sec),
        "--case-wall-sec",
        "180",
    ]
    if case_ids is not None:
        command.extend(("--case-ids", case_ids))
    if withheld_manifest is not None:
        command.extend(("--withheld-manifest", str(withheld_manifest)))
    if consume_withheld:
        command.append("--consume-withheld-manifest")
    command.extend(extra_args)
    environment = {
        "HOME": str(tmp_path),
        "PATH": os.defpath,
        "PYTHONPATH": str(SERVICES),
        "PYTHONDONTWRITEBYTECODE": "1",
    }
    started = time.perf_counter()
    completed = subprocess.run(
        command,
        cwd=ROOT,
        env=environment,
        check=False,
        capture_output=True,
        text=True,
        timeout=900,
    )
    elapsed = time.perf_counter() - started
    assert output_path.is_file(), completed.stderr
    document = json.loads(output_path.read_text(encoding="utf-8"))
    assert document["schema"] == "forksafe.run_candidate.v1"
    assert document["exitCode"] == completed.returncode
    assert document["status"] in {
        "passed",
        "failed",
        "invalid",
        "integrity_error",
        "infrastructure_error",
    }
    for evaluation in document["evaluations"]:
        CandidateEvaluation.model_validate(evaluation)
    for case in document["cases"]:
        assert case["status"] in {"passed", "failed", "invalid"}
        assert isinstance(case["failureKinds"], list)
        assert isinstance(case["metrics"]["caseWallSec"], (int, float))
    return completed, document, elapsed


def _only_case(document: dict[str, object]) -> dict[str, object]:
    cases = document["cases"]
    assert isinstance(cases, list) and len(cases) == 1
    return cases[0]


@pytest.mark.parametrize(
    ("source", "expected_failure"),
    [
        (
            """
def plan(scene):
    return [{"skill": "move_to_pose", "pos": [float("nan"), 0, 0.3], "speed": float("inf")}]
""",
            "nonfinite_command",
        ),
        (
            """
def plan(scene):
    raise RuntimeError("planned failure")
""",
            "invalid_run",
        ),
    ],
    ids=("nonfinite-command", "raising-controller"),
)
def test_nonfinite_and_raising_plans_are_reported(
    tmp_path: Path,
    source: str,
    expected_failure: str,
) -> None:
    completed, document, _ = _run_candidate(tmp_path, source=source)
    case = _only_case(document)
    assert completed.returncode == 1
    assert case["failureKinds"] == [expected_failure]
    assert case["status"] in {"failed", "invalid"}


def test_cpu_spin_is_limited(tmp_path: Path) -> None:
    source = "def plan(scene):\n    while True:\n        pass\n"
    completed, document, elapsed = _run_candidate(
        tmp_path,
        source=source,
        plan_wall_sec=3,
        plan_cpu_sec=3,
    )
    case = _only_case(document)
    assert completed.returncode == 1
    assert case["status"] == "invalid"
    assert elapsed < 20


def test_memory_blowup_is_limited(tmp_path: Path) -> None:
    source = "def plan(scene):\n    return [bytearray(8 * 1024 * 1024 * 1024)]\n"
    completed, document, _ = _run_candidate(tmp_path, source=source)
    assert completed.returncode == 1
    assert _only_case(document)["status"] == "invalid"


def test_withheld_manifest_read_is_blocked(tmp_path: Path) -> None:
    source = (
        f"def plan(scene):\n"
        f"    open({str(WITHHELD_MANIFEST)!r}, encoding='utf-8').read()\n"
        f"    return []\n"
    )
    completed, document, _ = _run_candidate(tmp_path, source=source)
    case = _only_case(document)
    assert completed.returncode == 1
    assert case["status"] == "invalid"


def test_consumed_withheld_manifest_is_unlinked_before_candidate_runs(tmp_path: Path) -> None:
    manifest_copy = tmp_path / "withheld.json"
    shutil.copyfile(WITHHELD_MANIFEST, manifest_copy)
    withheld_case_id = json.loads(manifest_copy.read_text(encoding="utf-8"))["cases"][0]["caseId"]
    source = (
        f"def plan(scene):\n"
        f"    open({str(manifest_copy)!r}, encoding='utf-8').read()\n"
        f"    return []\n"
    )
    completed, document, _ = _run_candidate(
        tmp_path,
        source=source,
        suite="withheld",
        case_ids=withheld_case_id,
        withheld_manifest=manifest_copy,
        consume_withheld=True,
    )
    assert completed.returncode == 1
    assert not manifest_copy.exists()
    assert _only_case(document)["status"] == "invalid"
    assert _only_case(document)["firstFailure"]["detail"] == "redacted: withheld case"
    assert document["firstFailure"]["detail"] == "redacted: withheld case"
    assert all("sceneOverrides" not in case for case in document["cases"])


def _assert_no_listener_connections(
    tmp_path: Path,
    source: str,
    *,
    extra_args: tuple[str, ...] = (),
) -> dict[str, object]:
    received: list[socket.socket] = []
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        listener.bind(("127.0.0.1", 0))
        listener.listen()
        listener.settimeout(4)
        host, port = listener.getsockname()

        def accept_one() -> None:
            try:
                connection, _ = listener.accept()
            except TimeoutError:
                return
            received.append(connection)
            connection.close()

        accept_thread = threading.Thread(target=accept_one, daemon=True)
        accept_thread.start()
        completed, document, _ = _run_candidate(
            tmp_path,
            source=source.format(host=host, port=port),
            extra_args=extra_args,
        )
        accept_thread.join(timeout=5)
    for connection in received:
        connection.close()
    assert completed.returncode == 1
    assert _only_case(document)["status"] == "invalid"
    assert received == []
    return document


@pytest.mark.parametrize(
    "source",
    [
        """
def plan(scene):
    import socket
    socket.create_connection(("{host}", {port}), timeout=1)
    return []
""",
        """
def plan(scene):
    import urllib.request
    urllib.request.urlopen("http://{host}:{port}/", timeout=1)
    return []
""",
    ],
    ids=("socket", "urllib"),
)
def test_network_attempts_are_blocked_before_connect(
    tmp_path: Path,
    source: str,
) -> None:
    _assert_no_listener_connections(tmp_path, source)


def test_audit_hook_only_fallback_still_blocks_network(tmp_path: Path) -> None:
    document = _assert_no_listener_connections(
        tmp_path,
        """
def plan(scene):
    import socket
    socket.create_connection(("{host}", {port}), timeout=1)
    return []
""",
        extra_args=("--test-audit-hook-only",),
    )
    assert document["isolation"]["network"] == "audit_hook_only"


@pytest.mark.parametrize("module", ("simulator", "evaluator", "ctypes"))
def test_protected_modules_cannot_be_imported(tmp_path: Path, module: str) -> None:
    source = f"import {module}\n\ndef plan(scene):\n    return []\n"
    completed, document, _ = _run_candidate(tmp_path, source=source)
    assert completed.returncode == 1
    assert _only_case(document)["status"] == "invalid"


def test_physics_monkeypatches_do_not_change_trusted_execution(tmp_path: Path) -> None:
    source = (
        "import sys\n"
        "import mujoco\n"
        "import numpy as np\n"
        "import math\n"
        "mujoco.mj_step = lambda *args: None\n"
        "sys.modules['simulator.runner'] = object()\n"
        "np.linalg.norm(np.array([0.0, 0.0]))\n"
        "math.isfinite(0.0)\n"
        + BASELINE_PLAN
    )
    completed, document, _ = _run_candidate(
        tmp_path,
        source=source,
        case_ids="original-divider-collision",
    )
    case = _only_case(document)
    assert completed.returncode == 1
    assert case["status"] == "failed"
    assert "forbidden_contact" in case["failureKinds"]


def test_writes_outside_plan_workdir_are_blocked(tmp_path: Path) -> None:
    marker = tmp_path / "marker.txt"
    target = tmp_path / "copy-safe.txt"
    target.write_text("keep", encoding="utf-8")
    source = f"""
from pathlib import Path

def plan(scene):
    succeeded = []
    try:
        Path({str(marker)!r}).write_text("marker", encoding="utf-8")
        succeeded.append(True)
    except PermissionError:
        succeeded.append(False)
    try:
        with Path({str(target)!r}).open("a", encoding="utf-8") as stream:
            stream.write("append")
        succeeded.append(True)
    except PermissionError:
        succeeded.append(False)
    if any(succeeded):
        return []
    raise RuntimeError("writes blocked")
"""
    completed, document, _ = _run_candidate(tmp_path, source=source)
    assert completed.returncode == 1
    assert _only_case(document)["status"] == "invalid"
    assert not marker.exists()
    assert target.read_text(encoding="utf-8") == "keep"


@pytest.mark.parametrize(
    "source",
    (
        "import os\n\ndef plan(scene):\n    os._exit(0)\n",
        "import sys\nsys.exit(0)\n\ndef plan(scene):\n    return []\n",
    ),
    ids=("os-exit-in-plan", "sys-exit-at-import"),
)
def test_clean_process_exit_cannot_spoof_a_plan_result(
    tmp_path: Path,
    source: str,
) -> None:
    completed, document, _ = _run_candidate(tmp_path, source=source)
    case = _only_case(document)
    assert completed.returncode == 1
    assert case["status"] == "invalid"
    assert case["firstFailure"]["detail"] == "plan process exited without a result"


def test_stdout_spoof_does_not_replace_physics_result(tmp_path: Path) -> None:
    source = 'def plan(scene):\n    print(\'{"status":"passed"}\')\n' + BASELINE_PLAN
    completed, document, _ = _run_candidate(
        tmp_path,
        source=source,
        case_ids="original-divider-collision",
    )
    case = _only_case(document)
    assert completed.returncode == 1
    assert case["status"] == "failed"
    assert "forbidden_contact" in case["failureKinds"]


@pytest.mark.parametrize(
    ("body", "imports"),
    [
        ("os.system('true')", "import os"),
        (
            "pid = os.fork()\nif pid == 0:\n    os._exit(0)\nos.waitpid(pid, 0)",
            "import os",
        ),
        ("import subprocess", ""),
        ("import ctypes", ""),
        ("os.kill(os.getppid(), 9)", "import os"),
    ],
    ids=("os-system", "fork", "subprocess", "ctypes", "kill-parent"),
)
def test_process_and_native_execution_attempts_are_blocked(
    tmp_path: Path,
    body: str,
    imports: str,
) -> None:
    source = (
        f"{imports}\n\ndef plan(scene):\n"
        f"{textwrap.indent(body, '    ')}\n"
        "    return []\n"
    )
    completed, document, _ = _run_candidate(tmp_path, source=source)
    assert completed.returncode == 1
    assert _only_case(document)["status"] == "invalid"


@pytest.mark.parametrize(
    "expression",
    (
        "object()",
        "[{} for _ in range(257)]",
        "[{} for _ in range(100000)]",
        "[{'value': 'x' * (2 * 1024 * 1024)}]",
    ),
    ids=("non-json-object", "skill-count-limit", "large-skill-list", "oversized-plan"),
)
def test_invalid_and_oversized_plans_are_rejected(tmp_path: Path, expression: str) -> None:
    source = f"def plan(scene):\n    return {expression}\n"
    completed, document, _ = _run_candidate(tmp_path, source=source)
    assert completed.returncode == 1
    assert _only_case(document)["status"] == "invalid"


def test_integrity_errors_return_exit_three_without_cases(tmp_path: Path) -> None:
    completed, document, _ = _run_candidate(tmp_path, expected_sha256="0" * 64)
    assert completed.returncode == 3
    assert document["cases"] == []
    assert document["error"]["code"] == "integrity_error"


def test_withheld_suite_requires_manifest(tmp_path: Path) -> None:
    completed, document, _ = _run_candidate(
        tmp_path,
        suite="withheld",
        case_ids=None,
    )
    assert completed.returncode == 3
    assert document["cases"] == []


def test_tampered_withheld_manifest_is_rejected(tmp_path: Path) -> None:
    manifest_copy = tmp_path / "withheld.json"
    shutil.copyfile(WITHHELD_MANIFEST, manifest_copy)
    manifest_copy.write_text(manifest_copy.read_text(encoding="utf-8") + " ", encoding="utf-8")
    completed, document, _ = _run_candidate(
        tmp_path,
        suite="withheld",
        case_ids=None,
        withheld_manifest=manifest_copy,
    )
    assert completed.returncode == 3
    assert document["cases"] == []


def test_code_tree_hash_tracks_source_changes(tmp_path: Path) -> None:
    services_copy = tmp_path / "services"
    (services_copy / "nested").mkdir(parents=True)
    source = services_copy / "nested/module.py"
    source.write_text("VALUE = 1\n", encoding="utf-8")
    before = code_tree_sha256(services_copy)
    source.write_text("VALUE = 2\n", encoding="utf-8")
    assert code_tree_sha256(services_copy) != before


def test_baseline_public_suite_reports_expected_regression(tmp_path: Path) -> None:
    completed, document, _ = _run_candidate(
        tmp_path,
        controller=BASELINE,
        suite="public",
        case_ids=None,
    )
    cases = {case["caseId"]: case for case in document["cases"]}
    assert completed.returncode == 1
    assert len(cases) == 10
    assert cases["original-divider-collision"]["status"] == "failed"
    assert "forbidden_contact" in cases["original-divider-collision"]["failureKinds"]
    assert cases["nominal"]["status"] == "passed"


def test_reference_controller_passes_public_and_withheld_suites(tmp_path: Path) -> None:
    completed, document, _ = _run_candidate(
        tmp_path,
        controller=REFERENCE,
        suite="all",
        case_ids=None,
        withheld_manifest=WITHHELD_MANIFEST,
    )
    assert completed.returncode == 0
    assert len(document["cases"]) == 18
    assert all(case["status"] == "passed" for case in document["cases"])


def test_deterministic_trace_and_replay_frame_cadence(tmp_path: Path) -> None:
    manifest = json.loads(PUBLIC_MANIFEST.read_text(encoding="utf-8"))
    case_payload = next(item for item in manifest["cases"] if item["caseId"] == "nominal")
    case = SimCase.model_validate(case_payload).model_dump(by_alias=True, exclude_none=True)
    attempt_id = UUID("cb7d7378-6eac-5e4d-a91b-6bd72e30e4a2")
    candidate_id = UUID("5d992c77-8a1c-5b9d-a0b6-95f5c402f211")
    investigation_id = UUID("cbb7ef41-2c50-5d7c-a1c1-e05bf584f1d0")
    artifacts = tmp_path / "artifacts"
    worker_root = tmp_path / "workers"
    reports = []
    traces = []
    for _ in range(2):
        reports.append(
            execute_case(
                BASELINE,
                hashlib.sha256(BASELINE.read_bytes()).hexdigest(),
                case,
                "public",
                attempt_id,
                candidate_id,
                investigation_id,
                artifacts,
                work_dir=worker_root,
                require_netns=probe_isolation()["netns"],
            )
        )
        trace_path = artifacts / "public/nominal/trace.json"
        traces.append(trace_path.read_bytes())
    assert traces[0] == traces[1]
    score_fields = ("status", "failureKinds", "completionTimeSec")
    assert {field: reports[0][field] for field in score_fields} == {
        field: reports[1][field] for field in score_fields
    }
    trace = json.loads(traces[0])
    frames = trace["frames"]
    sim_time = trace["finalState"]["simTimeSec"]
    replay = json.loads((artifacts / "public/nominal/replay.json").read_text(encoding="utf-8"))
    assert replay == {"sampleHz": 10, "frames": frames}
    assert len(frames) in {
        int(sim_time / 0.1) + 1,
        int(sim_time / 0.1) + 2,
    }
    for index, frame in enumerate(frames[:-1]):
        assert frame["tSec"] == pytest.approx(index * 0.1, abs=1e-9)
    assert frames[-1]["tSec"] == sim_time


def test_staged_image_context_excludes_protected_paths_and_matches_asset_hash(
    tmp_path: Path,
) -> None:
    output = tmp_path / "stage"
    completed = subprocess.run(
        [
            sys.executable,
            str(ROOT / "infra/daytona/execution/stage_context.py"),
            "--out",
            str(output),
        ],
        cwd=ROOT,
        check=False,
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert completed.returncode == 0, completed.stderr
    staged_paths = completed.stdout.splitlines()
    assert not any("withheld" in path.lower() for path in staged_paths)
    assert not any("reference_controller" in path.lower() for path in staged_paths)
    assert "services/simulator/app.py" not in staged_paths
    expected_sha = json.loads(
        (output / "assets/robots/manifest.json").read_text(encoding="utf-8")
    )["sha256"]
    digest = hashlib.sha256()
    asset_root = output / "assets/robots/mujoco_menagerie/franka_emika_panda"
    for path in sorted(asset_root.rglob("*"), key=lambda item: item.relative_to(asset_root).as_posix()):
        if path.is_file():
            digest.update(path.relative_to(asset_root).as_posix().encode())
            digest.update(path.read_bytes())
    assert digest.hexdigest() == expected_sha


def test_benchmark_reports_nominal_measurements(tmp_path: Path) -> None:
    completed = subprocess.run(
        [
            sys.executable,
            "-m",
            "evaluator.benchmark",
            "--case-ids",
            "nominal",
        ],
        cwd=ROOT,
        env={
            "HOME": str(tmp_path),
            "PATH": os.defpath,
            "PYTHONPATH": str(SERVICES),
            "PYTHONDONTWRITEBYTECODE": "1",
        },
        check=False,
        capture_output=True,
        text=True,
        timeout=180,
    )
    assert completed.returncode == 0, completed.stderr
    document = json.loads(completed.stdout)
    assert document["schema"] == "forksafe.benchmark.v1"
    assert len(document["runs"]) == 1
    assert document["runs"][0]["stepsPerSec"] > 0


def test_withheld_seed_rotates_without_changing_repository_manifests(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        build_suites,
        "_accepted_case",
        lambda candidate, report: candidate,
    )
    repository_files = (
        build_suites.PUBLIC_PATH,
        build_suites.WITHHELD_PATH,
        build_suites.LOCK_PATH,
    )
    before = {path: path.read_bytes() for path in repository_files}
    first = tmp_path / "withheld-first.json"
    second = tmp_path / "withheld-second.json"

    build_suites.build(withheld_out=first, withheld_seed=11)
    build_suites.build(withheld_out=second, withheld_seed=22)

    first_sha = hashlib.sha256(first.read_bytes()).hexdigest()
    second_sha = hashlib.sha256(second.read_bytes()).hexdigest()
    assert first_sha != second_sha
    assert all(path.read_bytes() == contents for path, contents in before.items())
    with pytest.raises(ValueError, match="outside the repository"):
        build_suites.build(
            withheld_out=ROOT / "evaluation/withheld/rotated-manifest.json",
            withheld_seed=33,
        )
    assert all(path.read_bytes() == contents for path, contents in before.items())
