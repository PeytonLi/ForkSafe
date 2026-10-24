from __future__ import annotations

import argparse
import hashlib
import json
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
ROBOT_ASSETS = Path("assets/robots/mujoco_menagerie/franka_emika_panda")
EVALUATOR_FILES = (
    "__init__.py",
    "models.py",
    "grader.py",
    "sandbox.py",
    "plan_entry.py",
    "case_worker.py",
    "run_candidate.py",
    "benchmark.py",
)


def _tree_sha256(root: Path) -> str:
    digest = hashlib.sha256()
    for path in sorted(root.rglob("*"), key=lambda item: item.relative_to(root).as_posix()):
        if path.is_file():
            digest.update(path.relative_to(root).as_posix().encode())
            digest.update(path.read_bytes())
    return digest.hexdigest()


def _copy_file(source: Path, destination: Path, files: list[Path]) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, destination)
    files.append(destination)


def stage(destination: Path) -> tuple[list[str], str]:
    destination = destination.resolve()
    destination.mkdir(parents=True, exist_ok=True)
    if any(destination.iterdir()):
        raise ValueError("staging output directory must be empty")
    staged: list[Path] = []

    for source in sorted((ROOT / "services/simulator").glob("*.py")):
        if source.name == "app.py":
            continue
        _copy_file(source, destination / source.relative_to(ROOT), staged)
    _copy_file(
        ROOT / "services/simulator/scene_config.json",
        destination / "services/simulator/scene_config.json",
        staged,
    )
    for name in EVALUATOR_FILES:
        source = ROOT / "services/evaluator" / name
        _copy_file(source, destination / source.relative_to(ROOT), staged)
    for relative in (
        Path("assets/robots/manifest.json"),
        Path("evaluation/public/manifest.json"),
        Path("evaluation/grader.json"),
        Path("evaluation/manifests.lock.json"),
        Path("controllers/baseline/manifest.json"),
        Path("controllers/baseline/task_controller.py"),
        Path("infra/daytona/execution/Dockerfile"),
    ):
        source = ROOT / relative
        target = destination / relative
        if relative.name == "Dockerfile":
            target = destination / "Dockerfile"
        _copy_file(source, target, staged)

    source_assets = ROOT / ROBOT_ASSETS
    staged_assets = destination / ROBOT_ASSETS
    shutil.copytree(
        source_assets,
        staged_assets,
        ignore=shutil.ignore_patterns("__pycache__", "*.pyc"),
    )
    staged.extend(path for path in staged_assets.rglob("*") if path.is_file())
    expected_asset_sha = json.loads(
        (destination / "assets/robots/manifest.json").read_text(encoding="utf-8")
    )["sha256"]
    if _tree_sha256(staged_assets) != expected_asset_sha:
        raise ValueError("staged robot asset tree does not match assets/robots/manifest.json")

    relative_files = sorted(path.relative_to(destination).as_posix() for path in staged)
    if any(
        "withheld" in part.lower() or "reference_controller" in part.lower()
        for relative in relative_files
        for part in Path(relative).parts
    ):
        raise ValueError("staged context contains a prohibited withheld/reference path")
    digest = hashlib.sha256()
    for relative in relative_files:
        digest.update(relative.encode())
        digest.update(b"\0")
        digest.update((destination / relative).read_bytes())
    return relative_files, digest.hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()
    try:
        files, digest = stage(args.out)
    except (OSError, KeyError, json.JSONDecodeError, ValueError) as exc:
        parser.error(str(exc))
    for path in files:
        print(path)
    print(f"stagedSha256={digest}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
