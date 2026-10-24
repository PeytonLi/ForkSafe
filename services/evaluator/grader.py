from __future__ import annotations

from math import inf
from typing import Any


def rank(entries: list[dict[str, Any]]) -> list[dict[str, Any]]:
    ranked = []
    for entry in entries:
        result = dict(entry)
        reasons = list(result.get("reasons", []))
        eligible = bool(result.get("allRequiredPassed", False))
        if not eligible and not reasons:
            reasons.append("one or more required cases did not pass")
        result["eligible"] = eligible
        result["reasons"] = reasons
        result["changedFunctionCount"] = len(result.get("changedFunctions", []))
        ranked.append(result)
    ranked.sort(
        key=lambda entry: (
            not entry["eligible"],
            entry["changedFunctionCount"],
            entry.get("medianCompletionTimeSec")
            if entry.get("medianCompletionTimeSec") is not None
            else inf,
            str(entry.get("candidateId", "")),
        )
    )
    return ranked
