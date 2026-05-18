"""Vercel: GET /api/cache/list — returns empty.

The disk cache that server.py keeps in ./data/lookups/ does not persist
between serverless invocations on Vercel. The frontend's localStorage-based
Concept Studio history continues to work; this endpoint just keeps the
client's sync call from erroring.
"""

from http.server import BaseHTTPRequestHandler
import json


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        body = json.dumps({"accounts": [], "note": "no persistent cache on serverless"}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        pass
