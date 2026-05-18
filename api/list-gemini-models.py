"""Vercel serverless function: POST /api/list-gemini-models

Returns the Gemini models that support generateContent for a given API key.
"""

from http.server import BaseHTTPRequestHandler
import urllib.request
import urllib.parse
import json


class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
            body = self.rfile.read(length).decode("utf-8")
            req = json.loads(body or "{}")
            api_key = req.get("api_key", "")
            if not api_key:
                return self._send({"error": "missing api_key"}, 400)
            url = f"https://generativelanguage.googleapis.com/v1beta/models?key={urllib.parse.quote(api_key)}"
            with urllib.request.urlopen(urllib.request.Request(url), timeout=20) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            models = []
            for m in (data.get("models") or []):
                name = m.get("name", "").replace("models/", "")
                methods = m.get("supportedGenerationMethods") or []
                if "generateContent" in methods:
                    models.append({
                        "id": name,
                        "label": m.get("displayName") or name,
                        "description": (m.get("description") or "")[:200],
                    })
            return self._send({"models": models}, 200)
        except Exception as e:
            return self._send({"error": str(e)}, 500)

    def do_GET(self):
        return self._send({"error": "POST only"}, 405)

    def _send(self, obj, status=200):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        pass
