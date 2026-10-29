"""Features of a charge point's recent behaviour, from OCPP 1.6 status notifications.

A window is the 72 hours before a moment (a ticket opening, or now). Everything here is computed
from what the operations backend actually records; the true causes are never an input.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta

import numpy as np

ERROR_CODES = [
    "ConnectorLockFailure",
    "EVCommunicationError",
    "GroundFailure",
    "HighTemperature",
    "InternalError",
    "OtherError",
    "OverCurrentFailure",
    "PowerSwitchFailure",
    "ReaderFailure",
    "ResetFailure",
    "WeakSignal",
]
VENDORS = ["ABB", "Alpitronic", "Compleo", "Kempower", "Mennekes"]
WINDOW = timedelta(hours=72)
FEATURE_NAMES = (
    [f"n_{c}" for c in ERROR_CODES]
    + ["n_faulted", "n_unavailable", "n_events", "connectors_affected", "span_hours", "power_kw", "high_power"]
    + [f"vendor_{v}" for v in VENDORS]
    + ["firmware_minor"]
)


@dataclass(frozen=True)
class Event:
    at: datetime
    connector: int
    status: str
    error_code: str


@dataclass(frozen=True)
class ChargePoint:
    id: str
    power_kw: int
    vendor: str
    firmware: str


def firmware_minor(version: str) -> float:
    """4.2.1 -> 2.0; the minor version separates firmware generations within a vendor."""
    parts = version.split(".")
    try:
        return float(parts[1]) if len(parts) > 1 else 0.0
    except ValueError:
        return 0.0


def featurise(cp: ChargePoint, events: list[Event], until: datetime) -> np.ndarray:
    """One feature vector for the window ending at `until`."""
    since = until - WINDOW
    window = [e for e in events if since <= e.at <= until and e.error_code != "NoError"]
    counts = {c: 0 for c in ERROR_CODES}
    for e in window:
        if e.error_code in counts:
            counts[e.error_code] += 1
    span = (max(e.at for e in window) - min(e.at for e in window)).total_seconds() / 3600 if len(window) > 1 else 0.0
    row = [float(counts[c]) for c in ERROR_CODES]
    row += [
        float(sum(e.status == "Faulted" for e in window)),
        float(sum(e.status == "Unavailable" for e in window)),
        float(len(window)),
        float(len({e.connector for e in window})),
        span,
        float(cp.power_kw),
        1.0 if cp.power_kw >= 150 else 0.0,
    ]
    row += [1.0 if cp.vendor == v else 0.0 for v in VENDORS]
    row += [firmware_minor(cp.firmware)]
    return np.asarray(row, dtype=np.float64)


def evidence(events: list[Event], until: datetime, top: int = 3) -> list[str]:
    """What a person reads first: the most frequent error codes in the window."""
    since = until - WINDOW
    counts: dict[str, int] = {}
    for e in events:
        if since <= e.at <= until and e.error_code != "NoError":
            counts[e.error_code] = counts.get(e.error_code, 0) + 1
    ranked = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))[:top]
    return [f"{code} x{n} in 72h" for code, n in ranked]
