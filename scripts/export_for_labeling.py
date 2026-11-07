"""Export DEV transcripts as numbered plain-text files for independent labelling."""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from backend import preprocess  # noqa: E402

out = Path(sys.argv[1])
out.mkdir(parents=True, exist_ok=True)
data = json.loads((ROOT / "data" / "dev.json").read_text(encoding="utf-8"))
records = data["data"]["records"]


def render(r):
    norm = preprocess.normalize(r)
    lines = [f"=== DIALOG {r['conversation_id']} | channel: {r['channel']} | language: {r['language']}"]
    for m in norm["messages"]:
        tag = m["speaker"].upper()
        if m.get("internal"):
            tag += " (internal consultation with a colleague while the client is ON HOLD - not addressed to the client)"
        if m["duplicate_of"] is not None:
            tag += f" (ASR duplicate of [{m['duplicate_of']}])"
        lines.append(f"[{m['id']}] {m['t_label']} {tag}: {m['text']}")
    return "\n".join(lines)


chats = [r for r in records if r["channel"] == "agent chat"]
calls = [r for r in records if r["channel"] != "agent chat"]
for k in range(0, len(chats), 10):
    batch = chats[k:k + 10]
    (out / f"chats_batch_{k // 10 + 1}.txt").write_text("\n\n".join(render(r) for r in batch), encoding="utf-8")
for r in calls:
    (out / f"call_{r['conversation_id']}.txt").write_text(render(r), encoding="utf-8")
print(json.dumps({
    "chat_batches": [{"file": str(out / f"chats_batch_{k // 10 + 1}.txt"), "ids": [r["conversation_id"] for r in chats[k:k + 10]]}
                     for k in range(0, len(chats), 10)],
    "calls": [{"file": str(out / f"call_{r['conversation_id']}.txt"), "id": r["conversation_id"]} for r in calls],
}, ensure_ascii=False))
