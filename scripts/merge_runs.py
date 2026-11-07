"""Merge a base run with criterion overrides from another run, save and score.

Usage: python scripts/merge_runs.py base.json override.json out.json
"""
import json
import sys
from pathlib import Path

base = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
over = {r["id"]: r for r in json.loads(Path(sys.argv[2]).read_text(encoding="utf-8"))["rows"]}
for row in base["rows"]:
    o = over.get(row["id"])
    if o:
        row["got"].update(o["got"])
        row["results"].update(o["results"])
Path(sys.argv[3]).write_text(json.dumps(base, ensure_ascii=False), encoding="utf-8")
print("merged ->", sys.argv[3])
