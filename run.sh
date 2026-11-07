#!/usr/bin/env bash
# CQA — запуск на Linux/macOS: ./run.sh
set -e
cd "$(dirname "$0")"
if [ ! -x .venv/bin/python ]; then
  python3 -m venv .venv
  .venv/bin/pip install --upgrade pip
  .venv/bin/pip install -r requirements.txt
fi
export OLLAMA_FLASH_ATTENTION=1 OLLAMA_KV_CACHE_TYPE=q8_0
curl -s http://127.0.0.1:11434/api/version >/dev/null || (ollama serve >/dev/null 2>&1 &) ; sleep 2
echo "CQA: http://127.0.0.1:8000"
exec .venv/bin/python -m uvicorn backend.app:app --host 127.0.0.1 --port 8000
