"""Local stand-in for the organisers' API — for rehearsing the control step end to end.

Serves, like the real Power Automate endpoints:
  GET /api?group_id=XXX            -> {"error":"","isSuccess":true,"data":{"dataset_group_id":..,"total_records":..,"records":[..]}}
  GET /player/<conversation_id>    -> HTML player page whose <source src> points to the recording (absolute URL)
  GET /files/<name>.wav            -> the recording

Usage: python scripts/mock_org_api.py <folder> [port]
  <folder>/<GROUP>.json   records list or full API envelope
  <folder>/audio/<conversation_id>.wav   optional recordings
"""
from __future__ import annotations

import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

FOLDER = Path(sys.argv[1])
PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 8765

PLAYER = """<!DOCTYPE html><html><head><meta charset="utf-8"><title>Воспроизведение записи</title></head><body>
<h3>Запись разговора</h3>
<audio id="myAudio" controls style="width:100%;"><source src="{src}" type="audio/wav">Ваш браузер не поддерживает аудиоплеер.</audio>
</body></html>"""


class Handler(BaseHTTPRequestHandler):
    def _send(self, code: int, body: bytes, ctype: str) -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Accept-Ranges", "bytes")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def do_HEAD(self) -> None:  # noqa: N802
        self.do_GET()

    def do_GET(self) -> None:  # noqa: N802
        u = urlparse(self.path)
        if u.path == "/api":
            gid = (parse_qs(u.query).get("group_id") or [""])[0]
            f = FOLDER / f"{gid}.json"
            if not f.exists():
                body = {"error": f"group {gid} not found", "isSuccess": False, "data": None}
                return self._send(200, json.dumps(body, ensure_ascii=False).encode(), "application/json; charset=utf-8")
            payload = json.loads(f.read_text(encoding="utf-8"))
            if isinstance(payload, list):
                payload = {"error": "", "isSuccess": True,
                           "data": {"dataset_group_id": gid, "total_records": len(payload), "records": payload}}
            return self._send(200, json.dumps(payload, ensure_ascii=False).encode(), "application/json; charset=utf-8")
        if u.path.startswith("/player/"):
            cid = u.path.rsplit("/", 1)[-1]
            src = f"http://127.0.0.1:{PORT}/files/{cid}.wav?sig=rehearsal"
            return self._send(200, PLAYER.format(src=src).encode(), "text/html; charset=utf-8")
        if u.path.startswith("/files/"):
            f = FOLDER / "audio" / u.path.rsplit("/", 1)[-1]
            if f.exists():
                return self._send(200, f.read_bytes(), "audio/wav")
        self._send(404, b"not found", "text/plain")

    def log_message(self, *args) -> None:  # quiet
        pass


if __name__ == "__main__":
    print(f"mock organisers API on http://127.0.0.1:{PORT}/api?group_id=... serving {FOLDER}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
