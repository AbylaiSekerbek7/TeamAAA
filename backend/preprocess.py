"""Transcript normalisation and deterministic facts.

Facts computed here are passed to the LLM as hints (small local models are much
more accurate when they do not have to infer timing, roles or system events
themselves) and are also shown in the UI.
"""
from __future__ import annotations

import re
from datetime import datetime
from typing import Any

SPEAKER_LABEL = {
    "client": "КЛИЕНТ",
    "operator": "ОПЕРАТОР",
    "bot": "БОТ",
    "system": "СИСТЕМА",
}

# System event categories (RU / KZ / EN). Lower-case substring match.
SYSTEM_EVENTS: dict[str, list[str]] = {
    "escalation": [
        "эскалация на оператора", "chat transferred to an agent", "операторға жіберілді",
        "переведен от агента", "переведён от агента", "transferred to",
    ],
    "operator_joined": ["агент присоединился", "agent joined", "оператор подключился"],
    "identity_verified": [
        "личность клиента подтверждена", "customer identity verified", "жеке басы расталды",
        "identity verified", "идентификация пройдена",
    ],
    "operator_closed": ["оператор закрыл чат", "agent closed the chat", "оператор чатты жапты"],
    "client_left": [
        "клиент покинул чат", "customer left", "клиент шықты", "клиент чаттан шықты",
        "клиент завершил разговор", "customer ended",
    ],
    "connection_lost": [
        "соединение с клиентом прервано", "connection to customer lost", "байланыс үзілді",
        "связь прервана", "connection lost",
    ],
    "recording_paused": ["запись и транскрибирование приостановлены", "recording paused"],
    "recording_resumed": ["запись и транскрибирование возобновлены", "recording resumed"],
    "hold_end": ["больше не находится на удержании", "no longer on hold", "removed from hold"],
    "hold_start": ["находится на удержании", "placed on hold", "is on hold"],
    "consult_start": ["началась консультация с агентом", "инициирована консультация", "consult started"],
    "agent_left": ["агент вышел из разговора", "agent left"],
}

EVENT_LABEL_RU = {
    "escalation": "передача чата оператору",
    "operator_joined": "оператор подключился",
    "identity_verified": "личность клиента подтверждена",
    "operator_closed": "оператор закрыл чат",
    "client_left": "клиент покинул чат / завершил разговор",
    "connection_lost": "соединение с клиентом прервано",
    "recording_paused": "запись приостановлена",
    "recording_resumed": "запись возобновлена",
    "hold_start": "клиент на удержании",
    "hold_end": "клиент снят с удержания",
    "consult_start": "консультация оператора с коллегой",
    "agent_left": "коллега вышел из разговора",
}

GREETINGS = [
    "здравствуйте", "добрый день", "добрый вечер", "доброе утро", "доброго дня", "приветствую", "привет",
    "сәлеметсіз", "сәлем", "қайырлы күн", "қайырлы таң", "армысыз",
    "hello", "good morning", "good afternoon", "good evening", "hi", "hey",
]
FAREWELLS = [
    "до свидания", "всего доброго", "всего хорошего", "хорошего дня", "хорошего вечера", "удачного дня",
    "до встречи", "прощайте", "сау болыңыз", "сау бол", "күніңіз сәтті", "кешіңіз сәтті", "қош болыңыз",
    "goodbye", "good bye", "bye", "take care", "have a good", "have a nice", "have a great",
]
NAME_PATTERNS = [
    re.compile(r"(\[имя скрыто\])", re.I),
    re.compile(r"(?i:меня зовут)\s+([А-ЯЁA-Z][а-яёa-z\-]{1,20})"),
    re.compile(r"(?i:\bя)\s+[—-]?\s*([А-ЯЁ][а-яё]{1,15})\b"),
    re.compile(r"(?i:менің атым)\s+([А-ЯӘҒҚҢӨҰҮҺІ][а-яәғқңөұүһі]{1,15})"),
    re.compile(r"(?i:\bмен)\s+([А-ЯӘҒҚҢӨҰҮҺІ][а-яәғқңөұүһі]{1,15}?)(?:мын|мін|пын|пін|бын|бін)?\b"),
    re.compile(r"(?i:\b(?:i['’]m|i am|my name is|this is))\s+([A-Z][a-z]{1,15})\b"),
]
NOT_NAMES = {"понимаю", "передам", "посмотрел", "уточню", "проверю", "сейчас", "рад", "рада", "here", "sorry", "happy", "glad"}

KZ_CHARS = set("әғқңөұүһіӘҒҚҢӨҰҮҺІ")
CYR_RE = re.compile(r"[А-Яа-яЁё]")
LAT_RE = re.compile(r"[A-Za-z]")


def detect_lang(text: str) -> str | None:
    if not text:
        return None
    if any(ch in KZ_CHARS for ch in text):
        return "KZ"
    cyr = len(CYR_RE.findall(text))
    lat = len(LAT_RE.findall(text))
    if cyr == 0 and lat == 0:
        return None
    # RU/KZ replies often contain Latin UI labels and brand names; a sizeable Cyrillic share means Cyrillic text.
    return "RU" if cyr >= 0.4 * lat else "EN"


def find_keyword(text: str, words: list[str]) -> str | None:
    low = (text or "").lower()
    for w in words:
        if re.search(rf"(?<![\wа-яёәғқңөұүһі]){re.escape(w)}(?![а-яёәғқңөұүһі\w])" if len(w) <= 4 else re.escape(w), low):
            return w
    return None


def find_name(text: str) -> str | None:
    for p in NAME_PATTERNS:
        m = p.search(text or "")
        if m:
            name = m.group(1).strip()
            if name.lower() not in NOT_NAMES:
                return name
    return None


def parse_ts(raw: str) -> tuple[float | None, datetime | None]:
    """Return (seconds for MM:SS / HH:MM:SS, datetime for ISO)."""
    if raw is None:
        return None, None
    s = str(raw).strip()
    m = re.fullmatch(r"(\d{1,2}):(\d{2})(?::(\d{2}))?", s)
    if m:
        if m.group(3) is not None:
            return int(m.group(1)) * 3600 + int(m.group(2)) * 60 + int(m.group(3)), None
        return int(m.group(1)) * 60 + int(m.group(2)), None
    try:
        iso = s.replace("Z", "+00:00")
        # Python < 3.11 cannot parse 7-digit fractions; trim to 6.
        iso = re.sub(r"(\.\d{6})\d+", r"\1", iso)
        return None, datetime.fromisoformat(iso)
    except ValueError:
        return None, None


def fmt_mmss(sec: float | None) -> str:
    if sec is None:
        return "--:--"
    sec = max(0, int(round(sec)))
    h, rem = divmod(sec, 3600)
    m, s = divmod(rem, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m:02d}:{s:02d}"


def classify_system(text: str) -> str | None:
    low = (text or "").lower()
    for cat, needles in SYSTEM_EVENTS.items():
        if any(n in low for n in needles):
            return cat
    return None


def normalize(record: dict) -> dict:
    """Build message list with stable ids (= original index) and relative seconds."""
    transcript = record.get("transcript") or []
    msgs: list[dict[str, Any]] = []
    base_dt: datetime | None = None
    for i, m in enumerate(transcript):
        sec, dt = parse_ts(m.get("timestamp"))
        if dt is not None:
            if base_dt is None:
                base_dt = dt
            sec = (dt - base_dt).total_seconds()
        speaker = (m.get("speaker") or "").strip().lower()
        text = (m.get("text") or "").strip()
        msgs.append({
            "id": i,
            "speaker": speaker,
            "text": text,
            "timestamp": m.get("timestamp"),
            "t": sec,
            "t_label": fmt_mmss(sec),
            "event": classify_system(text) if speaker == "system" else None,
            "lang": detect_lang(text) if speaker in ("client", "operator") else None,
            "duplicate_of": None,
            "internal": False,
        })
    # Operator lines while the client is on hold are an internal consultation with a colleague.
    on_hold = False
    for m in msgs:
        if m["event"] == "hold_start":
            on_hold = True
        elif m["event"] == "hold_end":
            on_hold = False
        elif on_hold and m["speaker"] == "operator":
            m["internal"] = True
    # Mark consecutive duplicates (frequent in ASR voice transcripts).
    for i in range(1, len(msgs)):
        a, b = msgs[i - 1], msgs[i]
        if a["speaker"] == b["speaker"] and a["text"] and a["text"] == b["text"]:
            b["duplicate_of"] = a["duplicate_of"] if a["duplicate_of"] is not None else a["id"]
    return {"messages": msgs, "is_voice": base_dt is not None or (record.get("channel") or "").lower().startswith("voice")}


WORD_RE = re.compile(r"[\wәғқңөұүһіё]+", re.I)


def call_metrics(norm: dict) -> dict | None:
    """Speech metrics estimated from ASR timestamps (voice calls only)."""
    if not norm.get("is_voice"):
        return None
    msgs = [m for m in norm["messages"] if m["t"] is not None]
    if len(msgs) < 2:
        return None
    hold = 0.0
    hold_start = None
    for m in msgs:
        if m["event"] == "hold_start":
            hold_start = m["t"]
        elif m["event"] == "hold_end" and hold_start is not None:
            hold += m["t"] - hold_start
            hold_start = None
    spoken = [m for m in msgs if m["speaker"] in ("operator", "client") and m["duplicate_of"] is None and not m["internal"]]
    op_words = sum(len(WORD_RE.findall(m["text"])) for m in spoken if m["speaker"] == "operator")
    cl_words = sum(len(WORD_RE.findall(m["text"])) for m in spoken if m["speaker"] == "client")
    # Operator speaking time ≈ time until the next utterance, capped (timestamps mark utterance starts).
    op_time = 0.0
    for i, m in enumerate(msgs):
        if m["speaker"] != "operator" or m["internal"] or m["duplicate_of"] is not None:
            continue
        nxt = next((x["t"] for x in msgs[i + 1:] if x["t"] > m["t"]), None)
        words = len(WORD_RE.findall(m["text"]))
        est = (nxt - m["t"]) if nxt is not None else words / 2.5
        op_time += max(0.5, min(est, words / 1.2 + 2, 30))
    # Longest silence between client-facing utterances outside hold.
    longest, longest_at = 0.0, None
    in_hold = False
    prev = None
    started = False
    for m in msgs:
        if not started:
            if m["speaker"] == "operator" and not m["internal"]:
                started = True
                prev = m
            continue
        if m["event"] == "hold_start":
            in_hold = True
        elif m["event"] == "hold_end":
            in_hold = False
            prev = None
            continue
        if in_hold or m["speaker"] not in ("operator", "client") or m["internal"]:
            continue
        if prev is not None and m["t"] - prev["t"] > longest:
            longest, longest_at = m["t"] - prev["t"], m["id"]
        prev = m
    return {
        "duration_sec": int(msgs[-1]["t"] - msgs[0]["t"]),
        "hold_sec": int(hold),
        "operator_words": op_words,
        "client_words": cl_words,
        "operator_share": round(op_words / max(1, op_words + cl_words) * 100),
        "operator_wpm": round(op_words / (op_time / 60)) if op_time > 5 else None,
        "longest_silence_sec": int(longest),
        "longest_silence_before_id": longest_at,
    }


def compute_facts(record: dict, norm: dict) -> dict:
    msgs = norm["messages"]
    ops = [m for m in msgs if m["speaker"] == "operator" and m["duplicate_of"] is None and not m["internal"]]
    clients = [m for m in msgs if m["speaker"] == "client" and m["duplicate_of"] is None]
    events = [m for m in msgs if m["speaker"] == "system" and m["event"]]

    first_op = ops[0] if ops else None
    last_op = ops[-1] if ops else None
    last_msg = msgs[-1] if msgs else None

    # Client messages written before the operator joined (known details).
    pre_op_client = [m["id"] for m in clients if first_op is None or m["id"] < first_op["id"]]

    # Ending
    tail_events = []
    if last_op is not None:
        tail_events = [e for e in events if e["id"] > last_op["id"]]
    ending = None
    for e in reversed(tail_events or events[-1:]):
        if e["event"] in ("operator_closed", "client_left", "connection_lost"):
            ending = {"event": e["event"], "message_id": e["id"], "label": EVENT_LABEL_RU[e["event"]]}
            break
    client_after_last_op = [m["id"] for m in clients if last_op is not None and m["id"] > last_op["id"]]

    # Operator response gaps after the first operator reply (first reaction is excluded by the rules).
    gaps = []
    if first_op is not None:
        prev_client_t = None
        prev_client_id = None
        for m in msgs:
            if m["id"] <= first_op["id"]:
                continue
            if m["speaker"] == "client" and m["duplicate_of"] is None:
                if prev_client_t is None:
                    prev_client_t, prev_client_id = m["t"], m["id"]
            elif m["speaker"] == "operator" and m["duplicate_of"] is None and not m["internal"]:
                if prev_client_t is not None and m["t"] is not None:
                    gap = m["t"] - prev_client_t
                    if gap >= 90:
                        gaps.append({"after_client_id": prev_client_id, "operator_id": m["id"], "seconds": int(gap)})
                prev_client_t, prev_client_id = None, None

    langs = [m["lang"] for m in clients if m["lang"]]
    client_lang = record.get("language") or (max(set(langs), key=langs.count) if langs else None)
    op_lang = first_op["lang"] if first_op else None

    duration = None
    if msgs and msgs[-1]["t"] is not None and msgs[0]["t"] is not None:
        duration = msgs[-1]["t"] - msgs[0]["t"]

    first_op_checks = None
    if first_op is not None:
        first_op_checks = {
            "greeting": find_keyword(first_op["text"], GREETINGS),
            "name": find_name(first_op["text"]),
            "language": op_lang,
        }
    last_op_checks = None
    if last_op is not None:
        last_op_checks = {"farewell": find_keyword(last_op["text"], FAREWELLS)}

    return {
        "client_language": client_lang,
        "first_operator_message_id": first_op["id"] if first_op else None,
        "first_operator_checks": first_op_checks,
        "last_operator_checks": last_op_checks,
        "first_operator_language": op_lang,
        "last_operator_message_id": last_op["id"] if last_op else None,
        "operator_message_count": len(ops),
        "client_message_count": len(clients),
        "client_messages_before_operator": pre_op_client,
        "system_events": [{"message_id": e["id"], "event": e["event"], "label": EVENT_LABEL_RU[e["event"]]} for e in events],
        "identity_verified_ids": [e["id"] for e in events if e["event"] == "identity_verified"],
        "ending": ending,
        "client_messages_after_last_operator": client_after_last_op,
        "long_operator_gaps": gaps,
        "duration_sec": duration,
        "duplicates": [m["id"] for m in msgs if m["duplicate_of"] is not None],
        "internal_ids": [m["id"] for m in msgs if m["internal"]],
        "call_metrics": call_metrics(norm),
    }


def facts_to_text(facts: dict, norm: dict) -> str:
    msgs = {m["id"]: m for m in norm["messages"]}
    lines = []
    lang_names = {"RU": "русский", "KZ": "казахский", "EN": "английский"}
    cl = facts.get("client_language")
    lines.append(f"- Язык клиента: {lang_names.get(cl, cl or 'не определён')}.")
    fo = facts.get("first_operator_message_id")
    if fo is None:
        lines.append("- Оператор в диалоге не писал.")
    else:
        ch = facts.get("first_operator_checks") or {}
        g = f"найдено («{ch['greeting']}»)" if ch.get("greeting") else "не найдено"
        nm = f"найдено («{ch['name']}»)" if ch.get("name") else "не найдено"
        ol = lang_names.get(ch.get("language"), ch.get("language") or "не определён")
        lines.append(f"- Первая реплика оператора: [{fo}]. Автопроверка по ключевым словам (может ошибаться): "
                     f"приветствие — {g}; имя оператора — {nm}; язык реплики — {ol}.")
    if facts.get("client_messages_before_operator"):
        ids = ", ".join(f"[{i}]" for i in facts["client_messages_before_operator"])
        lines.append(f"- До подключения оператора клиент уже написал: {ids} (это известные детали).")
    if facts.get("identity_verified_ids"):
        ids = ", ".join(f"[{i}]" for i in facts["identity_verified_ids"])
        lines.append(f"- Системное подтверждение личности клиента: {ids}.")
    else:
        lines.append("- Системного подтверждения личности клиента в диалоге нет.")
    end = facts.get("ending")
    if end:
        lines.append(f"- Завершение: [{end['message_id']}] {end['label']}.")
    lo = facts.get("last_operator_message_id")
    if lo is not None:
        after = facts.get("client_messages_after_last_operator") or []
        tail = f"; после неё клиент написал: {', '.join(f'[{i}]' for i in after)}" if after else "; после неё клиент больше не писал"
        fw = (facts.get("last_operator_checks") or {}).get("farewell")
        fws = f"прощание найдено («{fw}»)" if fw else "прощание не найдено"
        lines.append(f"- Последняя реплика оператора: [{lo}] ({fws} — автопроверка по ключевым словам){tail}.")
        end = facts.get("ending")
        if end and end["event"] in ("client_left", "connection_lost") and end["message_id"] > lo:
            if fw:
                lines.append(f"- После прощания оператора разговор завершился ([{end['message_id']}]).")
            else:
                lines.append(f"- Диалог прервался по инициативе клиента или из-за связи ([{end['message_id']}]) после последней реплики оператора, оператор не успел попрощаться.")
        if end and end["event"] == "operator_closed":
            lines.append(f"- Чат закрыл оператор ([{end['message_id']}]).")
        if not end and after:
            lines.append("- Диалог закончился репликой клиента, оператор на неё не ответил и системного сообщения о разрыве нет.")
    internal = facts.get("internal_ids") or []
    if internal:
        lines.append(f"- Реплики [{internal[0]}]–[{internal[-1]}] помечены «ВНУТР.»: клиент был на удержании, оператор "
                     f"консультировался с коллегой — эти реплики не адресованы клиенту.")
    cm = facts.get("call_metrics")
    if cm:
        wpm = f"; темп речи оператора ≈ {cm['operator_wpm']} слов/мин" if cm.get("operator_wpm") else ""
        lines.append(f"- Метрики звонка (оценка по таймингам распознавания): длительность {fmt_mmss(cm['duration_sec'])}; "
                     f"на удержании {cm['hold_sec']} с; доля речи оператора {cm['operator_share']}%{wpm}; "
                     f"самая длинная пауза вне удержания {cm['longest_silence_sec']} с"
                     + (f" (перед [{cm['longest_silence_before_id']}])" if cm.get("longest_silence_before_id") is not None else "") + ".")
    for g in facts.get("long_operator_gaps", []):
        lines.append(
            f"- Пауза {g['seconds']} с между репликой клиента [{g['after_client_id']}] и ответом оператора [{g['operator_id']}]."
        )
    return "\n".join(lines)


def render_transcript(norm: dict, bot_max_chars: int = 220, text_max_chars: int = 900) -> str:
    out = []
    for m in norm["messages"]:
        if m["duplicate_of"] is not None:
            continue
        text = m["text"].replace("\n", " ")
        limit = bot_max_chars if m["speaker"] == "bot" else text_max_chars
        if len(text) > limit:
            text = text[:limit].rstrip() + "…"
        label = SPEAKER_LABEL.get(m["speaker"], m["speaker"].upper() or "?")
        if m.get("internal"):
            label = "ОПЕРАТОР (ВНУТР., клиент на удержании)"
        out.append(f"[{m['id']}] {m['t_label']} {label}: {text}")
    return "\n".join(out)
