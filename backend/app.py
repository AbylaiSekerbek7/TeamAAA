"""FastAPI application: REST API + static frontend."""
from __future__ import annotations

import csv
import io
import json
import re
from pathlib import Path
from typing import Any

from fastapi import Body, FastAPI, File, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles

from . import autochecks, datasource, db, jobs, preprocess
from .evaluator import allowed_answers, answer_label, normalize_answer
from .llm import make_client
from .scoring import compute_score

ROOT = Path(__file__).resolve().parents[1]
FRONTEND = ROOT / "frontend"
LABELS_DIR = ROOT / "data" / "labels"

app = FastAPI(title="CQA — Conversation Quality Analytics", version="1.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


@app.on_event("startup")
def _startup() -> None:
    db.init()


def _err(status: int, msg: str):
    raise HTTPException(status_code=status, detail=msg)


# ---------------------------------------------------------------- health & settings
@app.get("/api/health")
def health():
    s = db.get_settings()
    h = make_client(s).health()
    model = s.get("model")
    available = any(m == model or m.split(":")[0] == model or m == f"{model}:latest" for m in h.get("models", []))
    return {"llm": h, "provider": s.get("provider"), "model": model, "model_available": available}


def _public_settings(s: dict) -> dict:
    s = dict(s)
    if s.get("api_key"):
        s["api_key"] = "••••" + s["api_key"][-4:]
    return s


@app.get("/api/settings")
def get_settings():
    return _public_settings(db.get_settings())


@app.put("/api/settings")
def put_settings(values: dict = Body(...)):
    if "api_key" in values and str(values["api_key"]).startswith("••••"):
        values.pop("api_key")
    for k in ("temperature", "vote_temperature"):
        if k in values:
            values[k] = float(values[k])
    for k in ("votes", "num_ctx", "max_tokens"):
        if k in values:
            values[k] = int(values[k])
    return _public_settings(db.save_settings(values))


# ---------------------------------------------------------------- conversations
@app.get("/api/conversations")
def conversations():
    return db.list_conversations()


@app.post("/api/datasets/fetch")
def fetch_dataset(body: dict = Body(...)):
    gid = (body.get("group_id") or "").strip()
    if not gid:
        _err(400, "Укажите group_id")
    try:
        return datasource.fetch_group(gid)
    except datasource.DataSourceError as e:
        _err(502, str(e))


@app.post("/api/conversations/upload")
async def upload(file: UploadFile = File(...), dataset: str = Query("UPLOAD")):
    raw = await file.read()
    try:
        payload = json.loads(raw.decode("utf-8-sig"))
    except ValueError:
        _err(400, "Файл должен быть JSON")
    try:
        return datasource.import_payload(payload, dataset)
    except datasource.DataSourceError as e:
        _err(400, str(e))


@app.post("/api/conversations/import")
def import_json(payload: Any = Body(...), dataset: str = Query("UPLOAD")):
    try:
        return datasource.import_payload(payload, dataset)
    except datasource.DataSourceError as e:
        _err(400, str(e))


@app.get("/api/conversations/{cid}")
def conversation(cid: str):
    conv = db.get_conversation(cid)
    if not conv:
        _err(404, "Диалог не найден")
    record = db.conversation_record(cid)
    norm = preprocess.normalize(record)
    facts = preprocess.compute_facts(record, norm)
    evals = db.list_evaluations(cid)
    return {
        "conversation": {k: v for k, v in conv.items() if k != "transcript"},
        "messages": norm["messages"],
        "is_voice": norm["is_voice"],
        "facts": facts,
        "evaluations": evals,
    }


@app.get("/api/audio/{cid}")
def audio(cid: str):
    try:
        return RedirectResponse(datasource.resolve_audio(cid), status_code=302)
    except datasource.DataSourceError as e:
        _err(404, str(e))


# ---------------------------------------------------------------- checklists
def _slug(text: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "_", text.lower()).strip("_")
    return s or "c"


def validate_checklist(data: dict) -> dict:
    if not isinstance(data, dict):
        _err(400, "Некорректный чек-лист")
    crits = data.get("criteria")
    if not isinstance(crits, list) or not crits:
        _err(400, "В чек-листе должен быть хотя бы один критерий")
    seen: set[str] = set()
    out = []
    for i, c in enumerate(crits):
        c = dict(c)
        title = (c.get("title") or "").strip()
        if not title:
            _err(400, f"Критерий №{i + 1}: укажите название")
        ctype = c.get("type")
        if ctype not in ("binary", "scale", "flag"):
            _err(400, f"«{title}»: тип должен быть binary, scale или flag")
        cid = (c.get("id") or "").strip() or f"c{i + 1:02d}_{_slug(title)[:20]}"
        base, n = cid, 2
        while cid in seen:
            cid = f"{base}_{n}"
            n += 1
        seen.add(cid)
        try:
            weight = float(c.get("weight") or 0)
        except (TypeError, ValueError):
            _err(400, f"«{title}»: вес должен быть числом")
        if weight < 0:
            _err(400, f"«{title}»: вес не может быть отрицательным")
        if ctype == "flag":
            weight = 0
            c["na_allowed"] = False
        scale = []
        if ctype == "scale":
            vals = set()
            for s in c.get("scale") or []:
                try:
                    v = float(s.get("value"))
                except (TypeError, ValueError):
                    continue
                v = int(v) if v == int(v) else v
                if v in vals:
                    continue
                vals.add(v)
                scale.append({"value": v, "description": (s.get("description") or "").strip()})
            if len(scale) < 2:
                _err(400, f"«{title}»: для шкалы нужно минимум две ступени")
            if max(vals) <= 0:
                _err(400, f"«{title}»: верхняя ступень шкалы должна быть больше нуля")
            scale.sort(key=lambda s: -s["value"])
        ac = c.get("auto_check") if isinstance(c.get("auto_check"), dict) else None
        if ac and ac.get("type") not in autochecks.AUTO_CHECKS:
            ac = None
        out.append({
            "auto_check": ac,
            "id": cid, "code": (c.get("code") or f"{i + 1:02d}").strip(), "section": (c.get("section") or "").strip(),
            "title": title, "type": ctype, "weight": int(weight) if weight == int(weight) else weight,
            "na_allowed": bool(c.get("na_allowed")), "yes_rule": (c.get("yes_rule") or "").strip(),
            "no_rule": (c.get("no_rule") or "").strip(), "na_rule": (c.get("na_rule") or "").strip(),
            "guidance": (c.get("guidance") or "").strip(), "scale": scale, "enabled": c.get("enabled", True) is not False,
        })
    channels = [ch for ch in (data.get("channels") or []) if ch in ("agent chat", "voice call")]
    return {
        "key": (data.get("key") or "").strip(),
        "name": (data.get("name") or "Чек-лист").strip(),
        "description": (data.get("description") or "").strip(),
        "channels": channels,
        "general_rules": (data.get("general_rules") or "").strip(),
        "criteria": out,
    }


@app.get("/api/checklists")
def checklists():
    return db.list_checklists()


@app.get("/api/checklists/active")
def checklist_active():
    return db.active_checklist()


@app.get("/api/checklists/by-channel")
def checklist_by_channel():
    return {"agent chat": db.checklist_for_channel("agent chat"), "voice call": db.checklist_for_channel("voice call")}


@app.post("/api/checklists/{cl_id}/deactivate")
def deactivate_checklist(cl_id: int):
    cl = db.get_checklist(cl_id)
    if not cl:
        _err(404, "Чек-лист не найден")
    db.deactivate_checklist_key(cl["key"])
    return {"ok": True}


@app.get("/api/autochecks")
def autocheck_types():
    return autochecks.AUTO_CHECKS


@app.post("/api/autochecks/signature")
def autocheck_signature(criterion: dict = Body(...)):
    """Signature binding an auto-check to the current criterion wording."""
    return {"signature": autochecks.signature(criterion), "active": autochecks.is_active(criterion)}


@app.get("/api/checklists/{cl_id}")
def checklist(cl_id: int):
    c = db.get_checklist(cl_id)
    if not c:
        _err(404, "Чек-лист не найден")
    return c


@app.post("/api/checklists")
def save_checklist(body: dict = Body(...)):
    data = validate_checklist(body.get("data") or body)
    existing = {c["key"] for c in db.list_checklists()}
    if body.get("as_new") or not data["key"]:
        base = _slug(data["name"])[:24] or "checklist"
        key, n = base, 2
        while key in existing:
            key = f"{base}-{n}"
            n += 1
        data["key"] = key
    return db.save_checklist(data, comment=body.get("comment", ""), activate=body.get("activate", True))


@app.post("/api/checklists/{cl_id}/activate")
def activate_checklist(cl_id: int):
    if not db.get_checklist(cl_id):
        _err(404, "Чек-лист не найден")
    db.activate_checklist(cl_id)
    return {"ok": True}


# ---------------------------------------------------------------- evaluations & jobs
@app.post("/api/evaluations")
def start_evaluation(body: dict = Body(...)):
    convs = [db.get_conversation(i) for i in body.get("conversation_ids") or []]
    convs = [c for c in convs if c]
    if not convs:
        _err(400, "Выберите хотя бы один диалог")
    cl_id = body.get("checklist_id")
    auto = cl_id in (None, "", "auto")
    if auto:
        pairs = [(c["id"], db.checklist_for_channel(c["channel"])["id"]) for c in convs]
    else:
        if not db.get_checklist(int(cl_id)):
            _err(404, "Чек-лист не найден")
        pairs = [(c["id"], int(cl_id)) for c in convs]
    settings = db.get_settings()
    for k in ("model", "votes", "temperature", "think"):
        if body.get(k) is not None:
            settings[k] = body[k]
    return jobs.submit(pairs, settings, auto=auto)


@app.get("/api/jobs")
def list_jobs():
    return jobs.list_jobs()


@app.get("/api/jobs/{job_id}")
def job(job_id: str):
    j = jobs.get(job_id)
    if not j:
        _err(404, "Задача не найдена")
    return j


@app.post("/api/jobs/{job_id}/cancel")
def cancel_job(job_id: str):
    jobs.cancel(job_id)
    return {"ok": True}


def _final_answers(ev: dict) -> dict:
    answers = {cid: r.get("answer") for cid, r in (ev["result"] or {}).get("criteria", {}).items()}
    for cid, ov in ((ev.get("final") or {}).get("overrides") or {}).items():
        answers[cid] = ov["answer"]
    return answers


@app.get("/api/evaluations/{eval_id}")
def evaluation(eval_id: int):
    ev = db.get_evaluation(eval_id)
    if not ev:
        _err(404, "Оценка не найдена")
    cl = db.get_checklist(ev["checklist_id"])
    ev["checklist"] = {"id": cl["id"], "name": cl["name"], "version": cl["version"], "data": cl["data"]}
    ev["appeals"] = db.list_appeals(evaluation_id=eval_id)
    if ev.get("result"):
        final_score = (ev.get("final") or {}).get("score") or ev["result"]["score"]
        ev["final_score"] = final_score
    return ev


# ---------------------------------------------------------------- appeals
@app.get("/api/appeals")
def appeals(status: str | None = None):
    out = db.list_appeals(status=status)
    cache: dict[int, dict] = {}
    for a in out:
        ev = cache.get(a["evaluation_id"]) or db.get_evaluation(a["evaluation_id"])
        cache[a["evaluation_id"]] = ev
        cl = db.get_checklist(ev["checklist_id"])["data"]
        crit = next((c for c in cl["criteria"] if c["id"] == a["criterion_id"]), None)
        a["criterion_title"] = f"{crit.get('code', '')} {crit['title']}" if crit else a["criterion_id"]
        a["final_total"] = ev.get("final_total")
    return out


@app.post("/api/appeals")
def create_appeal(body: dict = Body(...)):
    eval_id = int(body.get("evaluation_id") or 0)
    cid = body.get("criterion_id")
    comment = (body.get("comment") or "").strip()
    ev = db.get_evaluation(eval_id)
    if not ev or not ev.get("result"):
        _err(404, "Оценка не найдена")
    if cid not in ev["result"]["criteria"]:
        _err(400, "Критерий не найден в оценке")
    if not comment:
        _err(400, "Добавьте комментарий к апелляции")
    if any(a["criterion_id"] == cid and a["status"] == "open" for a in db.list_appeals(evaluation_id=eval_id)):
        _err(409, "По этому критерию уже есть открытая апелляция")
    cl = db.get_checklist(ev["checklist_id"])["data"]
    crit = next(c for c in cl["criteria"] if c["id"] == cid)
    proposed = body.get("proposed_answer")
    if proposed not in (None, ""):
        proposed = normalize_answer(crit, proposed)
        if proposed is None:
            _err(400, f"Недопустимое значение. Разрешено: {', '.join(allowed_answers(crit))}")
    else:
        proposed = None
    r = ev["result"]["criteria"][cid]
    current = _final_answers(ev).get(cid)
    original = {"answer": current, "answer_label": answer_label(crit, current), "explanation": r.get("explanation"),
                "evidence_ids": r.get("evidence_ids"), "model_answer": r.get("answer")}
    aid = db.create_appeal(eval_id, cid, comment, body.get("author") or "Супервайзер", proposed, original, ev.get("final_total"))
    return db.get_appeal(aid)


@app.post("/api/appeals/{appeal_id}/decision")
def decide(appeal_id: int, body: dict = Body(...)):
    ap = db.get_appeal(appeal_id)
    if not ap:
        _err(404, "Апелляция не найдена")
    if ap["status"] != "open":
        _err(409, "Апелляция уже рассмотрена")
    decision = body.get("decision")
    reason = (body.get("reason") or "").strip()
    if decision not in ("confirm", "change"):
        _err(400, "Решение: confirm или change")
    if not reason:
        _err(400, "Укажите причину решения")
    ev = db.get_evaluation(ap["evaluation_id"])
    cl = db.get_checklist(ev["checklist_id"])["data"]
    crit = next(c for c in cl["criteria"] if c["id"] == ap["criterion_id"])
    answers = _final_answers(ev)
    final = ev.get("final") or {"overrides": {}}
    final.setdefault("overrides", {})
    if decision == "change":
        new = normalize_answer(crit, body.get("new_answer"))
        if new is None:
            _err(400, f"Недопустимое значение. Разрешено: {', '.join(allowed_answers(crit))}")
        answers[ap["criterion_id"]] = new
        final["overrides"][ap["criterion_id"]] = {
            "answer": new, "answer_label": answer_label(crit, new), "appeal_id": appeal_id, "reason": reason,
            "reviewer": body.get("reviewer") or "Проверяющий", "previous": ap["original"]["answer"],
        }
    else:
        new = answers.get(ap["criterion_id"])
    score = compute_score(cl, answers)
    final["score"] = score
    db.update_evaluation(ev["id"], final_result_json=final, final_total=score["total"], final_gross_error=int(score["gross_error"]))
    db.decide_appeal(appeal_id, decision, new, body.get("reviewer") or "Проверяющий", reason, score["total"])
    return {"appeal": db.get_appeal(appeal_id), "final_total": score["total"], "score": score}


# ---------------------------------------------------------------- analytics, export, accuracy
def _crit_cols(cl: dict) -> list[dict]:
    return [c for c in cl["criteria"] if c.get("enabled", True)]


@app.get("/api/stats")
def stats(dataset: str | None = None):
    evs = db.latest_evaluations(dataset=dataset)
    convs = {c["id"]: c for c in db.list_conversations()}
    if not evs:
        return {"count": 0}
    totals = [e["final_total"] for e in evs if e["final_total"] is not None]
    by_lang: dict[str, list[float]] = {}
    by_channel: dict[str, list[float]] = {}
    per_crit: dict[str, dict[str, Any]] = {}
    hist = [0] * 10
    gross = []
    for e in evs:
        conv = convs.get(e["conversation_id"], {})
        if e["final_total"] is not None:
            by_lang.setdefault(conv.get("language") or "?", []).append(e["final_total"])
            by_channel.setdefault(conv.get("channel") or "?", []).append(e["final_total"])
            hist[min(9, int(e["final_total"] // 10))] += 1
        if e["final_gross_error"]:
            gross.append(e["conversation_id"])
        cl = db.get_checklist(e["checklist_id"])["data"]
        answers = _final_answers(e)
        for c in _crit_cols(cl):
            pc = per_crit.setdefault(c["id"], {"id": c["id"], "code": c.get("code"), "title": c["title"], "type": c["type"],
                                               "n": 0, "na": 0, "yes": 0, "no": 0, "sum_frac": 0.0, "applicable": 0})
            a = answers.get(c["id"])
            if a is None:
                continue
            pc["n"] += 1
            if a == "na":
                pc["na"] += 1
                continue
            if c["type"] == "scale":
                top = max(s["value"] for s in c["scale"])
                pc["sum_frac"] += float(a) / top
                pc["applicable"] += 1
            else:
                pc["yes" if a == "yes" else "no"] += 1
                if c["type"] == "binary":
                    pc["applicable"] += 1
                    pc["sum_frac"] += 1.0 if a == "yes" else 0.0
    for pc in per_crit.values():
        pc["pass_rate"] = round(pc["sum_frac"] / pc["applicable"] * 100, 1) if pc["applicable"] else None
    avg = lambda xs: round(sum(xs) / len(xs), 2) if xs else None  # noqa: E731
    return {
        "count": len(evs),
        "avg_total": avg(totals),
        "by_language": {k: {"avg": avg(v), "n": len(v)} for k, v in sorted(by_lang.items())},
        "by_channel": {k: {"avg": avg(v), "n": len(v)} for k, v in sorted(by_channel.items())},
        "histogram": hist,
        "gross_errors": gross,
        "criteria": list(per_crit.values()),
        "appeals": {"open": len(db.list_appeals(status="open")), "decided": len(db.list_appeals(status="decided"))},
    }


def _export_rows(dataset: str | None):
    evs = db.latest_evaluations(dataset=dataset)
    convs = {c["id"]: c for c in db.list_conversations()}
    rows = []
    for e in evs:
        cl_row = db.get_checklist(e["checklist_id"])
        cl = cl_row["data"]
        answers = _final_answers(e)
        crit_results = e["result"]["criteria"]
        row = {
            "conversation_id": e["conversation_id"],
            "dataset": convs.get(e["conversation_id"], {}).get("dataset"),
            "language": convs.get(e["conversation_id"], {}).get("language"),
            "channel": convs.get(e["conversation_id"], {}).get("channel"),
            "checklist": f"{cl_row['name']} v{cl_row['version']}",
            "model": e["model"],
            "total_ai": e["total"],
            "total_final": e["final_total"],
            "gross_error": bool(e["final_gross_error"]),
            "criteria": [],
        }
        for c in _crit_cols(cl):
            r = crit_results.get(c["id"], {})
            row["criteria"].append({
                "id": c["id"], "code": c.get("code"), "title": c["title"],
                "answer": answers.get(c["id"]), "answer_label": answer_label(c, answers.get(c["id"])),
                "ai_answer": r.get("answer"), "evidence_ids": r.get("evidence_ids"), "explanation": r.get("explanation"),
                "confidence": r.get("confidence"),
            })
        rows.append(row)
    return rows


@app.get("/api/export.json")
def export_json(dataset: str | None = None):
    return JSONResponse(_export_rows(dataset), headers={"Content-Disposition": "attachment; filename=cqa_results.json"})


@app.get("/api/export.csv")
def export_csv(dataset: str | None = None):
    rows = _export_rows(dataset)
    buf = io.StringIO()
    codes: list[str] = []
    for r in rows:
        for c in r["criteria"]:
            key = f"{c['code']} {c['title']}"
            if key not in codes:
                codes.append(key)
    w = csv.writer(buf, delimiter=";")
    w.writerow(["conversation_id", "dataset", "language", "channel", "checklist", "model", *codes, "total_ai", "total_final", "gross_error"])
    for r in rows:
        m = {f"{c['code']} {c['title']}": c["answer_label"] for c in r["criteria"]}
        w.writerow([r["conversation_id"], r["dataset"], r["language"], r["channel"], r["checklist"], r["model"],
                    *[m.get(k, "") for k in codes], r["total_ai"], r["total_final"], "Да" if r["gross_error"] else "Нет"])
    return Response("﻿" + buf.getvalue(), media_type="text/csv; charset=utf-8",
                    headers={"Content-Disposition": "attachment; filename=cqa_results.csv"})


def _load_labels() -> dict[str, dict]:
    labels: dict[str, dict] = {}
    if LABELS_DIR.exists():
        for p in sorted(LABELS_DIR.glob("*.json")):
            try:
                data = json.loads(p.read_text(encoding="utf-8"))
            except ValueError:
                continue
            for cid, v in (data.get("labels") or {}).items():
                labels[cid] = v
    return labels


@app.get("/api/accuracy")
def accuracy(dataset: str | None = None):
    """Compare the latest AI evaluations with reference labels in data/labels/*.json."""
    labels = _load_labels()
    evs = [e for e in db.latest_evaluations(dataset=dataset) if e["conversation_id"] in labels]
    per: dict[str, dict] = {}
    total_err = []
    rows = []
    for e in evs:
        lab = labels[e["conversation_id"]]
        cl = db.get_checklist(e["checklist_id"])["data"]
        ai = {cid: r.get("answer") for cid, r in e["result"]["criteria"].items()}
        mism = []
        for c in _crit_cols(cl):
            if c["id"] not in lab:
                continue
            exp = normalize_answer(c, lab[c["id"]])
            got = ai.get(c["id"])
            p = per.setdefault(c["id"], {"id": c["id"], "code": c.get("code"), "title": c["title"], "n": 0, "match": 0})
            p["n"] += 1
            if exp == got:
                p["match"] += 1
            else:
                mism.append({"criterion_id": c["id"], "expected": exp, "got": got})
        exp_score = compute_score(cl, {c["id"]: normalize_answer(c, lab.get(c["id"])) for c in _crit_cols(cl)})
        err = None
        if exp_score["total"] is not None and e["total"] is not None:
            err = round(abs(exp_score["total"] - e["total"]), 2)
            total_err.append(err)
        rows.append({"conversation_id": e["conversation_id"], "expected_total": exp_score["total"], "ai_total": e["total"],
                     "abs_error": err, "mismatches": mism})
    for p in per.values():
        p["accuracy"] = round(p["match"] / p["n"] * 100, 1) if p["n"] else None
    n_all = sum(p["n"] for p in per.values())
    m_all = sum(p["match"] for p in per.values())
    return {
        "dialogs": len(rows),
        "criterion_accuracy": round(m_all / n_all * 100, 1) if n_all else None,
        "total_mae": round(sum(total_err) / len(total_err), 2) if total_err else None,
        "exact_total": sum(1 for x in total_err if x == 0),
        "criteria": list(per.values()),
        "rows": sorted(rows, key=lambda r: -(r["abs_error"] or 0)),
    }


# ---------------------------------------------------------------- static frontend
if FRONTEND.exists():
    app.mount("/", StaticFiles(directory=FRONTEND, html=True), name="frontend")
