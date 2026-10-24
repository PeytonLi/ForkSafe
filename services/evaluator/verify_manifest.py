from __future__ import annotations

import argparse
import base64
import json
from pathlib import Path
from typing import Any

from evaluator.signing import (
    ManifestVerificationError,
    key_id,
    load_trusted_keys,
    verify_envelope,
)


def _arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True, type=Path)
    keys = parser.add_mutually_exclusive_group(required=True)
    keys.add_argument("--public-key")
    keys.add_argument("--trusted-keys", type=Path)
    parser.add_argument("--document", type=Path)
    parser.add_argument("--expect-controller-sha256")
    parser.add_argument("--expect-bundle-sha256")
    parser.add_argument("--expect-withheld-manifest-sha256")
    parser.add_argument("--expect-public-manifest-sha256")
    parser.add_argument("--require-suite", choices=("public", "withheld"), action="append", default=[])
    return parser.parse_args()


def _read(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def main() -> int:
    args = _arguments()
    try:
        manifest = _read(args.manifest)
        document = _read(args.document) if args.document else None
        if isinstance(manifest, dict) and "signedManifest" in manifest:
            document = document or manifest
            envelope = manifest.get("signedManifest")
        else:
            envelope = manifest
        if args.public_key:
            public = base64.b64decode(args.public_key, validate=True)
            if len(public) != 32:
                raise ManifestVerificationError("bad_envelope", "public key must be 32 bytes")
            trusted = {
                key_id(public): {
                    "publicKey": public,
                    "status": "active",
                    "retiredAtMs": None,
                }
            }
        else:
            trusted = load_trusted_keys(_read(args.trusted_keys))
        expected: dict[str, Any] = {}
        for option, field_name in (
            (args.expect_controller_sha256, "controllerSha256"),
            (args.expect_bundle_sha256, "bundleSha256"),
        ):
            if option is not None:
                expected[field_name] = option
        suites = {}
        if args.expect_withheld_manifest_sha256 is not None:
            suites["withheld"] = args.expect_withheld_manifest_sha256
        if args.expect_public_manifest_sha256 is not None:
            suites["public"] = args.expect_public_manifest_sha256
        if suites:
            expected["suites"] = suites
        payload = verify_envelope(envelope, trusted, expect=expected, document=document)
        if any(suite not in payload["suites"] for suite in args.require_suite):
            raise ManifestVerificationError("expectation_mismatch", "required suite is missing")
        result = {
            "valid": True,
            "keyId": payload["keyId"],
            "status": payload["status"],
            "controllerSha256": payload["candidate"]["controllerSha256"],
            "bundleSha256": payload["candidate"]["bundleSha256"],
            "suites": payload["suites"],
            "casesSha256": payload["casesSha256"],
            "counts": payload["counts"],
        }
        print(json.dumps(result, separators=(",", ":")))
        return 0
    except ManifestVerificationError as exc:
        print(json.dumps({"valid": False, "error": {"code": exc.code, "message": str(exc)}}, separators=(",", ":")))
        return 3
    except (OSError, UnicodeError, json.JSONDecodeError, ValueError) as exc:
        error = ManifestVerificationError("bad_envelope", f"manifest input is invalid: {type(exc).__name__}")
        print(json.dumps({"valid": False, "error": {"code": error.code, "message": str(error)}}, separators=(",", ":")))
        return 3


if __name__ == "__main__":
    raise SystemExit(main())
