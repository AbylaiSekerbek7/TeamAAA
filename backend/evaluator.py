"""Criterion-by-criterion LLM evaluation driven entirely by the checklist config.

Nothing here is specific to the default checklist: prompts, allowed answers and
the JSON schema are generated from each criterion's fields, so a criterion added
or replaced in the UI is evaluated without code changes.
"""
from __future__ import annotations

import time
from collections import Counter
from typing import Any, Callable

from . import autochecks, preprocess
from .llm import LLMError, make_client
from .scoring import compute_score

SYSTEM_PROMPT = """Ты — эксперт отдела контроля качества контакт-центра брокерской компании Freedom Broker.
Ты оцениваешь работу ОПЕРАТОРА в диалоге с клиентом строго по одному критерию чек-листа за раз.
Диалоги бывают на русском, казахском и английском — ты свободно понимаешь все три языка. Объяснения пиши по-русски.

ОБЩИЕ ПРАВИЛА ЧЕК-ЛИСТА:
{general_rules}

КАК ОТВЕЧАТЬ (строго JSON):
- "analysis": короткий разбор (2–5 предложений): какие реплики относятся к критерию и выполнено ли условие. Ссылайся на номера реплик в квадратных скобках.
- "answer": вердикт — только одно из допустимых значений.
- "evidence_ids": номера реплик (1–3), на которых основан вывод. Для пропущенного действия укажи реплику, где действие ожидалось. Для N/A — реплику или системное сообщение, подтверждающее неприменимость.
- "explanation": итоговое обоснование для отчёта, 1–2 предложения по-русски, в стиле: «Завершение — Нет. После ответа на вопрос оператор закрыл чат без прощания. Основание — последняя реплика оператора и сообщение о закрытии чата».
Оценивай только то, что есть в транскрипте. Не выдумывай реплик. Строго следуй формулировкам критерия и пояснениям к нему.
Не будь излишне строгим: «Нет» ставь только при явном нарушении условия критерия, подтверждённом конкретной репликой. Если условие «Да» выполнено — ставь «Да», даже если работу оператора можно было бы улучшить. Недостатки, которые относятся к другим критериям, в текущем критерии не учитывай."""

ANSWER_LABELS = {"yes": "Да", "no": "Нет", "na": "N/A"}


def criterion_type_label(c: dict) -> str:
    if c["type"] == "binary":
        return "Да / Нет / N/A" if c.get("na_allowed") else "Да / Нет"
    if c["type"] == "scale":
        vals = "/".join(str(s["value"]) for s in sorted(c.get("scale", []), key=lambda s: -s["value"]))
        return f"шкала {vals}" + (" / N/A" if c.get("na_allowed") else "")
    if c["type"] == "flag":
        return "флаг нарушения Да / Нет (без баллов)"
    return c["type"]


def allowed_answers(c: dict) -> list[str]:
    if c["type"] == "scale":
        vals = [str(s["value"]) for s in sorted(c.get("scale", []), key=lambda s: -s["value"])]
    else:
        vals = ["yes", "no"]
    if c.get("na_allowed") and c["type"] != "flag":
        vals.append("na")
    return vals


def build_schema(c: dict) -> dict:
    # Note: an "issues"-first field for scale criteria was tried and made the 8-9B model over-critical
    # (dialog-management accuracy 71% -> 31% on DEV), so verdicts are produced without it.
    props: dict = {}
    required: list = []
    props.update({
        "analysis": {"type": "string"},
        "answer": {"type": "string", "enum": allowed_answers(c)},
        "evidence_ids": {"type": "array", "items": {"type": "integer"}},
        "explanation": {"type": "string"},
    })
    required += ["analysis", "answer", "evidence_ids", "explanation"]
    return {"type": "object", "properties": props, "required": required}


def criterion_block(c: dict) -> str:
    lines = [f"КРИТЕРИЙ {c.get('code', '')} «{c['title']}» (секция: {c.get('section') or '—'})",
             f"Тип ответа: {criterion_type_label(c)}"]
    if c["type"] == "flag":
        lines.append(f"Да (нарушение выявлено) — {c.get('yes_rule', '')}")
        lines.append(f"Нет — {c.get('no_rule') or 'нарушение не выявлено.'}")
    elif c["type"] == "binary":
        lines.append(f"Да — {c.get('yes_rule', '')}")
        lines.append(f"Нет — {c.get('no_rule') or 'действие было нужно, но оператор его пропустил или выполнил неправильно.'}")
    else:
        if c.get("yes_rule"):
            lines.append(c["yes_rule"])
        lines.append("Шкала (выбери ровно одну ступень):")
        for s in sorted(c.get("scale", []), key=lambda s: -s["value"]):
            lines.append(f"  {s['value']} — {s.get('description', '')}")
    if c.get("na_allowed") and c["type"] != "flag":
        lines.append(f"N/A — {c.get('na_rule') or 'критерий неприменим.'} Ставь N/A только если это условие выполнено.")
    else:
        lines.append("N/A для этого критерия не допускается.")
    if c.get("guidance"):
        lines.append(f"Пояснения: {c['guidance']}")
    allowed = ", ".join(f'"{a}"' for a in allowed_answers(c))
    hint = ' ("yes" = Да, "no" = Нет' + (', "na" = N/A' if "na" in allowed_answers(c) else "") + ")" if c["type"] != "scale" else ""
    lines.append(f"Допустимые значения answer: {allowed}{hint}.")
    return "\n".join(lines)


def dialog_block(record: dict, norm: dict, facts: dict) -> str:
    head = (f"ДИАЛОГ {record.get('conversation_id', '')} · канал: {record.get('channel', '')} · "
            f"язык: {record.get('language', '')}")
    voice_note = ("\nЭто расшифровка телефонного звонка (автоматическое распознавание речи): возможны ошибки "
                  "распознавания, обрывки фраз и маскированные данные — оценивай смысл.") if norm.get("is_voice") else ""
    facts_text = preprocess.facts_to_text(facts, norm)
    if facts.get("audio_metrics"):
        from .audio import metrics_to_text
        facts_text += "\n" + metrics_to_text(facts["audio_metrics"])
    return (f"{head}{voice_note}\n\nФАКТЫ, вычисленные системой автоматически:\n{facts_text}\n\n"
            f"ТРАНСКРИПТ (номер реплики, время от начала, роль, текст):\n{preprocess.render_transcript(norm)}")


def normalize_answer(c: dict, raw: Any) -> Any:
    a = str(raw).strip().lower() if raw is not None else ""
    if a in ("n/a", "н/д", "na", "не применимо"):
        a = "na"
    if a in ("да", "true"):
        a = "yes"
    if a in ("нет", "false"):
        a = "no"
    allowed = allowed_answers(c)
    if c["type"] == "scale" and a != "na":
        try:
            v = float(a)
        except ValueError:
            return None
        step = next((s["value"] for s in c.get("scale", []) if float(s["value"]) == v), None)
        return step  # the configured step value (int or fractional), None if not a valid step
    if a not in allowed:
        return None
    return a


def answer_label(c: dict, answer: Any) -> str:
    if answer is None:
        return "—"
    if answer == "na":
        return "N/A"
    if c["type"] == "scale":
        top = max((s["value"] for s in c.get("scale", [])), default=0)
        return f"{answer} из {top}"
    if c["type"] == "flag":
        return "Да (нарушение)" if answer == "yes" else "Нет"
    return ANSWER_LABELS.get(answer, str(answer))


def _vote(c: dict, runs: list[dict]) -> dict:
    valid = [r for r in runs if r.get("answer") is not None]
    if not valid:
        return runs[0]
    counts = Counter(str(r["answer"]) for r in valid)
    top_n = counts.most_common(1)[0][1]
    leaders = [a for a, n in counts.items() if n == top_n]
    if len(leaders) == 1:
        winner = leaders[0]
    else:
        # ties go to the earliest run among the leaders (run 0 is the deterministic temperature-0 run)
        winner = next(str(r["answer"]) for r in valid if str(r["answer"]) in leaders)
    chosen = next(r for r in valid if str(r["answer"]) == winner)
    out = dict(chosen)
    out["votes"] = [r.get("answer") for r in runs]
    out["confidence"] = round(top_n / len(runs), 2)
    return out


def evaluate_criterion(client, settings: dict, system_prompt: str, dialog_text: str, c: dict,
                       max_id: int, facts: dict | None = None) -> dict:
    if facts is not None and settings.get("auto_checks", True):
        auto = autochecks.run(c, facts)
        if auto is not None:
            return {
                "criterion_id": c["id"], "answer": auto["answer"], "answer_label": answer_label(c, auto["answer"]),
                "evidence_ids": auto["evidence_ids"], "explanation": auto["explanation"],
                "analysis": f"Автопроверка правилом: {autochecks.AUTO_CHECKS[c['auto_check']['type']]}.",
                "source": "rule", "confidence": 1.0, "votes": [auto["answer"]],
                "prompt_tokens": 0, "completion_tokens": 0, "duration_ms": 0,
            }
    schema = build_schema(c)
    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": f"{dialog_text}\n\n==========\n{criterion_block(c)}\n\nВерни JSON."},
    ]
    votes = max(1, int(settings.get("votes", 1)))
    runs = []
    tokens_in = tokens_out = dur = 0
    for v in range(votes):
        temp = float(settings.get("temperature", 0.0)) if v == 0 else float(settings.get("vote_temperature", 0.7))
        seed = 42 + v
        last_err = None
        for _attempt in range(2):
            try:
                resp = client.chat_json(
                    model=settings["model"], messages=messages, schema=schema, temperature=temp, seed=seed,
                    num_ctx=int(settings.get("num_ctx", 8192)), think=settings.get("think", False),
                    max_tokens=int(settings.get("max_tokens", 900)),
                )
                data = resp["json"]
                tokens_in += resp["prompt_tokens"]
                tokens_out += resp["completion_tokens"]
                dur += resp["duration_ms"]
                if not isinstance(data, dict):
                    raise ValueError("ответ модели не является JSON-объектом")
                ans = normalize_answer(c, data.get("answer"))
                if ans is None:
                    raise ValueError(f"недопустимое значение ответа: {data.get('answer')!r}")
                raw_ev = data.get("evidence_ids")
                ev = []
                for x in raw_ev if isinstance(raw_ev, list) else []:
                    try:
                        xi = int(x)
                    except (TypeError, ValueError):
                        continue
                    if 0 <= xi <= max_id and xi not in ev:
                        ev.append(xi)
                issues = data.get("issues") if isinstance(data.get("issues"), list) else []
                analysis = str(data.get("analysis", "")).strip()
                if issues:
                    analysis = "Недочёты: " + "; ".join(str(i) for i in issues[:8]) + ". " + analysis
                runs.append({
                    "answer": ans,
                    "evidence_ids": ev[:5],
                    "analysis": analysis,
                    "issues": [str(i) for i in issues[:8]],
                    "explanation": str(data.get("explanation", "")).strip(),
                })
                last_err = None
                break
            except Exception as e:  # noqa: BLE001 — one failed criterion must not discard the whole evaluation
                last_err = e
                seed += 100
        if last_err is not None:
            runs.append({"answer": None, "evidence_ids": [], "analysis": "", "explanation": f"Ошибка модели: {last_err}"})
    result = _vote(c, runs)
    result.setdefault("votes", [r.get("answer") for r in runs])
    result.setdefault("confidence", 1.0 if result.get("answer") is not None else 0.0)
    result.update({
        "criterion_id": c["id"],
        "source": "llm",
        "answer_label": answer_label(c, result.get("answer")),
        "prompt_tokens": tokens_in,
        "completion_tokens": tokens_out,
        "duration_ms": dur,
    })
    return result


def fit_context(settings: dict, system_prompt: str, dialog_text: str, checklist: dict) -> dict:
    """Grow num_ctx for long dialogs so Ollama never truncates the start of the prompt."""
    longest_crit = max((len(criterion_block(c)) for c in checklist.get("criteria", [])), default=1500)
    approx_tokens = (len(system_prompt) + len(dialog_text) + longest_crit) / 2.5
    need = int(approx_tokens) + int(settings.get("max_tokens", 900)) + 512
    ctx = int(settings.get("num_ctx", 8192))
    while ctx < need and ctx < 32768:
        ctx += 4096
    return dict(settings, num_ctx=ctx)


def evaluate(record: dict, checklist: dict, settings: dict,
             progress: Callable[[str, int, int], None] | None = None, audio_metrics: dict | None = None) -> dict:
    t0 = time.time()
    norm = preprocess.normalize(record)
    facts = preprocess.compute_facts(record, norm)
    if audio_metrics:
        facts["audio_metrics"] = audio_metrics
    client = make_client(settings)
    system_prompt = SYSTEM_PROMPT.format(general_rules=checklist.get("general_rules", "").strip())
    dialog_text = dialog_block(record, norm, facts)
    settings = fit_context(settings, system_prompt, dialog_text, checklist)
    max_id = len(norm["messages"]) - 1

    criteria = [c for c in checklist.get("criteria", []) if c.get("enabled", True)]
    results: dict[str, dict] = {}
    for i, c in enumerate(criteria):
        if progress:
            progress(c["id"], i, len(criteria))
        results[c["id"]] = evaluate_criterion(client, settings, system_prompt, dialog_text, c, max_id, facts)

    if settings.get("auto_checks", True):
        autochecks.reconcile(checklist, results)
    answers = {cid: r.get("answer") for cid, r in results.items()}
    score = compute_score(checklist, answers)
    errors = [cid for cid, r in results.items() if r.get("answer") is None]
    return {
        "criteria": results,
        "score": score,
        "facts": facts,
        "model": settings.get("model"),
        "provider": settings.get("provider", "ollama"),
        "settings": {k: v for k, v in settings.items() if k != "api_key"},
        "prompt_tokens": sum(r["prompt_tokens"] for r in results.values()),
        "completion_tokens": sum(r["completion_tokens"] for r in results.values()),
        "duration_ms": int((time.time() - t0) * 1000),
        "errors": errors,
    }
