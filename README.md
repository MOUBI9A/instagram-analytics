# Pulse — Instagram Analytics & Concept Studio

A local-first dashboard that combines **public Instagram analytics**, an
**AI-assisted Concept Studio** for creators, and the **Instagram Graph API
(Live)** for accounts you manage — all running on your own machine.

Built for creators, influencers, and content strategists who want to:

- Look up any public Instagram account and see the full breakdown
- Track multiple accounts over time (Watchlist)
- Compare accounts side-by-side
- **Generate content concepts** matched to an account's followers, top hooks,
  hashtags, and viral patterns — with realistic view-range estimates
- Pull **live insights** from accounts they own through the Graph API
- Parse their own Instagram data export `.zip` offline

Nothing leaves your machine. Every lookup is cached to disk so you keep
working through rate-limits or network drops.

---

## Quick start

```sh
git clone https://github.com/MOUBI9A/instagram-analytics.git
cd instagram-analytics
sh run.sh         # starts http://localhost:8000
```

Requirements:

- Python 3.9+ (standard library only — no `pip install` needed)
- A modern browser

Optional (for the Live API / Meta OAuth wizard):

- `cloudflared` — auto-detected at `./cloudflared` if present, otherwise
  the wizard falls back to `localhost.run` (uses your built-in `ssh`, no
  install needed)

---

## What's inside

The dashboard has five tabs:

### 🔍 Lookup
Type any public username — get profile, follower count, engagement rate,
top posts, posting heatmap, hashtag breakdown, and more. Uses Instagram's
public web endpoint (no auth, no key). **Every successful fetch is cached
to disk** under `./data/lookups/<username>.json`, so when Instagram
rate-limits you the dashboard transparently serves the cached snapshot with
a clear "Showing cached data" banner.

### 📌 Watchlist
Track an account over time. Every refresh adds a snapshot — followers,
engagement, post count — and the dashboard plots the curve. Optionally
log private Insights numbers (reach, impressions, profile views, clicks)
by hand for richer charts.

### ⚖️ Compare
Side-by-side breakdown of up to 5 accounts, with a bar chart of headline
stats and a radar chart of relative strengths.

### 💡 Concept Studio
Pick 1+ accounts you've looked up. The engine runs:

1. **Viral DNA extraction** — top hooks from highest-engagement captions,
   format winner, hashtag clusters, engagement-rate context, posting
   cadence, peak-hour window.
2. **Matched actions** — concrete this-week to-dos derived from the
   account's strengths (post in your winning format, recycle the top hook,
   try the format you've under-used, etc.).
3. **Concept generation** — 8–12 ranked concept cards (title, hook,
   why-it-works, hashtags, format icon, best post hour, **estimated views
   low–high**, confidence pill).

Filters: format (Reel / Carousel / Photo / Story), tone
(educational / entertaining / inspiring / promotional),
ambition (safe / growth / viral), min-views floor, account tier
(nano / micro / mid / macro). Group results by format or ambition.
Copy a single concept or all of them with one click.

Pick 2+ accounts to unlock **fusion concepts** (cross-pollination ideas
that hit both audiences) and **collab Reels** with a built-in reach boost.

### 🔐 Live API — Meta Connect Wizard
A 4-step wizard for the Instagram Graph API:

1. **Start HTTPS tunnel** — one click. Tries `cloudflared` first
   (Cloudflare quick tunnel — no signup), automatically falls back to
   `localhost.run` over SSH if Cloudflare's API is down. Both yield a
   public `https://…` URL that satisfies Meta's HTTPS-redirect requirement.
2. **Configure your Meta app** — copy-paste cards with the exact URLs to
   put into App Domains, Privacy Policy URL, Terms of Service URL, and
   Valid OAuth Redirect URIs. The dashboard auto-serves `/privacy` and
   `/terms`.
3. **Paste your Meta App ID** (+ optional Login Configuration ID).
4. **Continue with Facebook** — runs the standard FB Login flow.
   Common errors are decoded into specific next-action hints
   (e.g. "switch your Instagram to Professional and link a Page").

### 📦 Data export
Drop your Instagram-issued data export `.zip` in. JavaScript parses the
JSON files in your browser. Surfaces:

- People who don't follow you back · Silent fans · Mutuals
- Followers gained over time · Posting activity by month
- Your 25 most recent posts · Top 30 hashtags
- Recent followers · Most-engaged accounts

To request your export: in the Instagram app → **Settings → Accounts
Center → Your information and permissions → Download your information**
→ choose **JSON** format and "since the beginning". Instagram emails the
zip in 1–48h.

---

## Architecture

| Layer | Tech |
| --- | --- |
| UI | Static HTML + Tailwind (CDN) + custom CSS, Chart.js, Lucide icons |
| Frontend logic | Vanilla ES modules — no build step |
| Local server | Python 3 standard library (`http.server` + `socketserver`) |
| Public-data proxy | `/api/lookup` wraps Instagram's `web_profile_info` + OG-tag fallback |
| Disk cache | `./data/lookups/<username>.json` per-account, with merge-on-partial fallback |
| Tunnel | `cloudflared` (primary) + `localhost.run` via SSH (fallback) |
| OAuth | Facebook JS SDK v19.0 — both classic Login and Login-for-Business flows |
| AI (optional) | Bring-your-own Gemini / Claude / OpenAI / Groq API keys for AI panels |

The local cache, JS state, and Concept-Studio history are all client-side
or filesystem-only. No telemetry, no third-party requests beyond the CDN
script loads and the Instagram endpoints you explicitly query.

---

## File layout

```
instagram-analytics/
├── index.html      # all panels and modals
├── styles.css      # custom theme + Concept Studio + wizard CSS
├── app.js          # ~5800 lines of UI + analytics + Graph API + Concept engine
├── server.py       # local server + lookup cache + tunnel manager + legal pages
├── run.sh          # python3 server.py
├── tunnel.sh       # standalone localhost.run SSH tunnel (manual fallback)
└── data/lookups/   # on-disk cache (gitignored)
```

---

## API reference (local)

| Route | Purpose |
| --- | --- |
| `GET /api/lookup?username=X` | Fresh fetch; falls back to OG tags / cache on rate-limit |
| `GET /api/lookup?username=X&cache=1` | Cache-only — skips network entirely |
| `GET /api/cache/list` | List of accounts currently cached on disk |
| `GET /api/cache/delete?username=X` | Remove one cached account |
| `GET /api/image?url=…` | CORS-friendly proxy for `cdninstagram.com` / `fbcdn.net` |
| `POST /api/tunnel/start` | Start HTTPS tunnel (cloudflared, falls back to SSH) |
| `POST /api/tunnel/stop` | Stop the tunnel |
| `GET /api/tunnel/status` | Current tunnel state + log tail |
| `GET /privacy` · `GET /terms` | Generated legal pages — paste these URLs into your Meta App |
| `POST /api/ai` | Forwards prompts to your configured AI provider |
| `POST /api/list-gemini-models` | List Gemini models for the configured API key |

---

## Privacy

- All Instagram lookups go directly from your machine to Instagram.
- Cached lookups are stored only on your local disk (`./data/lookups/`).
- AI prompts go to whichever provider you configure (Gemini / Claude / OpenAI / Groq) using the key you paste in — keys are kept in browser localStorage only.
- Meta OAuth access tokens stay in your browser's localStorage, never on disk.
- Nothing is shared, reported, or aggregated anywhere.

---

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `partial: true` on lookup | Instagram is rate-limiting. The dashboard automatically falls back to the disk cache and shows an amber banner. Wait 5–15 min. |
| Tunnel says `cloudflared` errored | Cloudflare's quick-tunnel API is intermittently down. The wizard auto-retries with `localhost.run` over SSH. |
| Meta login: "URL not whitelisted" | Reload the dashboard through the HTTPS tunnel URL (Step 1 of the wizard), not through `localhost`. |
| Live API: "no Page with Instagram linked" | Switch your IG account to **Professional** (Business / Creator) and link it to a Facebook Page you administer. |
| Page is blank | Open browser console. If you see a CDN error, check your network — Tailwind / Chart.js / Lucide load from public CDNs. |
| Export upload says "couldn't find data" | Pick **JSON** format when requesting the export, not HTML. |

---

## License

MIT.
