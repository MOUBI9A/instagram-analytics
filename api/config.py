"""Vercel: GET /api/config — frontend bootstrap config.

Reads from env vars (set in Vercel → Project Settings → Environment Variables):
  - SUPABASE_URL          → supabaseUrl
  - SUPABASE_ANON_KEY     → supabaseAnonKey  (publishable key or legacy anon)

If either is unset, the response is `{}` and the frontend falls back to
demo mode. The endpoint never returns secrets — only the public, browser-
safe values.
"""

from http.server import BaseHTTPRequestHandler
import json
import os


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        cfg = {}
        url = os.environ.get("SUPABASE_URL")
        key = os.environ.get("SUPABASE_ANON_KEY")
        if url and key:
            cfg["supabaseUrl"] = url
            cfg["supabaseAnonKey"] = key
        body = json.dumps(cfg).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        pass
