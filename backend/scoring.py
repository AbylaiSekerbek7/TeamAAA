"""Deterministic score engine.

The LLM never computes points. It only returns a verdict per criterion
("yes" / "no" / "na" or a scale step). Everything below follows the
"Порядок расчёта" section of the checklist:

1. N/A only where allowed (validated in evaluator / appeals).
2. "Да" gives the full weight, "Нет" gives zero, scale steps give value / max.
3. Scale scores are converted to points proportionally to the weight
   (top step = full weight).
4. N/A criteria are excluded and their weight is redistributed
   proportionally between applicable criteria, so the maximum stays 100.
5. Total is rounded to two decimals (half-up). If no weighted criterion is
   applicable the total is not calculated. Gross errors are flagged separately.
"""
from __future__ import annotations

from decimal import Decimal, ROUND_HALF_UP
from typing import Any

HUNDRED = Decimal(100)
CENT = Decimal("0.01")


def q2(value: Decimal) -> Decimal:
    return value.quantize(CENT, rounding=ROUND_HALF_UP)


def to_float(value: Decimal | None) -> float | None:
    return None if value is None else float(q2(value))


def scale_max(criterion: dict) -> Decimal:
    values = [Decimal(str(s["value"])) for s in criterion.get("scale", [])]
    return max(values) if values else Decimal(1)


def answer_fraction(criterion: dict, answer: Any) -> Decimal | None:
    """Return share of the weight earned, or None for N/A / missing answer."""
    if answer is None:
        return None
    if isinstance(answer, str):
        a = answer.strip().lower()
        if a in ("na", "n/a"):
            return None
    ctype = criterion.get("type")
    if ctype == "binary":
        return Decimal(1) if str(answer).lower() == "yes" else Decimal(0)
    if ctype == "scale":
        top = scale_max(criterion)
        if top == 0:
            return Decimal(0)
        return Decimal(str(answer)) / top
    return None


def is_weighted(criterion: dict) -> bool:
    return criterion.get("type") in ("binary", "scale") and Decimal(str(criterion.get("weight", 0))) > 0


def compute_score(checklist: dict, answers: dict[str, Any]) -> dict:
    """answers: {criterion_id: "yes"|"no"|"na"|int}. Returns a JSON-able dict."""
    criteria = [c for c in checklist.get("criteria", []) if c.get("enabled", True)]

    applicable: list[tuple[dict, Decimal, Decimal]] = []  # (criterion, weight, fraction)
    rows: dict[str, dict] = {}
    gross_flags: list[str] = []
    missing: list[str] = []  # criteria without any verdict (e.g. the model failed) — not the same as N/A

    for c in criteria:
        cid = c["id"]
        ans = answers.get(cid)
        weight = Decimal(str(c.get("weight", 0)))
        row = {
            "criterion_id": cid,
            "answer": ans,
            "weight": float(weight),
            "applicable": False,
            "effective_weight": None,
            "points": None,
            "fraction": None,
        }
        if c.get("type") == "flag":
            if ans is None:
                missing.append(cid)
            elif str(ans).lower() == "yes":
                gross_flags.append(cid)
            rows[cid] = row
            continue
        if not is_weighted(c):
            rows[cid] = row
            continue
        if ans is None:
            missing.append(cid)
            rows[cid] = row
            continue
        frac = answer_fraction(c, ans)
        if frac is not None:
            applicable.append((c, weight, frac))
            row["applicable"] = True
            row["fraction"] = float(frac)
        rows[cid] = row

    total_weight = sum((w for _, w, _ in applicable), Decimal(0))
    total: Decimal | None = None
    earned_raw = Decimal(0)
    if total_weight > 0 and not missing:
        for c, w, frac in applicable:
            eff = w * HUNDRED / total_weight
            pts = eff * frac
            earned_raw += w * frac
            rows[c["id"]]["effective_weight"] = to_float(eff)
            rows[c["id"]]["points"] = to_float(pts)
        total = q2(earned_raw * HUNDRED / total_weight)

    # Sections (in checklist order)
    sections: list[dict] = []
    seen: dict[str, dict] = {}
    for c in criteria:
        name = c.get("section") or "Без секции"
        if name not in seen:
            seen[name] = {"section": name, "criteria": [], "_max": Decimal(0), "_pts": Decimal(0), "applicable": 0}
            sections.append(seen[name])
        sec = seen[name]
        sec["criteria"].append(c["id"])
        r = rows[c["id"]]
        if r["applicable"] and total_weight > 0 and not missing:
            w = Decimal(str(c.get("weight", 0)))
            eff = w * HUNDRED / total_weight
            sec["_max"] += eff
            sec["_pts"] += eff * Decimal(str(r["fraction"]))
            sec["applicable"] += 1
    out_sections = []
    for sec in sections:
        has_weighted = any(is_weighted(c) for c in criteria if c["id"] in sec["criteria"])
        mx, pts = sec.pop("_max"), sec.pop("_pts")
        sec["max_points"] = to_float(mx) if sec["applicable"] else None
        sec["points"] = to_float(pts) if sec["applicable"] else None
        sec["percent"] = to_float(pts * HUNDRED / mx) if sec["applicable"] and mx > 0 else None
        sec["weighted"] = has_weighted
        out_sections.append(sec)

    return {
        "total": None if total is None else float(total),
        "total_calculated": total is not None,
        "missing": missing,
        "applicable_weight": float(total_weight),
        "gross_error": bool(gross_flags),
        "gross_error_criteria": gross_flags,
        "criteria": rows,
        "sections": out_sections,
    }
