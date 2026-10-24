from __future__ import annotations

import hashlib
import json
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
ASSET_DIR = REPO_ROOT / "assets/robots/mujoco_menagerie/franka_emika_panda"
MANIFEST_PATH = REPO_ROOT / "assets/robots/manifest.json"


class AssetIntegrityError(RuntimeError):
    """The local robot asset tree does not match its checked-in manifest."""


def tree_sha256(root: Path = ASSET_DIR) -> str:
    digest = hashlib.sha256()
    for path in sorted(root.rglob("*"), key=lambda item: item.relative_to(root).as_posix()):
        if path.is_file():
            digest.update(path.relative_to(root).as_posix().encode())
            digest.update(path.read_bytes())
    return digest.hexdigest()


def verify_assets() -> str:
    try:
        expected = json.loads(MANIFEST_PATH.read_text())["sha256"]
        actual = tree_sha256()
    except (OSError, KeyError, json.JSONDecodeError) as exc:
        raise AssetIntegrityError(f"robot assets or manifest unavailable: {exc}") from exc
    if actual != expected:
        raise AssetIntegrityError(
            f"robot asset sha256 mismatch: expected {expected}, got {actual}"
        )
    return actual
