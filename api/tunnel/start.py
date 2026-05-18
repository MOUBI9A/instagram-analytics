"""Vercel: POST /api/tunnel/start — returns 'not_needed'."""

from http.server import BaseHTTPRequestHandler
import json


class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        body = json.dumps({
            "status": "not_needed",
            "url": None,
            "provider": "vercel",
            "started_at": None,
            "uptime": 0,
            "error": None,
            "log_tail": [],
            "note": "This deployment is HTTPS — no tunnel needed.",
        }).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        return self.do_POST()

    def log_message(self, fmt, *args):
        pass
