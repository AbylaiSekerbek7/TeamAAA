"""Call-recording analysis: an additional source to the organisers' transcript.

1. Download the recording (the audio_url player page holds a short-lived signed mp3 link) and cache it.
2. Energy-based voice activity detection -> speech / silence timeline, pauses.
3. Local speech-to-text (faster-whisper) with word timestamps and word confidences.
4. Align Whisper segments with the transcript lines -> recording offset for every message (precise player seek)
   and a speaker label for every Whisper segment.
5. Metrics per speaker: speaking time, speech rate (words/min), intelligibility proxy (mean word confidence),
   long pauses outside hold.
"""
from __future__ import annotations

import re
import statistics
import threading
import time
import traceback
from pathlib import Path
from typing import Any

import httpx
import numpy as np

from . import datasource, db, preprocess

ROOT = Path(__file__).resolve().parents[1]
AUDIO_DIR = ROOT / "data" / "audio"
SR = 16000
WHISPER_LANG = {"RU": "ru", "KZ": "kk", "EN": "en"}

_model_lock = threading.Lock()
_transcribe_lock = threading.Lock()  # one CPU-heavy transcription at a time
_models: dict[tuple, Any] = {}
_running: dict[str, float] = {}
_run_lock = threading.Lock()


class AudioError(RuntimeError):
    pass


# ------------------------------------------------------------------ download / decode
def ensure_audio(cid: str) -> Path:
    AUDIO_DIR.mkdir(parents=True, exist_ok=True)
    path = AUDIO_DIR / f"{re.sub(r'[^A-Za-z0-9_.-]', '_', cid)}.mp3"
    if path.exists() and path.stat().st_size > 1000:
        return path
    try:
        url = datasource.resolve_audio(cid)
    except datasource.DataSourceError as e:
        raise AudioError(str(e)) from e
    tmp = path.with_suffix(".part")
    with httpx.stream("GET", url, timeout=180, follow_redirects=True) as r:
        if r.status_code >= 400:
            raise AudioError(f"Запись недоступна: HTTP {r.status_code}")
        with open(tmp, "wb") as f:
            for chunk in r.iter_bytes():
                f.write(chunk)
    tmp.replace(path)
    return path


def load_pcm(path: Path) -> np.ndarray:
    """Decode to mono float32 at 16 kHz with PyAV (independent of faster-whisper's decoder, which breaks on newer PyAV)."""
    import av
    resampler = av.AudioResampler(format="flt", layout="mono", rate=SR)
    chunks = []
    with av.open(str(path)) as container:
        stream = container.streams.audio[0]
        for frame in container.decode(stream):
            for out in resampler.resample(frame):
                chunks.append(out.to_ndarray().reshape(-1))
        for out in resampler.resample(None):
            chunks.append(out.to_ndarray().reshape(-1))
    if not chunks:
        raise AudioError("Не удалось декодировать запись")
    return np.concatenate(chunks).astype(np.float32)


# ------------------------------------------------------------------ voice activity (energy)
def energy_vad(pcm: np.ndarray, frame_ms: int = 30, min_silence: float = 0.35) -> list[tuple[float, float]]:
    hop = int(SR * frame_ms / 1000)
    n = len(pcm) // hop
    if n == 0:
        return []
    frames = pcm[: n * hop].reshape(n, hop)
    rms = np.sqrt((frames ** 2).mean(axis=1) + 1e-12)
    db_ = 20 * np.log10(rms + 1e-9)
    floor = np.percentile(db_, 15)
    thr = max(floor + 9.0, -50.0)
    speech = db_ > thr
    segs: list[tuple[float, float]] = []
    start = None
    for i, s in enumerate(speech):
        t = i * frame_ms / 1000
        if s and start is None:
            start = t
        elif not s and start is not None:
            segs.append((start, t))
            start = None
    if start is not None:
        segs.append((start, n * frame_ms / 1000))
    merged: list[list[float]] = []
    for a, b in segs:
        if merged and a - merged[-1][1] < min_silence:
            merged[-1][1] = b
        else:
            merged.append([a, b])
    return [(round(a, 2), round(b, 2)) for a, b in merged if b - a >= 0.12]


# ------------------------------------------------------------------ speech to text
def _model(name: str, device: str):
    from faster_whisper import WhisperModel
    key = (name, device)
    with _model_lock:
        if key not in _models:
            compute = "int8_float16" if device == "cuda" else "int8"
            _models[key] = WhisperModel(name, device=device, compute_type=compute, cpu_threads=6)
        return _models[key]


def transcribe(pcm: np.ndarray, language: str | None, model: str = "small", device: str = "cpu") -> list[dict]:
    m = _model(model, device)
    out = []
    with _transcribe_lock:
        segments, _info = m.transcribe(
            pcm, language=language, beam_size=1, vad_filter=True, word_timestamps=True,
            condition_on_previous_text=False,
        )
        for s in segments:  # the generator does the actual decoding
            words = [{"start": round(w.start, 2), "end": round(w.end, 2), "word": w.word, "p": round(w.probability, 3)}
                     for w in (s.words or [])]
            out.append({"start": round(s.start, 2), "end": round(s.end, 2), "text": s.text.strip(), "words": words})
    return out


# ------------------------------------------------------------------ alignment with the transcript
TOKEN_RE = re.compile(r"[\wәғқңөұүһіё]+", re.I)


def _tokens(text: str) -> set[str]:
    return {t.lower()[:6] for t in TOKEN_RE.findall(text or "") if len(t) > 2}


def align(norm: dict, segs: list[dict]) -> dict:
    """Return per-message audio time and per-segment speaker labels."""
    msgs = [m for m in norm["messages"] if m["t"] is not None and m["speaker"] in ("client", "operator", "bot")
            and m["duplicate_of"] is None and len(_tokens(m["text"])) >= 2]
    matches = []  # (msg_id, offset)
    for m in msgs:
        mt = _tokens(m["text"])
        best, best_s = 0.0, None
        for s in segs:
            st = _tokens(s["text"])
            if not st:
                continue
            j = len(mt & st) / len(mt | st)
            if j > best:
                best, best_s = j, s
        if best_s is not None and best >= 0.3:
            matches.append((m["id"], best_s["start"] - m["t"], best))
    offsets = [o for _, o, _ in matches]
    global_offset = statistics.median(offsets) if offsets else None
    # robust piecewise offsets (recording pauses shift the audio clock): drop outliers, then nearest-anchor.
    anchors = []
    if global_offset is not None:
        spread = 25.0
        anchors = sorted([(mid, off) for mid, off, _ in matches if abs(off - global_offset) <= spread])
    audio_t: dict[int, float] = {}
    for m in norm["messages"]:
        if m["t"] is None:
            continue
        if anchors:
            prev = [a for a in anchors if a[0] <= m["id"]]
            off = (prev[-1] if prev else anchors[0])[1]
        elif global_offset is not None:
            off = global_offset
        else:
            off = 0.0
        audio_t[m["id"]] = round(max(0.0, m["t"] + off), 2)
    # speaker of each Whisper segment = speaker of the latest transcript line that starts before it
    # Internal consultation while the client is on hold is labelled "internal" and excluded from the metrics.
    def label(m: dict) -> str | None:
        if m["event"] == "hold_start":
            return "internal"
        if m["event"] == "hold_end":
            return "operator"  # the operator normally speaks first after taking the client off hold
        if m["speaker"] in ("client", "operator", "bot"):
            return "internal" if m.get("internal") else m["speaker"]
        return None

    timeline = sorted(((audio_t[m["id"]], label(m), m["id"]) for m in norm["messages"]
                       if m["id"] in audio_t and label(m) is not None), key=lambda x: x[0])
    def who(t: float):
        cand = [x for x in timeline if x[0] <= t + 0.5]
        return (cand[-1][1], cand[-1][2]) if cand else ("unknown", None)

    # word-level attribution (Whisper segments can span a silence and a speaker change)
    for s in segs:
        votes: dict[str, int] = {}
        for w in s["words"]:
            w["speaker"], w["mid"] = who(w["start"])
            votes[w["speaker"]] = votes.get(w["speaker"], 0) + 1
        sp, mid = who(s["start"])
        s["speaker"] = max(votes, key=votes.get) if votes else sp
        s["near_message_id"] = mid
    return {"global_offset": global_offset, "anchors": len(anchors), "matched": len(matches), "audio_t": audio_t}


# ------------------------------------------------------------------ metrics
def compute_metrics(norm: dict, vad: list[tuple[float, float]], segs: list[dict], al: dict, duration: float) -> dict:
    per: dict[str, dict] = {}
    for sp in ("operator", "client"):
        words = sorted((w for s in segs for w in s["words"] if w.get("speaker") == sp), key=lambda w: w["start"])
        # speaking time = word spans merged across short gaps (< 0.7 s); long silences are not speech
        talk = 0.0
        span_start = span_end = None
        for w in words:
            if span_end is not None and w["start"] - span_end < 0.7:
                span_end = max(span_end, w["end"])
            else:
                if span_end is not None:
                    talk += span_end - span_start
                span_start, span_end = w["start"], w["end"]
        if span_end is not None:
            talk += span_end - span_start
        probs = [w["p"] for w in words]
        per[sp] = {
            "talk_sec": round(talk, 1),
            "words": len(words),
            "wpm": round(len(words) / (talk / 60)) if talk > 10 else None,
            "confidence": round(float(np.mean(probs)) * 100, 1) if probs else None,
            "low_conf_share": round(sum(1 for p in probs if p < 0.5) / len(probs) * 100, 1) if probs else None,
        }
    # hold periods in audio time (music / silence there is expected)
    holds = []
    start = None
    for m in norm["messages"]:
        if m["event"] == "hold_start":
            start = al["audio_t"].get(m["id"])
        elif m["event"] == "hold_end" and start is not None:
            holds.append((start, al["audio_t"].get(m["id"], start)))
            start = None
    first_op = next((al["audio_t"].get(m["id"]) for m in norm["messages"] if m["speaker"] == "operator" and not m.get("internal")), 0.0) or 0.0

    def in_hold(t: float) -> bool:
        return any(a - 1 <= t <= b + 1 for a, b in holds)

    pauses = []
    for (a1, b1), (a2, _b2) in zip(vad, vad[1:]):
        gap = a2 - b1
        if gap >= 5.0 and b1 >= first_op and not in_hold(b1) and not in_hold(a2):
            near = min(al["audio_t"].items(), key=lambda kv: abs(kv[1] - a2))[0] if al["audio_t"] else None
            pauses.append({"start": round(b1, 1), "end": round(a2, 1), "sec": round(gap, 1), "before_message_id": near})
    speech_sec = sum(b - a for a, b in vad)
    return {
        "duration_sec": round(duration, 1),
        "speech_share": round(speech_sec / duration * 100, 1) if duration else None,
        "hold_sec": round(sum(b - a for a, b in holds), 1),
        "operator": per["operator"],
        "client": per["client"],
        "pauses": pauses,
        "longest_pause_sec": max((p["sec"] for p in pauses), default=0),
        "alignment": {k: al[k] for k in ("global_offset", "anchors", "matched")},
    }


def metrics_to_text(m: dict) -> str:
    op, cl = m["operator"], m["client"]
    parts = [f"длительность записи {preprocess.fmt_mmss(m['duration_sec'])}"]
    if op.get("wpm"):
        parts.append(f"темп речи оператора ≈ {op['wpm']} слов/мин" + (f" (клиента ≈ {cl['wpm']})" if cl.get("wpm") else ""))
    if op.get("confidence") is not None:
        parts.append(f"разборчивость речи оператора (средняя уверенность распознавания слов) {op['confidence']}%, "
                     f"неуверенно распознанных слов {op['low_conf_share']}%")
    if m["pauses"]:
        lp = max(m["pauses"], key=lambda p: p["sec"])
        parts.append(f"пауз тишины ≥ 5 с вне удержания: {len(m['pauses'])} (самая длинная {lp['sec']} с, перед [{lp['before_message_id']}])")
    else:
        parts.append("пауз тишины ≥ 5 с вне удержания нет")
    return "- Анализ аудиозаписи (распознавание речи + энергия сигнала): " + "; ".join(parts) + "."


# ------------------------------------------------------------------ orchestration
def analyze(cid: str, settings: dict | None = None) -> dict:
    settings = settings or db.get_settings()
    record = db.conversation_record(cid)
    if record is None:
        raise AudioError("Диалог не найден")
    if not record.get("audio_url"):
        raise AudioError("У диалога нет аудиозаписи")
    t0 = time.time()
    path = ensure_audio(cid)
    pcm = load_pcm(path)
    duration = len(pcm) / SR
    vad = energy_vad(pcm)
    segs = transcribe(pcm, WHISPER_LANG.get(record.get("language") or "", None),
                      model=settings.get("whisper_model", "small"), device=settings.get("whisper_device", "cpu"))
    norm = preprocess.normalize(record)
    al = align(norm, segs)
    metrics = compute_metrics(norm, vad, segs, al, duration)
    result = {
        "metrics": metrics,
        "segments": segs,
        "vad": vad,
        "audio_t": al["audio_t"],
        "whisper_model": settings.get("whisper_model", "small"),
        "seconds": round(time.time() - t0, 1),
    }
    db.save_audio_analysis(cid, "done", result, None)
    return result


def start_background(cid: str) -> dict:
    with _run_lock:
        if cid in _running:
            return {"status": "running"}
        _running[cid] = time.time()
    db.save_audio_analysis(cid, "running", None, None)

    def work():
        try:
            analyze(cid)
        except Exception as e:  # noqa: BLE001
            traceback.print_exc()
            db.save_audio_analysis(cid, "error", None, str(e))
        finally:
            with _run_lock:
                _running.pop(cid, None)

    threading.Thread(target=work, daemon=True, name=f"audio-{cid}").start()
    return {"status": "running"}


def ensure_for_evaluation(cid: str, settings: dict) -> dict | None:
    """Used by the evaluation worker: reuse a finished analysis or compute it synchronously."""
    if not settings.get("audio_analysis", True):
        return None
    row = db.get_audio_analysis(cid)
    if row and row["status"] == "done":
        return row["result"]
    try:
        return analyze(cid, settings)
    except Exception as e:  # noqa: BLE001
        db.save_audio_analysis(cid, "error", None, str(e))
        return None
