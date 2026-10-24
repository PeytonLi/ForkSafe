from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import statistics
import sys
import tempfile
import time
from pathlib import Path
from uuid import NAMESPACE_URL, uuid4, uuid5

import mujoco
from simulator.assets import verify_assets
from simulator.models import SimCase

from evaluator.run_candidate import (
    ROOT,
    CandidateIntegrityError,
    CaseInfrastructureError,
    code_tree_sha256,
    execute_case,
)
from evaluator.sandbox import probe_isolation

DEFAULT_CONTROLLER = ROOT / "controllers/baseline/task_controller.py"


def _arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--controller", type=Path, default=DEFAULT_CONTROLLER)
    parser.add_argument("--case-ids")
    parser.add_argument("--repeat", type=int, default=1)
    parser.add_argument("--out", type=Path)
    return parser.parse_args()


def run(args: argparse.Namespace) -> tuple[int, dict[str, object]]:
    started = time.perf_counter()
    try:
        verify_assets()
        public_path = ROOT / "evaluation/public/manifest.json"
        lock = json.loads((ROOT / "evaluation/manifests.lock.json").read_text())
        manifest_bytes = public_path.read_bytes()
        controller_bytes = args.controller.resolve().read_bytes()
        controller_sha = hashlib.sha256(controller_bytes).hexdigest()
        if hashlib.sha256(manifest_bytes).hexdigest() != lock["public"]:
            raise CandidateIntegrityError("public manifest hash does not match lock")
        manifest = json.loads(manifest_bytes)
        case_ids = (
            {item.strip() for item in args.case_ids.split(",") if item.strip()}
            if args.case_ids
            else None
        )
        cases = [
            SimCase.model_validate(payload).model_dump(by_alias=True, exclude_none=True)
            for payload in manifest["cases"]
            if case_ids is None or payload["caseId"] in case_ids
        ]
        isolation = probe_isolation()
        code_sha = code_tree_sha256()
        runs: list[dict[str, object]] = []
        with tempfile.TemporaryDirectory(prefix="forksafe-benchmark-") as temporary:
            root = Path(temporary)
            for case in cases:
                for repeat in range(1, args.repeat + 1):
                    if code_tree_sha256() != code_sha:
                        raise CandidateIntegrityError("evaluator_code_modified")
                    attempt_id = uuid4()
                    report = execute_case(
                        args.controller,
                        controller_sha,
                        case,
                        "public",
                        attempt_id,
                        uuid5(NAMESPACE_URL, f"candidate:{controller_sha}"),
                        uuid5(NAMESPACE_URL, f"investigation:{controller_sha}"),
                        root / "artifacts",
                        work_dir=root,
                        require_netns=isolation["netns"],
                    )
                    metrics = report["metrics"]
                    runs.append(
                        {
                            "caseId": case["caseId"],
                            "repeat": repeat,
                            "status": report["status"],
                            "failureKinds": list(report["failureKinds"]),
                            "caseWallSec": metrics["caseWallSec"],
                            "planWallSec": metrics["planWallSec"],
                            "physicsWallSec": metrics["physicsWallSec"],
                            "simSteps": metrics["simSteps"],
                            "stepsPerSec": metrics["stepsPerSec"],
                        }
                    )
        if code_tree_sha256() != code_sha:
            raise CandidateIntegrityError("evaluator_code_modified")
        speeds = [float(run["stepsPerSec"]) for run in runs]
        if not runs or any(speed <= 0 for speed in speeds):
            raise CaseInfrastructureError("benchmark did not produce positive measurements")
        document: dict[str, object] = {
            "schema": "forksafe.benchmark.v1",
            "host": {
                "python": sys.version.split()[0],
                "mujoco": mujoco.__version__,
                "cpuCount": os.cpu_count(),
                "platform": platform.platform(),
            },
            "controllerSha256": controller_sha,
            "runs": runs,
            "completed": all(run["status"] == "passed" for run in runs),
            "failureKinds": sorted({kind for run in runs for kind in run["failureKinds"]}),
            "summary": {
                "totalWallSec": time.perf_counter() - started,
                "medianStepsPerSec": statistics.median(speeds),
                "minStepsPerSec": min(speeds),
            },
        }
        return 0, document
    except Exception as exc:  # noqa: BLE001
        return 4, {
            "schema": "forksafe.benchmark.v1",
            "host": {
                "python": sys.version.split()[0],
                "mujoco": mujoco.__version__,
                "cpuCount": os.cpu_count(),
                "platform": platform.platform(),
            },
            "controllerSha256": None,
            "runs": [],
            "completed": False,
            "failureKinds": [],
            "summary": {"totalWallSec": time.perf_counter() - started},
            "error": f"{type(exc).__name__}: {exc}",
        }


def main() -> int:
    args = _arguments()
    if args.repeat <= 0:
        raise SystemExit(2)
    code, document = run(args)
    rendered = json.dumps(document, sort_keys=True, allow_nan=True)
    print(rendered)
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(rendered + "\n", encoding="utf-8")
    if document.get("runs"):
        print("case\trepeat\tstatus\tsteps/s\tcase wall (s)", file=sys.stderr)
        for item in document["runs"]:  # type: ignore[index]
            print(
                f"{item['caseId']}\t{item['repeat']}\t{item['status']}\t"
                f"{item['stepsPerSec']:.2f}\t{item['caseWallSec']:.3f}",
                file=sys.stderr,
            )
        summary = document["summary"]
        print(
            f"median steps/s={summary['medianStepsPerSec']:.2f}; "
            f"min steps/s={summary['minStepsPerSec']:.2f}; "
            f"total wall={summary['totalWallSec']:.3f}s",
            file=sys.stderr,
        )
    return code


if __name__ == "__main__":
    raise SystemExit(main())
