#!/bin/sh
# Starts the local dashboard server.
# Serves the static dashboard AND a /proxy endpoint for username lookups.
cd "$(dirname "$0")" || exit 1
echo "Opening http://localhost:8000 — Ctrl+C to stop."
python3 server.py
