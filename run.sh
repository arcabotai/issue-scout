#!/usr/bin/env bash
# One command: ./run.sh   (needs META_API_KEY in env or .env)
set -e
cd "$(dirname "$0")"
[ -f .env ] && set -a && . ./.env && set +a
[ -d .venv ] || python3 -m venv .venv
.venv/bin/pip install -q -r requirements.txt
exec .venv/bin/uvicorn app:app --host 0.0.0.0 --port "${PORT:-8000}"
