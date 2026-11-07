"""Print the end of every DEV dialog (for re-labelling criterion 07)."""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from backend import preprocess  # noqa: E402

data = json.loads((ROOT / "data" / "dev.json").read_text(encoding="utf-8"))["data"]["records"]
out = []
for r in data:
    n = preprocess.normalize(r)
    f = preprocess.compute_facts(r, n)
    lo = f["last_operator_message_id"]
    msgs = n["messages"]
    start = max(0, (lo or len(msgs)) - 2)
    tail = [m for m in msgs[start:] if not m.get("internal")]
    out.append({"id": r["conversation_id"], "tail": [f"[{m['id']}] {m['speaker'].upper()}: {m['text']}" for m in tail]})
json.dump(out, sys.stdout, ensure_ascii=False, indent=1)
