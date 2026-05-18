"""Vercel serverless function: GET /api/image?url=...

CORS-friendly image proxy for Instagram CDN hosts only.
"""

from http.server import BaseHTTPRequestHandler
import urllib.request
import urllib.parse


UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15"
)
ALLOWED_IMG_HOSTS = ("cdninstagram.com", "fbcdn.net")


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        params = urllib.parse.parse_qs(parsed.query)
        url = (params.get("url") or [""])[0]

        if not url:
            return self._send_err(400, "missing url")
        target = urllib.parse.urlparse(url)
        if target.scheme not in ("http", "https"):
            return self._send_err(400, "bad scheme")
        host = (target.hostname or "").lower()
        if not any(host.endswith(h) for h in ALLOWED_IMG_HOSTS):
            return self._send_err(403, "host not allowed")

        try:
            req = urllib.request.Request(
                url,
                headers={"User-Agent": UA, "Referer": "https://www.instagram.com/"},
            )
            with urllib.request.urlopen(req, timeout=15) as resp:
                body = resp.read()
                ctype = resp.headers.get("Content-Type", "image/jpeg")
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Cache-Control", "public, max-age=3600")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except Exception as e:
            self._send_err(502, str(e))

    def _send_err(self, code, msg):
        body = msg.encode()
        self.send_response(code)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        pass
