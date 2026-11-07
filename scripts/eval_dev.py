"""Accuracy harness: run the evaluator on DEV chats and compare with reference labels.

Examples:
  python -m scripts.eval_dev                         # all labelled chats, all criteria
  python -m scripts.eval_dev --criteria c07_closing  # tune one criterion
  python -m scripts.eval_dev --pattern "p1-ru-0[01]" --votes 3
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import time
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backend import db, preprocess  # noqa: E402
from backend.evaluator import SYSTEM_PROMPT, dialog_block, evaluate_criterion, fit_context, normalize_answer  # noqa: E402
from backend.llm import make_client  # noqa: E402
from backend.scoring import compute_score  # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=str(ROOT / "data" / "dev.json"))
    ap.add_argument("--labels", default=str(ROOT / "data" / "labels"), help="labels JSON file or a folder of them")
    ap.add_argument("--checklist", default="", help="force one checklist; default = chat/call checklist by channel")
    ap.add_argument("--pattern", default=r"^p1-")
    ap.add_argument("--criteria", default="")
    ap.add_argument("--model", default=None)
    ap.add_argument("--votes", type=int, default=1)
    ap.add_argument("--think", action="store_true")
    ap.add_argument("--no-auto", action="store_true", help="disable rule auto-checks (pure LLM)")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--out", default="")
    args = ap.parse_args()

    data_path = Path(args.data)
    if not data_path.exists():
        import httpx
        from backend.datasource import _with_group
        url = _with_group(db.DEFAULT_SETTINGS["org_api_url"], "DEV")
        data_path.parent.mkdir(parents=True, exist_ok=True)
        data_path.write_text(httpx.get(url, timeout=120).text, encoding="utf-8")
    payload = json.loads(data_path.read_text(encoding="utf-8"))
    records = {r["conversation_id"]: r for r in payload["data"]["records"]}
    labels: dict = {}
    lp = Path(args.labels)
    for f in ([lp] if lp.is_file() else sorted(lp.glob("*.json"))):
        labels.update(json.loads(f.read_text(encoding="utf-8")).get("labels", {}))
    defaults = ROOT / "backend" / "defaults"
    cl_chat = json.loads(Path(args.checklist or defaults / "checklist_chat.json").read_text(encoding="utf-8"))
    cl_call = json.loads(Path(args.checklist or defaults / "checklist_call.json").read_text(encoding="utf-8"))
    wanted = set(filter(None, args.criteria.split(",")))

    settings = dict(db.DEFAULT_SETTINGS)
    if args.model:
        settings["model"] = args.model
    settings["votes"] = args.votes
    settings["think"] = args.think
    client = make_client(settings)

    ids = [cid for cid in records if re.search(args.pattern, cid) and cid in labels]
    if args.limit:
        ids = ids[: args.limit]
    per = {c["id"]: Counter() for c in cl_chat["criteria"] if not wanted or c["id"] in wanted}
    mism = []
    out_rows = []
    total_err = []
    t0 = time.time()
    for n, cid in enumerate(ids, 1):
        rec = records[cid]
        checklist = cl_call if rec.get("channel") != "agent chat" else cl_chat
        criteria = [c for c in checklist["criteria"] if not wanted or c["id"] in wanted]
        system_prompt = SYSTEM_PROMPT.format(general_rules=checklist.get("general_rules", ""))
        norm = preprocess.normalize(rec)
        facts = preprocess.compute_facts(rec, norm)
        if rec.get("audio_url"):
            aa = db.get_audio_analysis(cid)
            if aa and aa.get("status") == "done" and aa.get("result"):
                facts["audio_metrics"] = aa["result"]["metrics"]
        dialog_text = dialog_block(rec, norm, facts)
        run_settings = fit_context(settings, system_prompt, dialog_text, checklist)
        got = {}
        res = {}
        for c in criteria:
            r = evaluate_criterion(client, run_settings, system_prompt, dialog_text, c, len(norm["messages"]) - 1,
                                   None if args.no_auto else facts)
            got[c["id"]] = r.get("answer")
            res[c["id"]] = r
            exp = normalize_answer(c, labels[cid].get(c["id"]))
            ok = exp == r.get("answer")
            per[c["id"]]["n"] += 1
            per[c["id"]]["ok"] += int(ok)
            if not ok:
                mism.append((cid, c["id"], exp, r.get("answer"), r.get("explanation", "")[:160]))
        if not args.no_auto:
            from backend import autochecks
            for cid_changed in autochecks.reconcile(checklist, res):
                got[cid_changed] = res[cid_changed]["answer"]
        exp_s = got_s = None
        if not wanted:
            exp_s = compute_score(checklist, {c["id"]: normalize_answer(c, labels[cid].get(c["id"])) for c in criteria})["total"]
            got_s = compute_score(checklist, got)["total"]
            if exp_s is not None and got_s is not None:
                total_err.append(abs(exp_s - got_s))
        out_rows.append({"id": cid, "got": got, "exp_total": exp_s, "got_total": got_s, "results": res})
        el = time.time() - t0
        print(f"[{n}/{len(ids)}] {cid} {el / n:.1f}s/dialog  " + " ".join(
            f"{k[:3]}={'+' if normalize_answer(next(c for c in criteria if c['id']==k), labels[cid].get(k)) == v else '-'}{v}"
            for k, v in got.items()), flush=True)

    print("\n=== Accuracy by criterion ===")
    all_n = all_ok = 0
    for cid, cnt in per.items():
        all_n += cnt["n"]
        all_ok += cnt["ok"]
        print(f"{cid:22s} {cnt['ok']:3d}/{cnt['n']:<3d} {100 * cnt['ok'] / max(1, cnt['n']):5.1f}%")
    print(f"{'ALL':22s} {all_ok:3d}/{all_n:<3d} {100 * all_ok / max(1, all_n):5.1f}%")
    if total_err:
        print(f"Total score MAE: {sum(total_err) / len(total_err):.2f}  exact: {sum(1 for e in total_err if e < 0.005)}/{len(total_err)}")
    print("\n=== Mismatches (id, criterion, expected, got, explanation) ===")
    for m in mism:
        print(" | ".join(str(x) for x in m))
    out = Path(args.out or (ROOT / "data" / "runs" / f"run_{int(time.time())}.json"))
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({"args": vars(args), "rows": out_rows}, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"\nSaved: {out}  ({time.time() - t0:.0f}s)")


if __name__ == "__main__":
    main()
