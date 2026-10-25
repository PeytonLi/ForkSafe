from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import sys
import time
from collections import Counter
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path
from typing import Any
from uuid import UUID

import numpy as np

from simulator.models import SimCase
from simulator.runner import _resolve_case, run_case
from simulator.scene import TOSS_BIN_CONFIG_PATH, task_family


def _axis_values(low: float, high: float, count: int) -> list[float]:
    if count == 1 and low <= 0.0 <= high:
        return [0.0]
    step = (high - low) / count
    return [
        float(value)
        for value in np.linspace(low + step / 2, high - step / 2, count)
    ]


# Editor ranges from the scene contracts. Used only when --center-overrides is set.
_EDITOR_RANGES: dict[str, tuple[float, float]] = {
    "dividerDx": (-0.10, 0.10),
    "dividerDy": (-0.10, 0.10),
    "cubeDx": (-0.10, 0.10),
    "cubeDy": (-0.10, 0.10),
    "targetDx": (-0.10, 0.10),
    "targetDy": (-0.10, 0.10),
    "gapDx": (-0.10, 0.10),
    "dividerHeight": (0.02, 0.25),
    "gapWidth": (0.05, 0.20),
    "binDx": (-0.10, 0.10),
    "binDy": (-0.10, 0.10),
    "binWidth": (0.08, 0.20),
    "speedScale": (0.5, 2.0),
}


_BIN_DROP_EDITOR_RANGES: dict[str, tuple[float, float]] = {
    "cubeDx": (-0.10, 0.10),
    "cubeDy": (-0.10, 0.10),
    "binDx": (-0.10, 0.10),
    "binDy": (-0.10, 0.10),
    "binWidth": (0.08, 0.20),
    "speedScale": (0.5, 2.0),
}


def _editor_ranges_for(family: str) -> dict[str, tuple[float, float]]:
    if family == "toss_into_bin":
        config = json.loads(TOSS_BIN_CONFIG_PATH.read_text())
        return {
            **_EDITOR_RANGES,
            **{key: (float(bounds[0]), float(bounds[1])) for key, bounds in config["overrideRanges"].items()},
        }
    if family == "bin_drop":
        return {**_EDITOR_RANGES, **_BIN_DROP_EDITOR_RANGES}
    return _EDITOR_RANGES


def _clamp_editor(key: str, value: float, ranges: dict[str, tuple[float, float]]) -> float:
    span = ranges.get(key)
    if span is None:
        return float(value)
    low, high = span
    return float(min(high, max(low, value)))


def _parse_center_overrides(raw: str | None) -> dict[str, float] | None:
    if raw is None:
        return None
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValueError(
            f"--center-overrides must be a JSON object of numbers ({exc.msg})"
        ) from exc
    if not isinstance(parsed, dict):
        raise ValueError("--center-overrides must be a JSON object of numbers")
    overrides: dict[str, float] = {}
    for key, value in parsed.items():
        if not isinstance(key, str):
            raise ValueError("--center-overrides keys must be strings")
        if (
            isinstance(value, bool)
            or not isinstance(value, (int, float))
            or not math.isfinite(value)
        ):
            raise ValueError(f"--center-overrides {key} must be a finite number")
        overrides[key] = float(value)
    return overrides


def _centered_axis(
    key: str,
    low: float,
    high: float,
    count: int,
    overrides: dict[str, Any],
    ranges: dict[str, tuple[float, float]],
) -> list[float]:
    values = _axis_values(low, high, count)
    if key in overrides:
        shift = float(overrides[key]) - (low + high) / 2.0
        values = [value + shift for value in values]
    return [_clamp_editor(key, value, ranges) for value in values]


def _run_sample(job: dict[str, Any]) -> dict[str, Any]:
    started = time.perf_counter()
    sample = {
        "index": job["index"],
        "row": job["row"],
        "col": job["col"],
        "sceneOverrides": job["sceneOverrides"],
        "seed": job["seed"],
    }
    try:
        case = SimCase.model_validate(job["case"])
        result, _ = run_case(
            Path(job["controllerDir"]),
            case,
            job["seed"],
            UUID(int=job["index"] + 1),
            job["timeoutSec"],
        )
        passed = bool(result["completed"] and not result["failureKinds"])
        failure = result.get("firstFailure")
        failure_kind = None
        if not passed:
            failure_kind = (
                result["failureKinds"][0]
                if result["failureKinds"]
                else failure["kind"]
                if failure
                else "invalid_run"
            )
        sample.update(
            {
                "passed": passed,
                "failureKind": failure_kind,
                "firstFailureTSec": failure["tSec"] if failure else None,
                "completionTimeSec": result.get("completionTimeSec"),
            }
        )
    except Exception as exc:  # noqa: BLE001
        sample.update(
            {
                "passed": False,
                "failureKind": "invalid_run",
                "firstFailureTSec": None,
                "completionTimeSec": None,
                "detail": f"{type(exc).__name__}: {exc}",
            }
        )
    sample["_wallTimeSec"] = time.perf_counter() - started
    return sample


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="python -m simulator.fuzz")
    parser.add_argument("--controller", required=True, type=Path)
    parser.add_argument("--around", required=True)
    parser.add_argument("--n", type=int, default=64)
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--center-overrides")
    parser.add_argument("--workers", type=int)
    parser.add_argument("--out", type=Path)
    parser.add_argument("--svg", type=Path)
    parser.add_argument("--timeout-sec", type=float, default=30)
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = _parser()
    args = parser.parse_args(argv)
    command_started = time.perf_counter()
    try:
        if not 1 <= args.n <= 1024:
            raise ValueError("--n must be between 1 and 1024")
        if args.seed < 0:
            raise ValueError("--seed must be nonnegative")
        workers = args.workers
        if workers is None:
            workers = min(8, os.cpu_count() or 1)
        if workers < 1:
            raise ValueError("--workers must be at least 1")
        if args.timeout_sec <= 0:
            raise ValueError("--timeout-sec must be positive")
        center_overrides = _parse_center_overrides(args.center_overrides)

        controller_dir = args.controller.resolve()
        controller_path = controller_dir / "task_controller.py"
        if not controller_path.is_file():
            raise ValueError(
                f"controller directory must contain task_controller.py: {controller_dir}"
            )
        around = _resolve_case(args.around)
        family = task_family(around)
        editor_ranges = _editor_ranges_for(family)
        controller_sha = hashlib.sha256(controller_path.read_bytes()).hexdigest()

        cols = math.ceil(math.sqrt(args.n))
        rows = math.ceil(args.n / cols)
        if family == "divider_pick_place":
            x_key, x_low, x_high = "dividerDx", -0.25, 0.25
            y_key, y_low, y_high = "dividerHeight", 0.03, 0.12
        elif family == "toss_into_bin":
            x_key, x_low, x_high = "binDx", -0.15, 0.05
            y_key, y_low, y_high = "objectMass", 0.01, 0.5
        elif family == "bin_drop":
            x_key, x_low, x_high = "binDx", -0.08, 0.08
            y_key, y_low, y_high = "binWidth", 0.08, 0.16
        else:
            x_key, x_low, x_high = "gapDx", -0.08, 0.08
            y_key, y_low, y_high = "gapWidth", 0.05, 0.10
        x_values = _axis_values(x_low, x_high, cols)
        y_values = _axis_values(y_low, y_high, rows)

        rng = np.random.default_rng(args.seed)
        around_doc = around.model_dump(by_alias=True, exclude_none=True)
        base_overrides = dict(around.scene_overrides)
        if center_overrides is not None:
            base_overrides.update(center_overrides)
            x_values = _centered_axis(x_key, x_low, x_high, cols, base_overrides, editor_ranges)
            y_values = _centered_axis(y_key, y_low, y_high, rows, base_overrides, editor_ranges)
        position_dx_key = "objectDx" if family == "toss_into_bin" else "cubeDx"
        position_dy_key = "objectDy" if family == "toss_into_bin" else "cubeDy"
        base_position_dx = float(base_overrides.get(position_dx_key, 0.0))
        base_position_dy = float(base_overrides.get(position_dy_key, 0.0))
        jobs = []
        for index in range(args.n):
            row, col = divmod(index, cols)
            overrides = dict(base_overrides)
            overrides[x_key] = x_values[col]
            overrides[y_key] = y_values[row]
            if family == "push_through_gap":
                overrides["targetDx"] = x_values[col]
            overrides[position_dx_key] = round(
                base_position_dx + float(rng.uniform(-0.01, 0.01)), 5
            )
            overrides[position_dy_key] = round(
                base_position_dy + float(rng.uniform(-0.01, 0.01)), 5
            )
            if center_overrides is not None:
                for key, value in list(overrides.items()):
                    if key in editor_ranges and isinstance(value, (int, float)):
                        overrides[key] = _clamp_editor(key, float(value), editor_ranges)
            sample_seed = int(rng.integers(0, 2**31 - 1))
            case_doc = dict(around_doc)
            case_doc["sceneOverrides"] = overrides
            case_doc["seed"] = sample_seed
            jobs.append(
                {
                    "index": index,
                    "row": row,
                    "col": col,
                    "sceneOverrides": overrides,
                    "seed": sample_seed,
                    "case": case_doc,
                    "controllerDir": str(controller_dir),
                    "timeoutSec": args.timeout_sec,
                }
            )

        with ProcessPoolExecutor(max_workers=workers) as executor:
            measured_samples = list(executor.map(_run_sample, jobs))
        samples = []
        failure_counts: Counter[str] = Counter()
        for sample in measured_samples:
            wall_time = sample.pop("_wallTimeSec")
            print(
                f"sample {sample['index']}: {wall_time:.3f}s",
                file=sys.stderr,
            )
            if sample["failureKind"] is not None:
                failure_counts[sample["failureKind"]] += 1
            samples.append(sample)

        pass_count = sum(sample["passed"] for sample in samples)
        grid = {
            "schema": "forksafe.fuzz-grid/v1",
            "controllerSha256": controller_sha,
            "aroundCase": around_doc,
            "taskFamily": family,
            "seed": args.seed,
            "n": args.n,
            "rows": rows,
            "cols": cols,
            "axes": {
                "x": {"key": x_key, "values": x_values},
                "y": {"key": y_key, "values": y_values},
            },
            "samples": samples,
            "summary": {
                "passCount": pass_count,
                "failCount": args.n - pass_count,
                "failureKindCounts": dict(sorted(failure_counts.items())),
            },
        }
        encoded = json.dumps(grid, indent=2, sort_keys=True, allow_nan=False) + "\n"
        if args.out is None:
            print(encoded, end="")
        else:
            args.out.parent.mkdir(parents=True, exist_ok=True)
            args.out.write_text(encoded)
        if args.svg is not None:
            from simulator.fuzz_svg import render_svg

            args.svg.parent.mkdir(parents=True, exist_ok=True)
            args.svg.write_text(render_svg(grid))
        print(
            f"total wall time: {time.perf_counter() - command_started:.3f}s",
            file=sys.stderr,
        )
        return 0
    except Exception as exc:  # noqa: BLE001
        print(f"{type(exc).__name__}: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
