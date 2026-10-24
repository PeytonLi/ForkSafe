from __future__ import annotations

import base64
import hashlib
import json
import math
import os
import re
import stat
from collections.abc import MutableMapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from evaluator import ed25519

EVALUATOR_VERSION = "forksafe-evaluator/0.3.0"
ENVELOPE_SCHEMA = "forksafe.signed_evaluation_manifest.v1"
PAYLOAD_SCHEMA = "forksafe.evaluation_manifest.v1"
TRUSTED_KEYS_SCHEMA = "forksafe.evaluator_trusted_keys.v1"
DOMAIN = b"forksafe.evaluation_manifest.v1\x00"
_TOKEN = re.compile(r"^[A-Za-z0-9._:/+=@-]{0,256}$")


class SigningKeyError(RuntimeError):
    pass


class ManifestVerificationError(ValueError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class SigningKey:
    seed: bytes = field(repr=False)
    public_key: bytes
    key_id: str


def key_id(public: bytes) -> str:
    return "ed25519:" + hashlib.sha256(public).hexdigest()[:16]


def _decode_seed(encoded: str) -> bytes:
    try:
        seed = base64.b64decode(encoded, validate=True)
    except (ValueError, base64.binascii.Error) as exc:
        raise SigningKeyError("signing key is not valid base64") from exc
    if len(seed) != 32:
        raise SigningKeyError("signing key must encode a 32-byte seed")
    return seed


def load_signing_key(environ: MutableMapping[str, str] = os.environ) -> SigningKey | None:
    encoded = environ.pop("FORKSAFE_EVAL_SIGNING_KEY", None)
    file_path = environ.pop("FORKSAFE_EVAL_SIGNING_KEY_FILE", None)
    if encoded is not None and file_path is not None:
        raise SigningKeyError("provide only one signing key source")
    if encoded is None and file_path is None:
        return None
    if file_path is not None:
        fd = -1
        try:
            flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0)
            fd = os.open(file_path, flags)
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode):
                raise SigningKeyError("signing key file must be a regular file")
            with os.fdopen(fd, "rb") as handle:
                fd = -1
                raw = handle.read(4097)
            Path(file_path).unlink()
            encoded = raw.decode("ascii").strip()
            if len(encoded) > 4096:
                raise SigningKeyError("signing key file is too large")
        except SigningKeyError:
            raise
        except FileNotFoundError:
            raise SigningKeyError("signing key file is unavailable or invalid") from None
        except (OSError, UnicodeError, ValueError) as exc:
            raise SigningKeyError("signing key file is unavailable or invalid") from exc
        finally:
            if fd >= 0:
                os.close(fd)
    seed = _decode_seed(encoded or "")
    public = ed25519.public_key(seed)
    return SigningKey(seed, public, key_id(public))


def _validate_canonical(value: Any) -> None:
    if value is None or isinstance(value, bool):
        return
    if isinstance(value, int):
        return
    if isinstance(value, float):
        raise TypeError("floating-point values are not canonical")
    if isinstance(value, str):
        if not _TOKEN.fullmatch(value):
            raise ValueError("string contains unsupported characters or is too long")
        return
    if isinstance(value, list):
        for item in value:
            _validate_canonical(item)
        return
    if isinstance(value, dict):
        for key, item in value.items():
            if not isinstance(key, str) or not _TOKEN.fullmatch(key):
                raise ValueError("object key contains unsupported characters or is too long")
            _validate_canonical(item)
        return
    raise ValueError("value is not canonical JSON")


def canonical_bytes(value: Any) -> bytes:
    _validate_canonical(value)
    return json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=True,
        allow_nan=False,
    ).encode("ascii")


def _case_entry(case: dict[str, Any]) -> dict[str, Any]:
    completion = case.get("completionTimeSec")
    return {
        "caseId": case["caseId"],
        "suite": case["suite"],
        "status": case["status"],
        "failureKinds": sorted(case.get("failureKinds", [])),
        "completionTimeUs": math.floor(completion * 1_000_000) if completion is not None else None,
        "experimentId": case["experimentId"],
        "traceSha256": case.get("traceSha256"),
        "replaySha256": case.get("replaySha256"),
    }


def build_payload(
    document: dict[str, Any],
    *,
    bundle: Any,
    simulator_sha256: str,
    manifests_lock_sha256: str,
    case_filter: list[str] | None,
    key_id: str,
) -> dict[str, Any]:
    cases = sorted(
        (_case_entry(case) for case in document["cases"]),
        key=lambda case: (case["suite"], case["caseId"]),
    )
    manifest_sha = document["manifestSha256"]
    manifest_entries = [
        {"path": path, "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)}
        for path, data in bundle.files.items()
    ]
    manifest_entries.sort(key=lambda entry: entry["path"])
    return {
        "schema": PAYLOAD_SCHEMA,
        "evaluatorVersion": EVALUATOR_VERSION,
        "evaluatorCodeSha256": document["evaluatorCodeSha256"],
        "simulatorSha256": simulator_sha256,
        "assetsSha256": document["assetsSha256"],
        "engineVersion": document["engineVersion"],
        "manifestsLockSha256": manifests_lock_sha256,
        "suites": dict(sorted(manifest_sha.items())),
        "candidate": {
            "controllerSha256": document["controllerSha256"],
            "bundleSha256": bundle.bundle_sha256,
            "files": manifest_entries,
        },
        "candidateId": document["candidateId"],
        "investigationId": document["investigationId"],
        "evaluatorAttemptId": document["evaluatorAttemptId"],
        "caseFilter": sorted(case_filter) if case_filter is not None else None,
        "status": document["status"],
        "exitCode": document["exitCode"],
        "cases": cases,
        "casesSha256": hashlib.sha256(canonical_bytes(cases)).hexdigest(),
        "counts": {
            "total": len(cases),
            "passed": sum(case["status"] == "passed" for case in cases),
            "failed": sum(case["status"] == "failed" for case in cases),
            "invalid": sum(case["status"] == "invalid" for case in cases),
        },
        "isolation": {
            "planProcess": document["isolation"]["planProcess"],
            "network": document["isolation"]["network"],
            "privilegeDrop": document["isolation"]["privilegeDrop"],
            "parentDumpable": document["isolation"]["parentDumpable"],
        },
        "createdAtMs": int(__import__("time").time() * 1000),
        "keyId": key_id,
    }


def sign_payload(payload: dict[str, Any], key: SigningKey) -> dict[str, str]:
    encoded = canonical_bytes(payload)
    return {
        "schema": ENVELOPE_SCHEMA,
        "algorithm": "ed25519",
        "keyId": key.key_id,
        "publicKey": base64.b64encode(key.public_key).decode("ascii"),
        "payload": base64.b64encode(encoded).decode("ascii"),
        "signature": base64.b64encode(ed25519.sign(key.seed, DOMAIN + encoded)).decode("ascii"),
    }


def load_trusted_keys(value: Any) -> dict[str, dict[str, Any]]:
    try:
        if not isinstance(value, dict) or value.get("schema") != TRUSTED_KEYS_SCHEMA:
            raise ValueError
        entries = value.get("keys")
        if not isinstance(entries, list):
            raise TypeError("trusted key entries must be a list")
        result: dict[str, dict[str, Any]] = {}
        for entry in entries:
            if not isinstance(entry, dict):
                raise TypeError("trusted key entry must be an object")
            identifier = entry["keyId"]
            public = base64.b64decode(entry["publicKey"], validate=True)
            status = entry["status"]
            if (
                not isinstance(identifier, str)
                or len(public) != 32
                or identifier != key_id(public)
                or status not in {"active", "retired", "revoked"}
                or identifier in result
            ):
                raise TypeError("manifest candidate is invalid")
            if status == "retired" and (type(entry.get("retiredAtMs")) is not int):
                raise ValueError
            result[identifier] = {
                "publicKey": public,
                "status": status,
                "retiredAtMs": entry.get("retiredAtMs"),
            }
        return result
    except (KeyError, TypeError, ValueError, base64.binascii.Error) as exc:
        raise ManifestVerificationError("bad_envelope", "trusted key set is invalid") from exc


def _fail(code: str, message: str) -> None:
    raise ManifestVerificationError(code, message)


def _required_payload(payload: Any) -> None:
    fields = {
        "schema", "evaluatorVersion", "evaluatorCodeSha256", "simulatorSha256",
        "assetsSha256", "engineVersion", "manifestsLockSha256", "suites", "candidate",
        "candidateId", "investigationId", "evaluatorAttemptId", "caseFilter", "status",
        "exitCode", "cases", "casesSha256", "counts", "isolation", "createdAtMs", "keyId",
    }
    if not isinstance(payload, dict) or not fields.issubset(payload):
        _fail("bad_payload", "manifest payload has missing required fields")
    if payload["schema"] != PAYLOAD_SCHEMA:
        _fail("bad_payload", "manifest payload schema is unsupported")
    if type(payload["createdAtMs"]) is not int or type(payload["exitCode"]) is not int:
        _fail("bad_payload", "manifest payload has invalid scalar fields")
    if not isinstance(payload["cases"], list) or not isinstance(payload["suites"], dict):
        _fail("bad_payload", "manifest payload has invalid collection fields")
    if not isinstance(payload["candidate"], dict) or not isinstance(payload["counts"], dict):
        _fail("bad_payload", "manifest payload has invalid candidate or counts")
    try:
        for field_name in ("controllerSha256", "bundleSha256"):
            if not isinstance(payload["candidate"][field_name], str):
                raise TypeError("manifest candidate hash is invalid")
        for case in payload["cases"]:
            if not isinstance(case, dict) or not {"caseId", "suite", "status", "failureKinds", "completionTimeUs", "experimentId", "traceSha256", "replaySha256"}.issubset(case):
                raise ValueError
            if not isinstance(case["failureKinds"], list) or not all(isinstance(item, str) for item in case["failureKinds"]):
                raise ValueError
            if case["status"] not in {"passed", "failed", "invalid"}:
                raise ValueError
        _validate_canonical(payload)
    except (KeyError, TypeError, ValueError):
        _fail("bad_payload", "manifest payload has invalid fields")


def _verify_document(payload: dict[str, Any], document: dict[str, Any]) -> None:
    expected_fields = {
        "assetsSha256": document.get("assetsSha256"),
        "evaluatorCodeSha256": document.get("evaluatorCodeSha256"),
        "suites": document.get("manifestSha256"),
        "candidateId": document.get("candidateId"),
        "investigationId": document.get("investigationId"),
        "evaluatorAttemptId": document.get("evaluatorAttemptId"),
        "status": document.get("status"),
        "exitCode": document.get("exitCode"),
    }
    if any(payload.get(field) != value for field, value in expected_fields.items()):
        _fail("document_mismatch", "signed manifest does not match run document")
    if payload["candidate"]["controllerSha256"] != document.get("controllerSha256"):
        _fail("document_mismatch", "signed manifest does not match run document")
    actual = sorted((_case_entry(case) for case in document.get("cases", [])), key=lambda c: (c["suite"], c["caseId"]))
    if actual != payload["cases"]:
        _fail("document_mismatch", "signed cases do not match run document")


def verify_envelope(
    envelope: Any,
    trusted: dict[str, dict[str, Any]],
    *,
    expect: dict[str, Any] | None = None,
    document: dict[str, Any] | None = None,
) -> dict[str, Any]:
    if not isinstance(envelope, dict) or envelope.get("schema") != ENVELOPE_SCHEMA:
        _fail("unsigned" if envelope is None else "bad_envelope", "signed manifest envelope is invalid")
    if envelope.get("algorithm") != "ed25519":
        _fail("unsupported_algorithm", "manifest signature algorithm is unsupported")
    try:
        identifier = envelope["keyId"]
        embedded = base64.b64decode(envelope["publicKey"], validate=True)
        encoded = base64.b64decode(envelope["payload"], validate=True)
        signature = base64.b64decode(envelope["signature"], validate=True)
    except (KeyError, TypeError, ValueError, base64.binascii.Error):
        _fail("bad_envelope", "signed manifest envelope encoding is invalid")
    record = trusted.get(identifier)
    if record is None:
        _fail("unknown_key", "manifest signing key is not trusted")
    if embedded != record["publicKey"]:
        _fail("key_mismatch", "embedded key does not match trusted key")
    if record["status"] == "revoked":
        _fail("key_revoked", "manifest signing key is revoked")
    try:
        payload = json.loads(encoded)
    except (UnicodeDecodeError, json.JSONDecodeError):
        _fail("bad_payload", "manifest payload is invalid JSON")
    try:
        canonical = canonical_bytes(payload)
    except (TypeError, ValueError):
        _fail("bad_payload", "manifest payload contains invalid values")
    if canonical != encoded:
        _fail("non_canonical_payload", "manifest payload is not canonical JSON")
    _required_payload(payload)
    if payload["keyId"] != identifier:
        _fail("key_mismatch", "manifest payload key does not match envelope")
    if not ed25519.verify(embedded, DOMAIN + encoded, signature):
        _fail("bad_signature", "manifest signature is invalid")
    if record["status"] == "retired" and payload["createdAtMs"] > record["retiredAtMs"]:
        _fail("key_retired", "manifest was signed after key retirement")
    cases = payload["cases"]
    if hashlib.sha256(canonical_bytes(cases)).hexdigest() != payload["casesSha256"]:
        _fail("cases_digest_mismatch", "signed cases digest does not match")
    counts = {
        "total": len(cases),
        "passed": sum(case["status"] == "passed" for case in cases),
        "failed": sum(case["status"] == "failed" for case in cases),
        "invalid": sum(case["status"] == "invalid" for case in cases),
    }
    if counts != payload["counts"]:
        _fail("bad_payload", "signed case counts do not match")
    if expect:
        aliases = {
            "controllerSha256": ("candidate", "controllerSha256"),
            "bundleSha256": ("candidate", "bundleSha256"),
            "candidateId": (None, "candidateId"),
            "investigationId": (None, "investigationId"),
            "evaluatorAttemptId": (None, "evaluatorAttemptId"),
            "evaluatorCodeSha256": (None, "evaluatorCodeSha256"),
            "assetsSha256": (None, "assetsSha256"),
            "manifestsLockSha256": (None, "manifestsLockSha256"),
        }
        for field_name, expected in expect.items():
            if field_name == "suites":
                if not isinstance(expected, dict) or any(payload["suites"].get(k) != v for k, v in expected.items()):
                    _fail("expectation_mismatch", "signed suite hashes do not match expectations")
            elif field_name in aliases:
                parent, child = aliases[field_name]
                actual = payload[parent][child] if parent else payload.get(child)
                if actual != expected:
                    _fail("expectation_mismatch", f"signed {field_name} does not match expectation")
            else:
                _fail("expectation_mismatch", "unsupported manifest expectation")
    if document is not None:
        _verify_document(payload, document)
    return payload
