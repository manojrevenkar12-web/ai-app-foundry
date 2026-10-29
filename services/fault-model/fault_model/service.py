"""HTTP service: GET /diagnose/{id} ranks likely causes for one charge point.

    uv run uvicorn fault_model.service:app --port 8090

The platform calls it only after checking that the person asking may see the charge point.
"""

from __future__ import annotations

import os
from datetime import UTC, datetime

import joblib
import numpy as np
from fastapi import FastAPI, HTTPException

from .features import evidence, featurise

MODEL_FILE = os.environ.get("MODEL_FILE", os.path.join(os.path.dirname(__file__), "..", "model", "fault-model.joblib"))


def create_app(load=None, model_file: str = MODEL_FILE, now=lambda: datetime.now(UTC)) -> FastAPI:
    """`load(cp_id)` returns (ChargePoint | None, events); injectable for tests."""
    bundle = joblib.load(model_file)
    model, classes, version = bundle["model"], bundle["classes"], bundle["version"]
    if load is None:
        from .data import connect, load_one

        conn = connect()

        def load(cp_id: str):
            return load_one(conn, cp_id)

    app = FastAPI(title="fault-model", version=version)

    @app.get("/healthz")
    def health() -> dict:
        return {"status": "ok", "model": version}

    @app.get("/diagnose/{cp_id}")
    def diagnose(cp_id: str) -> dict:
        cp, events = load(cp_id)
        if cp is None:
            raise HTTPException(404, "no such charge point")
        until = now()
        x = featurise(cp, events, until).reshape(1, -1)
        p = model.predict_proba(x)[0]
        order = np.argsort(-p)[:3]
        recent = evidence(events, until)
        return {
            "id": cp_id,
            "causes": [{"cause": classes[i], "probability": round(float(p[i]), 3)} for i in order],
            "evidence": recent or ["no error notifications in the last 72 hours"],
            "modelVersion": version,
            "note": "ranked causes are a starting point for the technician, not a diagnosis",
        }

    return app


app = create_app() if os.environ.get("FAULT_MODEL_AUTOSTART", "1") == "1" and os.path.exists(MODEL_FILE) else None
