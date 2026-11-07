"""Deterministic auto-checks that can confirm or correct the LLM for fully formal criteria.

A criterion opts in with  "auto_check": {"type": "...", "signature": "..."}.
The check runs only while the criterion wording is unchanged (signature of yes/na rules
matches), so an edited or replaced criterion is always judged by the LLM alone.
"""
from __future__ import annotations

import hashlib

AUTO_CHECKS = {
    "contact_greeting_name": "Приветствие + имя + язык клиента в первой реплике оператора",
    "closing_farewell": "Нет прощания в последней реплике оператора / обрыв чата (при наличии прощания решает модель)",
}


def signature(c: dict) -> str:
    text = "|".join([c.get("type", ""), c.get("yes_rule", ""), c.get("na_rule", ""), str(bool(c.get("na_allowed")))])
    return hashlib.sha1(text.encode("utf-8")).hexdigest()[:10]


def is_active(c: dict) -> bool:
    ac = c.get("auto_check") or {}
    return ac.get("type") in AUTO_CHECKS and ac.get("signature") == signature(c)


def run(c: dict, facts: dict) -> dict | None:
    """Return {"answer", "explanation", "evidence_ids", "strength"} or None if not decisive."""
    if not is_active(c):
        return None
    kind = c["auto_check"]["type"]
    if kind == "contact_greeting_name":
        fo = facts.get("first_operator_message_id")
        ch = facts.get("first_operator_checks") or {}
        if fo is None:
            return None
        same_lang = ch.get("language") == facts.get("client_language")
        if ch.get("greeting") and ch.get("name") and same_lang:
            return {"answer": "yes", "evidence_ids": [fo], "strength": "strong",
                    "explanation": f"{c['title']} — Да. В первой реплике оператора [{fo}] есть приветствие («{ch['greeting']}») "
                                   f"и имя («{ch['name']}») на языке клиента."}
        return None  # a missed keyword is not proof of absence: leave the verdict to the LLM
    if kind == "closing_farewell":
        lo = facts.get("last_operator_message_id")
        if lo is None:
            return None
        fw = (facts.get("last_operator_checks") or {}).get("farewell")
        end = facts.get("ending") or {}
        after = facts.get("client_messages_after_last_operator") or []
        if fw:
            # A farewell alone is not enough (checklist: summary OR offer of help AND farewell) —
            # whether the closing contains a summary/offer is a semantic judgement left to the LLM.
            return None
        if end.get("event") == "operator_closed":
            return {"answer": "no", "evidence_ids": [lo, end["message_id"]], "strength": "strong",
                    "explanation": f"{c['title']} — Нет. Оператор закрыл чат [{end['message_id']}] без прощания; "
                                   f"основание — последняя реплика оператора [{lo}] и сообщение о закрытии чата."}
        if end.get("event") in ("client_left", "connection_lost") and end.get("message_id", -1) > lo and c.get("na_allowed"):
            return {"answer": "na", "evidence_ids": [end["message_id"]], "strength": "strong",
                    "explanation": f"{c['title']} — N/A. Диалог оборвался ([{end['message_id']}] {end.get('label', '')}) "
                                   f"до того, как оператор мог его завершить."}
        if not end and after:
            return {"answer": "no", "evidence_ids": [lo, after[-1]], "strength": "strong",
                    "explanation": f"{c['title']} — Нет. Оператор не ответил на последнюю реплику клиента [{after[-1]}] и не попрощался."}
        if not end and not after:
            return {"answer": "no", "evidence_ids": [lo], "strength": "strong",
                    "explanation": f"{c['title']} — Нет. Последняя реплика оператора [{lo}] не содержит прощания."}
        return None
    return None
