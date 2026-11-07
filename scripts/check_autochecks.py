"""Compare rule auto-checks with the reference labels on all DEV chats."""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from backend import autochecks, preprocess  # noqa: E402

cl = json.loads((ROOT / "backend" / "defaults" / "checklist_chat.json").read_text(encoding="utf-8"))
ref = json.loads((ROOT / "data" / "labels" / "dev_reference_labels.json").read_text(encoding="utf-8"))["labels"]
data = json.loads((ROOT / "data" / "dev.json").read_text(encoding="utf-8"))["data"]["records"]
crit = {c["id"]: c for c in cl["criteria"]}
for k in ("c01_contact", "c07_closing"):
    ok = n = left = 0
    for r in data:
        if r["channel"] != "agent chat":
            continue
        f = preprocess.compute_facts(r, preprocess.normalize(r))
        a = autochecks.run(crit[k], f)
        if a is None:
            left += 1
            print(f"  LLM  {r['conversation_id']} {k} ref={ref[r['conversation_id']][k]} closing=«{f.get('closing_text', '')[:70]}»")
            continue
        n += 1
        good = a["answer"] == ref[r["conversation_id"]][k]
        ok += good
        if not good:
            print(f"  MISMATCH {r['conversation_id']} {k} rule={a['answer']} ref={ref[r['conversation_id']][k]} "
                  f"rest=«{autochecks.strip_courtesy(f.get('closing_text', ''))}» closing=«{f.get('closing_text', '')[:80]}»")
    print(f"{k}: rule decided {n}, correct {ok}, left to LLM {left}")
