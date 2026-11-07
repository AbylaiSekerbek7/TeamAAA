import json
from pathlib import Path

from backend import autochecks, preprocess

ROOT = Path(__file__).resolve().parents[1]
CHECKLIST = json.loads((ROOT / "backend" / "defaults" / "checklist_chat.json").read_text(encoding="utf-8"))


def rec(lines, channel="agent chat", language="RU"):
    return {"conversation_id": "t", "channel": channel, "language": language,
            "transcript": [{"timestamp": ts, "speaker": sp, "text": tx} for ts, sp, tx in lines]}


def facts_of(r):
    n = preprocess.normalize(r)
    return preprocess.compute_facts(r, n), n


def test_greeting_and_name_detection_three_languages():
    for text, name in [("Здравствуйте! Меня зовут Алина.", "Алина"), ("Добрый день! Я Лера из поддержки.", "Лера"),
                       ("Сәлеметсіз бе! Мен Нұрланмын.", "Нұрлан"), ("Hi, I'm Maya from support.", "Maya")]:
        f, _ = facts_of(rec([("00:00", "client", "q"), ("00:10", "operator", text)]))
        assert f["first_operator_checks"]["greeting"], text
        assert f["first_operator_checks"]["name"] == name, text


def test_no_name_in_informal_greeting():
    f, _ = facts_of(rec([("00:00", "client", "q"), ("00:10", "operator", "Привет, где именно ищете?")]))
    assert f["first_operator_checks"]["name"] is None


def test_mixed_latin_ui_labels_stay_russian():
    assert preprocess.detect_lang("Здравствуйте! Я Кира. На сайте Freedom Holding Corp. откройте Investors, затем Financial Information.") == "RU"
    assert preprocess.detect_lang("Open the account area, labelled «Кабинет» in the Russian interface.") == "EN"
    assert preprocess.detect_lang("Сәлеметсіз бе") == "KZ"


def test_iso_timestamps_relative_seconds():
    r = rec([("2026-11-03T13:10:00.6388245+00:00", "system", "start"), ("2026-11-03T13:11:17.2581733+00:00", "operator", "Здравствуйте")],
            channel="voice call")
    _, n = facts_of(r)
    assert n["is_voice"] is True
    assert round(n["messages"][1]["t"]) == 77
    assert n["messages"][1]["t_label"] == "01:17"


def test_hold_marks_internal_operator_lines():
    r = rec([("00:00", "operator", "Здравствуйте, меня зовут Ира"), ("00:05", "client", "вопрос"),
             ("00:10", "system", "Клиент находится на удержании."), ("00:20", "operator", "Коллега, подскажи"),
             ("01:00", "system", "Клиент больше не находится на удержании."), ("01:05", "operator", "Спасибо за ожидание. До свидания!")])
    f, n = facts_of(r)
    assert n["messages"][3]["internal"] is True
    assert f["last_operator_message_id"] == 5
    assert f["internal_ids"] == [3]


def _crit(cid):
    c = next(c for c in CHECKLIST["criteria"] if c["id"] == cid)
    return dict(c, auto_check={"type": {"c01_contact": "contact_greeting_name", "c07_closing": "closing_farewell"}[cid],
                               "signature": autochecks.signature(c)})


def test_closing_autocheck_variants():
    c = _crit("c07_closing")
    base = [("00:00", "client", "q"), ("00:10", "operator", "Здравствуйте, я Ира. Ответ.")]
    f, _ = facts_of(rec(base + [("00:20", "client", "Спасибо"), ("00:30", "operator", "Пожалуйста. Хорошего дня!")]))
    assert autochecks.run(c, f)["answer"] == "yes"
    f, _ = facts_of(rec(base + [("00:20", "client", "Спасибо"), ("00:30", "system", "Соединение с клиентом прервано.")]))
    assert autochecks.run(c, f)["answer"] == "na"
    f, _ = facts_of(rec(base + [("00:20", "client", "А где?"), ("00:30", "system", "Оператор закрыл чат.")]))
    assert autochecks.run(c, f)["answer"] == "no"


def test_autocheck_disabled_when_wording_changes():
    c = _crit("c01_contact")
    f, _ = facts_of(rec([("00:00", "client", "q"), ("00:10", "operator", "Здравствуйте! Меня зовут Алина.")]))
    assert autochecks.run(c, f)["answer"] == "yes"
    changed = dict(c, yes_rule="Оператор поздоровался, представился и назвал компанию.")
    assert autochecks.run(changed, f) is None
