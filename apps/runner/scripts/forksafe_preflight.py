"""Sandbox preflight: proves the simulator bundle + robot assets are usable."""
import hashlib, json, os, sys

root = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(root, "services"))
try:
    import mujoco  # noqa: F401
    mujoco_version = mujoco.__version__
except Exception as error:  # pragma: no cover - reported to Convex
    print(json.dumps({"ok": False, "error": f"mujoco_import_failed: {error}"}))
    sys.exit(2)
assets = os.path.join(root, "assets", "robots")
digest = hashlib.sha256()
count = 0
for base, _dirs, files in os.walk(assets):
    for name in sorted(files):
        path = os.path.join(base, name)
        digest.update(os.path.relpath(path, assets).encode())
        with open(path, "rb") as handle:
            digest.update(handle.read())
        count += 1
if count == 0:
    print(json.dumps({"ok": False, "error": "assets_missing"}))
    sys.exit(3)
print(json.dumps({"ok": True, "mujoco": mujoco_version, "assetsSha256": digest.hexdigest(), "assetFiles": count}))
