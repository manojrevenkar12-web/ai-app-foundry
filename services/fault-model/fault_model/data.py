"""Reads the operations data. The service connects as foundry_ml: read-only, every country."""

from __future__ import annotations

import os
from collections import defaultdict
from datetime import datetime

import psycopg

from .features import ChargePoint, Event

DEFAULT_URL = "postgresql://foundry_ml:foundry_ml@127.0.0.1:5432/foundry"


def connect(url: str | None = None) -> psycopg.Connection:
    return psycopg.connect(url or os.environ.get("ML_DATABASE_URL", DEFAULT_URL), autocommit=True)


def load_training(
    conn: psycopg.Connection,
) -> tuple[dict[str, ChargePoint], dict[str, list[Event]], list[tuple[str, str, datetime, str]]]:
    """Charge points, their error events, and closed tickets with the cause the technician recorded."""
    cps = {
        r[0]: ChargePoint(r[0], r[1], r[2], r[3])
        for r in conn.execute("select id, power_kw, vendor, firmware from ev.chargepoints").fetchall()
    }
    events: dict[str, list[Event]] = defaultdict(list)
    for cp_id, at, connector, status, code in conn.execute(
        "select cp_id, at, connector, status, error_code from ev.status_events "
        "where error_code <> 'NoError' order by at"
    ):
        events[cp_id].append(Event(at, connector, status, code))
    tickets = [
        (r[0], r[1], r[2], r[3])
        for r in conn.execute(
            "select id, cp_id, opened, resolution_cause from ev.tickets "
            "where status = 'closed' and resolution_cause is not null order by opened"
        )
    ]
    return cps, events, tickets


def load_one(conn: psycopg.Connection, cp_id: str) -> tuple[ChargePoint | None, list[Event]]:
    row = conn.execute("select id, power_kw, vendor, firmware from ev.chargepoints where id = %s", (cp_id,)).fetchone()
    if not row:
        return None, []
    events = [
        Event(r[0], r[1], r[2], r[3])
        for r in conn.execute(
            "select at, connector, status, error_code from ev.status_events "
            "where cp_id = %s and error_code <> 'NoError' order by at",
            (cp_id,),
        )
    ]
    return ChargePoint(row[0], row[1], row[2], row[3]), events
