import json
from pathlib import Path

from backend.scoring import compute_score

CHECKLIST = json.loads((Path(__file__).resolve().parents[1] / "backend" / "defaults" / "checklist_chat.json").read_text(encoding="utf-8"))

ALL_YES = {
    "c01_contact": "yes", "c02_needs": "yes", "c03_identification": "yes", "c04_consultation": 20,
    "c05_empathy": "yes", "c06_dialog": 10, "c07_closing": "yes", "c08_gross": "no",
}


def test_perfect_score_is_100():
    s = compute_score(CHECKLIST, ALL_YES)
    assert s["total"] == 100.0
    assert s["gross_error"] is False


def test_na_redistribution_and_half_up_rounding():
    # 03 = N/A, 04 = 15/20, 06 = 7/10 -> 70.5 / 80 * 100 = 88.125 -> 88.13 (half-up)
    a = dict(ALL_YES, c03_identification="na", c04_consultation=15, c06_dialog=7)
    s = compute_score(CHECKLIST, a)
    assert s["total"] == 88.13
    assert s["applicable_weight"] == 80.0
    assert s["criteria"]["c03_identification"]["applicable"] is False
    # effective weight of 01 = 10 * 100 / 80 = 12.5
    assert s["criteria"]["c01_contact"]["effective_weight"] == 12.5


def test_all_no():
    a = {k: ("no" if isinstance(v, str) else 0) for k, v in ALL_YES.items()}
    assert compute_score(CHECKLIST, a)["total"] == 0.0


def test_gross_error_is_separate_from_points():
    s = compute_score(CHECKLIST, dict(ALL_YES, c08_gross="yes"))
    assert s["total"] == 100.0
    assert s["gross_error"] is True
    assert s["gross_error_criteria"] == ["c08_gross"]


def test_client_left_case():
    # p1-ru-025: 02, 03, 04, 07 = N/A -> applicable 01(10) + 05(15) + 06(15) = 40
    a = dict(ALL_YES, c02_needs="na", c03_identification="na", c04_consultation="na", c07_closing="na")
    s = compute_score(CHECKLIST, a)
    assert s["total"] == 100.0
    assert s["applicable_weight"] == 40.0
    a2 = dict(a, c06_dialog=4)  # 10 + 15 + 6 = 31 / 40 -> 77.5
    assert compute_score(CHECKLIST, a2)["total"] == 77.5


def test_nothing_applicable_total_not_calculated():
    cl = {"criteria": [
        {"id": "a", "type": "binary", "weight": 10, "na_allowed": True, "section": "S"},
        {"id": "g", "type": "flag", "weight": 0, "section": "G"},
    ]}
    s = compute_score(cl, {"a": "na", "g": "no"})
    assert s["total"] is None
    assert s["total_calculated"] is False


def test_sections():
    a = dict(ALL_YES, c03_identification="na", c04_consultation=10)
    s = compute_score(CHECKLIST, a)
    sec = {x["section"]: x for x in s["sections"]}
    b = sec["Безопасность и решение"]
    # only 04 applicable: eff weight 20*100/80 = 25, half earned = 12.5
    assert b["max_points"] == 25.0 and b["points"] == 12.5 and b["percent"] == 50.0
    assert sec["Грубые нарушения"]["weighted"] is False
