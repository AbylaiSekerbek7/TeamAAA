"""Export evaluations in the organisers' submission format (JSON 1.0, appendix "Как сдать результаты").

results/<dev|prod>/results.json:
{"schema_version": "1.0", "team_name": ..., "model": {"mode": "local", "name": ...},
 "results": [{"conversation_id", "status": "ok"|"error", "criteria": [{"criterion_id", "value", "rationale",
 "evidence_turns"}], "score": {"final_score", "critical_flag"} | null, "error"?}]}

Values: true = Да, false = Нет, null = N/A, numbers = scale step before weighting.
evidence_turns are 1-based indices into the ORIGINAL transcript array (our message ids are 0-based indices).
The exported verdicts are the system's own (AI + rule) answers, not reviewer overrides.
"""
from __future__ import annotations

import re
from typing import Any

from . import db
from .scoring import compute_score

SCHEMA_VERSION = "1.0"
CRITERIA_ORDER = ["contact", "discovery", "identification", "consultation", "empathy", "dialogue", "closure", "critical"]
BY_ID = {
    "c01_contact": "contact", "c02_needs": "discovery", "c03_identification": "identification",
    "c04_consultation": "consultation", "c05_empathy": "empathy", "c06_dialog": "dialogue",
    "c07_closing": "closure", "c08_gross": "critical",
}
BY_CODE = {"01": "contact", "02": "discovery", "03": "identification", "04": "consultation",
           "05": "empathy", "06": "dialogue", "07": "closure", "08": "critical"}
ALLOWED = {
    "contact": {True, False}, "discovery": {True, False, None}, "identification": {True, False, None},
    "consultation": {0, 5, 10, 15, 20, None}, "empathy": {True, False}, "dialogue": {0, 4, 7, 10},
    "closure": {True, False, None}, "critical": {True, False},
}


def to_value(answer: Any) -> Any:
    if answer == "yes":
        return True
    if answer == "no":
        return False
    if answer == "na":
        return None
    if isinstance(answer, (int, float)):
        return int(answer) if float(answer).is_integer() else answer
    return answer


TURN_REF = re.compile(r"\[(\d+)\]")


def one_based_refs(text: str, transcript_len: int) -> str:
    """Rationales cite messages as [n] with 0-based ids; the submission numbers turns from 1."""
    return TURN_REF.sub(lambda m: f"[{int(m.group(1)) + 1}]" if int(m.group(1)) < transcript_len else m.group(0), text)


def _error(cid: str, reason: str) -> dict:
    return {"conversation_id": cid, "status": "error", "criteria": [], "score": None, "error": reason}


def _record(conv_id: str, ev: dict | None, transcript_len: int) -> dict:
    if ev is None:
        return _error(conv_id, "Диалог не оценён системой.")
    if ev.get("status") != "done" or not ev.get("result"):
        return _error(conv_id, ev.get("error") or f"Оценка не завершена (статус: {ev.get('status')}).")
    cl = db.get_checklist(ev["checklist_id"])["data"]
    res = ev["result"]["criteria"]
    out, answers = [], {}
    for c in cl["criteria"]:
        if not c.get("enabled", True):
            continue
        code = BY_ID.get(c["id"]) or BY_CODE.get(str(c.get("code", "")).zfill(2))
        if code is None:
            continue
        r = res.get(c["id"]) or {}
        if r.get("answer") is None:
            return _error(conv_id, f"Модель не смогла оценить критерий «{c['title']}».")
        answers[c["id"]] = r["answer"]
        turns = sorted({int(i) + 1 for i in (r.get("evidence_ids") or []) if 0 <= int(i) < transcript_len})
        out.append({
            "criterion_id": code,
            "value": to_value(r["answer"]),
            "rationale": one_based_refs((r.get("explanation") or "").strip(), transcript_len) or "Обоснование не сформировано.",
            "evidence_turns": turns,
        })
    out.sort(key=lambda x: CRITERIA_ORDER.index(x["criterion_id"]))
    score = compute_score(cl, answers)  # AI verdicts only (reviewer overrides are not part of the submission)
    critical = next((x["value"] for x in out if x["criterion_id"] == "critical"), False)
    return {
        "conversation_id": conv_id,
        "status": "ok",
        "criteria": out,
        "score": {"final_score": score["total"], "critical_flag": bool(critical)},
    }


def build(dataset: str, team_name: str, model_name: str, mode: str = "local") -> dict:
    convs = [c for c in db.list_conversations() if c["dataset"] == dataset]
    results = []
    for c in convs:
        ev = db.latest_done_evaluation(c["id"])
        if ev is None:
            last = db.list_evaluations(c["id"])
            ev = db.get_evaluation(last[0]["id"]) if last else None
        results.append(_record(c["id"], ev, c["n_messages"] or 0))
    return {"schema_version": SCHEMA_VERSION, "team_name": team_name,
            "model": {"mode": mode, "name": model_name}, "results": results}


def validate(payload: dict, expected_ids: list[str] | None = None) -> list[str]:
    """Return a list of problems (empty = valid)."""
    errs: list[str] = []
    if payload.get("schema_version") != SCHEMA_VERSION:
        errs.append("schema_version должен быть \"1.0\"")
    if not payload.get("team_name"):
        errs.append("пустой team_name")
    m = payload.get("model") or {}
    if m.get("mode") not in ("local", "external_api", "hybrid") or not m.get("name"):
        errs.append("model.mode/name заполнены неверно")
    ids = [r.get("conversation_id") for r in payload.get("results", [])]
    if len(ids) != len(set(ids)):
        errs.append("есть повторяющиеся conversation_id")
    if expected_ids is not None and sorted(ids) != sorted(expected_ids):
        missing = set(expected_ids) - set(ids)
        extra = set(ids) - set(expected_ids)
        errs.append(f"ID не совпадают с API: нет {sorted(missing)[:5]}, лишние {sorted(extra)[:5]}")
    for r in payload.get("results", []):
        cid = r.get("conversation_id")
        if r.get("status") == "error":
            if r.get("criteria") != [] or r.get("score") is not None or not r.get("error"):
                errs.append(f"{cid}: запись с ошибкой должна иметь criteria=[], score=null и error")
            continue
        if r.get("status") != "ok":
            errs.append(f"{cid}: status должен быть ok или error")
            continue
        crit = r.get("criteria") or []
        codes = [x.get("criterion_id") for x in crit]
        if sorted(codes) != sorted(CRITERIA_ORDER):
            errs.append(f"{cid}: нужны все 8 критериев ровно по одному разу, есть {codes}")
        for x in crit:
            v = x.get("value")
            allowed = ALLOWED.get(x.get("criterion_id"), set())
            if isinstance(v, bool) or v is None:
                ok = v in allowed and (v is None or any(isinstance(a, bool) for a in allowed))
            else:
                ok = v in {a for a in allowed if not isinstance(a, bool) and a is not None}
            if not ok:
                errs.append(f"{cid}: недопустимое value {v!r} для {x.get('criterion_id')}")
            if not isinstance(x.get("evidence_turns"), list) or not all(isinstance(t, int) and t >= 1 for t in x["evidence_turns"]):
                errs.append(f"{cid}: evidence_turns должны быть целыми ≥ 1")
            if not isinstance(x.get("rationale"), str) or not x["rationale"].strip():
                errs.append(f"{cid}: пустой rationale у {x.get('criterion_id')}")
        sc = r.get("score") or {}
        fs = sc.get("final_score")
        if fs is not None and not (0 <= fs <= 100 and round(fs, 2) == fs):
            errs.append(f"{cid}: final_score вне 0..100 или не округлён до 2 знаков")
        crit_v = next((x.get("value") for x in crit if x.get("criterion_id") == "critical"), None)
        if sc.get("critical_flag") != crit_v:
            errs.append(f"{cid}: critical_flag не совпадает с value критерия critical")
    return errs
