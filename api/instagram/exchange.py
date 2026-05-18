"""Vercel: POST /api/instagram/exchange

Exchanges an Instagram OAuth `code` for an access_token. Required step
in the Instagram Login flow — must be server-side because it needs the
Instagram App Secret which can never live in client JS.

After getting the short-lived token (1 hour TTL), immediately exchange
it for a long-lived token (60 days) so the dashboard keeps working.
"""

from http.server import BaseHTTPRequestHandler
import urllib.request
import urllib.parse
import urllib.error
import json


def http_post(url, data, headers=None):
    h = {"Content-Type": "application/x-www-form-urlencoded"}
    if headers:
        h.update(headers)
    body = urllib.parse.urlencode(data).encode()
    req = urllib.request.Request(url, data=body, headers=h, method="POST")
    with urllib.request.urlopen(req, timeout=20) as resp:
        return json.loads(resp.read().decode("utf-8"))


def http_get(url, headers=None):
    req = urllib.request.Request(url, headers=headers or {})
    with urllib.request.urlopen(req, timeout=20) as resp:
        return json.loads(resp.read().decode("utf-8"))


class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
            body = self.rfile.read(length).decode("utf-8")
            req = json.loads(body or "{}")
            code = req.get("code", "")
            client_id = req.get("client_id", "")
            client_secret = req.get("client_secret", "")
            redirect_uri = req.get("redirect_uri", "")

            if not (code and client_id and client_secret and redirect_uri):
                return self._send({"error": "missing code, client_id, client_secret, or redirect_uri"}, 400)

            # Step 1: short-lived token
            try:
                short = http_post(
                    "https://api.instagram.com/oauth/access_token",
                    {
                        "client_id": client_id,
                        "client_secret": client_secret,
                        "grant_type": "authorization_code",
                        "redirect_uri": redirect_uri,
                        "code": code,
                    },
                )
            except urllib.error.HTTPError as e:
                err_body = e.read().decode("utf-8", errors="replace")
                return self._send({"error": f"short-token exchange failed: {err_body}"}, 502)

            access_token = short.get("access_token")
            user_id = short.get("user_id")
            if not access_token:
                return self._send({"error": "Instagram returned no access_token", "raw": short}, 502)

            # Step 2: exchange for a long-lived token (60-day TTL)
            try:
                long_lived = http_get(
                    "https://graph.instagram.com/access_token?" + urllib.parse.urlencode({
                        "grant_type": "ig_exchange_token",
                        "client_secret": client_secret,
                        "access_token": access_token,
                    })
                )
                long_token = long_lived.get("access_token") or access_token
                expires_in = long_lived.get("expires_in", 3600)
                token_type = long_lived.get("token_type", "bearer")
            except Exception:
                # If long-lived exchange fails, return the short one — still usable
                long_token = access_token
                expires_in = 3600
                token_type = "bearer"

            return self._send({
                "access_token": long_token,
                "user_id": user_id,
                "expires_in": expires_in,
                "token_type": token_type,
            }, 200)
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
