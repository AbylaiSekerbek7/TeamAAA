"""SQLite storage (stdlib only)."""
from __future__ import annotations

import json
import os
import sqlite3
import threading
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

ROOT = Path(__file__).resolve().parents[1]
DB_PATH = ROOT / "data" / "cqa.db"
DEFAULT_CHECKLIST = Path(__file__).resolve().parent / "defaults" / "checklist_chat.json"

_lock = threading.RLock()

# evaluations.result_json -> ev["result"] (AI verdicts), final_result_json -> ev["final"] (appeal overrides + final score)
JSON_KEYS = {"result_json": "result", "final_result_json": "final"}

SCHEMA = """
CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    dataset TEXT,
    channel TEXT,
    language TEXT,
    audio_url TEXT,
    transcript_json TEXT NOT NULL,
    source TEXT,
    imported_at TEXT
);
CREATE TABLE IF NOT EXISTS checklists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT NOT NULL,
    version INTEGER NOT NULL,
    name TEXT NOT NULL,
    data_json TEXT NOT NULL,
    comment TEXT,
    is_active INTEGER DEFAULT 0,
    created_at TEXT
);
CREATE TABLE IF NOT EXISTS evaluations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    checklist_id INTEGER NOT NULL,
    job_id TEXT,
    status TEXT NOT NULL,
    model TEXT,
    created_at TEXT,
    finished_at TEXT,
    result_json TEXT,
    total REAL,
    gross_error INTEGER,
    final_result_json TEXT,
    final_total REAL,
    final_gross_error INTEGER,
    error TEXT
);
CREATE INDEX IF NOT EXISTS ix_eval_conv ON evaluations(conversation_id, id);
CREATE TABLE IF NOT EXISTS appeals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    evaluation_id INTEGER NOT NULL,
    criterion_id TEXT NOT NULL,
    comment TEXT,
    author TEXT,
    proposed_answer TEXT,
    created_at TEXT,
    status TEXT NOT NULL,
    original_json TEXT,
    decision TEXT,
    new_answer TEXT,
    reviewer TEXT,
    reviewer_comment TEXT,
    decided_at TEXT,
    total_before REAL,
    total_after REAL
);
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audio_analysis (
    conversation_id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    result_json TEXT,
    error TEXT,
    updated_at TEXT
);
"""


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _connect() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(DB_PATH, check_same_thread=False, timeout=30)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA journal_mode=WAL")
    return con


_con: sqlite3.Connection | None = None


@contextmanager
def tx() -> Iterator[sqlite3.Connection]:
    global _con
    with _lock:
        if _con is None:
            _con = _connect()
        try:
            yield _con
            _con.commit()
        except Exception:
            _con.rollback()
            raise


DEFAULTS_DIR = Path(__file__).resolve().parent / "defaults"
DEFAULT_COMMENTS = {
    "chat-quality": "Начальная конфигурация из PDF",
    "call-quality": "Адаптация чек-листа к звонкам по разъяснению организаторов",
}


def init() -> None:
    with tx() as con:
        con.executescript(SCHEMA)
        for path in sorted(DEFAULTS_DIR.glob("checklist_*.json")):
            data = json.loads(path.read_text(encoding="utf-8"))
            rows = con.execute("SELECT id, version, comment FROM checklists WHERE key=?", (data["key"],)).fetchall()
            if rows:
                # Keep the shipped default (v1, never edited in the UI) in sync with the file; user versions are untouched.
                if len(rows) == 1 and rows[0]["version"] == 1 and rows[0]["comment"] == DEFAULT_COMMENTS.get(data["key"], "Начальная конфигурация"):
                    con.execute("UPDATE checklists SET data_json=?, name=? WHERE id=?",
                                (json.dumps(data, ensure_ascii=False), data["name"], rows[0]["id"]))
                continue
            con.execute(
                "INSERT INTO checklists(key, version, name, data_json, comment, is_active, created_at) VALUES (?,?,?,?,?,1,?)",
                (data["key"], 1, data["name"], json.dumps(data, ensure_ascii=False),
                 DEFAULT_COMMENTS.get(data["key"], "Начальная конфигурация"), now()),
            )


def row_to_dict(row: sqlite3.Row | None) -> dict | None:
    return None if row is None else {k: row[k] for k in row.keys()}


# ---------------- settings ----------------
DEFAULT_SETTINGS: dict[str, Any] = {
    "provider": "ollama",
    "ollama_url": "http://127.0.0.1:11434",
    "base_url": "",
    "api_key": "",
    "model": "qwen3.5:9b",
    "temperature": 0.0,
    "votes": 1,
    "vote_temperature": 0.7,
    "num_ctx": 8192,
    "think": False,
    "max_tokens": 900,
    "team_name": "TeamAAA",
    "audio_analysis": True,
    "whisper_model": "small",
    "whisper_device": "cpu",
    # The organisers' signed API URL is not committed: set CQA_ORG_API_URL, put it into config.local.json
    # ({"org_api_url": "..."}), or paste it in the UI (Настройки → Источник данных).
    "org_api_url": "",
}

_LOCAL_CONFIG = ROOT / "config.local.json"


def _local_overrides() -> dict:
    out: dict[str, Any] = {}
    if _LOCAL_CONFIG.exists():
        try:
            out.update(json.loads(_LOCAL_CONFIG.read_text(encoding="utf-8-sig")))
        except ValueError:
            pass
    if os.environ.get("CQA_ORG_API_URL"):
        out["org_api_url"] = os.environ["CQA_ORG_API_URL"]
    if os.environ.get("CQA_MODEL"):
        out["model"] = os.environ["CQA_MODEL"]
    return {k: v for k, v in out.items() if k in DEFAULT_SETTINGS}


DEFAULT_SETTINGS.update(_local_overrides())


def get_settings() -> dict:
    with tx() as con:
        rows = con.execute("SELECT key, value_json FROM settings").fetchall()
    s = dict(DEFAULT_SETTINGS)
    for r in rows:
        s[r["key"]] = json.loads(r["value_json"])
    return s


def save_settings(values: dict) -> dict:
    with tx() as con:
        for k, v in values.items():
            if k not in DEFAULT_SETTINGS:
                continue
            con.execute("INSERT INTO settings(key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json",
                        (k, json.dumps(v, ensure_ascii=False)))
    return get_settings()


# ---------------- conversations ----------------
def upsert_conversation(rec: dict, dataset: str, source: str) -> None:
    with tx() as con:
        con.execute(
            """INSERT INTO conversations(id, dataset, channel, language, audio_url, transcript_json, source, imported_at)
               VALUES (?,?,?,?,?,?,?,?)
               ON CONFLICT(id) DO UPDATE SET dataset=excluded.dataset, channel=excluded.channel, language=excluded.language,
                 audio_url=excluded.audio_url, transcript_json=excluded.transcript_json, source=excluded.source,
                 imported_at=excluded.imported_at""",
            (rec["conversation_id"], dataset, rec.get("channel"), rec.get("language"), rec.get("audio_url"),
             json.dumps(rec.get("transcript") or [], ensure_ascii=False), source, now()),
        )


def get_conversation(cid: str) -> dict | None:
    with tx() as con:
        row = con.execute("SELECT * FROM conversations WHERE id=?", (cid,)).fetchone()
    d = row_to_dict(row)
    if d:
        d["transcript"] = json.loads(d.pop("transcript_json"))
    return d


def conversation_record(cid: str) -> dict | None:
    c = get_conversation(cid)
    if not c:
        return None
    return {"conversation_id": c["id"], "channel": c["channel"], "language": c["language"],
            "transcript": c["transcript"], "audio_url": c["audio_url"]}


def list_conversations() -> list[dict]:
    # Score/appeal columns come from the latest *done* evaluation; last_status reflects the latest run of any status.
    with tx() as con:
        rows = con.execute(
            """SELECT c.id, c.dataset, c.channel, c.language, c.audio_url IS NOT NULL AS has_audio, c.imported_at,
                      json_array_length(c.transcript_json) AS n_messages,
                      e.id AS eval_id, e.status AS done_status, e.total, e.gross_error, e.final_total, e.final_gross_error,
                      e.checklist_id, e.finished_at, e.model,
                      l.status AS eval_status, l.error AS last_error,
                      (SELECT COUNT(*) FROM appeals a WHERE a.evaluation_id = e.id) AS appeals_total,
                      (SELECT COUNT(*) FROM appeals a WHERE a.evaluation_id = e.id AND a.status='open') AS appeals_open
               FROM conversations c
               LEFT JOIN evaluations e ON e.id = (SELECT MAX(id) FROM evaluations e2 WHERE e2.conversation_id = c.id AND e2.status='done')
               LEFT JOIN evaluations l ON l.id = (SELECT MAX(id) FROM evaluations e3 WHERE e3.conversation_id = c.id)
               ORDER BY c.dataset, c.id"""
        ).fetchall()
    return [row_to_dict(r) for r in rows]


# ---------------- checklists ----------------
def _checklist_row(row) -> dict | None:
    d = row_to_dict(row)
    if d:
        d["data"] = json.loads(d.pop("data_json"))
    return d


def list_checklists() -> list[dict]:
    with tx() as con:
        rows = con.execute("SELECT * FROM checklists ORDER BY key, version DESC").fetchall()
    return [_checklist_row(r) for r in rows]


def get_checklist(cl_id: int) -> dict | None:
    with tx() as con:
        return _checklist_row(con.execute("SELECT * FROM checklists WHERE id=?", (cl_id,)).fetchone())


def active_checklists() -> list[dict]:
    """One active version per checklist key."""
    with tx() as con:
        rows = con.execute("SELECT * FROM checklists WHERE is_active=1 ORDER BY id").fetchall()
    return [_checklist_row(r) for r in rows]


def active_checklist() -> dict:
    act = active_checklists()
    if act:
        return act[0]
    with tx() as con:
        return _checklist_row(con.execute("SELECT * FROM checklists ORDER BY id DESC LIMIT 1").fetchone())


def _is_voice(channel: str | None) -> bool:
    return (channel or "").lower().startswith(("voice", "call", "phone", "звон"))


def checklist_for_channel(channel: str | None) -> dict:
    """Active checklist bound to the dialog's channel; a checklist with no channels applies to all."""
    want = "voice call" if _is_voice(channel) else "agent chat"
    act = active_checklists()
    exact = [c for c in act if want in (c["data"].get("channels") or [])]
    if exact:
        return exact[-1]
    generic = [c for c in act if not c["data"].get("channels")]
    if generic:
        return generic[-1]
    return None  # no active checklist for this channel — the caller reports it instead of guessing


def save_checklist(data: dict, comment: str = "", activate: bool = True) -> dict:
    key = data.get("key") or "checklist"
    with tx() as con:
        v = con.execute("SELECT COALESCE(MAX(version), 0) FROM checklists WHERE key=?", (key,)).fetchone()[0] + 1
        data = dict(data, key=key)
        if activate:
            con.execute("UPDATE checklists SET is_active=0 WHERE key=?", (key,))
        cur = con.execute(
            "INSERT INTO checklists(key, version, name, data_json, comment, is_active, created_at) VALUES (?,?,?,?,?,?,?)",
            (key, v, data.get("name") or key, json.dumps(data, ensure_ascii=False), comment, 1 if activate else 0, now()),
        )
        new_id = cur.lastrowid
    return get_checklist(new_id)


def activate_checklist(cl_id: int) -> None:
    with tx() as con:
        row = con.execute("SELECT key FROM checklists WHERE id=?", (cl_id,)).fetchone()
        if row is None:
            return
        con.execute("UPDATE checklists SET is_active=0 WHERE key=?", (row["key"],))
        con.execute("UPDATE checklists SET is_active=1 WHERE id=?", (cl_id,))


def deactivate_checklist_key(key: str) -> None:
    with tx() as con:
        con.execute("UPDATE checklists SET is_active=0 WHERE key=?", (key,))


# ---------------- evaluations ----------------
def create_evaluation(conversation_id: str, checklist_id: int, job_id: str, model: str) -> int:
    with tx() as con:
        cur = con.execute(
            "INSERT INTO evaluations(conversation_id, checklist_id, job_id, status, model, created_at) VALUES (?,?,?,?,?,?)",
            (conversation_id, checklist_id, job_id, "queued", model, now()),
        )
        return cur.lastrowid


def update_evaluation(eval_id: int, **fields: Any) -> None:
    if not fields:
        return
    cols = []
    vals = []
    for k, v in fields.items():
        if k in ("result_json", "final_result_json") and not isinstance(v, str) and v is not None:
            v = json.dumps(v, ensure_ascii=False)
        cols.append(f"{k}=?")
        vals.append(v)
    vals.append(eval_id)
    with tx() as con:
        con.execute(f"UPDATE evaluations SET {', '.join(cols)} WHERE id=?", vals)


def get_evaluation(eval_id: int) -> dict | None:
    with tx() as con:
        row = con.execute("SELECT * FROM evaluations WHERE id=?", (eval_id,)).fetchone()
    d = row_to_dict(row)
    if d:
        for k in ("result_json", "final_result_json"):
            raw = d.pop(k)
            d[JSON_KEYS[k]] = json.loads(raw) if raw else None
    return d


def latest_done_evaluation(conversation_id: str) -> dict | None:
    with tx() as con:
        row = con.execute("SELECT MAX(id) FROM evaluations WHERE conversation_id=? AND status='done'", (conversation_id,)).fetchone()
    return get_evaluation(row[0]) if row and row[0] else None


def list_evaluations(conversation_id: str) -> list[dict]:
    with tx() as con:
        rows = con.execute(
            "SELECT id, checklist_id, status, model, created_at, finished_at, total, gross_error, final_total, final_gross_error, error "
            "FROM evaluations WHERE conversation_id=? ORDER BY id DESC", (conversation_id,)).fetchall()
    return [row_to_dict(r) for r in rows]


def latest_evaluations(dataset: str | None = None, checklist_id: int | None = None) -> list[dict]:
    q = """SELECT e.* FROM evaluations e
           JOIN conversations c ON c.id = e.conversation_id
           WHERE e.status='done' AND e.id = (SELECT MAX(id) FROM evaluations e2 WHERE e2.conversation_id=e.conversation_id AND e2.status='done'
                                              {cl_filter})
           {ds_filter}
           ORDER BY e.conversation_id"""
    params: list[Any] = []
    cl_filter = ""
    if checklist_id is not None:
        cl_filter = "AND e2.checklist_id=?"
        params.append(checklist_id)
    ds_filter = ""
    if dataset:
        ds_filter = "AND c.dataset=?"
        params.append(dataset)
    with tx() as con:
        rows = con.execute(q.format(cl_filter=cl_filter, ds_filter=ds_filter), params).fetchall()
    out = []
    for r in rows:
        d = row_to_dict(r)
        for k in ("result_json", "final_result_json"):
            raw = d.pop(k)
            d[JSON_KEYS[k]] = json.loads(raw) if raw else None
        out.append(d)
    return out


# ---------------- appeals ----------------
def create_appeal(evaluation_id: int, criterion_id: str, comment: str, author: str, proposed_answer: Any,
                  original: dict, total_before: float | None) -> int:
    with tx() as con:
        cur = con.execute(
            """INSERT INTO appeals(evaluation_id, criterion_id, comment, author, proposed_answer, created_at, status,
                                   original_json, total_before) VALUES (?,?,?,?,?,?,?,?,?)""",
            (evaluation_id, criterion_id, comment, author, None if proposed_answer is None else json.dumps(proposed_answer),
             now(), "open", json.dumps(original, ensure_ascii=False), total_before),
        )
        return cur.lastrowid


def _appeal_row(row) -> dict | None:
    d = row_to_dict(row)
    if d:
        d["original"] = json.loads(d.pop("original_json") or "null")
        for k in ("proposed_answer", "new_answer"):
            d[k] = json.loads(d[k]) if d[k] else None
    return d


def get_appeal(appeal_id: int) -> dict | None:
    with tx() as con:
        return _appeal_row(con.execute("SELECT * FROM appeals WHERE id=?", (appeal_id,)).fetchone())


def list_appeals(status: str | None = None, evaluation_id: int | None = None) -> list[dict]:
    q = ("SELECT a.*, e.conversation_id FROM appeals a JOIN evaluations e ON e.id = a.evaluation_id WHERE 1=1")
    params: list[Any] = []
    if status:
        q += " AND a.status=?"
        params.append(status)
    if evaluation_id is not None:
        q += " AND a.evaluation_id=?"
        params.append(evaluation_id)
    q += " ORDER BY a.id DESC"
    with tx() as con:
        rows = con.execute(q, params).fetchall()
    return [_appeal_row(r) for r in rows]


def decide_appeal_atomic(appeal_id: int, compute: Any) -> dict | None:
    """Decide an appeal in one transaction: re-read the evaluation, let `compute(ev, appeal)` return
    (final_json, final_total, final_gross, decision, new_answer, reviewer, reason), write both rows.
    Returns None if the appeal is no longer open (concurrent decision)."""
    with tx() as con:
        ap = _appeal_row(con.execute("SELECT * FROM appeals WHERE id=?", (appeal_id,)).fetchone())
        if ap is None or ap["status"] != "open":
            return None
        row = row_to_dict(con.execute("SELECT * FROM evaluations WHERE id=?", (ap["evaluation_id"],)).fetchone())
        for k in ("result_json", "final_result_json"):
            raw = row.pop(k)
            row[JSON_KEYS[k]] = json.loads(raw) if raw else None
        total_before = row.get("final_total")
        final, final_total, final_gross, decision, new_answer, reviewer, reason = compute(row, ap)
        con.execute("UPDATE evaluations SET final_result_json=?, final_total=?, final_gross_error=? WHERE id=?",
                    (json.dumps(final, ensure_ascii=False), final_total, final_gross, row["id"]))
        con.execute(
            """UPDATE appeals SET status='decided', decision=?, new_answer=?, reviewer=?, reviewer_comment=?, decided_at=?,
                   total_before=?, total_after=? WHERE id=? AND status='open'""",
            (decision, json.dumps(new_answer), reviewer, reason, now(), total_before, final_total, appeal_id),
        )
        return {"total_before": total_before, "total_after": final_total}


def save_audio_analysis(cid: str, status: str, result: dict | None, error: str | None) -> None:
    with tx() as con:
        con.execute(
            """INSERT INTO audio_analysis(conversation_id, status, result_json, error, updated_at) VALUES (?,?,?,?,?)
               ON CONFLICT(conversation_id) DO UPDATE SET status=excluded.status, result_json=excluded.result_json,
               error=excluded.error, updated_at=excluded.updated_at""",
            (cid, status, json.dumps(result, ensure_ascii=False) if result is not None else None, error, now()),
        )


def get_audio_analysis(cid: str) -> dict | None:
    with tx() as con:
        row = con.execute("SELECT * FROM audio_analysis WHERE conversation_id=?", (cid,)).fetchone()
    d = row_to_dict(row)
    if d:
        raw = d.pop("result_json")
        d["result"] = json.loads(raw) if raw else None
    return d


def fail_interrupted_evaluations() -> int:
    """Evaluations left queued/running by a server restart can never finish (the queue is in memory)."""
    with tx() as con:
        cur = con.execute(
            "UPDATE evaluations SET status='error', error='Прервано перезапуском сервера — запустите оценку снова', finished_at=? "
            "WHERE status IN ('queued','running')", (now(),))
        con.execute("UPDATE audio_analysis SET status='error', error='Прервано перезапуском сервера' WHERE status='running'")
        return cur.rowcount
