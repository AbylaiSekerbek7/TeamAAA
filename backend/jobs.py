"""Background evaluation queue (single worker: one local GPU)."""
from __future__ import annotations

import queue
import threading
import time
import traceback
import uuid
from typing import Any

from . import db
from .evaluator import evaluate

_jobs: dict[str, dict[str, Any]] = {}
_q: "queue.Queue[tuple[str, int, str, int, dict]]" = queue.Queue()
_worker: threading.Thread | None = None
_lock = threading.Lock()


def _ensure_worker() -> None:
    global _worker
    if _worker is None or not _worker.is_alive():
        _worker = threading.Thread(target=_run, daemon=True, name="cqa-eval-worker")
        _worker.start()


def submit(pairs: list[tuple[str, int]], settings: dict, auto: bool = False) -> dict:
    """pairs: (conversation_id, checklist_id). auto=True means checklists were chosen by channel."""
    job_id = uuid.uuid4().hex[:10]
    names = {}
    for _, cl_id in pairs:
        if cl_id not in names:
            cl = db.get_checklist(cl_id)
            if cl is None:
                raise ValueError("Чек-лист не найден")
            names[cl_id] = f"{cl['name']} v{cl['version']}"
    label = " + ".join(names.values())
    if auto:
        label = f"по каналу: {label}"
    job = {
        "id": job_id,
        "checklist_id": pairs[0][1] if len(names) == 1 else None,
        "checklist_name": label,
        "model": settings.get("model"),
        "total": len(pairs),
        "done": 0,
        "failed": 0,
        "status": "queued",
        "current": None,
        "current_criterion": None,
        "items": [],
        "created_at": time.time(),
        "started_at": None,
        "finished_at": None,
        "cancel": False,
    }
    for cid, cl_id in pairs:
        eval_id = db.create_evaluation(cid, cl_id, job_id, settings.get("model", ""))
        job["items"].append({"conversation_id": cid, "evaluation_id": eval_id, "checklist_id": cl_id, "status": "queued", "total": None})
    with _lock:
        _jobs[job_id] = job
    for item in job["items"]:
        _q.put((job_id, item["evaluation_id"], item["conversation_id"], item["checklist_id"], settings))
    _ensure_worker()
    return public(job)


def public(job: dict) -> dict:
    j = {k: v for k, v in job.items() if k != "cancel"}
    if job["started_at"] and job["done"]:
        per = ((job["finished_at"] or time.time()) - job["started_at"]) / max(1, job["done"])
        j["avg_seconds"] = round(per, 1)
        j["eta_seconds"] = int(per * (job["total"] - job["done"])) if job["status"] == "running" else 0
    return j


def get(job_id: str) -> dict | None:
    job = _jobs.get(job_id)
    return public(job) if job else None


def list_jobs() -> list[dict]:
    return [public(j) for j in sorted(_jobs.values(), key=lambda j: -j["created_at"])][:20]


def cancel(job_id: str) -> None:
    job = _jobs.get(job_id)
    if job:
        job["cancel"] = True


def _run() -> None:
    while True:
        job_id, eval_id, cid, checklist_id, settings = _q.get()
        job = _jobs.get(job_id)
        item = next((i for i in job["items"] if i["evaluation_id"] == eval_id), None) if job else None
        try:
            if job is None:
                continue
            if job["cancel"]:
                db.update_evaluation(eval_id, status="cancelled")
                item["status"] = "cancelled"
                job["done"] += 1
                continue
            if job["started_at"] is None:
                job["started_at"] = time.time()
            job["status"] = "running"
            job["current"] = cid
            item["status"] = "running"
            db.update_evaluation(eval_id, status="running")
            record = db.conversation_record(cid)
            checklist = db.get_checklist(checklist_id)["data"]

            def progress(crit_id: str, i: int, n: int) -> None:
                job["current_criterion"] = f"{i + 1}/{n}"

            result = evaluate(record, checklist, settings, progress)
            score = result["score"]
            status = "done" if not result["errors"] else "done"
            db.update_evaluation(
                eval_id, status=status, finished_at=db.now(), result_json=result,
                total=score["total"], gross_error=int(score["gross_error"]),
                final_result_json=None, final_total=score["total"], final_gross_error=int(score["gross_error"]),
                error=(f"Не удалось оценить: {', '.join(result['errors'])}" if result["errors"] else None),
            )
            item["status"] = "done"
            item["total"] = score["total"]
            item["gross_error"] = score["gross_error"]
            job["done"] += 1
            if result["errors"]:
                job["failed"] += 1
                item["error"] = f"не оценены: {', '.join(result['errors'])}"
        except Exception as e:  # noqa: BLE001
            traceback.print_exc()
            db.update_evaluation(eval_id, status="error", error=str(e), finished_at=db.now())
            if item:
                item["status"] = "error"
                item["error"] = str(e)
            if job:
                job["done"] += 1
                job["failed"] += 1
        finally:
            if job and job["done"] >= job["total"]:
                job["status"] = "finished"
                job["finished_at"] = time.time()
                job["current"] = None
                job["current_criterion"] = None
            _q.task_done()
