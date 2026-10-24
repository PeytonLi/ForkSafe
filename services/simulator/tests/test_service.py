from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from simulator import assets
from simulator.app import app


def test_public_service_does_not_expose_or_run_withheld_cases():
    with TestClient(app) as client:
        response = client.get("/cases")
        assert response.status_code == 200
        public_ids = {case["caseId"] for case in response.json()["cases"]}
        assert not any(case_id.startswith("withheld-") for case_id in public_ids)
        hidden_id = "withheld-01"
        run = client.post(
            "/runs",
            json={
                "experimentId": "ef336706-2805-4e63-b112-e1b9b04021d8",
                "seed": 0,
                "controllerDir": "controllers/baseline",
                "caseId": hidden_id,
                "outDir": "var/artifacts/test-hidden",
            },
        )
        assert run.status_code == 404
        outside = client.post(
            "/runs",
            json={
                "experimentId": "ef336706-2805-4e63-b112-e1b9b04021d8",
                "seed": 0,
                "controllerDir": "controllers/baseline",
                "caseId": "original-divider-collision",
                "outDir": "../outside",
            },
        )
        assert outside.status_code == 400


def test_asset_mismatch_blocks_service_startup(tmp_path, monkeypatch):
    manifest = tmp_path / "manifest.json"
    manifest.write_text('{"sha256":"0000000000000000000000000000000000000000000000000000000000000000"}')
    monkeypatch.setattr(assets, "MANIFEST_PATH", manifest)
    with pytest.raises(assets.AssetIntegrityError, match="sha256 mismatch"), TestClient(app):
        pass
