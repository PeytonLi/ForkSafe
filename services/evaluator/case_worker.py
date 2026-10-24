from __future__ import annotations

import argparse
import hashlib
import json
import sys
import traceback
from pathlib import Path
from uuid import UUID


def _arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--services", required=True, type=Path)
    parser.add_argument("--case-json", required=True, type=Path)
    parser.add_argument("--seed", required=True, type=int)
    parser.add_argument("--controller", required=True, type=Path)
    parser.add_argument("--controller-sha256", required=True)
    parser.add_argument("--experiment-id", required=True, type=UUID)
    parser.add_argument("--out-dir", required=True, type=Path)
    parser.add_argument("--plan-wall-sec", type=float, default=10)
    parser.add_argument("--plan-cpu-sec", type=int, default=10)
    parser.add_argument("--plan-memory-mb", type=int, default=1024)
    parser.add_argument("--require-netns", action="store_true")
    parser.add_argument("--test-audit-hook-only", action="store_true", help=argparse.SUPPRESS)
    return parser.parse_args()


def _write(path: Path, value: object) -> None:
    path.write_text(
        json.dumps(value, allow_nan=True, sort_keys=True, separators=(",", ":")),
        encoding="utf-8",
    )


def main() -> int:
    args = _arguments()
    sys.path.insert(0, str(args.services.resolve()))
    import mujoco
    from simulator import runner
    from simulator.assets import verify_assets
    from simulator.models import SimCase

    from evaluator.sandbox import PlanLimits, run_plan_sandbox

    try:
        case = SimCase.model_validate_json(args.case_json.read_text(encoding="utf-8"))
        controller_path = args.controller.resolve()
        controller_hash = hashlib.sha256(controller_path.read_bytes()).hexdigest()
        if controller_hash != args.controller_sha256:
            raise ValueError("controller SHA changed before case execution")
        asset_hash = verify_assets()
        plan_input = runner.controller_input(case, args.seed)
        outcome = run_plan_sandbox(
            controller_path,
            plan_input,
            controller_path.parent,
            PlanLimits(
                wall_sec=args.plan_wall_sec,
                cpu_sec=args.plan_cpu_sec,
                memory_bytes=args.plan_memory_mb * 1024 * 1024,
            ),
            args.require_netns,
            args.test_audit_hook_only,
        )
        if outcome.ok:
            result, trace, metrics = runner.run_plan(
                case,
                args.seed,
                args.experiment_id,
                outcome.plan or [],
                controller_hash,
            )
        else:
            scene = runner.build_scene(case)
            detail = outcome.detail or "plan process exited without a result"
            result = {
                "experimentId": str(args.experiment_id),
                "completed": False,
                "failureKinds": ["invalid_run"],
                "firstFailure": {"kind": "invalid_run", "tSec": 0, "detail": detail},
                "frames": [],
                "engineVersion": mujoco.__version__,
                "assetsSha256": asset_hash,
                "controllerSha256": controller_hash,
            }
            trace = {
                "case": case.model_dump(by_alias=True),
                "sceneConfig": scene.config,
                "frames": [],
                "assetsSha256": asset_hash,
                "controllerSha256": controller_hash,
                "mujocoVersion": mujoco.__version__,
                "finalState": {
                    "simTimeSec": 0.0,
                    "completed": False,
                    "failure": result["firstFailure"],
                },
            }
            metrics = {
                "simSteps": 0,
                "simTimeSec": 0.0,
                "physicsWallSec": 0.0,
                "stepsPerSec": 0.0,
            }
        metrics["planWallSec"] = outcome.wall_sec
        args.out_dir.mkdir(parents=True, exist_ok=True)
        _write(args.out_dir / "result.json", runner.finite_json(result))
        _write(args.out_dir / "trace.json", runner.finite_json(trace))
        _write(args.out_dir / "metrics.json", runner.finite_json(metrics))
        return 0
    except Exception as exc:  # noqa: BLE001
        sys.stderr.write(f"{type(exc).__name__}: {exc}\n")
        sys.stderr.write(traceback.format_exc()[-1000:])
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
