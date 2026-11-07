"""One-command control run: fetch by group_id -> evaluate all -> export results.json -> validate -> commit & push.

Usage (server must be running, see run.ps1):
  python -m scripts.control_run --group-id <ID> --target prod --push
  python -m scripts.control_run --group-id DEV --target dev
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import time
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from backend import results_export  # noqa: E402


def git_exe() -> str:
    return shutil.which("git") or r"C:\Program Files\Git\cmd\git.exe"


def log(msg: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def wait_job(s: httpx.Client, job_id: str) -> dict:
    last = None
    while True:
        j = s.get(f"/api/jobs/{job_id}").json()
        line = f"оценка: {j['done']}/{j['total']}, ошибок {j['failed']}" + (f", ≈ {j.get('eta_seconds', 0) // 60} мин" if j.get("eta_seconds") else "")
        if line != last:
            log(line)
            last = line
        if j["status"] == "finished":
            return j
        time.sleep(10)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--group-id", required=True)
    ap.add_argument("--target", choices=["dev", "prod"], required=True)
    ap.add_argument("--server", default="http://127.0.0.1:8000")
    ap.add_argument("--expect", type=int, default=None, help="expected number of dialogs (prod: 10)")
    ap.add_argument("--skip-eval", action="store_true", help="only export what is already evaluated")
    ap.add_argument("--push", action="store_true")
    args = ap.parse_args()
    expect = args.expect if args.expect is not None else (10 if args.target == "prod" else None)
    t0 = time.time()
    s = httpx.Client(base_url=args.server, timeout=300)

    log(f"1/5 Загружаю набор {args.group_id} из API организаторов…")
    r = s.post("/api/datasets/fetch", json={"group_id": args.group_id})
    r.raise_for_status()
    fetched = r.json()
    ids, dataset = fetched["ids"], fetched["dataset"]
    log(f"    получено диалогов: {len(ids)} (набор {dataset})")
    if expect is not None and len(ids) != expect:
        log(f"    ВНИМАНИЕ: ожидалось {expect}, получено {len(ids)}")

    if not args.skip_eval:
        log("2/5 Запускаю оценку всех диалогов (чек-лист по каналу)…")
        job = s.post("/api/evaluations", json={"conversation_ids": ids, "checklist_id": "auto"}).json()
        j = wait_job(s, job["id"])
        failed = [i["conversation_id"] for i in j["items"] if i["status"] != "done" or i.get("error")]
        if failed:
            log(f"3/5 Повторяю оценку неудачных: {failed}")
            job = s.post("/api/evaluations", json={"conversation_ids": failed, "checklist_id": "auto"}).json()
            wait_job(s, job["id"])
        else:
            log("3/5 Повтор не нужен — все диалоги оценены")

    log(f"4/5 Выгружаю results/{args.target}/results.json и проверяю формат…")
    res = s.post("/api/results/save", json={"dataset": dataset, "target": args.target}).json()
    out = ROOT / res["path"]
    payload = json.loads(out.read_text(encoding="utf-8"))
    problems = results_export.validate(payload, expected_ids=ids)
    ok = sum(1 for x in payload["results"] if x["status"] == "ok")
    log(f"    записей: {len(payload['results'])}, ok: {ok}, error: {len(res['errors'])} {res['errors'] or ''}")
    if problems:
        log("    ПРОБЛЕМЫ ФОРМАТА:")
        for p in problems:
            log(f"      - {p}")
    else:
        log("    формат и ID проверены — ошибок нет")

    if args.push:
        log("5/5 Commit и push…")
        g = git_exe()
        subprocess.run([g, "-C", str(ROOT), "add", res["path"]], check=True)
        msg = f"Results {args.target}: {dataset} ({len(payload['results'])} dialogs, ok {ok})"
        subprocess.run([g, "-C", str(ROOT), "commit", "-m", msg], check=False)
        p = subprocess.run([g, "-C", str(ROOT), "push", "origin", "HEAD"], capture_output=True, text=True)
        log("    push: " + ("OK" if p.returncode == 0 else f"ОШИБКА {p.stderr.strip()[:300]}"))
    else:
        log("5/5 Push пропущен (добавьте --push)")
    log(f"Готово за {int(time.time() - t0)} с")


if __name__ == "__main__":
    main()
