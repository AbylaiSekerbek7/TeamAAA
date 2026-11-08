"""Stress test for criterion 07 «Завершение» on edge-case chat endings.

Input: a JSON file {"cases": [{"id", "lang", "transcript", "consensus"|"expected", ...}]}
(e.g. tests/c07_stress/cases.json — generated endings labelled blind by the organisers' definition).

For every case the deterministic rule decides first; if the rule abstains and --llm is given, the LLM
judges with the same prompt as in production. Prints the confusion table and every disagreement.

    python -m scripts.c07_stress tests/c07_stress/cases.json [--llm] [--only-unanimous]
"""
from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from backend import autochecks, db, evaluator, preprocess  # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("cases")
    ap.add_argument("--llm", action="store_true", help="ask the model when the rule abstains")
    ap.add_argument("--only-unanimous", action="store_true")
    ap.add_argument("--out", help="write per-case results to this JSON file")
    args = ap.parse_args()

    cases = json.loads(Path(args.cases).read_text(encoding="utf-8"))["cases"]
    checklist = json.loads((ROOT / "backend" / "defaults" / "checklist_chat.json").read_text(encoding="utf-8"))
    crit = next(c for c in checklist["criteria"] if c["id"] == "c07_closing")
    settings = db.get_settings() if args.llm else {}
    client = evaluator.make_client(settings) if args.llm else None

    conf: Counter = Counter()
    rows, misses = [], []
    for case in cases:
        gold = case.get("consensus") or case.get("expected")
        if not gold or (args.only_unanimous and not case.get("unanimous", True)):
            continue
        rec = {"conversation_id": case["id"], "channel": "agent chat", "language": case.get("lang", "").upper(),
               "transcript": case["transcript"]}
        norm = preprocess.normalize(rec)
        facts = preprocess.compute_facts(rec, norm)
        auto = autochecks.run(crit, facts)
        source, got, expl = "rule", None, ""
        if auto is not None:
            got, expl = auto["answer"], auto["explanation"]
        elif client is not None:
            system_prompt = evaluator.SYSTEM_PROMPT.format(general_rules=checklist.get("general_rules", "").strip())
            dialog = evaluator.dialog_block(rec, norm, facts)
            s = evaluator.fit_context(settings, system_prompt, dialog, checklist)
            r = evaluator.evaluate_criterion(client, s, system_prompt, dialog, crit,
                                             max_id=len(norm["messages"]) - 1, facts=None)
            source, got, expl = "llm", r.get("answer"), r.get("explanation", "")
        else:
            source = "abstain"
        conf[(gold, got if got else "—")] += 1
        row = {"id": case["id"], "category": case.get("category"), "gold": gold, "got": got, "source": source,
               "unanimous": case.get("unanimous"), "explanation": expl,
               "ending": [f"{m['speaker']}: {m['text']}" for m in case["transcript"][-4:]]}
        rows.append(row)
        if got != gold:
            misses.append(row)

    n = len(rows)
    ok = n - len(misses)
    decided = [r for r in rows if r["got"]]
    print(f"cases: {n}, correct: {ok} ({ok / max(1, n):.1%}), rule decided: {sum(r['source'] == 'rule' for r in rows)}, "
          f"llm: {sum(r['source'] == 'llm' for r in rows)}, abstained: {n - len(decided)}")
    print("confusion (gold -> got):", dict(conf))
    for r in misses:
        print(f"\n[{r['id']}] cat {r['category']} gold={r['gold']} got={r['got']} ({r['source']}, unanimous={r['unanimous']})")
        for line in r["ending"]:
            print("   ", line[:160])
        if r["explanation"]:
            print("    ->", r["explanation"][:200])
    if args.out:
        Path(args.out).write_text(json.dumps(rows, ensure_ascii=False, indent=1), encoding="utf-8")


if __name__ == "__main__":
    main()
