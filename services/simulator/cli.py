from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path
from uuid import UUID

import mujoco

from simulator.models import SimCase
from simulator.runner import RunSession, _resolve_case, finite_json, run_case
from simulator.snapshot import (
    SnapshotError,
    SnapshotStepUnreachable,
    make_snapshot,
    restore_session,
    write_snapshot_atomic,
)
from simulator.trace_store import export_trace

ROOT = Path(__file__).resolve().parents[2]


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


def _write_artifacts(result: dict, trace: dict, out_dir: Path) -> None:
    safe_result = finite_json(result)
    safe_trace = finite_json(trace)
    result.clear()
    result.update(safe_result)
    trace.clear()
    trace.update(safe_trace)
    (out_dir / "trace.json").write_text(json.dumps(trace, indent=2) + "\n")
    result["traceRef"] = export_trace(trace, out_dir)
    (out_dir / "result.json").write_text(json.dumps(result, indent=2) + "\n")


def _legacy_main() -> int:
    args = _arguments()
    sys.argv[:] = sys.argv[:1]
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
        _write_artifacts(result, trace, args.out_dir)
        print(result["firstFailure"]["detail"], file=sys.stderr)
        return 1
    _write_artifacts(result, trace, args.out_dir)
    print(
        json.dumps(
            {key: value for key, value in result.items() if key != "traceRef"},
            separators=(",", ":"),
        )
    )
    return 0 if not result["failureKinds"] else 1


def _nonnegative_int(value: str) -> int:
    try:
        number = int(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("must be a nonnegative integer") from exc
    if number < 0:
        raise argparse.ArgumentTypeError("must be a nonnegative integer")
    return number


def _case_arguments(parser: argparse.ArgumentParser) -> None:
    cases = parser.add_mutually_exclusive_group(required=True)
    cases.add_argument("--case")
    cases.add_argument("--case-json", type=Path)


def _load_case(case_id: str | None, case_json: Path | None) -> SimCase:
    if case_json is not None:
        return SimCase.model_validate_json(case_json.read_text())
    assert case_id is not None
    return _resolve_case(case_id)


def _snapshot_main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="simulator.cli snapshot")
    _case_arguments(parser)
    parser.add_argument("--at-step", required=True, type=_nonnegative_int)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument(
        "--controller-dir", type=Path, default=ROOT / "controllers/baseline"
    )
    parser.add_argument("--seed", type=int)
    parser.add_argument("--timeout-sec", type=float, default=30)
    args = parser.parse_args(argv)
    try:
        case = _load_case(args.case, args.case_json)
        seed = case.seed if args.seed is None else args.seed
        sys.argv[:] = sys.argv[:1]
        session = RunSession.start(
            args.controller_dir.resolve(),
            case,
            seed,
            UUID(int=0),
            args.timeout_sec,
        )
        while session.step_count < args.at_step and not session.finished:
            session.step()
        if session.step_count != args.at_step or session.finished:
            raise SnapshotStepUnreachable(
                session.step_count,
                session.failure[0] if session.failure else None,
            )
        snapshot_doc = make_snapshot(session)
        write_snapshot_atomic(snapshot_doc, args.out)
    except SnapshotError as exc:
        print(str(exc), file=sys.stderr)
        return 2
    except Exception as exc:  # noqa: BLE001
        print(f"{type(exc).__name__}: {exc}", file=sys.stderr)
        return 2
    print(
        json.dumps(
            {
                "snapshotSha256": snapshot_doc["snapshotSha256"],
                "stepIndex": snapshot_doc["manifest"]["stepIndex"],
                "simTimeSec": snapshot_doc["manifest"]["simTimeSec"],
                "out": str(args.out),
            },
            separators=(",", ":"),
        )
    )
    return 0


def _restore_main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="simulator.cli restore")
    parser.add_argument("--snapshot", required=True, type=Path)
    parser.add_argument("--out-dir", required=True, type=Path)
    parser.add_argument("--experiment-id", required=True, type=UUID)
    parser.add_argument(
        "--controller-dir", type=Path, default=ROOT / "controllers/baseline"
    )
    args = parser.parse_args(argv)
    try:
        snapshot_doc = json.loads(args.snapshot.read_text())
        session = restore_session(
            snapshot_doc, args.controller_dir.resolve(), args.experiment_id
        )
    except (SnapshotError, OSError, json.JSONDecodeError) as exc:
        print(str(exc), file=sys.stderr)
        return 2
    session.run_to_end()
    result, trace = session.finish()
    args.out_dir.mkdir(parents=True, exist_ok=True)
    _write_artifacts(result, trace, args.out_dir)
    print(json.dumps(result, separators=(",", ":")))
    return 0 if not result["failureKinds"] else 1


def main() -> int:
    if len(sys.argv) > 1 and sys.argv[1] == "snapshot":
        return _snapshot_main(sys.argv[2:])
    if len(sys.argv) > 1 and sys.argv[1] == "restore":
        return _restore_main(sys.argv[2:])
    return _legacy_main()


if __name__ == "__main__":
    raise SystemExit(main())
