"""Vercel: GET /api/parse-export?path=… — not supported on serverless.

The local server.py reads a zip from a path under the user's home directory.
On Vercel there is no shared filesystem with the user. The dashboard's UI
has a drag-and-drop flow that parses the zip in the browser with JSZip,
which works everywhere. This stub returns a clear error.
"""

from http.server import BaseHTTPRequestHandler
import json


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        body = json.dumps({
            "error": "Server-side path parsing is disabled on this deployment. Drag the export .zip into the dashboard instead — it parses in your browser.",
            "available": False,
        }).encode()
        self.send_response(400)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        pass
