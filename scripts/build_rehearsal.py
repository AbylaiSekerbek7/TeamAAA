"""Build the rehearsal control set from the generation workflow output.

Usage: python scripts/build_rehearsal.py <workflow_output.json> [mock_port]
Writes tests/rehearsal/REHEARSAL.json (organisers' API format) and data/labels/rehearsal_labels.json (ground truth).
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
KEYMAP = {"c01": "c01_contact", "c02": "c02_needs", "c03": "c03_identification", "c04": "c04_consultation",
          "c05": "c05_empathy", "c06": "c06_dialog", "c07": "c07_closing", "c08": "c08_gross"}

raw = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
items = raw.get("result", raw) if isinstance(raw, dict) else raw
if isinstance(items, str):
    items = json.loads(items)
port = int(sys.argv[2]) if len(sys.argv) > 2 else 8765

records, labels, report = [], {}, []
for it in items:
    voice = it["channel"] != "agent chat"
    records.append({
        "conversation_id": it["id"],
        "channel": it["channel"],
        "language": it["language"],
        "transcript": [{"timestamp": m["timestamp"], "speaker": m["speaker"], "text": m["text"]} for m in it["transcript"]],
        "audio_url": f"http://127.0.0.1:{port}/player/{it['id']}?api-version=1&sig=rehearsal" if voice else None,
    })
    lab = {}
    for k, v in it["final"].items():
        lab[KEYMAP[k]] = int(v) if str(v).isdigit() else v
    labels[it["id"]] = lab
    report.append((it["id"], len(it["transcript"]), len(it["disagreements"]),
                   "; ".join(f"{d['criterion']}: intended={d['intended']} blind={[b['a'] if b else None for b in d['blind']]}"
                             for d in it["disagreements"])))

out = ROOT / "tests" / "rehearsal"
out.mkdir(parents=True, exist_ok=True)
envelope = {"error": "", "isSuccess": True,
            "data": {"dataset_group_id": "REHEARSAL", "total_records": len(records), "records": records}}
(out / "REHEARSAL.json").write_text(json.dumps(envelope, ensure_ascii=False, indent=1), encoding="utf-8")
(ROOT / "data" / "labels" / "rehearsal_labels.json").write_text(json.dumps(
    {"source": "Репетиция контроля: синтетические диалоги, эталон = большинство (задуманная разметка + 2 слепых разметчика)",
     "labels": labels}, ensure_ascii=False, indent=1), encoding="utf-8")
for r in report:
    print(*r, sep=" | ")
print("written", out / "REHEARSAL.json")
