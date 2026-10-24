from __future__ import annotations

import base64
import copy
import hashlib
import io
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tarfile
from argparse import Namespace
from pathlib import Path
from uuid import UUID

import pytest
from evaluator import ed25519
from evaluator.admission import admit
from evaluator.run_candidate import execute_case
from evaluator.signing import (
    TRUSTED_KEYS_SCHEMA,
    ManifestVerificationError,
    SigningKeyError,
    key_id,
    load_signing_key,
    load_trusted_keys,
    verify_envelope,
)
from simulator.models import SimCase

ROOT = Path(__file__).resolve().parents[2]
SERVICES = ROOT / "services"
BASELINE = ROOT / "controllers/baseline/task_controller.py"
PUBLIC_MANIFEST = ROOT / "evaluation/public/manifest.json"
WITHHELD_MANIFEST = ROOT / "evaluation/withheld/manifest.json"
CONTROLLER_SOURCE = "def plan(scene):\n    return []\n"
CONTROLLER_BYTES = CONTROLLER_SOURCE.encode()
_TEST_SEED = bytes.fromhex("01" * 32)
_SIGNING_KEY_B64 = base64.b64encode(_TEST_SEED).decode("ascii")


def _controller_bytes(path: Path, *, bundle: bool) -> bytes:
    if not bundle:
        return path.read_bytes()
    if path.is_dir():
        return (path / "task_controller.py").read_bytes()
    with tarfile.open(path, "r:*") as archive:
        member = archive.getmember("task_controller.py")
        stream = archive.extractfile(member)
        assert stream is not None
        return stream.read()


def _run_candidate(
    tmp_path: Path,
    *,
    source: str | None = None,
    controller: Path | None = None,
    bundle: Path | None = None,
    suite: str = "public",
    case_ids: str | None = "nominal",
    withheld_manifest: Path | None = None,
    environment: dict[str, str] | None = None,
    extra_args: tuple[str, ...] = (),
    expected_sha256: str | None = None,
    expected_bundle_sha256: str | None = None,
) -> tuple[subprocess.CompletedProcess[str], dict[str, object], Path]:
    tmp_path.mkdir(parents=True, exist_ok=True)
    if source is not None:
        controller = tmp_path / "controller.py"
        controller.write_text(source, encoding="utf-8")
    candidate = bundle or controller or BASELINE
    is_bundle = bundle is not None
    try:
        controller_hash = hashlib.sha256(_controller_bytes(candidate, bundle=is_bundle)).hexdigest()
    except (KeyError, OSError, tarfile.TarError):
        controller_hash = hashlib.sha256(CONTROLLER_BYTES).hexdigest()
    controller_hash = expected_sha256 or controller_hash
    output = tmp_path / "run.json"
    command = [
        sys.executable,
        "-m",
        "evaluator.run_candidate",
        "--bundle" if is_bundle else "--controller",
        str(candidate),
        "--expected-sha256",
        controller_hash,
        "--suite",
        suite,
        "--out",
        str(output),
        "--artifacts-dir",
        str(tmp_path / "artifacts"),
        "--work-dir",
        str(tmp_path / "workers"),
        "--plan-wall-sec",
        "10",
        "--plan-cpu-sec",
        "10",
        "--case-wall-sec",
        "180",
        "--test-audit-hook-only",
    ]
    if expected_bundle_sha256 is not None:
        command.extend(("--expected-bundle-sha256", expected_bundle_sha256))
    if case_ids is not None:
        command.extend(("--case-ids", case_ids))
    if withheld_manifest is not None:
        command.extend(("--withheld-manifest", str(withheld_manifest)))
    command.extend(extra_args)
    child_env = {
        "HOME": str(tmp_path),
        "PATH": os.defpath,
        "PYTHONPATH": str(SERVICES),
        "PYTHONDONTWRITEBYTECODE": "1",
    }
    if environment:
        child_env.update(environment)
    completed = subprocess.run(
        command,
        cwd=ROOT,
        env=child_env,
        check=False,
        capture_output=True,
        text=True,
        timeout=900,
    )
    assert output.is_file(), completed.stderr
    document = json.loads(output.read_text(encoding="utf-8"))
    assert document["exitCode"] == completed.returncode
    return completed, document, output


def _bundle_manifest(assets: dict[str, bytes], *, declared: dict[str, dict[str, object]] | None = None) -> bytes:
    entries = []
    for path, contents in assets.items():
        entry = (declared or {}).get(path)
        entries.append(
            {
                "path": path,
                "sha256": str(entry["sha256"]) if entry and "sha256" in entry else hashlib.sha256(contents).hexdigest(),
                "bytes": int(entry["bytes"]) if entry and "bytes" in entry else len(contents),
            }
        )
    return json.dumps(
        {"schema": "forksafe.candidate_bundle.v1", "entry": "task_controller.py", "assets": entries},
        sort_keys=True,
        separators=(",", ":"),
    ).encode()


def _make_bundle_dir(
    root: Path,
    *,
    files: dict[str, bytes] | None = None,
    declared: dict[str, dict[str, object]] | None = None,
    controller: bytes = CONTROLLER_BYTES,
) -> Path:
    root.mkdir(parents=True, exist_ok=True)
    (root / "task_controller.py").write_bytes(controller)
    assets = files or {}
    for relative, content in assets.items():
        target = root / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)
    (root / "forksafe-bundle.json").write_bytes(_bundle_manifest(assets, declared=declared))
    return root


def _write_tar(
    path: Path,
    entries: list[tuple[str, bytes | tarfile.TarInfo]],
) -> Path:
    with tarfile.open(path, "w") as archive:
        for name, value in entries:
            if isinstance(value, tarfile.TarInfo):
                archive.addfile(value)
            else:
                info = tarfile.TarInfo(name)
                info.size = len(value)
                archive.addfile(info, io.BytesIO(value))
    return path


def _trusted_from_envelope(envelope: dict[str, object], *, status: str = "active", retired_at: int | None = None):
    entry: dict[str, object] = {
        "keyId": envelope["keyId"],
        "publicKey": envelope["publicKey"],
        "status": status,
    }
    if retired_at is not None:
        entry["retiredAtMs"] = retired_at
    return load_trusted_keys({"schema": TRUSTED_KEYS_SCHEMA, "keys": [entry]})


def _trusted_json(
    envelope: dict[str, object],
    *,
    status: str = "active",
    retired_at: int | None = None,
) -> dict[str, object]:
    entry: dict[str, object] = {
        "keyId": envelope["keyId"],
        "publicKey": envelope["publicKey"],
        "status": status,
    }
    if retired_at is not None:
        entry["retiredAtMs"] = retired_at
    return {"schema": TRUSTED_KEYS_SCHEMA, "keys": [entry]}


def _verify_ts(
    tmp_path: Path,
    envelope: dict[str, object],
    trusted: dict[str, object],
    *,
    document: dict[str, object] | None,
) -> tuple[int, dict[str, object]]:
    node = shutil.which("node")
    if node is None:
        pytest.skip("node is unavailable")
    tmp_path.mkdir(parents=True, exist_ok=True)
    manifest_path = tmp_path / "envelope.json"
    trusted_path = tmp_path / "trusted.json"
    manifest_path.write_text(json.dumps(envelope), encoding="utf-8")
    trusted_path.write_text(json.dumps(trusted), encoding="utf-8")
    command = [
        node,
        "services/evaluator/ts/cli.ts",
        "--manifest",
        str(manifest_path),
        "--trusted-keys",
        str(trusted_path),
    ]
    if document is not None:
        document_path = tmp_path / "document.json"
        document_path.write_text(json.dumps(document), encoding="utf-8")
        command.extend(("--document", str(document_path)))
    completed = subprocess.run(
        command,
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
        timeout=30,
    )
    return completed.returncode, json.loads(completed.stdout)


def test_ed25519_rfc8032_vectors_and_rejections() -> None:
    vectors = [
        (
            "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
            "",
            "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
            (
                "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e06522490155"
                "5fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b"
            ),
        ),
        (
            "4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb",
            "72",
            "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c",
            (
                "92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da"
                "085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00"
            ),
        ),
        (
            "c5aa8df43f9f837bedb7442f31dcb7b166d38535076f094b85ce3a2e0b4458f7",
            "af82",
            "fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025",
            (
                "6291d657deec24024827e69c3abe01a30ce548a284743a445e3680d7db5ac3ac"
                "18ff9b538d16f290ae67f760984dc6594a7c15e9716ed28dc027beceea1ec40a"
            ),
        ),
    ]
    for seed_hex, message_hex, public_hex, signature_hex in vectors:
        seed = bytes.fromhex(seed_hex)
        message = bytes.fromhex(message_hex)
        public = bytes.fromhex(public_hex)
        signature = bytes.fromhex(signature_hex)
        assert ed25519.public_key(seed) == public
        assert ed25519.sign(seed, message) == signature
        assert ed25519.verify(public, message, signature)
    seed = b"rfc8032 sha256 abc test seed...."
    message = hashlib.sha256(b"abc").digest()
    public = ed25519.public_key(seed)
    signature = ed25519.sign(seed, message)
    assert ed25519.verify(public, message, signature)
    assert not ed25519.verify(public[:-1], message, signature)
    assert not ed25519.verify(public, message + b"x", signature)
    assert not ed25519.verify(public, message, signature[:-1])
    changed_public = bytearray(public)
    changed_public[0] ^= 1
    assert not ed25519.verify(changed_public, message, signature)
    changed_message = bytearray(message)
    changed_message[0] ^= 1
    assert not ed25519.verify(public, changed_message, signature)
    changed_signature = bytearray(signature)
    changed_signature[0] ^= 1
    assert not ed25519.verify(public, message, changed_signature)
    order = 2**252 + 27742317777372353535851937790883648493
    r, s = signature[:32], int.from_bytes(signature[32:], "little")
    assert s + order < 2**256
    assert not ed25519.verify(public, message, r + (s + order).to_bytes(32, "little"))
    bad_y = (2**255 - 19).to_bytes(32, "little")
    assert not ed25519.verify(bad_y, message, signature)
    x_zero_with_sign = ((1 << 255) | 1).to_bytes(32, "little")
    assert not ed25519.verify(x_zero_with_sign, message, signature)
    assert not ed25519.verify(public, message, x_zero_with_sign + b"\x00" * 32)


def test_signing_key_sources_are_consumed_and_redacted(tmp_path: Path) -> None:
    environ = {"FORKSAFE_EVAL_SIGNING_KEY": _SIGNING_KEY_B64}
    key = load_signing_key(environ)
    assert key is not None
    assert key.public_key == ed25519.public_key(_TEST_SEED)
    assert key.key_id == key_id(key.public_key)
    assert "seed" not in repr(key)
    assert environ == {}
    with pytest.raises(SigningKeyError):
        load_signing_key(
            {
                "FORKSAFE_EVAL_SIGNING_KEY": _SIGNING_KEY_B64,
                "FORKSAFE_EVAL_SIGNING_KEY_FILE": "/does/not/exist",
            }
        )
    key_file = tmp_path / "signing.key"
    key_file.write_text(_SIGNING_KEY_B64 + "\n", encoding="ascii")
    environ = {"FORKSAFE_EVAL_SIGNING_KEY_FILE": str(key_file)}
    loaded = load_signing_key(environ)
    assert loaded is not None and loaded.key_id == key.key_id
    assert not key_file.exists()
    assert environ == {}
    with pytest.raises(SigningKeyError) as error:
        load_signing_key({"FORKSAFE_EVAL_SIGNING_KEY": "this is not a key"})
    assert "this is not a key" not in str(error.value)


def test_signing_required_and_malformed_key_fail_before_cases(tmp_path: Path) -> None:
    required, required_document, _ = _run_candidate(
        tmp_path / "required",
        environment={"FORKSAFE_REQUIRE_SIGNING": "1"},
    )
    assert required.returncode == 4
    assert required_document["error"]["code"] == "signing_key_required"
    assert required_document["cases"] == []
    malformed_text = "not-a-real-secret-key"
    malformed, malformed_document, _ = _run_candidate(
        tmp_path / "malformed",
        environment={"FORKSAFE_EVAL_SIGNING_KEY": malformed_text},
    )
    assert malformed.returncode == 4
    assert malformed_document["error"]["code"] == "signing_key_invalid"
    assert malformed_text not in json.dumps(malformed_document)
    assert malformed_text not in malformed.stderr


def test_sequential_execute_case_does_not_leak_state_or_siblings(tmp_path: Path) -> None:
    manifest = json.loads(PUBLIC_MANIFEST.read_text(encoding="utf-8"))
    case = SimCase.model_validate(manifest["cases"][0]).model_dump(by_alias=True, exclude_none=True)
    artifacts = tmp_path / "artifacts"
    work_dir = tmp_path / "workers"
    first = tmp_path / "first.py"
    first.write_text(
        """
import builtins, os
MODULE_GLOBAL_LEAK = "first candidate"
builtins._forksafe_security_leak = "first candidate"
os.environ["LEAK_TEST_VALUE"] = "first candidate"
open("candidate-file", "w").write("first")
os.mkdir("private-dir")
open("private-dir/marker", "w").write("first")
os.chmod("private-dir", 0)
for path in ("/tmp/forksafe-leak-test", "/dev/shm/forksafe-leak-test"):
    try:
        open(path, "w").write("blocked")
    except PermissionError:
        pass
def plan(scene):
    return []
""",
        encoding="utf-8",
    )
    second = tmp_path / "second.py"
    second.write_text(
        f"""
import builtins, glob, os
def blocked(callback):
    try:
        callback()
    except (PermissionError, FileNotFoundError):
        return
    raise RuntimeError("LEAK: protected path was readable")
if hasattr(builtins, "_forksafe_security_leak"):
    raise RuntimeError("LEAK: builtins survived")
if os.environ.get("LEAK_TEST_VALUE"):
    raise RuntimeError("LEAK: environment survived")
if any(name.startswith("FORKSAFE_") for name in os.environ):
    raise RuntimeError("LEAK: evaluator environment exposed")
if globals().get("MODULE_GLOBAL_LEAK"):
    raise RuntimeError("LEAK: module global survived")
blocked(lambda: os.listdir({str(artifacts)!r}))
blocked(lambda: open({str(artifacts / 'public' / 'nominal' / 'trace.json')!r}).read())
blocked(lambda: os.listdir({str(work_dir)!r}))
if glob.glob({str(work_dir / '*manifest*')!r}):
    raise RuntimeError("LEAK: sibling manifest was discoverable")
def plan(scene):
    return []
""",
        encoding="utf-8",
    )
    controller_sha_a = hashlib.sha256(first.read_bytes()).hexdigest()
    controller_sha_b = hashlib.sha256(second.read_bytes()).hexdigest()
    work_dir.mkdir(parents=True, exist_ok=True)
    for controller_path, expected_sha in ((first, controller_sha_a), (second, controller_sha_b)):
        if controller_path is second:
            (work_dir / "prior-run.manifest.json").write_text("protected", encoding="utf-8")
        report = execute_case(
            controller_path,
            expected_sha,
            case,
            "public",
            UUID("cb7d7378-6eac-5e4d-a91b-6bd72e30e4a2"),
            UUID("5d992c77-8a1c-5b9d-a0b6-95f5c402f211"),
            UUID("cbb7ef41-2c50-5d7c-a1c1-e05bf584f1d0"),
            artifacts,
            work_dir=work_dir,
            test_skip_netns=True,
        )
        assert report["status"] != "invalid"
    (work_dir / "prior-run.manifest.json").unlink()
    assert list(work_dir.iterdir()) == []


def test_each_run_gets_a_fresh_controller_process(tmp_path: Path) -> None:
    cases = json.loads(PUBLIC_MANIFEST.read_text(encoding="utf-8"))["cases"]
    selected_ids = [case["caseId"] for case in cases[:3]]
    source = """
import os
counter = globals().get("counter", 0) + 1
if counter > 1:
    raise RuntimeError("LEAK: controller module counter survived")
if os.path.exists("marker"):
    raise RuntimeError("LEAK: prior case marker survived")
open("marker", "w").write("this case")
def plan(scene):
    if counter > 1:
        raise RuntimeError("LEAK: controller counter at plan time")
    return []
"""
    completed, document, _ = _run_candidate(
        tmp_path,
        source=source,
        case_ids=",".join(selected_ids),
    )
    assert completed.returncode == 1
    assert len(document["cases"]) == 3
    assert all(case["status"] != "invalid" for case in document["cases"])


def test_withheld_manifest_is_unreadable_without_consumption(tmp_path: Path) -> None:
    manifest_copy = tmp_path / "protected-withheld.json"
    shutil.copyfile(WITHHELD_MANIFEST, manifest_copy)
    case_id = json.loads(manifest_copy.read_text(encoding="utf-8"))["cases"][0]["caseId"]
    source = f"""
import glob, os
path = {str(manifest_copy)!r}
attempts = [
    lambda: open(path, encoding="utf-8").read(),
    lambda: open("/proc/" + str(os.getppid()) + "/cmdline", "rb").read(),
    lambda: os.listdir({str(tmp_path)!r}),
    lambda: os.listdir("/"),
]
for attempt in attempts:
    try:
        attempt()
    except (PermissionError, FileNotFoundError):
        continue
    raise RuntimeError("LEAK: withheld manifest or parent metadata readable")
if glob.glob({str(tmp_path / '*withheld*')!r}):
    raise RuntimeError("LEAK: withheld manifest was discoverable")
def plan(scene):
    return []
"""
    completed, document, _ = _run_candidate(
        tmp_path,
        source=source,
        suite="withheld",
        case_ids=case_id,
        withheld_manifest=manifest_copy,
    )
    assert completed.returncode == 1
    assert manifest_copy.is_file()
    assert document["cases"][0]["status"] != "invalid"


def test_signing_key_is_unreachable_to_candidate(tmp_path: Path) -> None:
    controller_source = f"""
import os, re
secret = {_SIGNING_KEY_B64!r}
key_names = ("FORKSAFE_EVAL_SIGNING_KEY", "FORKSAFE_EVAL_SIGNING_KEY_FILE")
paths = ["/proc/self/environ", "/proc/" + str(os.getppid()) + "/environ"]
try:
    status = open("/proc/self/status", encoding="ascii").read()
    parent = int(re.search(r"^PPid:\\s+(\\d+)$", status, re.M).group(1))
    grandparent_status = open(f"/proc/{{parent}}/status", encoding="ascii").read()
    grandparent = int(re.search(r"^PPid:\\s+(\\d+)$", grandparent_status, re.M).group(1))
    paths.append(f"/proc/{{grandparent}}/environ")
except (PermissionError, FileNotFoundError, AttributeError):
    pass
if secret in os.environ.values() or any(key.startswith("FORKSAFE_") for key in os.environ):
    raise RuntimeError("LEAK: signing key in environment")
for path in paths:
    try:
        data = open(path, "rb").read()
    except (PermissionError, FileNotFoundError):
        continue
    if secret.encode() in data or any(name.encode() in data for name in key_names):
        raise RuntimeError("LEAK: signing key in proc environ")
key_file = os.environ.get("FORKSAFE_EVAL_SIGNING_KEY_FILE")
if key_file:
    try:
        open(key_file, "rb").read()
    except (PermissionError, FileNotFoundError):
        pass
    else:
        raise RuntimeError("LEAK: signing key file readable")
def plan(scene):
    return []
"""
    key_run, document, output = _run_candidate(
        tmp_path / "environment-key",
        source=controller_source,
        environment={
            "FORKSAFE_EVAL_SIGNING_KEY": _SIGNING_KEY_B64,
            "FORKSAFE_REQUIRE_SIGNING": "1",
        },
    )
    assert key_run.returncode in {0, 1}
    assert document["cases"][0]["status"] != "invalid"
    assert document["signing"]["mode"] == "signed"
    assert document["isolation"]["parentDumpable"] is False
    assert document["signedManifest"] is not None
    assert _SIGNING_KEY_B64 not in json.dumps(document)
    assert _SIGNING_KEY_B64 not in key_run.stderr
    envelope = document["signedManifest"]
    public_key_b64 = envelope["publicKey"]
    trusted = {
        "schema": TRUSTED_KEYS_SCHEMA,
        "keys": [
            {"keyId": envelope["keyId"], "publicKey": public_key_b64, "status": "active"}
        ],
    }
    trusted_path = tmp_path / "trusted.json"
    trusted_path.write_text(json.dumps(trusted), encoding="utf-8")
    verified = subprocess.run(
        [
            sys.executable,
            "-m",
            "evaluator.verify_manifest",
            "--manifest",
            str(output.with_name("run.manifest.json")),
            "--trusted-keys",
            str(trusted_path),
            "--document",
            str(output),
        ],
        cwd=ROOT,
        env={"HOME": str(tmp_path), "PATH": os.defpath, "PYTHONPATH": str(SERVICES)},
        capture_output=True,
        text=True,
        check=False,
        timeout=30,
    )
    assert verified.returncode == 0, verified.stdout + verified.stderr
    assert json.loads(verified.stdout)["valid"] is True
    if shutil.which("node") is not None:
        ts_status, ts_output = _verify_ts(
            tmp_path / "typescript-verified",
            envelope,
            trusted,
            document=document,
        )
        assert ts_status == 0
        assert ts_output["valid"] is True

    key_file = tmp_path / "file-key"
    key_file.write_text(_SIGNING_KEY_B64 + "\n", encoding="ascii")
    file_run, file_document, _ = _run_candidate(
        tmp_path / "file-key-run",
        source=controller_source.replace(
            "key_file = os.environ.get(\"FORKSAFE_EVAL_SIGNING_KEY_FILE\")",
            f"key_file = {str(key_file)!r}",
        ),
        environment={
            "FORKSAFE_EVAL_SIGNING_KEY_FILE": str(key_file),
            "FORKSAFE_REQUIRE_SIGNING": "1",
        },
    )
    assert file_run.returncode in {0, 1}
    assert not key_file.exists()
    assert file_document["cases"][0]["status"] != "invalid"
    assert file_document["signing"]["mode"] == "signed"
    file_envelope = file_document["signedManifest"]
    file_trusted = {
        "schema": TRUSTED_KEYS_SCHEMA,
        "keys": [
            {
                "keyId": file_envelope["keyId"],
                "publicKey": file_envelope["publicKey"],
                "status": "active",
            }
        ],
    }
    file_trusted_path = tmp_path / "file-trusted.json"
    file_trusted_path.write_text(json.dumps(file_trusted), encoding="utf-8")
    file_verified = subprocess.run(
        [
            sys.executable,
            "-m",
            "evaluator.verify_manifest",
            "--manifest",
            str(tmp_path / "file-key-run" / "run.manifest.json"),
            "--trusted-keys",
            str(file_trusted_path),
            "--document",
            str(tmp_path / "file-key-run" / "run.json"),
        ],
        cwd=ROOT,
        env={"HOME": str(tmp_path), "PATH": os.defpath, "PYTHONPATH": str(SERVICES)},
        capture_output=True,
        text=True,
        check=False,
        timeout=30,
    )
    assert file_verified.returncode == 0, file_verified.stdout + file_verified.stderr
    assert json.loads(file_verified.stdout)["valid"] is True


@pytest.mark.parametrize("archive", [False, True], ids=["directory", "tar"])
def test_declared_asset_bundle_runs_and_is_signed(tmp_path: Path, archive: bool) -> None:
    source = """
import json
CARRY_HEIGHT = json.load(open("assets/params.json", encoding="utf-8"))["carryHeight"]
def plan(scene):
    cube = scene["cubePos"]
    target = scene["targetPos"]
    return [
        {"skill": "open_gripper"},
        {"skill": "move_to_pose", "pos": [cube[0], cube[1], cube[2] + 0.12], "speed": 0.2},
        {"skill": "move_to_pose", "pos": [cube[0], cube[1], cube[2]], "speed": 0.2},
        {"skill": "close_gripper"},
        {"skill": "move_to_pose", "pos": [cube[0], cube[1], CARRY_HEIGHT], "speed": 0.15},
        {"skill": "move_to_pose", "pos": [target[0], target[1], CARRY_HEIGHT], "speed": 0.15},
        {"skill": "move_to_pose", "pos": target, "speed": 0.2},
        {"skill": "open_gripper"},
        {"skill": "move_to_pose", "pos": [target[0], target[1], target[2] + 0.12], "speed": 0.2},
    ]
"""
    controller = source.encode()
    asset = b'{"carryHeight":0.06}'
    manifest = _bundle_manifest({"assets/params.json": asset})
    if archive:
        tar_path = tmp_path / "bundle.tgz"
        bundle = _write_tar(
            tar_path,
            [
                ("task_controller.py", controller),
                ("assets/params.json", asset),
                ("forksafe-bundle.json", manifest),
            ],
        )
    else:
        bundle = _make_bundle_dir(
            tmp_path / "bundle",
            files={"assets/params.json": asset},
            controller=controller,
        )
    completed, document, _ = _run_candidate(
        tmp_path,
        bundle=bundle,
        environment={"FORKSAFE_EVAL_SIGNING_KEY": _SIGNING_KEY_B64},
        expected_bundle_sha256=admit(bundle).bundle_sha256,
    )
    assert completed.returncode == 0, completed.stderr
    envelope = document["signedManifest"]
    assert re.fullmatch(r"[0-9a-f]{64}", document["bundleSha256"])
    payload = verify_envelope(envelope, _trusted_from_envelope(envelope))
    assert payload["candidate"]["bundleSha256"] == document["bundleSha256"]
    assert payload["candidate"]["files"] == list(admit(bundle).manifest_entries)


def test_expected_bundle_hash_mismatch_stops_before_cases(tmp_path: Path) -> None:
    bundle = _make_bundle_dir(tmp_path / "bundle")
    completed, document, _ = _run_candidate(
        tmp_path / "run",
        bundle=bundle,
        expected_bundle_sha256="0" * 64,
    )
    assert completed.returncode == 3
    assert document["error"]["code"] == "integrity_error"
    assert document["cases"] == []


def test_python_and_typescript_reject_signed_manifest_tampering(tmp_path: Path) -> None:
    completed, document, _ = _run_candidate(
        tmp_path / "signed",
        controller=BASELINE,
        environment={
            "FORKSAFE_EVAL_SIGNING_KEY": _SIGNING_KEY_B64,
            "FORKSAFE_REQUIRE_SIGNING": "1",
        },
    )
    assert completed.returncode == 0
    envelope = document["signedManifest"]
    trusted = _trusted_json(envelope)
    payload = json.loads(base64.b64decode(envelope["payload"]))
    variants: list[tuple[str, dict[str, object], dict[str, object], dict[str, object] | None]] = []

    payload_bytes = bytearray(base64.b64decode(envelope["payload"]))
    created_at = payload_bytes.index(b'"createdAtMs":') + len(b'"createdAtMs":')
    payload_bytes[created_at] = ord("2") if payload_bytes[created_at] != ord("2") else ord("3")
    variants.append(
        (
            "bad_signature",
            dict(envelope, payload=base64.b64encode(payload_bytes).decode()),
            trusted,
            document,
        )
    )
    signature = bytearray(base64.b64decode(envelope["signature"]))
    signature[0] ^= 1
    variants.append(
        ("bad_signature", dict(envelope, signature=base64.b64encode(signature).decode()), trusted, document)
    )

    attacker_public = ed25519.public_key(b"\x02" * 32)
    attacker_id = key_id(attacker_public)
    variants.append(
        (
            "unknown_key",
            dict(
                envelope,
                keyId=attacker_id,
                publicKey=base64.b64encode(attacker_public).decode(),
            ),
            trusted,
            document,
        )
    )
    variants.append(
        ("unknown_key", dict(envelope, keyId="ed25519:0000000000000000"), trusted, document)
    )
    variants.append(
        (
            "key_mismatch",
            dict(envelope, publicKey=base64.b64encode(attacker_public).decode()),
            trusted,
            document,
        )
    )
    variants.append(
        ("key_revoked", envelope, _trusted_json(envelope, status="revoked"), document)
    )
    variants.append(
        (
            "key_retired",
            envelope,
            _trusted_json(
                envelope,
                status="retired",
                retired_at=int(payload["createdAtMs"]) - 1,
            ),
            document,
        )
    )
    status_document = copy.deepcopy(document)
    status_document["cases"][0]["status"] = "failed"
    variants.append(("document_mismatch", envelope, trusted, status_document))
    time_document = copy.deepcopy(document)
    time_document["cases"][0]["completionTimeSec"] += 0.01
    variants.append(("document_mismatch", envelope, trusted, time_document))

    canonical_payload_bytes = base64.b64decode(envelope["payload"])
    variants.append(
        (
            "non_canonical_payload",
            dict(
                envelope,
                payload=base64.b64encode(b" " + canonical_payload_bytes + b" ").decode(),
            ),
            trusted,
            document,
        )
    )
    float_payload = dict(payload, smuggledFloat=1.25)
    float_bytes = json.dumps(float_payload, sort_keys=True, separators=(",", ":")).encode()
    variants.append(
        (
            "bad_payload",
            dict(envelope, payload=base64.b64encode(float_bytes).decode()),
            trusted,
            document,
        )
    )

    for index, (code, changed_envelope, changed_trusted, changed_document) in enumerate(variants):
        with pytest.raises(ManifestVerificationError) as error:
            verify_envelope(
                changed_envelope,
                load_trusted_keys(changed_trusted),
                document=changed_document,
            )
        assert error.value.code == code
        if shutil.which("node") is not None:
            ts_status, ts_output = _verify_ts(
                tmp_path / f"ts-{index}",
                changed_envelope,
                changed_trusted,
                document=changed_document,
            )
            assert ts_status == 3
            assert ts_output["error"]["code"] == code


def _assert_admission_rejected(
    tmp_path: Path,
    path: Path,
    reason: str,
    *,
    controller: bool = False,
    expected_sha256: str | None = None,
) -> None:
    completed, document, _ = _run_candidate(
        tmp_path,
        controller=path if controller else None,
        bundle=None if controller else path,
        expected_sha256=expected_sha256,
    )
    assert completed.returncode == 3, completed.stderr
    assert document["error"]["code"] == "admission_rejected"
    assert document["error"]["reason"] == reason
    assert document["cases"] == []


@pytest.mark.parametrize("target", ["/etc/passwd", "task_controller.py"], ids=["external", "sibling"])
def test_directory_bundle_rejects_symlinks(tmp_path: Path, target: str) -> None:
    bundle = _make_bundle_dir(tmp_path / "bundle")
    os.symlink(target, bundle / "linked-file")
    _assert_admission_rejected(tmp_path / "run", bundle, "symlink")


def test_tar_bundle_rejects_symlinks_and_hardlinks(tmp_path: Path) -> None:
    symlink = tarfile.TarInfo("assets/link.txt")
    symlink.type = tarfile.SYMTYPE
    symlink.linkname = "/etc/passwd"
    link_bundle = _write_tar(
        tmp_path / "symlink.tar",
        [
            ("task_controller.py", CONTROLLER_BYTES),
            ("forksafe-bundle.json", _bundle_manifest({})),
            ("assets/link.txt", symlink),
        ],
    )
    _assert_admission_rejected(tmp_path / "symlink-run", link_bundle, "symlink")

    hardlink = tarfile.TarInfo("assets/hard.txt")
    hardlink.type = tarfile.LNKTYPE
    hardlink.linkname = "task_controller.py"
    hard_bundle = _write_tar(
        tmp_path / "hardlink.tar",
        [
            ("task_controller.py", CONTROLLER_BYTES),
            ("forksafe-bundle.json", _bundle_manifest({})),
            ("assets/hard.txt", hardlink),
        ],
    )
    _assert_admission_rejected(tmp_path / "hardlink-run", hard_bundle, "hardlink")


@pytest.mark.parametrize("kind", ["hardlink", "fifo", "socket"])
def test_directory_bundle_rejects_hardlinks_and_special_files(tmp_path: Path, kind: str) -> None:
    bundle = _make_bundle_dir(tmp_path / kind)
    target = bundle / "invalid-entry"
    if kind == "hardlink":
        os.link(bundle / "task_controller.py", target)
        reason = "hardlink"
    elif kind == "fifo":
        os.mkfifo(target)
        reason = "special_file"
    else:
        listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        listener.bind(str(target))
        listener.close()
        reason = "special_file"
    _assert_admission_rejected(tmp_path / f"{kind}-run", bundle, reason)


def test_tar_bundle_rejects_character_device_and_fifo(tmp_path: Path) -> None:
    for name, file_type in (("device.tar", tarfile.CHRTYPE), ("fifo.tar", tarfile.FIFOTYPE)):
        special = tarfile.TarInfo("assets/special")
        special.type = file_type
        special.devmajor = 1
        special.devminor = 3
        bundle = _write_tar(
            tmp_path / name,
            [
                ("task_controller.py", CONTROLLER_BYTES),
                ("forksafe-bundle.json", _bundle_manifest({})),
                ("assets/special", special),
            ],
        )
        _assert_admission_rejected(tmp_path / f"{name}-run", bundle, "special_file")


@pytest.mark.parametrize(
    ("member", "reason"),
    [
        ("/absolute/file.txt", "absolute_path"),
        ("../escape.txt", "path_traversal"),
        ("./a/../../x", "path_traversal"),
        (".hidden", "invalid_path"),
        ("assets/é.json", "invalid_path"),
        ("a/b/c/d/e.txt", "invalid_path"),
    ],
)
def test_tar_bundle_rejects_invalid_path_members(
    tmp_path: Path,
    member: str,
    reason: str,
) -> None:
    bundle = _write_tar(
        tmp_path / "invalid-path.tar",
        [
            ("task_controller.py", CONTROLLER_BYTES),
            ("forksafe-bundle.json", _bundle_manifest({})),
            (member, b"x"),
        ],
    )
    _assert_admission_rejected(tmp_path / "invalid-path-run", bundle, reason)


@pytest.mark.parametrize("archive", [False, True], ids=["directory", "tar"])
def test_bundle_rejects_hidden_invalid_and_undeclared_files(tmp_path: Path, archive: bool) -> None:
    for name, reason in ((".hidden", "invalid_path"), ("unicode-é.txt", "invalid_path"), ("extra.txt", "undeclared_path")):
        if archive:
            path = _write_tar(
                tmp_path / f"{name.replace('/', '_')}.tar",
                [
                    ("task_controller.py", CONTROLLER_BYTES),
                    ("forksafe-bundle.json", _bundle_manifest({})),
                    (name, b"unexpected"),
                ],
            )
        else:
            path = _make_bundle_dir(tmp_path / name.replace("/", "_"))
            (path / name).write_bytes(b"unexpected")
        _assert_admission_rejected(tmp_path / f"run-{name.replace('/', '_')}", path, reason)


@pytest.mark.parametrize("archive", [False, True], ids=["directory", "tar"])
def test_bundle_rejects_oversized_controller_and_asset(tmp_path: Path, archive: bool) -> None:
    for kind in ("controller", "asset"):
        oversized_controller = b"x" * 200_001 if kind == "controller" else CONTROLLER_BYTES
        oversized_asset = b"x" * (1024 * 1024 + 1)
        assets = {"assets/large.json": oversized_asset} if kind == "asset" else {}
        if archive:
            entries = [
                ("task_controller.py", oversized_controller),
                ("forksafe-bundle.json", _bundle_manifest(assets)),
                *[(path, contents) for path, contents in assets.items()],
            ]
            path = _write_tar(tmp_path / f"{kind}.tar", entries)
        else:
            path = _make_bundle_dir(
                tmp_path / kind,
                files=assets,
                controller=oversized_controller,
            )
        _assert_admission_rejected(
            tmp_path / f"{kind}-run",
            path,
            "file_too_large",
            expected_sha256=hashlib.sha256(oversized_controller).hexdigest(),
        )


@pytest.mark.parametrize("archive", [False, True], ids=["directory", "tar"])
def test_bundle_rejects_total_size_and_file_count_limits(tmp_path: Path, archive: bool) -> None:
    too_large_assets = {
        f"assets/{index}.json": b"x" * (1024 * 1024) for index in range(5)
    }
    too_many_assets = {f"assets/{index:02}.json": b"x" for index in range(31)}
    for name, assets, reason in (
        ("size", too_large_assets, "bundle_too_large"),
        ("count", too_many_assets, "too_many_files"),
    ):
        manifest = _bundle_manifest(assets)
        if archive:
            entries = [
                ("task_controller.py", CONTROLLER_BYTES),
                ("forksafe-bundle.json", manifest),
                *[(path, contents) for path, contents in assets.items()],
            ]
            bundle = _write_tar(tmp_path / f"{name}.tar", entries)
        else:
            bundle = _make_bundle_dir(tmp_path / name, files=assets)
        _assert_admission_rejected(tmp_path / f"{name}-run", bundle, reason)


@pytest.mark.parametrize("archive", [False, True], ids=["directory", "tar"])
def test_bundle_rejects_missing_and_hash_mismatched_assets(tmp_path: Path, archive: bool) -> None:
    asset_data = b'{"p":1}'
    good_manifest = _bundle_manifest({"assets/params.json": asset_data})
    wrong_manifest = _bundle_manifest(
        {"assets/params.json": asset_data},
        declared={"assets/params.json": {"sha256": "0" * 64}},
    )
    for name, manifest, included, reason in (
        ("missing", good_manifest, False, "missing_declared_asset"),
        ("mismatch", wrong_manifest, True, "asset_hash_mismatch"),
    ):
        if archive:
            entries = [
                ("task_controller.py", CONTROLLER_BYTES),
                ("forksafe-bundle.json", manifest),
            ]
            if included:
                entries.append(("assets/params.json", asset_data))
            bundle = _write_tar(tmp_path / f"{name}.tar", entries)
        else:
            bundle = tmp_path / name
            bundle.mkdir()
            (bundle / "task_controller.py").write_bytes(CONTROLLER_BYTES)
            (bundle / "forksafe-bundle.json").write_bytes(manifest)
            if included:
                (bundle / "assets").mkdir()
                (bundle / "assets/params.json").write_bytes(asset_data)
        _assert_admission_rejected(tmp_path / f"{name}-run", bundle, reason)


def test_bundle_rejects_duplicate_members_and_missing_entry(tmp_path: Path) -> None:
    duplicate = _write_tar(
        tmp_path / "duplicate.tar",
        [
            ("task_controller.py", CONTROLLER_BYTES),
            ("task_controller.py", CONTROLLER_BYTES),
        ],
    )
    _assert_admission_rejected(tmp_path / "duplicate-run", duplicate, "duplicate_path")

    missing_directory = _make_bundle_dir(tmp_path / "missing-directory")
    (missing_directory / "task_controller.py").unlink()
    _assert_admission_rejected(tmp_path / "missing-directory-run", missing_directory, "missing_entry")
    missing_tar = _write_tar(
        tmp_path / "missing.tar",
        [("forksafe-bundle.json", _bundle_manifest({}))],
    )
    _assert_admission_rejected(tmp_path / "missing-tar-run", missing_tar, "missing_entry")


def test_legacy_controller_admission_rejects_symlink_and_oversize(tmp_path: Path) -> None:
    target = tmp_path / "target.py"
    target.write_bytes(CONTROLLER_BYTES)
    symlink = tmp_path / "controller-link.py"
    os.symlink(target, symlink)
    _assert_admission_rejected(
        tmp_path / "symlink-run",
        symlink,
        "symlink",
        controller=True,
        expected_sha256=hashlib.sha256(CONTROLLER_BYTES).hexdigest(),
    )
    oversized = tmp_path / "oversized.py"
    oversized.write_bytes(b"x" * 200_001)
    _assert_admission_rejected(
        tmp_path / "oversized-run",
        oversized,
        "file_too_large",
        controller=True,
        expected_sha256=hashlib.sha256(oversized.read_bytes()).hexdigest(),
    )


def test_admission_rejection_happens_before_execute_case(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    bundle = _make_bundle_dir(tmp_path / "bundle")
    os.symlink("/etc/passwd", bundle / "link")
    monkeypatch.delenv("FORKSAFE_EVAL_SIGNING_KEY", raising=False)
    monkeypatch.delenv("FORKSAFE_EVAL_SIGNING_KEY_FILE", raising=False)
    monkeypatch.delenv("FORKSAFE_REQUIRE_SIGNING", raising=False)

    def forbidden_execute_case(*args: object, **kwargs: object) -> None:
        pytest.fail("execute_case ran for a rejected candidate")

    from evaluator import run_candidate as run_module

    monkeypatch.setattr(run_module, "execute_case", forbidden_execute_case)
    args = Namespace(
        controller=None,
        bundle=bundle,
        expected_sha256=hashlib.sha256(CONTROLLER_BYTES).hexdigest(),
        expected_bundle_sha256=None,
        suite="public",
        out=tmp_path / "out.json",
        manifest_out=None,
        withheld_manifest=None,
        consume_withheld_manifest=False,
        candidate_id=None,
        investigation_id=None,
        evaluator_attempt_id=None,
        artifacts_dir=tmp_path / "artifacts",
        work_dir=tmp_path / "workers",
        case_ids="nominal",
        plan_wall_sec=10,
        plan_cpu_sec=10,
        plan_memory_mb=1024,
        case_wall_sec=180,
        case_memory_mb=3072,
        test_audit_hook_only=True,
    )
    code, document = run_module.run(args)
    assert code == 3
    assert document["error"]["code"] == "admission_rejected"
    assert document["cases"] == []
