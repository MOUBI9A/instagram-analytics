"""Vercel serverless function: POST /api/ai

Proxies prompts to Anthropic / Gemini / Groq / OpenAI based on the `provider`
field of the JSON request body. Matches server.py's handle_ai shape so the
frontend works identically locally and on Vercel.
"""

from http.server import BaseHTTPRequestHandler
import urllib.request
import urllib.parse
import json


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
    with urllib.request.urlopen(req, timeout=55) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    if isinstance(data.get("content"), list):
        parts = [c.get("text", "") for c in data["content"] if c.get("type") == "text"]
        return "\n".join(parts).strip()
    return data.get("error", {}).get("message") or json.dumps(data)


def call_gemini(api_key, system, user_msg, model="gemini-2.5-flash"):
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={urllib.parse.quote(api_key)}"
    payload = json.dumps({
        "contents": [{"role": "user", "parts": [{"text": user_msg}]}],
        "systemInstruction": {"parts": [{"text": system}]},
        "generationConfig": {"maxOutputTokens": 8000, "temperature": 0.7},
    }).encode("utf-8")
    req = urllib.request.Request(url, data=payload, headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=55) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    candidates = data.get("candidates") or []
    if candidates and isinstance(candidates[0].get("content"), dict):
        parts = candidates[0]["content"].get("parts") or []
        return "".join(p.get("text", "") for p in parts).strip()
    if data.get("error"):
        return f"Gemini error: {data['error'].get('message', json.dumps(data['error']))}"
    return json.dumps(data)


def call_groq(api_key, system, user_msg, model="llama-3.3-70b-versatile"):
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
    with urllib.request.urlopen(req, timeout=55) as resp:
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
    with urllib.request.urlopen(req, timeout=55) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    if data.get("choices"):
        return data["choices"][0]["message"]["content"].strip()
    return data.get("error", {}).get("message") or json.dumps(data)


class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
            body = self.rfile.read(length).decode("utf-8")
            req = json.loads(body or "{}")
            provider = req.get("provider", "openai")
            model = req.get("model", "")
            api_key = req.get("api_key", "")
            prompt = req.get("prompt", "")
            context = req.get("context", {})
            if not api_key:
                return self._send({"error": "missing api_key"}, 400)
            if not prompt:
                return self._send({"error": "missing prompt"}, 400)

            system = (
                "You are an expert Instagram growth strategist and content advisor. "
                "Given concrete data about an account (followers, engagement, posting patterns, "
                "captions, hashtags, detected brand partnerships, etc.), produce practical, "
                "specific, actionable advice. Always cite the numbers from the context. "
                "Format with clear headings and bullet points. Be concise and direct."
            )

            if isinstance(context, str) and context:
                user_msg = f"=== ACCOUNT DATA ===\n{context}\n\n=== TASK ===\n{prompt}"
            elif context:
                user_msg = f"=== ACCOUNT DATA ===\n{json.dumps(context, ensure_ascii=False, indent=2)}\n\n=== TASK ===\n{prompt}"
            else:
                user_msg = prompt

            if provider == "anthropic":
                out = call_anthropic(api_key, system, user_msg, model=model or "claude-sonnet-4-6")
            elif provider == "openai":
                out = call_openai(api_key, system, user_msg, model=model or "gpt-4o-mini")
            elif provider == "gemini":
                out = call_gemini(api_key, system, user_msg, model=model or "gemini-2.5-flash")
            elif provider == "groq":
                out = call_groq(api_key, system, user_msg, model=model or "llama-3.3-70b-versatile")
            else:
                return self._send({"error": "unknown provider"}, 400)
            return self._send({"text": out}, 200)
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
