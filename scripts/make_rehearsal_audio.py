"""Synthesise call recordings for rehearsal records with Windows TTS (System.Speech, ru-RU voice).

Each spoken line is placed at its transcript timestamp (relative to the first one); speakers get different pitch.
Usage: python scripts/make_rehearsal_audio.py <records.json> <out_audio_dir>
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
import tempfile
import wave
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from backend import preprocess  # noqa: E402

SR = 16000
PITCH = {"operator": "medium", "client": "x-low", "bot": "high"}
RATE = {"operator": "0%", "client": "-5%", "bot": "+5%"}


def xml_escape(s: str) -> str:
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")


def main() -> None:
    payload = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    records = payload["data"]["records"] if isinstance(payload, dict) else payload
    out = Path(sys.argv[2])
    out.mkdir(parents=True, exist_ok=True)
    tmp = Path(tempfile.mkdtemp(prefix="cqa_tts_"))
    jobs = []
    for r in records:
        if r.get("channel") == "agent chat":
            continue
        norm = preprocess.normalize(r)
        for m in norm["messages"]:
            if m["speaker"] not in PITCH or m["duplicate_of"] is not None or m["t"] is None:
                continue
            text = re.sub(r"\[[^\]]*\]", "", m["text"]).strip() or "э"
            ssml = (f'<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="ru-RU">'
                    f'<prosody pitch="{PITCH[m["speaker"]]}" rate="{RATE[m["speaker"]]}">{xml_escape(text)}</prosody></speak>')
            wav = tmp / f"{r['conversation_id']}_{m['id']}.wav"
            jobs.append((r["conversation_id"], m["t"], wav, ssml))
    # one PowerShell process synthesises everything
    ps = ["Add-Type -AssemblyName System.Speech",
          "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer",
          "$s.SelectVoice('Microsoft Irina Desktop')",
          "$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)"]
    for _cid, _t, wav, ssml in jobs:
        ssml_ps = ssml.replace("'", "''")
        ps.append(f"$s.SetOutputToWaveFile('{wav}', $fmt); $s.SpeakSsml('{ssml_ps}')")
    ps.append("$s.SetOutputToNull()")
    script = tmp / "tts.ps1"
    script.write_text("\n".join(ps), encoding="utf-8-sig")
    subprocess.run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(script)], check=True)

    by_call: dict[str, list] = {}
    for cid, t, wav, _ in jobs:
        by_call.setdefault(cid, []).append((t, wav))
    for cid, items in by_call.items():
        items.sort()
        cursor = 0.0
        pieces = []
        for t, wav in items:
            with wave.open(str(wav)) as w:
                pcm = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768
            start = max(t, cursor)  # if the previous line ran long, shift (the analyser re-aligns automatically)
            pieces.append((start, pcm))
            cursor = start + len(pcm) / SR + 0.25
        total = int((cursor + 1.0) * SR)
        mix = np.zeros(total, dtype=np.float32)
        for start, pcm in pieces:
            i = int(start * SR)
            mix[i:i + len(pcm)] += pcm[: max(0, total - i)]
        mix += np.random.default_rng(0).normal(0, 0.002, size=len(mix)).astype(np.float32)  # line noise
        mix = np.clip(mix, -1, 1)
        dest = out / f"{cid}.wav"
        with wave.open(str(dest), "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(SR)
            w.writeframes((mix * 32767).astype(np.int16).tobytes())
        print(f"{cid}: {len(items)} lines, {len(mix) / SR:.0f} s -> {dest}")


if __name__ == "__main__":
    main()
