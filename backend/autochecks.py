"""Deterministic auto-checks that can confirm or correct the LLM for fully formal criteria.

A criterion opts in with  "auto_check": {"type": "...", "signature": "..."}.
The check runs only while the criterion wording is unchanged (signature of yes/na rules
matches), so an edited or replaced criterion is always judged by the LLM alone.
"""
from __future__ import annotations

import hashlib
import re

from .preprocess import FAREWELLS

# Courtesy formulas that are NOT a summary or an offer of help (RU / KZ / EN).
COURTESY_PATTERNS = [
    r"пожалуйста", r"рад[аы]?\s+(?:был[аи]?\s+)?(?:вам\s+)?помочь", r"рад[аы]?,?\s+что\s+(?:смог(?:ла|ли)?\s+)?помочь",
    r"всегда\s+рады?\s+помочь", r"обращайтесь", r"отлично", r"хорошо", r"супер", r"замечательно", r"понял[аи]?", r"ясно",
    r"спасибо,?\s+что\s+(?:обратились|подождали|дождались|выбрали\s+нас)(?:\s+к\s+нам)?",
    r"спасибо(?:\s+(?:вам\s+)?за\s+(?:обращение|ожидание|звонок|время|понимание|терпение|вопрос))?",
    r"благодарю\s+(?:вас\s+)?за\s+(?:обращение|ожидание|звонок|уделенное\s+время|уделённое\s+время|время|понимание)",
    r"благодар\w*",
    r"не\s+за\s+что", r"всего\s+хорошего", r"всего\s+доброго", r"удачи",
    r"оқасы\s+жоқ", r"көмегім\s+тигеніне\s+қуаныштымын", r"рақмет\w*", r"жақсы", r"жарайды", r"әрине",
    r"you(?:'|’)re\s+welcome", r"happy\s+to\s+help", r"glad\s+(?:i\s+could\s+help|to\s+help|you\s+got\s+in|it\s+worked|that\s+helped)",
    r"thanks?\s+(?:you\s+)?(?:for\s+(?:reaching\s+out|contacting\s+us|your\s+patience|waiting))?", r"great", r"of\s+course",
    r"no\s+problem", r"sure", r"perfect", r"you\s+too", r"and",
]


BYPASS_RE = re.compile(
    r"личн\w*\s+(?:номер|телефон)|(?:мне|на\s+мою|на\s+мой)\s+(?:лично\s+)?(?:на\s+)?карт|скиньте\s+(?:мне\s+)?деньги|"
    r"переведите\s+(?:мне|деньги\s+мне)|в\s+частном\s+порядке|частн\w+\s+консультац|за\s+(?:отдельную\s+)?плату|"
    r"(?:моя|моей)\s+(?:частн\w+|личн\w+)\s+консультац|"
    r"жеке\s+нөмір|ақылы\s+(?:түрде|кеңес)|маған\s+(?:ақша|аударыңыз)|менің\s+карт|"
    r"personal\s+(?:phone\s+)?number|send\s+(?:me\s+)?(?:the\s+)?money|to\s+my\s+(?:card|account)|i\s+charge|private\s+(?:paid\s+)?advice|paid\s+advice",
    re.I)


def strip_courtesy(text: str) -> str:
    """Remove farewells and courtesy formulas, leaving only substantive content."""
    low = " " + (text or "").lower() + " "
    for f in sorted(FAREWELLS, key=len, reverse=True):
        low = re.sub(rf"(?<![\wа-яёәғқңөұүһі]){re.escape(f)}\w*(?:\s+(?:дня|вечера|day|evening|өтсін))?", " ", low)
    for p in COURTESY_PATTERNS:
        low = re.sub(rf"(?<![\wа-яёәғқңөұүһі]){p}(?![а-яёәғқңөұүһі\w])", " ", low)
    return re.sub(r"[\s,.!?;:—–-]+", " ", low).strip()

AUTO_CHECKS = {
    "gross_violation": "Предложение услуг в обход компании по устойчивым фразам; раскрытие данных до идентификации (связь с критерием идентификации)",
    "contact_greeting_name": "Приветствие + имя + язык клиента в первой реплике оператора",
    "closing_farewell": "Нет прощания в последней реплике оператора / обрыв чата (при наличии прощания решает модель)",
    "identification_disclosure": "Ответ «Нет» проверяется: модель указывает реплику с данными счёта до подтверждения личности",
}


def signature(c: dict) -> str:
    text = "|".join([c.get("type", ""), c.get("yes_rule", ""), c.get("na_rule", ""), str(bool(c.get("na_allowed")))])
    return hashlib.sha1(text.encode("utf-8")).hexdigest()[:10]


def is_active(c: dict) -> bool:
    ac = c.get("auto_check") or {}
    return ac.get("type") in AUTO_CHECKS and ac.get("signature") == signature(c)


def reconcile(checklist: dict, results: dict) -> list[str]:
    """Cross-criterion consistency after evaluation: account data disclosed before identification
    (identification = «Нет») is also a disclosure of confidential information (gross error = «Да»)."""
    changed = []
    for c in checklist.get("criteria", []):
        if not is_active(c) or c["auto_check"].get("type") != "gross_violation":
            continue
        src = c["auto_check"].get("disclosure_from")
        r, s = results.get(c["id"]), results.get(src) if src else None
        if not r or not s or r.get("answer") == "yes" or s.get("answer") != "no":
            continue
        ident = next((x for x in checklist["criteria"] if x["id"] == src), {})
        r.update({
            "llm_answer": r.get("answer"), "answer": "yes", "source": "rule",
            "evidence_ids": s.get("evidence_ids") or r.get("evidence_ids") or [],
            "explanation": f"{c['title']} — Да. Раскрытие конфиденциальной информации: данные счёта сообщены без подтверждённой "
                           f"идентификации (см. критерий «{ident.get('title', src)}» — Нет). {s.get('explanation', '')}".strip(),
        })
        changed.append(c["id"])
    return changed


def run(c: dict, facts: dict) -> dict | None:
    """Return {"answer", "explanation", "evidence_ids", "strength"} or None if not decisive."""
    if not is_active(c):
        return None
    kind = c["auto_check"]["type"]
    if kind == "gross_violation":
        for m in facts.get("operator_messages") or []:
            hit = BYPASS_RE.search(m["text"])
            if hit:
                return {"answer": "yes", "evidence_ids": [m["id"]], "strength": "strong",
                        "explanation": f"{c['title']} — Да. Оператор предлагает услугу в обход компании: «{m['text'].strip()[:160]}» [{m['id']}]. "
                                       f"Достаточно самого предложения, согласие клиента не требуется."}
        return None  # insults / disclosure need judgement; disclosure is also linked to identification after evaluation
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
            # Checklist: summary OR offer of further help AND farewell. Strip farewells and pleasantries from the
            # closing; nothing left -> bare farewell ("Нет"); a substantive sentence left -> summary/offer ("Да").
            closing = facts.get("closing_text") or ""
            rest = strip_courtesy(closing)
            words = [w for w in re.findall(r"[\wәғқңөұүһіё]+", rest.lower()) if len(w) > 2]
            if not words:
                return {"answer": "no", "evidence_ids": [lo], "strength": "strong",
                        "explanation": f"{c['title']} — Нет. В заключительной реплике [{lo}] только вежливая формула и прощание "
                                       f"(«{closing.strip()[:80]}») — нет ни итога, ни предложения дальнейшей помощи."}
            if len(words) >= 3:
                return {"answer": "yes", "evidence_ids": [lo], "strength": "strong",
                        "explanation": f"{c['title']} — Да. Оператор подвёл итог / обозначил дальнейший шаг и попрощался: "
                                       f"«{closing.strip()[:120]}» [{lo}]."}
            return None  # short remainder — let the LLM judge
        if end.get("event") == "operator_closed":
            return {"answer": "no", "evidence_ids": [lo, end["message_id"]], "strength": "strong",
                    "explanation": f"{c['title']} — Нет. Оператор закрыл чат [{end['message_id']}] без прощания; "
                                   f"основание — последняя реплика оператора [{lo}] и сообщение о закрытии чата."}
        if end.get("event") in ("client_left", "connection_lost") and end.get("after_last_operator", end.get("message_id", -1) > lo) and c.get("na_allowed"):
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
