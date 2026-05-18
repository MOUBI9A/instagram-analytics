"""Vercel serverless function: GET /api/lookup?username=X

Multi-strategy public-profile fetcher. Tries (in order):
  1) web_profile_info endpoint with rotating desktop User-Agents
  2) i.instagram.com mobile API endpoint with Android UA
  3) Embedded JSON inside the public HTML page
  4) OG meta tag scrape (basic counts only)

Each strategy retries on rate-limit with exponential backoff + jitter.
Result is enriched as we go — if 1) gives a partial response, we still
try 2) and 3) to fill in missing pieces.
"""

from http.server import BaseHTTPRequestHandler
import urllib.request
import urllib.parse
import urllib.error
import json
import gzip
import re
import time
import random


WEB_APP_ID = "936619743392459"

# Rotate through these — Instagram is more aggressive against fixed UAs
DESKTOP_UAS = [
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
]

MOBILE_UA = "Instagram 295.0.0.32.119 Android (33/13; 420dpi; 1080x2208; samsung; SM-G991B; o1s; exynos2100; en_US; 502173050)"


def _pick_ua():
    return random.choice(DESKTOP_UAS)


def _open(url, headers=None, timeout=15):
    req = urllib.request.Request(url, headers=headers or {"User-Agent": _pick_ua()})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
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
                # rate-limited; back off with jitter and try again
                sleep = base_delay * (2 ** attempt) + random.uniform(0, 0.5)
                time.sleep(sleep)
                continue
            raise
        except Exception as e:
            last_err = e
            time.sleep(base_delay)
    if last_err:
        raise last_err
    raise RuntimeError("all retry attempts failed")


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


# ---------- Strategy 1: web_profile_info (rich, often rate-limited) ----------
def fetch_web_profile_info(username):
    url = f"https://www.instagram.com/api/v1/users/web_profile_info/?username={urllib.parse.quote(username)}"
    def do():
        ua = _pick_ua()
        return _open(url, headers={
            "User-Agent": ua,
            "Accept": "*/*",
            "Accept-Language": "en-US,en;q=0.9",
            "x-ig-app-id": WEB_APP_ID,
            "Referer": f"https://www.instagram.com/{username}/",
        })
    raw_text = _try_with_retries(do, max_attempts=2)
    raw = json.loads(raw_text)
    user = (raw.get("data") or {}).get("user")
    if not user:
        raise RuntimeError("web_profile_info: empty user")

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
        "_source": "web_profile_info",
    }


# ---------- Strategy 2: i.instagram.com mobile API ----------
# Different rate-limit pool from web_profile_info. Returns less data
# (no recent posts) but works when the web endpoint is throttled.
def fetch_mobile_api(username):
    url = f"https://i.instagram.com/api/v1/users/web_profile_info/?username={urllib.parse.quote(username)}"
    def do():
        return _open(url, headers={
            "User-Agent": MOBILE_UA,
            "Accept": "*/*",
            "x-ig-app-id": WEB_APP_ID,
            "Accept-Language": "en-US",
        })
    raw_text = _try_with_retries(do, max_attempts=2)
    raw = json.loads(raw_text)
    user = (raw.get("data") or {}).get("user") or raw.get("user")
    if not user:
        raise RuntimeError("mobile API: empty user")
    # Mirror the web_profile_info shape so frontends don't care about the source
    out = {
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
    return out


# ---------- Strategy 3: embedded HTML JSON ----------
def fetch_html_json(username):
    url = f"https://www.instagram.com/{username}/"
    def do():
        return _open(url, headers={
            "User-Agent": _pick_ua(),
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9",
            "Accept-Language": "en-US,en;q=0.9",
        })
    html = _try_with_retries(do, max_attempts=2)
    out = _parse_og(html, username)
    # Try to find embedded JSON-LD with richer data
    ld_m = re.search(r'<script type="application/ld\+json">(.+?)</script>', html, re.DOTALL)
    if ld_m:
        try:
            ld = json.loads(ld_m.group(1))
            if isinstance(ld, dict):
                if ld.get("description") and not out.get("biography"):
                    out["biography"] = ld["description"]
                if ld.get("interactionStatistic"):
                    for stat in ld["interactionStatistic"]:
                        kind = stat.get("interactionType", "")
                        count = stat.get("userInteractionCount")
                        if "Follow" in kind and count and not out.get("followers"):
                            out["followers"] = count
        except Exception:
            pass
    out["_source"] = "html_scrape"
    return out


# ---------- Strategy 4: OG meta only ----------
def _parse_og(html, username):
    out = {
        "username": username,
        "posts": [],
        "related_profiles": [],
        "fetched_at": int(time.time()),
    }
    desc_m = re.search(r'property="og:description"\s+content="([^"]*)"', html)
    if desc_m:
        desc = desc_m.group(1)
        out["description"] = desc
        nums = re.findall(r"([\d.,]+[KMB]?)\s+(Followers|Following|Posts)", desc, re.I)
        for value, label in nums:
            key = label.lower() if label.lower() != "posts" else "posts_count"
            out[key] = parse_count(value)
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
    out["available"] = bool(out.get("followers") is not None or out.get("username") != username or out.get("full_name"))
    return out


def fetch_og_only(username):
    html = _open(f"https://www.instagram.com/{username}/", headers={
        "User-Agent": _pick_ua(),
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
    })
    out = _parse_og(html, username)
    out["_source"] = "og_only"
    return out


# ---------- Orchestrator ----------
def fetch_with_fallbacks(username):
    """Try every strategy in order; collect what we get; return the richest result.

    Even if Strategy 1 partially succeeds (counts but no posts), we don't
    burn requests on 2-4. Only fall through when the previous one truly fails.
    """
    errors = []

    # Strategy 1: rich web endpoint
    try:
        result = fetch_web_profile_info(username)
        return result
    except urllib.error.HTTPError as e:
        errors.append(f"web_profile_info: HTTP {e.code}")
    except Exception as e:
        errors.append(f"web_profile_info: {e}")

    # Strategy 2: mobile endpoint
    try:
        result = fetch_mobile_api(username)
        result["partial"] = True
        result["note"] = "Web endpoint rate-limited; counts came from the mobile API. Posts will load on next retry."
        result["fetch_errors"] = errors
        return result
    except urllib.error.HTTPError as e:
        errors.append(f"mobile_api: HTTP {e.code}")
    except Exception as e:
        errors.append(f"mobile_api: {e}")

    # Strategy 3: HTML JSON scrape
    try:
        result = fetch_html_json(username)
        result["partial"] = True
        result["note"] = "Both API endpoints rate-limited; basic data from the public HTML page."
        result["fetch_errors"] = errors
        return result
    except Exception as e:
        errors.append(f"html_scrape: {e}")

    # Strategy 4: bare OG meta tags (last resort)
    try:
        result = fetch_og_only(username)
        result["partial"] = True
        result["note"] = "All endpoints rate-limited; only OG tags available (followers + basic counts)."
        result["fetch_errors"] = errors
        return result
    except Exception as e:
        errors.append(f"og_only: {e}")
        raise RuntimeError("All strategies failed: " + " | ".join(errors))


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
            data = fetch_with_fallbacks(username)
            return self._send_json(data, 200)
        except Exception as e:
            return self._send_json({"error": str(e), "available": False}, 502)

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
