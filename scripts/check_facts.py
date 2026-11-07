"""Print deterministic facts for every DEV dialog (sanity check of keyword detectors)."""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from backend import preprocess  # noqa: E402

data = json.loads((ROOT / "data" / "dev.json").read_text(encoding="utf-8"))
labels = json.loads((ROOT / "data" / "labels" / "dev_team_labels.json").read_text(encoding="utf-8"))["labels"]
for r in data["data"]["records"]:
    norm = preprocess.normalize(r)
    f = preprocess.compute_facts(r, norm)
    fo = f["first_operator_checks"] or {}
    lo = f["last_operator_checks"] or {}
    lab = labels.get(r["conversation_id"], {})
    c01 = "yes" if fo.get("greeting") and fo.get("name") and fo.get("language") == f["client_language"] else "no"
    flag01 = "" if not lab or lab.get("c01_contact") == c01 else "  <-- c01 mismatch"
    end = (f["ending"] or {}).get("event")
    print(f"{r['conversation_id']:10s} greet={fo.get('greeting')!s:14s} name={fo.get('name')!s:14s} lang={fo.get('language')}/{f['client_language']} "
          f"farewell={lo.get('farewell')!s:14s} end={end!s:16s} c07={lab.get('c07_closing')}{flag01}")
