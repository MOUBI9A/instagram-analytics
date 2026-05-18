"""Vercel serverless function: GET /api/lookup?username=X

Returns JSON with Instagram public profile + recent posts.
Adapted from server.py's handle_lookup — no disk cache (serverless).
"""

from http.server import BaseHTTPRequestHandler
import urllib.request
import urllib.parse
import urllib.error
import json
import gzip
import re
import time


WEB_APP_ID = "936619743392459"
UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15"
)


def http_get_json(url, headers=None):
    req = urllib.request.Request(url, headers=headers or {"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=15) as resp:
        raw = resp.read()
        if resp.headers.get("Content-Encoding") == "gzip":
            raw = gzip.decompress(raw)
        return json.loads(raw.decode("utf-8", errors="replace"))


def http_get_text(url, headers=None):
    req = urllib.request.Request(url, headers=headers or {"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=15) as resp:
        raw = resp.read()
        if resp.headers.get("Content-Encoding") == "gzip":
            raw = gzip.decompress(raw)
        return raw.decode("utf-8", errors="replace")


def parse_count(s):
    if not s:
        return None
    s = s.replace(",", "").strip()
    mult = 1
    if s.endswith("K"):
        mult, s = 1_000, s[:-1]
    elif s.endswith("M"):
        mult, s = 1_000_000, s[:-1]
    elif s.endswith("B"):
        mult, s = 1_000_000_000, s[:-1]
    try:
        return int(float(s) * mult)
    except ValueError:
        return None


def fetch_web_profile_info(username):
    url = (
        f"https://www.instagram.com/api/v1/users/web_profile_info/"
        f"?username={urllib.parse.quote(username)}"
    )
    raw = http_get_json(
        url,
        headers={
            "User-Agent": UA,
            "Accept": "*/*",
            "x-ig-app-id": WEB_APP_ID,
            "Referer": f"https://www.instagram.com/{username}/",
        },
    )
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
        "fetched_at": int(time.time()),
        "available": True,
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
    return out


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        params = urllib.parse.parse_qs(parsed.query)
        username = (params.get("username") or [""])[0].strip()

        if not username:
            raw = (params.get("url") or [""])[0]
            m = re.match(r"https?://(?:www\.)?instagram\.com/([\w.]+)/?", raw)
            if m:
                username = m.group(1)

        if not username:
            return self._send_json({"error": "missing username"}, 400)
        if not re.match(r"^[\w.]{1,30}$", username):
            return self._send_json({"error": "invalid username"}, 400)

        try:
            data = fetch_web_profile_info(username)
            return self._send_json(data, 200)
        except urllib.error.HTTPError as e:
            if e.code in (401, 403, 429):
                try:
                    fallback = fetch_og_only(username)
                    fallback["partial"] = True
                    fallback["note"] = (
                        "Instagram rate-limited rich data; showing basic counts only. "
                        "Wait a few minutes and try again."
                    )
                    return self._send_json(fallback, 200)
                except Exception:
                    return self._send_json({"error": f"rate limited: {e.code}"}, 502)
            return self._send_json({"error": f"upstream {e.code}: {e.reason}"}, 502)
        except Exception as e:
            return self._send_json({"error": str(e)}, 500)

    def _send_json(self, obj, status=200):
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
