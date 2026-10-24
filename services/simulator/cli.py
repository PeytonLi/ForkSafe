from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from uuid import UUID

import mujoco

from simulator.models import SimCase
from simulator.runner import _resolve_case, run_case


def _arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--controller-dir", required=True, type=Path)
    cases = parser.add_mutually_exclusive_group(required=True)
    cases.add_argument("--case-json", type=Path)
    cases.add_argument("--case-id")
    parser.add_argument("--seed", type=int, required=True)
    parser.add_argument("--out-dir", required=True, type=Path)
    parser.add_argument("--experiment-id", required=True, type=UUID)
    parser.add_argument("--timeout-sec", type=float, default=30)
    return parser.parse_args()


def main() -> int:
    args = _arguments()
    args.out_dir.mkdir(parents=True, exist_ok=True)
    try:
        case = (
            SimCase.model_validate_json(args.case_json.read_text())
            if args.case_json
            else _resolve_case(args.case_id)
        )
        result, trace = run_case(
            args.controller_dir.resolve(),
            case,
            args.seed,
            args.experiment_id,
            args.timeout_sec,
        )
    except Exception as exc:  # noqa: BLE001
        import hashlib

        from simulator.assets import AssetIntegrityError, verify_assets

        try:
            assets_sha = verify_assets()
        except AssetIntegrityError:
            assets_sha = "0" * 64
        result = {
            "experimentId": str(args.experiment_id),
            "completed": False,
            "failureKinds": ["invalid_run"],
            "firstFailure": {
                "kind": "invalid_run",
                "tSec": 0,
                "detail": f"{type(exc).__name__}: {exc}",
            },
            "frames": [],
            "engineVersion": mujoco.__version__,
            "assetsSha256": assets_sha,
            "controllerSha256": hashlib.sha256(b"").hexdigest(),
        }
        trace = {
            "failure": result["firstFailure"],
            "mujocoVersion": mujoco.__version__,
            "assetsSha256": assets_sha,
            "frames": [],
        }
        (args.out_dir / "trace.json").write_text(json.dumps(trace, indent=2) + "\n")
        (args.out_dir / "result.json").write_text(json.dumps(result, indent=2) + "\n")
        print(result["firstFailure"]["detail"], file=sys.stderr)
        return 1
    (args.out_dir / "trace.json").write_text(json.dumps(trace, indent=2) + "\n")
    (args.out_dir / "result.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result, separators=(",", ":")))
    return 0 if not result["failureKinds"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
