"""Merge judge reconciliation output (reference-labels workflow) with team labels.

Usage: python scripts/merge_judge_labels.py <workflow_output.json> [--write]
Prints disagreements with the current team labels and the judges' policy notes.
With --write, saves data/labels/dev_reference_labels.json (judge-final answers for all dialogs).
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
KEYMAP = {"c01": "c01_contact", "c02": "c02_needs", "c03": "c03_identification", "c04": "c04_consultation",
          "c05": "c05_empathy", "c06": "c06_dialog", "c07": "c07_closing", "c08": "c08_gross"}


def norm(v):
    if v is None:
        return None
    s = str(v).strip().lower()
    return int(s) if s.isdigit() else s


raw = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
data = raw.get("result", raw) if isinstance(raw, dict) else raw
if isinstance(data, str):
    data = json.loads(data)
team = json.loads((ROOT / "data" / "labels" / "dev_team_labels.json").read_text(encoding="utf-8"))["labels"]

final, notes, contested = {}, [], []
for item in data:
    verdict = item["final"] or {}
    notes += [f"[{item['item']}] {n}" for n in verdict.get("policy_notes", [])]
    lab_by_id = {}
    for lab in item["labellers"]:
        for d in lab["dialogs"]:
            lab_by_id.setdefault(d["id"], []).append({c["criterion"]: norm(c["answer"]) for c in d["criteria"]})
    for d in verdict.get("dialogs", []):
        ans = {KEYMAP[c["criterion"]]: norm(c["answer"]) for c in d["criteria"]}
        why = {KEYMAP[c["criterion"]]: (c["why"], c["confidence"]) for c in d["criteria"]}
        final[d["id"]] = ans
        t = team.get(d["id"], {})
        for k, v in ans.items():
            labs = [l.get(k[:3]) for l in lab_by_id.get(d["id"], [])]
            tv = norm(t.get(k)) if t else None
            if t and tv != v:
                contested.append((d["id"], k, f"team={tv}", f"judge={v}", f"labellers={labs}", why[k][1], why[k][0]))

print(f"dialogs with judge labels: {len(final)}")
print(f"\n=== Judge vs team disagreements ({len(contested)}) ===")
for c in contested:
    print(" | ".join(str(x) for x in c))
print("\n=== Calls (judge final) ===")
for cid, ans in final.items():
    if cid.startswith("p4-"):
        print(cid, ans)
print(f"\n=== Policy notes ({len(notes)}) ===")
for n in notes:
    print("-", n)

if "--write" in sys.argv:
    out = {"source": "Независимая двойная разметка по PDF + судья (сверено с разметкой команды). Не эталон организаторов.",
           "labels": final}
    (ROOT / "data" / "labels" / "dev_reference_labels.json").write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print("\nwritten data/labels/dev_reference_labels.json")
