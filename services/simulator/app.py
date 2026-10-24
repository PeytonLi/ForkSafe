from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import time
from contextlib import asynccontextmanager
from pathlib import Path

import mujoco
from fastapi import FastAPI, HTTPException

from simulator.assets import verify_assets
from simulator.models import SimRunRequest
from simulator.runner import PUBLIC_MANIFEST, _resolve_case

ROOT = Path(__file__).resolve().parents[2]
ARTIFACT_ROOT = Path(os.environ.get("ARTIFACT_ROOT", ROOT / "var/artifacts")).resolve()


def _resolve_artifact_dir(value: str) -> Path:
    path = Path(value)
    if not path.is_absolute():
        path = ROOT / path
    resolved = path.resolve()
    if not resolved.is_relative_to(ARTIFACT_ROOT):
        raise HTTPException(status_code=400, detail="outDir must be under ARTIFACT_ROOT")
    return resolved


def _resolve_controller_dir(value: str) -> Path:
    path = Path(value)
    if not path.is_absolute():
        path = ROOT / path
    resolved = path.resolve()
    if not resolved.is_relative_to(ROOT):
        raise HTTPException(status_code=400, detail="controllerDir must be under the repository")
    if not (resolved / "task_controller.py").is_file():
        raise HTTPException(status_code=400, detail="controllerDir has no task_controller.py")
    return resolved


@asynccontextmanager
async def _lifespan(app: FastAPI):
    app.state.assets_sha256 = verify_assets()
    yield


app = FastAPI(title="ForkSafe simulator", lifespan=_lifespan)


@app.get("/health")
def health() -> dict[str, object]:
    asset_hash = getattr(app.state, "assets_sha256", None) or verify_assets()
    return {
        "name": "simulator",
        "mode": "local",
        "detail": f"MuJoCo {mujoco.__version__}; assets sha256 {asset_hash}",
        "checkedAtMs": time.time_ns() // 1_000_000,
    }


@app.get("/cases")
def cases() -> dict[str, object]:
    return json.loads(PUBLIC_MANIFEST.read_text())


@app.post("/runs")
def runs(request: SimRunRequest) -> dict[str, object]:
    try:
        case = _resolve_case(request.case_id)
    except (ValueError, OSError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=404, detail="caseId is not in the public manifest") from exc
    controller_dir = _resolve_controller_dir(request.controller_dir)
    output_dir = _resolve_artifact_dir(request.out_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    command = [
        sys.executable,
        "-m",
        "simulator.cli",
        "--controller-dir",
        str(controller_dir),
        "--case-id",
        case.case_id,
        "--seed",
        str(request.seed),
        "--out-dir",
        str(output_dir),
        "--experiment-id",
        str(request.experiment_id),
        "--timeout-sec",
        str(min(request.timeout_sec, 30.0)),
    ]
    environment = os.environ.copy()
    environment["PYTHONPATH"] = str(ROOT / "services")
    try:
        subprocess.run(
            command,
            cwd=ROOT,
            env=environment,
            check=False,
            capture_output=True,
            text=True,
            timeout=min(request.timeout_sec, 30.0) + 10.0,
        )
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=504, detail="simulator subprocess exceeded its wall-clock limit")
    result_path = output_dir / "result.json"
    trace_path = output_dir / "trace.json"
    if result_path.is_file() and trace_path.is_file():
        return json.loads(result_path.read_text())
    try:
        controller_sha = hashlib.sha256((controller_dir / "task_controller.py").read_bytes()).hexdigest()
    except OSError:
        controller_sha = "0" * 64
    return {
        "experimentId": str(request.experiment_id),
        "completed": False,
        "failureKinds": ["missing_artifact"],
        "firstFailure": {
            "kind": "missing_artifact",
            "tSec": 0,
            "detail": "simulator subprocess did not write trace.json and result.json",
        },
        "frames": [],
        "engineVersion": mujoco.__version__,
        "assetsSha256": app.state.assets_sha256,
        "controllerSha256": controller_sha,
    }
