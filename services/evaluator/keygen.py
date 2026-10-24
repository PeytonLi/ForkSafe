from __future__ import annotations

import argparse
import base64
import json
import os
import secrets
import stat
import time
from pathlib import Path
from typing import Any

from evaluator.ed25519 import public_key
from evaluator.signing import TRUSTED_KEYS_SCHEMA, key_id


def _arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--private-out", required=True, type=Path)
    parser.add_argument("--trusted-keys", type=Path)
    parser.add_argument("--retire-active", action="store_true")
    return parser.parse_args()


def _trusted_keys(path: Path, identifier: str, public: bytes, retire: bool) -> None:
    now = int(time.time() * 1000)
    try:
        value: dict[str, Any] = json.loads(path.read_text(encoding="utf-8"))
        if value.get("schema") != TRUSTED_KEYS_SCHEMA or not isinstance(value.get("keys"), list):
            raise ValueError
    except FileNotFoundError:
        value = {"schema": TRUSTED_KEYS_SCHEMA, "keys": []}
    for entry in value["keys"]:
        if retire and entry.get("status") == "active":
            entry["status"] = "retired"
            entry["retiredAtMs"] = now
    value["keys"].append(
        {
            "keyId": identifier,
            "publicKey": base64.b64encode(public).decode("ascii"),
            "status": "active",
        }
    )
    temporary = path.with_name(f".{path.name}.{secrets.token_hex(8)}.tmp")
    temporary.write_text(json.dumps(value, sort_keys=True, indent=2) + "\n", encoding="utf-8")
    os.chmod(temporary, stat.S_IRUSR | stat.S_IWUSR)
    os.replace(temporary, path)


def main() -> int:
    args = _arguments()
    if args.retire_active and args.trusted_keys is None:
        raise SystemExit("--retire-active requires --trusted-keys")
    seed = secrets.token_bytes(32)
    public = public_key(seed)
    identifier = key_id(public)
    encoded = base64.b64encode(seed)
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(args.private_out, flags, 0o600)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(encoded + b"\n")
    except BaseException:
        try:
            args.private_out.unlink()
        except OSError:
            pass
        raise
    if args.trusted_keys is not None:
        _trusted_keys(args.trusted_keys, identifier, public, args.retire_active)
    print(json.dumps({"keyId": identifier, "publicKey": base64.b64encode(public).decode("ascii")}, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
