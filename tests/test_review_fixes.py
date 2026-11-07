"""Regression tests for issues found in code review."""
import json
from pathlib import Path

import pytest

from backend import evaluator, preprocess
from backend.scoring import compute_score

ROOT = Path(__file__).resolve().parents[1]
CHAT = json.loads((ROOT / "backend" / "defaults" / "checklist_chat.json").read_text(encoding="utf-8"))
ALL_YES = {"c01_contact": "yes", "c02_needs": "yes", "c03_identification": "yes", "c04_consultation": 20,
           "c05_empathy": "yes", "c06_dialog": 10, "c07_closing": "yes", "c08_gross": "no"}


def test_failed_criterion_is_not_treated_as_na():
    s = compute_score(CHAT, dict(ALL_YES, c04_consultation=None))
    assert s["total"] is None and s["total_calculated"] is False
    assert s["missing"] == ["c04_consultation"]


def test_fractional_scale_steps_are_kept():
    c = {"id": "x", "type": "scale", "na_allowed": False, "scale": [{"value": 1}, {"value": 0.5}, {"value": 0}]}
    assert evaluator.normalize_answer(c, "0.5") == 0.5
    assert evaluator.normalize_answer(c, "1") == 1
    assert evaluator.normalize_answer(c, "0.7") is None
    c4 = next(x for x in CHAT["criteria"] if x["id"] == "c04_consultation")
    assert evaluator.normalize_answer(c4, "15") == 15
    assert evaluator.normalize_answer(c4, "na") == "na"


def test_vote_tie_break_picks_a_leader():
    c = {"id": "x", "type": "binary", "na_allowed": True}
    runs = [{"answer": a} for a in ["yes", "no", "no", "na", "na"]]
    assert evaluator._vote(c, runs)["answer"] in ("no", "na")


def test_pronoun_is_not_a_name():
    assert preprocess.find_name("Здравствуйте! Я Вас внимательно слушаю.") is None
    assert preprocess.find_name("Здравствуйте! Я Вас слушаю, меня зовут Алина.") == "Алина"


def test_russian_text_with_kazakh_name_stays_russian():
    assert preprocess.detect_lang("Здравствуйте! Меня зовут Айгүл, чем могу помочь?") == "RU"
    assert preprocess.detect_lang("Сәлеметсіз бе, мен Айбекпін.") == "KZ"
    assert preprocess.detect_lang("Иә, қосыңызшы") == "KZ"


def test_hold_is_not_an_operator_gap():
    r = {"conversation_id": "t", "channel": "voice call", "language": "RU", "transcript": [
        {"timestamp": "2026-11-03T13:00:00+00:00", "speaker": "operator", "text": "Здравствуйте, меня зовут Ира"},
        {"timestamp": "2026-11-03T13:00:10+00:00", "speaker": "client", "text": "Хорошо"},
        {"timestamp": "2026-11-03T13:00:12+00:00", "speaker": "system", "text": "Клиент находится на удержании."},
        {"timestamp": "2026-11-03T13:06:00+00:00", "speaker": "system", "text": "Клиент больше не находится на удержании."},
        {"timestamp": "2026-11-03T13:06:05+00:00", "speaker": "operator", "text": "Спасибо за ожидание"},
    ]}
    f = preprocess.compute_facts(r, preprocess.normalize(r))
    assert f["long_operator_gaps"] == []


@pytest.fixture()
def temp_db(tmp_path, monkeypatch):
    from backend import db
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "t.db")
    monkeypatch.setattr(db, "_con", None)
    db.init()
    yield db
    if db._con is not None:
        db._con.close()


def test_jobs_submit_smoke(temp_db, monkeypatch):
    from backend import jobs
    monkeypatch.setattr(jobs, "_ensure_worker", lambda: None)
    temp_db.upsert_conversation({"conversation_id": "c1", "channel": "agent chat", "language": "RU",
                                 "transcript": [{"timestamp": "00:00", "speaker": "client", "text": "привет"}]}, "T", "test")
    cl = temp_db.checklist_for_channel("agent chat")
    job = jobs.submit([("c1", cl["id"])], dict(temp_db.DEFAULT_SETTINGS))
    assert job["total"] == 1 and job["items"][0]["status"] == "queued"


def test_auto_mode_has_no_cross_channel_fallback(temp_db):
    call = temp_db.checklist_for_channel("voice call")
    temp_db.deactivate_checklist_key(call["key"])
    assert temp_db.checklist_for_channel("voice call") is None
    assert temp_db.checklist_for_channel("agent chat") is not None


def test_appeal_decision_records_total_at_decision_time(temp_db):
    from backend import app as appmod
    temp_db.upsert_conversation({"conversation_id": "c1", "channel": "agent chat", "language": "RU",
                                 "transcript": [{"timestamp": "00:00", "speaker": "client", "text": "q"}]}, "T", "test")
    cl = temp_db.checklist_for_channel("agent chat")
    eid = temp_db.create_evaluation("c1", cl["id"], "j", "m")
    answers = dict(ALL_YES, c01_contact="no", c07_closing="no")
    score = compute_score(cl["data"], answers)
    result = {"criteria": {k: {"answer": v, "explanation": "", "evidence_ids": []} for k, v in answers.items()}, "score": score}
    temp_db.update_evaluation(eid, status="done", result_json=result, total=score["total"], final_total=score["total"],
                              gross_error=0, final_gross_error=0)
    a = appmod.create_appeal({"evaluation_id": eid, "criterion_id": "c01_contact", "comment": "x"})
    b = appmod.create_appeal({"evaluation_id": eid, "criterion_id": "c07_closing", "comment": "y"})
    r1 = appmod.decide(a["id"], {"decision": "change", "new_answer": "yes", "reason": "r"})
    r2 = appmod.decide(b["id"], {"decision": "change", "new_answer": "yes", "reason": "r"})
    assert r1["total_before"] == score["total"] and r1["final_total"] == 95.0
    assert r2["total_before"] == 95.0 and r2["final_total"] == 100.0
    ev = temp_db.get_evaluation(eid)
    assert set(ev["final"]["overrides"]) == {"c01_contact", "c07_closing"}
