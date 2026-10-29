"""Trains the fault model on closed tickets and evaluates it on later ones.

    uv run python -m fault_model.train

Labels are the causes technicians recorded, which are sometimes wrong, as they are in real
operations. The evaluation reports agreement with those records and, separately, with the
simulator's true causes (TRUTH_FILE), which only the evaluation may read. The baseline is the
rule a technician would use: the most frequent error code decides the cause.
"""

from __future__ import annotations

import json
import os
from datetime import timedelta
from pathlib import Path

import joblib
import numpy as np
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.metrics import accuracy_score, f1_score

from .data import connect, load_training
from .features import ERROR_CODES, FEATURE_NAMES, featurise

ROOT = Path(__file__).resolve().parents[3]
MODEL_FILE = Path(os.environ.get("MODEL_FILE", Path(__file__).resolve().parents[1] / "model" / "fault-model.joblib"))
REPORT_FILE = Path(os.environ.get("REPORT_FILE", ROOT / "reports" / "fault-model" / "latest.json"))
TEST_DAYS = 14

RULE = {
    "GroundFailure": "rcd_trip",
    "OverCurrentFailure": "rcd_trip",
    "ConnectorLockFailure": "cable_damage",
    "EVCommunicationError": "cable_damage",
    "WeakSignal": "comms_loss",
    "OtherError": "comms_loss",
    "HighTemperature": "overheating",
    "PowerSwitchFailure": "overheating",
    "ReaderFailure": "payment_terminal",
    "InternalError": "firmware_crash",
    "ResetFailure": "firmware_crash",
}


def baseline(x: np.ndarray) -> str:
    counts = x[: len(ERROR_CODES)]
    if counts.sum() == 0:
        return "comms_loss"
    return RULE[ERROR_CODES[int(np.argmax(counts))]]


def scores(y_true: list[str], y_pred: list[str], proba_top2: list[list[str]] | None = None) -> dict:
    out = {
        "accuracy": round(float(accuracy_score(y_true, y_pred)), 4),
        "macro_f1": round(float(f1_score(y_true, y_pred, average="macro")), 4),
    }
    if proba_top2 is not None:
        out["top2_accuracy"] = round(float(np.mean([t in p for t, p in zip(y_true, proba_top2, strict=True)])), 4)
    return out


def main() -> None:
    with connect() as conn:
        cps, events, tickets = load_training(conn)
    last = max(t[2] for t in tickets)
    cutoff = last - timedelta(days=TEST_DAYS)
    rows, labels, when, ids = [], [], [], []
    for tid, cp_id, opened, cause in tickets:
        cp = cps.get(cp_id)
        if cp is None:
            continue
        rows.append(featurise(cp, events.get(cp_id, []), opened))
        labels.append(cause)
        when.append(opened)
        ids.append(tid)
    x = np.vstack(rows)
    y = np.asarray(labels)
    train = np.asarray([w < cutoff for w in when])
    test = ~train

    model = HistGradientBoostingClassifier(
        max_iter=300, learning_rate=0.06, max_leaf_nodes=31, l2_regularization=1.0, random_state=0
    )
    model.fit(x[train], y[train])
    pred = model.predict(x[test]).tolist()
    proba = model.predict_proba(x[test])
    classes = model.classes_.tolist()
    top2 = [[classes[i] for i in np.argsort(-p)[:2]] for p in proba]
    base = [baseline(r) for r in x[test]]

    recorded = y[test].tolist()
    report = {
        "trained_on": int(train.sum()),
        "tested_on": int(test.sum()),
        "split": f"tickets opened in the last {TEST_DAYS} days are the test set",
        "features": FEATURE_NAMES,
        "against_recorded_causes": {"model": scores(recorded, pred, top2), "baseline_rule": scores(recorded, base)},
    }
    truth_file = os.environ.get("TRUTH_FILE", str(ROOT / "build" / "sim" / "truth.json"))
    if Path(truth_file).exists():
        truth = json.loads(Path(truth_file).read_text())
        true = [truth[t] for t, keep in zip(ids, test, strict=True) if keep]
        report["against_true_causes"] = {"model": scores(true, pred, top2), "baseline_rule": scores(true, base)}
        report["recorded_label_error_rate_in_test"] = round(
            float(np.mean([a != b for a, b in zip(recorded, true, strict=True)])), 4
        )
        per_class = f1_score(true, pred, average=None, labels=classes)
        report["per_class_f1_true"] = {c: round(float(f), 3) for c, f in zip(classes, per_class, strict=True)}
    MODEL_FILE.parent.mkdir(parents=True, exist_ok=True)
    joblib.dump(
        {"model": model, "classes": classes, "features": FEATURE_NAMES, "version": f"fault-hgb-{last:%Y.%m.%d}"},
        MODEL_FILE,
    )
    report["model_version"] = f"fault-hgb-{last:%Y.%m.%d}"
    REPORT_FILE.parent.mkdir(parents=True, exist_ok=True)
    REPORT_FILE.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({k: report[k] for k in report if k != "features"}, indent=2))


if __name__ == "__main__":
    main()
