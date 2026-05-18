#!/usr/bin/env python3
"""Local server: static dashboard + Instagram public-profile proxy.

Endpoints
---------
GET /            → static files (index.html, etc.)
GET /api/lookup?username=X
                 → JSON with profile + recent posts. Uses Instagram's
                   public web_profile_info endpoint (no auth) and falls
                   back to OG meta tag scraping if it fails.
GET /api/image?url=...
                 → CORS-friendly image proxy (instagram.com CDN only).
"""

import http.server
import socketserver
import urllib.request
import urllib.parse
import urllib.error
import os
import sys
import re
import json
import gzip
import io
import time
import subprocess
import threading
import shlex

PORT = 8000
ROOT = os.path.dirname(os.path.abspath(__file__))
WEB_APP_ID = "936619743392459"  # Instagram's public web client ID (hard-coded in their JS)
UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15"
)
ALLOWED_IMG_HOSTS = ("cdninstagram.com", "fbcdn.net")

# ---------- lookup disk cache ----------
# Every successful /api/lookup is written to ./data/lookups/<username>.json so
# the dashboard keeps working when Instagram rate-limits us or the network drops.
CACHE_DIR = os.path.join(ROOT, "data", "lookups")
os.makedirs(CACHE_DIR, exist_ok=True)


def _cache_path(username):
    safe = re.sub(r"[^\w.-]", "_", username.lower())[:80]
    return os.path.join(CACHE_DIR, f"{safe}.json")


def cache_read(username):
    p = _cache_path(username)
    if not os.path.exists(p):
        return None
    try:
        with open(p, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data
    except Exception:
        return None


def cache_write(username, data):
    if not data or not data.get("available"):
        return
    p = _cache_path(username)
    try:
        payload = dict(data)
        payload["cached_at"] = int(time.time())
        tmp = p + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False)
        os.replace(tmp, p)
    except Exception as e:
        sys.stderr.write(f"cache_write({username}) failed: {e}\n")


def cache_list():
    out = []
    try:
        for fn in os.listdir(CACHE_DIR):
            if not fn.endswith(".json"):
                continue
            try:
                with open(os.path.join(CACHE_DIR, fn), "r", encoding="utf-8") as f:
                    d = json.load(f)
                out.append({
                    "username": d.get("username") or fn[:-5],
                    "full_name": d.get("full_name", ""),
                    "followers": d.get("followers", 0),
                    "posts_cached": len(d.get("posts") or []),
                    "cached_at": d.get("cached_at", 0),
                    "is_verified": d.get("is_verified", False),
                    "is_business": d.get("is_business", False),
                    "profile_pic_url": d.get("profile_pic_url", ""),
                })
            except Exception:
                continue
    except FileNotFoundError:
        pass
    out.sort(key=lambda x: x.get("cached_at") or 0, reverse=True)
    return out


def cache_delete(username):
    try:
        os.remove(_cache_path(username))
        return True
    except FileNotFoundError:
        return False
    except Exception:
        return False


# ---------- tunnel manager ----------
# Meta OAuth requires an HTTPS redirect URI. Two providers, auto-fallback:
#   1) cloudflared quick tunnel → https://*.trycloudflare.com
#   2) localhost.run via SSH    → https://*.lhr.life
# Cloudflare's quick-tunnel API has been flaky in 2026 (intermittent 500s),
# so when it errors within a few seconds we transparently fall back to SSH.
PROVIDERS = {
    "cloudflared": {
        "cmd": lambda binary, target: [binary, "tunnel", "--url", target, "--no-autoupdate"],
        "url_regex": re.compile(r"https://[a-z0-9-]+\.trycloudflare\.com"),
        "needs_binary": True,
    },
    "localhost.run": {
        # SSH reverse tunnel; outputs the public URL in its banner
        "cmd": lambda _, target: [
            "ssh",
            "-o", "StrictHostKeyChecking=accept-new",
            "-o", "ServerAliveInterval=30",
            "-o", "ExitOnForwardFailure=yes",
            "-R", f"80:{target.replace('http://', '').replace('https://', '')}",
            "nokey@localhost.run",
        ],
        "url_regex": re.compile(r"https://[a-z0-9-]+\.lhr\.life"),
        "needs_binary": False,
    },
}


class TunnelManager:
    def __init__(self, binary_path, target_url):
        self.binary = binary_path
        self.target = target_url
        self.proc = None
        self.url = None
        self.provider = None
        self.started_at = None
        self.status = "stopped"  # stopped | starting | running | error
        self.error = None
        self._lock = threading.Lock()
        self._log_tail = []

    def _reader(self, stream, provider_name):
        regex = PROVIDERS[provider_name]["url_regex"]
        ansi_re = re.compile(r"\x1b\[[0-9;]*[a-zA-Z]")
        try:
            for line in iter(stream.readline, b""):
                try:
                    s = line.decode("utf-8", errors="replace").rstrip()
                except Exception:
                    continue
                s_clean = ansi_re.sub("", s).strip()
                if not s_clean:
                    continue
                self._log_tail.append(f"[{provider_name}] {s_clean}")
                if len(self._log_tail) > 80:
                    self._log_tail = self._log_tail[-80:]
                m = regex.search(s_clean)
                if m and not self.url:
                    self.url = m.group(0)
                    self.status = "running"
        except Exception:
            pass

    def _spawn(self, provider_name):
        p = PROVIDERS[provider_name]
        if p["needs_binary"] and not os.path.exists(self.binary):
            return None, f"{provider_name} binary not found at {self.binary}"
        try:
            cmd = p["cmd"](self.binary, self.target)
            proc = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                bufsize=1,
            )
            return proc, None
        except FileNotFoundError as e:
            return None, f"{provider_name} command not available: {e}"
        except Exception as e:
            return None, str(e)

    def _try_provider(self, provider_name, wait_seconds=8):
        proc, err = self._spawn(provider_name)
        if not proc:
            return False, err
        self.proc = proc
        self.provider = provider_name
        self.started_at = time.time()
        threading.Thread(target=self._reader, args=(proc.stdout, provider_name), daemon=True).start()
        # wait for URL or early exit
        deadline = time.time() + wait_seconds
        while time.time() < deadline:
            if self.url:
                return True, None
            if proc.poll() is not None:
                tail = " | ".join(self._log_tail[-3:])
                return False, f"{provider_name} exited: {tail[-300:]}"
            time.sleep(0.2)
        # still waiting — kill and report timeout
        try:
            proc.terminate()
            try:
                proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                proc.kill()
        except Exception:
            pass
        return False, f"{provider_name} did not produce a URL within {wait_seconds}s"

    def start(self, preferred=None):
        with self._lock:
            if self.proc and self.proc.poll() is None and self.url:
                return self._snapshot()
            self.url = None
            self.error = None
            self.provider = None
            self._log_tail = []
            self.status = "starting"

            order = []
            if preferred and preferred in PROVIDERS:
                order.append(preferred)
            for p in ("cloudflared", "localhost.run"):
                if p not in order:
                    order.append(p)

            errors = []
            for provider in order:
                ok, err = self._try_provider(provider)
                if ok:
                    return self._snapshot()
                errors.append(f"{provider}: {err}")
            # all providers failed
            self.status = "error"
            self.error = " | ".join(errors)[:500]
            self.proc = None
            return self._snapshot()

    def stop(self):
        with self._lock:
            if self.proc and self.proc.poll() is None:
                try:
                    self.proc.terminate()
                    try:
                        self.proc.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        self.proc.kill()
                except Exception:
                    pass
            self.proc = None
            self.url = None
            self.provider = None
            self.status = "stopped"
            self.error = None
            self.started_at = None
        return self._snapshot()

    def _snapshot(self):
        running = bool(self.proc and self.proc.poll() is None)
        if not running and self.status == "running":
            self.status = "stopped"
        return {
            "status": self.status,
            "url": self.url,
            "provider": self.provider,
            "started_at": self.started_at,
            "uptime": int(time.time() - self.started_at) if self.started_at else 0,
            "error": self.error,
            "log_tail": self._log_tail[-15:],
        }

    def status_snapshot(self):
        with self._lock:
            return self._snapshot()


TUNNEL = TunnelManager(
    binary_path=os.path.join(ROOT, "cloudflared"),
    target_url=f"http://localhost:{PORT}",
)


def merge_with_cache(fresh, cached):
    """If fresh is partial (no posts) but cached has them, merge."""
    if not cached:
        return fresh
    merged = dict(fresh)
    if not fresh.get("posts") and cached.get("posts"):
        merged["posts"] = cached["posts"]
        merged["merged_posts_from_cache"] = True
    # preserve richer fields if fresh dropped them
    for k in ("biography", "category", "external_url", "business_email",
              "related_profiles", "is_business", "is_professional", "has_clips"):
        if not merged.get(k) and cached.get(k):
            merged[k] = cached[k]
    return merged


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def do_GET(self):
        p = urllib.parse.urlparse(self.path)
        if p.path == "/api/lookup":
            return self.handle_lookup(p)
        if p.path == "/api/image":
            return self.handle_image(p)
        if p.path == "/api/parse-export":
            return self.handle_parse_export(p)
        if p.path == "/api/cache/list":
            return self.handle_cache_list()
        if p.path == "/api/cache/delete":
            return self.handle_cache_delete(p)
        if p.path == "/api/tunnel/status":
            return self.send_json(TUNNEL.status_snapshot(), 200)
        if p.path == "/api/config":
            return self.handle_config()
        if p.path == "/privacy":
            return self.handle_legal_page("privacy")
        if p.path == "/terms":
            return self.handle_legal_page("terms")
        # legacy
        if p.path == "/proxy":
            return self.handle_lookup(p, legacy=True)
        return super().do_GET()

    def do_POST(self):
        p = urllib.parse.urlparse(self.path)
        if p.path == "/api/ai":
            return self.handle_ai()
        if p.path == "/api/list-gemini-models":
            return self.handle_list_gemini()
        if p.path == "/api/tunnel/start":
            return self.send_json(TUNNEL.start(), 200)
        if p.path == "/api/tunnel/stop":
            return self.send_json(TUNNEL.stop(), 200)
        if p.path == "/api/instagram/exchange":
            return self.handle_instagram_exchange()
        self.send_error(404, "Not found")

    def handle_config(self):
        cfg = {}
        url = os.environ.get("SUPABASE_URL")
        key = os.environ.get("SUPABASE_ANON_KEY")
        if url and key:
            cfg["supabaseUrl"] = url
            cfg["supabaseAnonKey"] = key
        return self.send_json(cfg, 200)

    def handle_instagram_exchange(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
            body = self.rfile.read(length).decode("utf-8")
            req = json.loads(body or "{}")
            code = req.get("code", "")
            client_id = req.get("client_id", "")
            client_secret = req.get("client_secret", "")
            redirect_uri = req.get("redirect_uri", "")
            if not (code and client_id and client_secret and redirect_uri):
                return self.send_json({"error": "missing code, client_id, client_secret, or redirect_uri"}, 400)

            form = urllib.parse.urlencode({
                "client_id": client_id,
                "client_secret": client_secret,
                "grant_type": "authorization_code",
                "redirect_uri": redirect_uri,
                "code": code,
            }).encode()
            req1 = urllib.request.Request(
                "https://api.instagram.com/oauth/access_token",
                data=form,
                headers={"Content-Type": "application/x-www-form-urlencoded"},
                method="POST",
            )
            try:
                with urllib.request.urlopen(req1, timeout=20) as resp:
                    short = json.loads(resp.read().decode("utf-8"))
            except urllib.error.HTTPError as e:
                return self.send_json({"error": f"short-token exchange failed: {e.read().decode('utf-8', errors='replace')}"}, 502)

            access_token = short.get("access_token")
            user_id = short.get("user_id")
            if not access_token:
                return self.send_json({"error": "Instagram returned no access_token", "raw": short}, 502)

            # long-lived exchange
            try:
                url2 = "https://graph.instagram.com/access_token?" + urllib.parse.urlencode({
                    "grant_type": "ig_exchange_token",
                    "client_secret": client_secret,
                    "access_token": access_token,
                })
                with urllib.request.urlopen(urllib.request.Request(url2), timeout=20) as resp:
                    long_lived = json.loads(resp.read().decode("utf-8"))
                long_token = long_lived.get("access_token") or access_token
                expires_in = long_lived.get("expires_in", 3600)
            except Exception:
                long_token = access_token
                expires_in = 3600

            return self.send_json({"access_token": long_token, "user_id": user_id, "expires_in": expires_in, "token_type": "bearer"}, 200)
        except Exception as e:
            return self.send_json({"error": str(e)}, 500)

    def handle_legal_page(self, kind):
        # Minimal pages required by Meta for OAuth app review.
        if kind == "privacy":
            title = "Privacy Policy — Pulse Instagram Analytics"
            body = """
            <h2>Privacy Policy</h2>
            <p>This software runs locally on the user's own machine. It connects to Instagram's
            public web endpoints and (optionally) to Facebook Login + Instagram Graph API on behalf
            of the signed-in user.</p>
            <h3>Data collected</h3>
            <ul>
              <li>Instagram usernames the user explicitly looks up</li>
              <li>Profile data and recent public posts returned by Instagram</li>
              <li>OAuth access tokens kept only in the user's browser (localStorage)</li>
            </ul>
            <h3>Data storage</h3>
            <p>All lookups are cached to disk on the user's local machine under
            <code>./data/lookups/</code>. Nothing is uploaded to a third-party server by this software.</p>
            <h3>Data sharing</h3>
            <p>No data is shared. The dashboard runs entirely on localhost (or the user's own tunnel).</p>
            <h3>Deletion</h3>
            <p>Delete the <code>./data/lookups/</code> folder or clear browser storage to remove all data.</p>
            <h3>Contact</h3>
            <p>Reach the operator of this instance directly.</p>
            """
        else:
            title = "Terms of Service — Pulse Instagram Analytics"
            body = """
            <h2>Terms of Service</h2>
            <p>This software is provided "as is" for personal and educational analytics on
            Instagram accounts you own or have permission to analyze.</p>
            <h3>Acceptable use</h3>
            <ul>
              <li>Do not use this software to scrape at scale, spam, or harass.</li>
              <li>Respect Instagram and Meta's platform policies and rate limits.</li>
              <li>You are responsible for complying with applicable laws in your jurisdiction.</li>
            </ul>
            <h3>Liability</h3>
            <p>No warranty is provided. Use at your own risk.</p>
            """
        html = f"""<!doctype html><html><head><meta charset=utf-8><title>{title}</title>
        <style>
          body{{font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:720px;margin:48px auto;padding:0 20px;color:#0f172a;line-height:1.55}}
          h2{{margin-top:0;color:#a21caf}} h3{{margin-top:1.5em;color:#475569}}
          code{{background:#f1f5f9;padding:1px 6px;border-radius:4px;font-size:.92em}}
          a{{color:#a21caf}}
          .meta{{color:#64748b;font-size:.85em;border-top:1px solid #e2e8f0;margin-top:32px;padding-top:16px}}
        </style></head><body>{body}
        <p class=meta>Last updated: {time.strftime('%Y-%m-%d')} · <a href="/">← back to app</a></p>
        </body></html>"""
        encoded = html.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def handle_list_gemini(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
            body = self.rfile.read(length).decode("utf-8")
            req = json.loads(body or "{}")
            api_key = req.get("api_key", "")
            if not api_key:
                return self.send_json({"error": "missing api_key"}, 400)
            url = f"https://generativelanguage.googleapis.com/v1beta/models?key={urllib.parse.quote(api_key)}"
            with urllib.request.urlopen(urllib.request.Request(url), timeout=20) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            # filter to models that support generateContent
            models = []
            for m in (data.get("models") or []):
                name = m.get("name", "").replace("models/", "")
                methods = m.get("supportedGenerationMethods") or []
                if "generateContent" in methods:
                    models.append({
                        "id": name,
                        "display_name": m.get("displayName", name),
                        "description": (m.get("description", "") or "")[:200],
                    })
            return self.send_json({"models": models}, 200)
        except urllib.error.HTTPError as e:
            return self.send_json({"error": f"HTTP {e.code}: {e.reason}"}, 502)
        except Exception as e:
            return self.send_json({"error": str(e)}, 500)

    def handle_ai(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
            body = self.rfile.read(length).decode("utf-8")
            req = json.loads(body)
            provider = req.get("provider", "openai")
            model = req.get("model", "")
            api_key = req.get("api_key", "")
            prompt = req.get("prompt", "")
            context = req.get("context", {})
            if not api_key:
                return self.send_json({"error": "missing api_key"}, 400)
            if not prompt:
                return self.send_json({"error": "missing prompt"}, 400)

            # build full prompt with context
            system = (
                "You are an expert Instagram growth strategist and content advisor. "
                "Given concrete data about an account (followers, engagement, posting patterns, "
                "captions, hashtags, detected brand partnerships, etc.), produce practical, "
                "specific, actionable advice. Always cite the numbers from the context. "
                "Format with clear headings and bullet points. Be concise and direct."
            )
            user_msg = f"=== ACCOUNT DATA ===\n{json.dumps(context, ensure_ascii=False, indent=2)}\n\n=== TASK ===\n{prompt}"

            if provider == "anthropic":
                out = call_anthropic(api_key, system, user_msg, model=model or "claude-sonnet-4-6")
            elif provider == "openai":
                out = call_openai(api_key, system, user_msg, model=model or "gpt-4o-mini")
            elif provider == "gemini":
                out = call_gemini(api_key, system, user_msg, model=model or "gemini-1.5-flash")
            elif provider == "groq":
                out = call_groq(api_key, system, user_msg, model=model or "llama-3.3-70b-versatile")
            else:
                return self.send_json({"error": "unknown provider"}, 400)
            return self.send_json({"text": out}, 200)
        except Exception as e:
            import traceback
            sys.stderr.write(traceback.format_exc())
            return self.send_json({"error": str(e)}, 500)

    # ---------- parse Instagram data export (server-side, low-memory) ----------
    def handle_parse_export(self, p):
        params = urllib.parse.parse_qs(p.query)
        fpath = (params.get("path") or [""])[0].strip().strip('"').strip("'")
        if not fpath:
            return self.send_json({"error": "missing path"}, 400)

        real = resolve_export_path(fpath)
        if real is None:
            return self.send_json({
                "error": f"file not found. Tried: {fpath} (also with /, ~, ~/Downloads/)"
            }, 404)
        home = os.path.realpath(os.path.expanduser("~"))
        if not real.startswith(home):
            return self.send_json({"error": "path must be under your home directory"}, 403)
        if not real.lower().endswith(".zip"):
            return self.send_json({"error": "must be a .zip"}, 400)
        try:
            data = parse_export_zip(real)
            return self.send_json(data, 200)
        except Exception as e:
            import traceback
            sys.stderr.write(traceback.format_exc())
            return self.send_json({"error": str(e)}, 500)

    # ---------- lookup ----------
    def handle_lookup(self, p, legacy=False):
        params = urllib.parse.parse_qs(p.query)
        username = (params.get("username") or [""])[0].strip()
        only_cache = (params.get("cache") or ["0"])[0] == "1"
        if legacy and not username:
            # legacy path: ?url=https://www.instagram.com/USERNAME/
            raw = (params.get("url") or [""])[0]
            m = re.match(r"https?://(?:www\.)?instagram\.com/([\w.]+)/?", raw)
            if m:
                username = m.group(1)
        if not username:
            return self.send_json({"error": "missing username"}, 400)
        if not re.match(r"^[\w.]{1,30}$", username):
            return self.send_json({"error": "invalid username"}, 400)

        cached = cache_read(username)

        # cache-only mode: skip network entirely (useful in offline / heavy rate-limit)
        if only_cache:
            if cached:
                cached["from_cache"] = True
                return self.send_json(cached, 200)
            return self.send_json({"error": "no cached data", "available": False}, 404)

        try:
            data = fetch_with_fallbacks(username)
            # Only write to cache when we got real (non-partial) data
            if not data.get("partial"):
                cache_write(username, data)
            elif cached and data.get("partial"):
                # merge cached posts into a partial result so the dashboard stays useful
                data = merge_with_cache(data, cached)
                data["served_from_cache_age"] = int(time.time()) - (cached.get("cached_at") or 0)
            return self.send_json(data, 200)
        except Exception as e:
            # All strategies failed — fall back to cache if available
            if cached:
                cached["from_cache"] = True
                cached["partial"] = True
                cached["note"] = f"All endpoints rate-limited ({e}); showing cached snapshot."
                cached["served_from_cache_age"] = int(time.time()) - (cached.get("cached_at") or 0)
                return self.send_json(cached, 200)
            return self.send_json({"error": str(e), "available": False}, 502)

    def handle_cache_list(self):
        return self.send_json({"accounts": cache_list()}, 200)

    def handle_cache_delete(self, p):
        params = urllib.parse.parse_qs(p.query)
        username = (params.get("username") or [""])[0].strip()
        if not username:
            return self.send_json({"error": "missing username"}, 400)
        ok = cache_delete(username)
        return self.send_json({"deleted": ok}, 200)

    # ---------- image proxy ----------
    def handle_image(self, p):
        params = urllib.parse.parse_qs(p.query)
        url = (params.get("url") or [""])[0]
        if not url:
            return self.send_err(400, "missing url")
        parsed = urllib.parse.urlparse(url)
        if parsed.scheme not in ("http", "https"):
            return self.send_err(400, "bad scheme")
        host = (parsed.hostname or "").lower()
        if not any(host.endswith(h) for h in ALLOWED_IMG_HOSTS):
            return self.send_err(403, "host not allowed")
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Referer": "https://www.instagram.com/"})
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
            self.send_err(502, str(e))

    # ---------- helpers ----------
    def send_json(self, obj, status=200):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_err(self, code, msg):
        body = msg.encode()
        self.send_response(code)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


import random as _random

# Rotate UAs — Instagram is more aggressive against a fixed UA
DESKTOP_UAS = [
    UA,
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
]
MOBILE_UA = "Instagram 295.0.0.32.119 Android (33/13; 420dpi; 1080x2208; samsung; SM-G991B; o1s; exynos2100; en_US; 502173050)"


def _pick_ua():
    return _random.choice(DESKTOP_UAS)


def http_get_json(url, headers=None):
    req = urllib.request.Request(url, headers=headers or {"User-Agent": _pick_ua()})
    with urllib.request.urlopen(req, timeout=15) as resp:
        raw = resp.read()
        if resp.headers.get("Content-Encoding") == "gzip":
            raw = gzip.decompress(raw)
        return json.loads(raw.decode("utf-8", errors="replace"))


def http_get_text(url, headers=None):
    req = urllib.request.Request(url, headers=headers or {"User-Agent": _pick_ua()})
    with urllib.request.urlopen(req, timeout=15) as resp:
        raw = resp.read()
        if resp.headers.get("Content-Encoding") == "gzip":
            raw = gzip.decompress(raw)
        return raw.decode("utf-8", errors="replace")


def _try_with_retries(fn, max_attempts=3, base_delay=1.0):
    last_err = None
    for attempt in range(max_attempts):
        try:
            return fn()
        except urllib.error.HTTPError as e:
            last_err = e
            if e.code in (401, 403, 429):
                time.sleep(base_delay * (2 ** attempt) + _random.uniform(0, 0.5))
                continue
            raise
        except Exception as e:
            last_err = e
            time.sleep(base_delay)
    if last_err:
        raise last_err
    raise RuntimeError("retries exhausted")


def fetch_web_profile_info(username):
    url = (
        f"https://www.instagram.com/api/v1/users/web_profile_info/"
        f"?username={urllib.parse.quote(username)}"
    )
    def _do():
        return http_get_json(
            url,
            headers={
                "User-Agent": _pick_ua(),
                "Accept": "*/*",
                "Accept-Language": "en-US,en;q=0.9",
                "x-ig-app-id": WEB_APP_ID,
                "Referer": f"https://www.instagram.com/{username}/",
            },
        )
    raw = _try_with_retries(_do, max_attempts=2)
    user = (raw.get("data") or {}).get("user")
    if not user:
        raise RuntimeError("Account not found or response missing user")

    posts = []
    for edge in (user.get("edge_owner_to_timeline_media", {}).get("edges") or []):
        n = edge.get("node") or {}
        caption = ""
        cap_edges = (n.get("edge_media_to_caption") or {}).get("edges") or []
        if cap_edges:
            caption = (cap_edges[0].get("node") or {}).get("text", "")
        likes = (
            (n.get("edge_liked_by") or {}).get("count")
            or (n.get("edge_media_preview_like") or {}).get("count")
            or 0
        )
        comments = (n.get("edge_media_to_comment") or {}).get("count") or 0
        posts.append({
            "id": n.get("id"),
            "shortcode": n.get("shortcode"),
            "permalink": f"https://www.instagram.com/p/{n.get('shortcode')}/" if n.get("shortcode") else None,
            "display_url": n.get("display_url"),
            "thumbnail": n.get("thumbnail_src"),
            "is_video": bool(n.get("is_video")),
            "video_view_count": n.get("video_view_count"),
            "timestamp": n.get("taken_at_timestamp"),
            "caption": caption,
            "likes": likes,
            "comments": comments,
            "is_carousel": n.get("__typename") == "GraphSidecar",
            "accessibility_caption": n.get("accessibility_caption"),
        })

    related = []
    for edge in (user.get("edge_related_profiles", {}).get("edges") or [])[:8]:
        n = edge.get("node") or {}
        related.append({
            "username": n.get("username"),
            "full_name": n.get("full_name"),
            "profile_pic": n.get("profile_pic_url"),
            "is_verified": bool(n.get("is_verified")),
        })

    return {
        "username": user.get("username"),
        "full_name": user.get("full_name"),
        "biography": user.get("biography") or "",
        "external_url": user.get("external_url"),
        "category": user.get("category_name") or user.get("business_category_name"),
        "is_verified": bool(user.get("is_verified")),
        "is_private": bool(user.get("is_private")),
        "is_business": bool(user.get("is_business_account")),
        "is_professional": bool(user.get("is_professional_account")),
        "profile_pic_url": user.get("profile_pic_url_hd") or user.get("profile_pic_url"),
        "followers": (user.get("edge_followed_by") or {}).get("count") or 0,
        "following": (user.get("edge_follow") or {}).get("count") or 0,
        "posts_count": (user.get("edge_owner_to_timeline_media") or {}).get("count") or 0,
        "highlight_reel_count": user.get("highlight_reel_count") or 0,
        "has_clips": bool(user.get("has_clips")),
        "business_email": user.get("business_email"),
        "business_phone": user.get("business_phone_number"),
        "fbid": user.get("fbid"),
        "id": user.get("id"),
        "posts": posts,
        "related_profiles": related,
        "fetched_at": int(__import__("time").time()),
        "available": True,
        "_source": "web_profile_info",
    }


def fetch_mobile_api(username):
    """Strategy 2: i.instagram.com mobile endpoint — different rate-limit pool."""
    url = f"https://i.instagram.com/api/v1/users/web_profile_info/?username={urllib.parse.quote(username)}"
    def _do():
        return http_get_json(url, headers={
            "User-Agent": MOBILE_UA,
            "Accept": "*/*",
            "x-ig-app-id": WEB_APP_ID,
            "Accept-Language": "en-US",
        })
    raw = _try_with_retries(_do, max_attempts=2)
    user = (raw.get("data") or {}).get("user") or raw.get("user")
    if not user:
        raise RuntimeError("mobile API: empty user")
    return {
        "username": user.get("username") or username,
        "full_name": user.get("full_name", ""),
        "biography": user.get("biography") or "",
        "external_url": user.get("external_url"),
        "category": user.get("category_name") or user.get("business_category_name"),
        "is_verified": bool(user.get("is_verified")),
        "is_private": bool(user.get("is_private")),
        "is_business": bool(user.get("is_business_account")),
        "is_professional": bool(user.get("is_professional_account")),
        "profile_pic_url": user.get("profile_pic_url_hd") or user.get("profile_pic_url"),
        "followers": (user.get("edge_followed_by") or {}).get("count") or user.get("follower_count") or 0,
        "following": (user.get("edge_follow") or {}).get("count") or user.get("following_count") or 0,
        "posts_count": (user.get("edge_owner_to_timeline_media") or {}).get("count") or user.get("media_count") or 0,
        "has_clips": bool(user.get("has_clips")),
        "id": user.get("id") or user.get("pk"),
        "posts": [],
        "related_profiles": [],
        "fetched_at": int(time.time()),
        "available": True,
        "_source": "i_instagram",
    }


def fetch_og_only(username):
    html = http_get_text(
        f"https://www.instagram.com/{username}/",
        headers={
            "User-Agent": UA,
            "Accept": "text/html,application/xhtml+xml",
            "Accept-Language": "en-US,en;q=0.9",
        },
    )
    out = {"username": username, "posts": [], "related_profiles": []}
    desc_m = re.search(r'property="og:description"\s+content="([^"]*)"', html)
    if desc_m:
        desc = desc_m.group(1)
        out["description"] = desc
        nums = re.findall(r"([\d.,]+[KMB]?)\s+(Followers|Following|Posts)", desc, re.I)
        for value, label in nums:
            out[label.lower() if label.lower() != "posts" else "posts_count"] = parse_count(value)
    title_m = re.search(r'property="og:title"\s+content="([^"]*)"', html)
    if title_m:
        title = title_m.group(1)
        u = re.search(r"\(@([\w.]+)\)", title)
        if u:
            out["username"] = u.group(1)
        n = re.match(r"^(.*?)\s*\(@", title)
        if n:
            out["full_name"] = n.group(1).strip()
    img_m = re.search(r'property="og:image"\s+content="([^"]*)"', html)
    if img_m:
        out["profile_pic_url"] = img_m.group(1)
    out["available"] = bool(out.get("followers") is not None or out.get("username"))
    out["_source"] = "og_only"
    return out


def fetch_with_fallbacks(username):
    """Try strategies in order until one succeeds. Returns the richest result.

    Strategy 1: web_profile_info (full posts + bio)
    Strategy 2: i.instagram.com mobile API (counts only, different rate-limit pool)
    Strategy 3: OG meta scrape (basic counts only, no posts)
    """
    errors = []
    try:
        return fetch_web_profile_info(username)
    except urllib.error.HTTPError as e:
        errors.append(f"web_profile_info: HTTP {e.code}")
    except Exception as e:
        errors.append(f"web_profile_info: {e}")

    try:
        result = fetch_mobile_api(username)
        result["partial"] = True
        result["note"] = "Web endpoint rate-limited; counts came from mobile API. Posts will load on next retry."
        result["fetch_errors"] = errors
        return result
    except urllib.error.HTTPError as e:
        errors.append(f"mobile_api: HTTP {e.code}")
    except Exception as e:
        errors.append(f"mobile_api: {e}")

    try:
        result = fetch_og_only(username)
        result["partial"] = True
        result["note"] = "All API endpoints rate-limited; basic data from OG tags."
        result["fetch_errors"] = errors
        return result
    except Exception as e:
        errors.append(f"og_only: {e}")
        raise RuntimeError("All strategies failed: " + " | ".join(errors))


def parse_count(s):
    if not s:
        return None
    s = s.replace(",", "").strip()
    mult = 1
    if s.endswith("K"): mult, s = 1_000, s[:-1]
    elif s.endswith("M"): mult, s = 1_000_000, s[:-1]
    elif s.endswith("B"): mult, s = 1_000_000_000, s[:-1]
    try:
        return int(float(s) * mult)
    except ValueError:
        return None


# ====================================================
# PATH RESOLUTION — forgiving so users can paste sloppy paths
# ====================================================

def resolve_export_path(raw):
    """Try multiple interpretations of a user-given path. Returns absolute path
    if any variant exists as a file, else None."""
    if not raw:
        return None
    home = os.path.realpath(os.path.expanduser("~"))
    candidates = []

    # 1) as-is (expanded and absoluted)
    candidates.append(os.path.realpath(os.path.abspath(os.path.expanduser(raw))))

    # 2) prepend /  (handles "Users/..." instead of "/Users/...")
    if not raw.startswith(("/", "~")):
        candidates.append(os.path.realpath("/" + raw.lstrip("/")))

    # 3) join with home  (handles "Downloads/foo.zip" or "~/Downloads/foo.zip")
    candidates.append(os.path.realpath(os.path.join(home, raw.lstrip("/").replace("Users/", "", 1) if raw.startswith("Users/") else raw.lstrip("/"))))

    # 4) explicit Downloads
    candidates.append(os.path.realpath(os.path.join(home, "Downloads", os.path.basename(raw))))
    # 5) explicit Desktop
    candidates.append(os.path.realpath(os.path.join(home, "Desktop", os.path.basename(raw))))

    for c in candidates:
        try:
            if os.path.isfile(c):
                return c
        except OSError:
            pass
    return None


# ====================================================
# AI PROVIDERS — server-side proxy so the browser doesn't need CORS exemptions
# ====================================================

def call_anthropic(api_key, system, user_msg, model="claude-sonnet-4-6"):
    payload = json.dumps({
        "model": model,
        "max_tokens": 8000,
        "system": system,
        "messages": [{"role": "user", "content": user_msg}],
    }).encode("utf-8")
    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages",
        data=payload,
        headers={
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    # response shape: {"content": [{"type":"text","text":"..."}], ...}
    if isinstance(data.get("content"), list):
        parts = [c.get("text", "") for c in data["content"] if c.get("type") == "text"]
        return "\n".join(parts).strip()
    return data.get("error", {}).get("message") or json.dumps(data)


def call_gemini(api_key, system, user_msg, model="gemini-2.5-flash"):
    """Google Generative Language API — free tier, no credit card."""
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={urllib.parse.quote(api_key)}"
    payload = json.dumps({
        "contents": [{"role": "user", "parts": [{"text": user_msg}]}],
        "systemInstruction": {"parts": [{"text": system}]},
        "generationConfig": {"maxOutputTokens": 8000, "temperature": 0.7},
    }).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=payload,
        headers={"content-type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    candidates = data.get("candidates") or []
    if candidates and isinstance(candidates[0].get("content"), dict):
        parts = candidates[0]["content"].get("parts") or []
        return "".join(p.get("text", "") for p in parts).strip()
    if data.get("error"):
        return f"Gemini error: {data['error'].get('message', json.dumps(data['error']))}"
    return json.dumps(data)


def call_groq(api_key, system, user_msg, model="llama-3.3-70b-versatile"):
    """Groq — free fast inference of open-source models (OpenAI-compatible API)."""
    payload = json.dumps({
        "model": model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user_msg},
        ],
        "max_tokens": 8000,
        "temperature": 0.7,
    }).encode("utf-8")
    req = urllib.request.Request(
        "https://api.groq.com/openai/v1/chat/completions",
        data=payload,
        headers={
            "Authorization": f"Bearer {api_key}",
            "content-type": "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    if data.get("choices"):
        return data["choices"][0]["message"]["content"].strip()
    return data.get("error", {}).get("message") or json.dumps(data)


def call_openai(api_key, system, user_msg, model="gpt-4o-mini"):
    payload = json.dumps({
        "model": model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user_msg},
        ],
        "max_tokens": 8000,
    }).encode("utf-8")
    req = urllib.request.Request(
        "https://api.openai.com/v1/chat/completions",
        data=payload,
        headers={
            "Authorization": f"Bearer {api_key}",
            "content-type": "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    if data.get("choices"):
        return data["choices"][0]["message"]["content"].strip()
    return data.get("error", {}).get("message") or json.dumps(data)


# ====================================================
# DATA EXPORT PARSING (server-side, low-memory)
# ====================================================
import zipfile
import html as htmllib
from datetime import datetime
from html.parser import HTMLParser
from collections import Counter

IG_PATH_SKIP = {"i", "p", "reel", "reels", "stories", "tv", "accounts", "explore",
                "direct", "_u", "_n", "web", "legal", "about", "developer", ""}

# Loose: "May 18, 2026 1:58 am", "Oct 28, 2024 at 5:23:11 PM", "2024-10-28T17:23:11"
DATE_RX = re.compile(
    r"(\w{3,9}\s+\d{1,2},?\s*\d{4}(?:\s+at)?\s+\d{1,2}:\d{2}(?::\d{2})?\s*[AaPp]\.?[Mm]\.?)|"
    r"(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?)"
)
DATE_FORMATS = [
    "%b %d, %Y %I:%M %p", "%b %d, %Y %I:%M:%S %p",
    "%B %d, %Y %I:%M %p", "%B %d, %Y %I:%M:%S %p",
    "%b %d, %Y at %I:%M %p", "%b %d, %Y at %I:%M:%S %p",
    "%B %d, %Y at %I:%M %p", "%B %d, %Y at %I:%M:%S %p",
    "%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S",
]


def parse_date_to_ts(s):
    if not s:
        return 0
    cleaned = s.strip().replace(" pm", " PM").replace(" am", " AM").replace(" p.m.", " PM").replace(" a.m.", " AM")
    for fmt in DATE_FORMATS:
        try:
            return int(datetime.strptime(cleaned, fmt).timestamp())
        except ValueError:
            pass
    # final fallback: dateutil-style? we only have stdlib. Just return 0
    return 0


def extract_username_from_href(href):
    if not href:
        return None
    m = re.search(r"instagram\.com/(?:_u/|_n/)?([\w.]+)", href)
    if not m:
        return None
    u = m.group(1)
    if u.lower() in IG_PATH_SKIP:
        return None
    if not (1 <= len(u) <= 30):
        return None
    return u


def html_to_text(s):
    return htmllib.unescape(re.sub(r"<[^>]+>", " ", s or "")).strip()


def split_pam_rows(html):
    """Splits IG HTML into top-level `pam` row chunks (each row = one entry)."""
    # Each row begins with class="pam _3-95 _2ph- _a6-g uiBoxWhite noborder"
    # We split on this fingerprint but preserve order. Note rows can nest, but
    # the outermost ones we care about all start at a depth-1 `pam` div.
    parts = re.split(r'<div class="pam _3-95 _2ph- _a6-g uiBoxWhite noborder"', html)
    return parts[1:]  # first chunk before the first row is header


def parse_html_people_list(html):
    """For followers / following / close_friends / pending_follow_requests."""
    if not html:
        return []
    rows = split_pam_rows(html)
    out = []
    seen = set()
    for row in rows:
        # find FIRST instagram link in the row
        m = re.search(r'<a[^>]+href="(https?://[^"]*instagram\.com[^"]*)"', row)
        if not m:
            continue
        username = extract_username_from_href(m.group(1))
        if not username or username.lower() in seen:
            continue
        seen.add(username.lower())
        dm = DATE_RX.search(row)
        ts = parse_date_to_ts(dm.group(1) or dm.group(2)) if dm else 0
        out.append({"username": username, "timestamp": ts})
    return out


def parse_html_owner_username(html):
    """For liked_posts.html — extracts Owner.Username table cells."""
    if not html:
        return []
    # patterns:
    #   <td class="_a6_q">Username</td><td class="_2piu _a6_r">aymanehitmi</td>
    # the td between can have nested divs
    out = []
    for m in re.finditer(
        r'<td[^>]*class="[^"]*_a6_q[^"]*">Username</td>\s*<td[^>]*>([^<]+)</td>',
        html,
    ):
        u = m.group(1).strip().split()[0]
        if re.match(r"^[\w.]{1,30}$", u):
            out.append({"username": u, "timestamp": 0})
    return out


def parse_html_media_owner_comments(html):
    """For post_comments_X.html — extracts Media Owner + Time per row."""
    if not html:
        return []
    rows = split_pam_rows(html)
    out = []
    for row in rows:
        m = re.search(
            r'<td[^>]*class="[^"]*_a6_q[^"]*">Media Owner<div[^>]*><div[^>]*>([^<]+)</div>',
            row,
        )
        if not m:
            # alternate structure: <td>Media Owner</td><td>OWNER</td>
            m = re.search(
                r'<td[^>]*class="[^"]*_a6_q[^"]*">Media Owner</td>\s*<td[^>]*>([^<]+)</td>',
                row,
            )
        if not m:
            continue
        username = m.group(1).strip()
        if not re.match(r"^[\w.]{1,30}$", username):
            continue
        dm = DATE_RX.search(row)
        ts = parse_date_to_ts(dm.group(1) or dm.group(2)) if dm else 0
        # also try to extract the comment text
        cm = re.search(
            r'<td[^>]*class="[^"]*_a6_q[^"]*">Comment<div[^>]*><div[^>]*>([^<]+)</div>',
            row,
        )
        text = cm.group(1).strip() if cm else ""
        out.append({"username": username, "timestamp": ts, "text": text})
    return out


def parse_html_posts(html, kind):
    """For reels.html / other_content.html / archived_posts.html / stories.html."""
    if not html:
        return []
    import time
    now = int(time.time())
    future_cap = now + 86400 * 7  # accept up to 7 days in the future (timezone slack)
    past_cap = 946684800  # year 2000 — anything before is invalid

    rows = split_pam_rows(html)
    out = []
    seen_keys = set()
    for row in rows:
        # caption
        cm = re.search(r'<h2[^>]*class="[^"]*_a6-h[^"]*"[^>]*>([^<]*)</h2>', row)
        caption = htmllib.unescape(cm.group(1)).strip() if cm else ""
        # date: ONLY trust the dedicated post-date div (_a6-o) to avoid catching
        # "Expiration time" / EXIF dates / etc. that appear in nested tables.
        dm = re.search(r'<div class="_3-94 _a6-o">([^<]+)</div>', row)
        if not dm:
            continue
        ts = parse_date_to_ts(dm.group(1))
        if not ts or ts > future_cap or ts < past_cap:
            continue
        is_video = bool(re.search(r'<video[^>]+src=', row)) or kind == "reel"
        media_uris = re.findall(r'<(?:video|img)[^>]+src="([^"]+)"', row)
        media_uris = [u for u in media_uris if "Instagram-Logo" not in u]
        media_type = (
            "Reel" if kind == "reel"
            else "Story" if kind == "story"
            else "Video" if is_video
            else "Carousel" if len(media_uris) > 1
            else "Image"
        )
        key = f"{ts}_{caption[:30]}"
        if key in seen_keys:
            continue
        seen_keys.add(key)
        out.append({
            "caption": caption,
            "timestamp": ts,
            "mediaType": media_type,
            "is_video": is_video,
            "is_carousel": media_type == "Carousel",
            "media_count": len(media_uris),
        })
    return out


def parse_personal_info(html):
    if not html:
        return {"username": "", "bio": ""}
    text = html_to_text(html)
    out = {"username": "", "bio": ""}
    um = re.search(r"Username\s+([\w.]+)", text)
    if um:
        out["username"] = um.group(1)
    bm = re.search(r"(?:Bio|Biographie)\s+([^\n]{2,200})", text)
    if bm:
        out["bio"] = bm.group(1).strip()
    return out


def extract_entries_json(node):
    items = []
    if isinstance(node, list):
        items = node
    elif isinstance(node, dict):
        for v in node.values():
            if isinstance(v, list):
                items = v
                break
    out = []
    for it in items:
        sld = it.get("string_list_data") if isinstance(it, dict) else None
        if isinstance(sld, list) and sld:
            first = sld[0]
            out.append({
                "username": first.get("value") or it.get("title") or "",
                "timestamp": first.get("timestamp") or 0,
            })
        elif isinstance(it, dict) and it.get("title"):
            out.append({"username": it["title"], "timestamp": 0})
    return [x for x in out if x["username"]]


def parse_export_zip(zip_path):
    """Streams the IG export zip and returns parsed analytics-ready data."""
    with zipfile.ZipFile(zip_path) as z:
        names = z.namelist()
        has_html = any(n.endswith(".html") for n in names)
        has_json = any(n.endswith(".json") for n in names)
        fmt = ("JSON" if has_json else "") + (" + " if has_json and has_html else "") + ("HTML" if has_html else "")

        def read(name):
            try:
                with z.open(name) as f:
                    return f.read().decode("utf-8", errors="replace")
            except KeyError:
                return None

        def match(pattern):
            rx = re.compile(pattern, re.I)
            return [n for n in names if rx.search(n)]

        # followers
        followers = []
        if has_json:
            for n in match(r"followers(_\d+)?\.json$"):
                if "pending" in n:
                    continue
                txt = read(n)
                if txt:
                    try:
                        followers.extend(extract_entries_json(json.loads(txt, strict=False)))
                    except Exception:
                        pass
        if not followers and has_html:
            for n in match(r"followers(_\d+)?\.html$"):
                if "pending" in n:
                    continue
                followers.extend(parse_html_people_list(read(n) or ""))
        followers = dedupe_users(followers)

        # following
        following = []
        if has_json:
            for n in match(r"following\.json$"):
                if "hashtag" in n:
                    continue
                txt = read(n)
                if txt:
                    try:
                        following.extend(extract_entries_json(json.loads(txt, strict=False)))
                    except Exception:
                        pass
        if not following and has_html:
            for n in match(r"following\.html$"):
                if "hashtag" in n:
                    continue
                following.extend(parse_html_people_list(read(n) or ""))
        following = dedupe_users(following)

        # posts
        posts = []
        if has_html:
            for n in match(r"your_instagram_activity/media/reels\.html$"):
                posts.extend(parse_html_posts(read(n) or "", "reel"))
            for n in match(r"your_instagram_activity/media/(other_content|archived_posts|reposts)\.html$"):
                posts.extend(parse_html_posts(read(n) or "", "post"))
            for n in match(r"your_instagram_activity/media/stories\.html$"):
                posts.extend(parse_html_posts(read(n) or "", "story"))
        posts.sort(key=lambda p: -p["timestamp"])

        # likes
        liked = []
        if has_html:
            for n in match(r"liked_posts\.html$"):
                liked.extend(parse_html_owner_username(read(n) or ""))

        # comments
        commented = []
        if has_html:
            for n in match(r"comments/(post_comments|reels_comments|story_comments)(_\d+)?\.html$"):
                commented.extend(parse_html_media_owner_comments(read(n) or ""))

        # profile
        info = {"username": "", "bio": ""}
        if has_html:
            for n in match(r"personal_information\.html$"):
                if "edits" in n:
                    continue
                p = parse_personal_info(read(n) or "")
                if p["username"]:
                    info = p
                    break
        # fallback: guess from filename
        if not info["username"]:
            m = re.search(r"instagram-([a-z0-9_.]+)", os.path.basename(zip_path), re.I)
            if m:
                info["username"] = m.group(1)

        return {
            "username": info["username"],
            "bio": info["bio"],
            "format": fmt or "unknown",
            "followers": followers,
            "following": following,
            "posts": posts,
            "likedAccounts": liked,
            "commented": commented,
        }


def dedupe_users(arr):
    seen = {}
    for x in arr:
        k = x["username"].lower()
        if k not in seen or (x.get("timestamp") and not seen[k].get("timestamp")):
            seen[k] = x
    return list(seen.values())


def main():
    os.chdir(ROOT)
    with socketserver.ThreadingTCPServer(("", PORT), Handler) as httpd:
        httpd.allow_reuse_address = True
        print(f"Serving Instagram Analytics on http://localhost:{PORT}")
        print(f"Lookup: http://localhost:{PORT}/api/lookup?username=cristiano")
        print("Ctrl+C to stop.")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
