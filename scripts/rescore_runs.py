"""Re-score saved eval_dev runs against the current reference labels (no LLM calls).

Usage: python scripts/rescore_runs.py data/runs/probe_A*.json data/runs/probe_B*.json
"""
import json
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from backend.evaluator import normalize_answer  # noqa: E402
from backend.scoring import compute_score  # noqa: E402

labels = {}
for f in sorted((ROOT / "data" / "labels").glob("*.json")):
    labels.update(json.loads(f.read_text(encoding="utf-8")).get("labels", {}))
cl_chat = json.loads((ROOT / "backend" / "defaults" / "checklist_chat.json").read_text(encoding="utf-8"))
cl_call = json.loads((ROOT / "backend" / "defaults" / "checklist_call.json").read_text(encoding="utf-8"))

for path in sys.argv[1:]:
    for p in sorted(ROOT.glob(path)) if not Path(path).is_absolute() else [Path(path)]:
        run = json.loads(p.read_text(encoding="utf-8"))
        per = Counter()
        tot = Counter()
        errs = []
        for row in run["rows"]:
            cid = row["id"]
            if cid not in labels:
                continue
            cl = cl_call if cid.startswith("p4-") else cl_chat
            crit = {c["id"]: c for c in cl["criteria"]}
            exp = {k: normalize_answer(crit[k], v) for k, v in labels[cid].items() if k in crit}
            got = row["got"]
            for k, v in got.items():
                if k in exp:
                    tot[k] += 1
                    per[k] += int(exp[k] == v)
            if len(got) == len(crit):
                a = compute_score(cl, exp)["total"]
                b = compute_score(cl, got)["total"]
                if a is not None and b is not None:
                    errs.append(abs(a - b))
        n, ok = sum(tot.values()), sum(per.values())
        crit_str = " ".join(f"{k[:3]}={100 * per[k] / tot[k]:.0f}%" for k in sorted(tot))
        mae = f"MAE={sum(errs) / len(errs):.2f}" if errs else ""
        print(f"{p.name:40s} {ok}/{n} = {100 * ok / max(1, n):.1f}%  {mae}  | {crit_str}")
