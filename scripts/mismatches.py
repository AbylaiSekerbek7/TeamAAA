"""List mismatches of a saved run against the current reference labels.

Usage: python scripts/mismatches.py data/runs/full_qwen35_v4.json [c04_consultation,c02_needs]
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from backend.evaluator import normalize_answer  # noqa: E402

labels = {}
for f in sorted((ROOT / "data" / "labels").glob("*.json")):
    labels.update(json.loads(f.read_text(encoding="utf-8")).get("labels", {}))
cls = {k: json.loads((ROOT / "backend" / "defaults" / f"checklist_{k}.json").read_text(encoding="utf-8")) for k in ("chat", "call")}
run = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
only = set(sys.argv[2].split(",")) if len(sys.argv) > 2 else None
for row in run["rows"]:
    cid = row["id"]
    cl = cls["call" if cid.startswith("p4-") else "chat"]
    crit = {c["id"]: c for c in cl["criteria"]}
    for k, got in row["got"].items():
        if only and k not in only:
            continue
        exp = normalize_answer(crit[k], labels.get(cid, {}).get(k))
        if exp != got:
            expl = (row["results"].get(k) or {}).get("explanation", "")
            print(f"{cid} {k} exp={exp} got={got} :: {expl[:220]}")
