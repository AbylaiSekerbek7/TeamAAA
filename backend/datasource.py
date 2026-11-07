"""Organizers' API adapter (server side, avoids CORS) and audio URL resolver."""
from __future__ import annotations

import html
import re
import time
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import httpx

from . import db


class DataSourceError(RuntimeError):
    pass


def _with_group(url: str, group_id: str) -> str:
    parts = urlsplit(url)
    q = [(k, v) for k, v in parse_qsl(parts.query, keep_blank_values=True) if k != "group_id"]
    q.append(("group_id", group_id))
    return urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(q), parts.fragment))


def validate_records(records: list) -> list[dict]:
    ok = []
    for r in records:
        if not isinstance(r, dict) or not r.get("conversation_id"):
            continue
        tr = r.get("transcript")
        if isinstance(tr, str):
            import json
            try:
                tr = json.loads(tr)
            except ValueError:
                tr = []
        if not isinstance(tr, list):
            continue
        r = dict(r, transcript=[
            {"timestamp": m.get("timestamp"), "speaker": (m.get("speaker") or "").lower(), "text": m.get("text") or ""}
            for m in tr if isinstance(m, dict)
        ])
        ok.append(r)
    return ok


def extract_records(payload) -> list[dict]:
    """Accept the organizers' envelope, a bare list, or a single record."""
    if isinstance(payload, dict) and "data" in payload and isinstance(payload["data"], dict):
        if payload.get("isSuccess") is False:
            raise DataSourceError(payload.get("error") or "API вернул isSuccess=false")
        return validate_records(payload["data"].get("records") or [])
    if isinstance(payload, dict) and "records" in payload:
        return validate_records(payload["records"])
    if isinstance(payload, list):
        return validate_records(payload)
    if isinstance(payload, dict) and "conversation_id" in payload:
        return validate_records([payload])
    raise DataSourceError("Не удалось распознать формат: ожидается ответ API организаторов, список записей или одна запись")


def fetch_group(group_id: str) -> dict:
    settings = db.get_settings()
    if not settings.get("org_api_url"):
        raise DataSourceError("Не задан URL API организаторов: вставьте ссылку «GET для DEV» из задания в Настройки → Источник данных")
    url = _with_group(settings["org_api_url"], group_id)
    try:
        r = httpx.get(url, timeout=120)
    except httpx.HTTPError as e:
        raise DataSourceError(f"API организаторов недоступен: {e}") from e
    if r.status_code >= 400:
        raise DataSourceError(f"API организаторов вернул {r.status_code}: {r.text[:200]}")
    payload = r.json()
    records = extract_records(payload)
    dataset = (payload.get("data") or {}).get("dataset_group_id") or group_id
    for rec in records:
        db.upsert_conversation(rec, dataset, "api")
    return {"dataset": dataset, "imported": len(records), "ids": [r["conversation_id"] for r in records]}


def import_payload(payload, dataset: str = "UPLOAD") -> dict:
    records = extract_records(payload)
    if isinstance(payload, dict) and isinstance(payload.get("data"), dict):
        dataset = payload["data"].get("dataset_group_id") or dataset
    for rec in records:
        db.upsert_conversation(rec, dataset, "upload")
    return {"dataset": dataset, "imported": len(records), "ids": [r["conversation_id"] for r in records]}


# ---------------- audio ----------------
_audio_cache: dict[str, tuple[float, str]] = {}
SOURCE_RE = re.compile(r"<source[^>]+src=\"([^\"]+)\"", re.I)
AUDIO_RE = re.compile(r"<audio[^>]+src=\"([^\"]+)\"", re.I)


def resolve_audio(conversation_id: str) -> str:
    """audio_url returns an HTML player page whose <source> holds a short-lived signed mp3 URL."""
    cached = _audio_cache.get(conversation_id)
    if cached and cached[0] > time.time():
        return cached[1]
    conv = db.get_conversation(conversation_id)
    if not conv or not conv.get("audio_url"):
        raise DataSourceError("У диалога нет записи")
    url = conv["audio_url"]
    try:
        r = httpx.get(url, timeout=60, follow_redirects=True)
    except httpx.HTTPError as e:
        raise DataSourceError(f"Плеер недоступен: {e}") from e
    ctype = r.headers.get("content-type", "")
    if ctype.startswith("audio/"):
        src = url
    else:
        m = SOURCE_RE.search(r.text) or AUDIO_RE.search(r.text)
        if not m:
            raise DataSourceError("Ссылка на аудио не найдена на странице плеера")
        src = html.unescape(m.group(1))
    _audio_cache[conversation_id] = (time.time() + 45 * 60, src)  # signed URL lives ~60 min
    return src
