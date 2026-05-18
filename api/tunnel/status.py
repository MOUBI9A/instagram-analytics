"""Vercel: GET /api/tunnel/status — returns 'not_needed'.

Vercel deployments are already HTTPS, so the wizard's tunnel step is
auto-skipped on the client side.
"""

from http.server import BaseHTTPRequestHandler
import json


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        body = json.dumps({
            "status": "not_needed",
            "url": None,
            "provider": "vercel",
            "started_at": None,
            "uptime": 0,
            "error": None,
            "log_tail": [],
            "note": "Vercel deployments are HTTPS by default — no tunnel required.",
        }).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        pass
