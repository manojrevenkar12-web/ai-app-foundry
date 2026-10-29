import json
import os
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from fault_model.features import FEATURE_NAMES, ChargePoint, Event, evidence, featurise
from fault_model.train import baseline

NOW = datetime(2026, 10, 29, 12, tzinfo=UTC)
CP = ChargePoint("DE*EDR*E1001", 150, "Alpitronic", "1.9.4")


def ev(hours_ago: float, code: str, status: str = "Faulted", connector: int = 1) -> Event:
    return Event(NOW - timedelta(hours=hours_ago), connector, status, code)


def test_features_count_only_the_window():
    events = [ev(1, "GroundFailure"), ev(2, "GroundFailure"), ev(100, "GroundFailure"), ev(3, "NoError", "Charging")]
    x = featurise(CP, events, NOW)
    assert len(x) == len(FEATURE_NAMES)
    assert x[FEATURE_NAMES.index("n_GroundFailure")] == 2
    assert x[FEATURE_NAMES.index("n_events")] == 2
    assert x[FEATURE_NAMES.index("high_power")] == 1


def test_evidence_names_the_most_frequent_codes():
    events = [ev(1, "ReaderFailure"), ev(2, "ReaderFailure"), ev(3, "OtherError")]
    assert evidence(events, NOW) == ["ReaderFailure x2 in 72h", "OtherError x1 in 72h"]


def test_baseline_follows_the_dominant_code():
    x = featurise(CP, [ev(1, "HighTemperature"), ev(2, "HighTemperature"), ev(3, "OverCurrentFailure")], NOW)
    assert baseline(x) == "overheating"


REPORT = Path(__file__).resolve().parents[3] / "reports" / "fault-model" / "latest.json"


@pytest.mark.skipif(not REPORT.exists(), reason="train the model first")
def test_the_model_beats_the_technicians_rule_on_later_tickets():
    r = json.loads(REPORT.read_text())
    m, b = r["against_true_causes"]["model"], r["against_true_causes"]["baseline_rule"]
    assert m["macro_f1"] > b["macro_f1"]
    assert m["top2_accuracy"] > m["accuracy"]


MODEL = Path(os.environ.get("MODEL_FILE", Path(__file__).resolve().parents[1] / "model" / "fault-model.joblib"))


@pytest.mark.skipif(not MODEL.exists(), reason="train the model first")
def test_service_ranks_causes_and_shows_evidence():
    from fault_model.service import create_app

    events = [ev(h, "ReaderFailure", connector=c) for h in (1, 5, 9, 20) for c in (1, 2)]
    app = create_app(
        load=lambda cp_id: (CP, events) if cp_id == CP.id else (None, []), model_file=str(MODEL), now=lambda: NOW
    )
    client = TestClient(app)
    r = client.get(f"/diagnose/{CP.id}")
    assert r.status_code == 200
    body = r.json()
    assert body["causes"][0]["cause"] == "payment_terminal"
    assert abs(sum(c["probability"] for c in body["causes"]) - 1) < 0.2
    assert body["evidence"][0] == "ReaderFailure x8 in 72h"
    assert client.get("/diagnose/NL*EDR*E9").status_code == 404
