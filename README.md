# Instagram Analytics — Local Dashboard

A stylish, fully-local dashboard that turns your **Instagram data export** into
useful analytics. No Meta API, no app registration, no login of any kind. Just
drop your zip in and look.

## How it works

1. You ask Instagram for an export of your data (legitimate, built-in feature).
2. Instagram emails you a `.zip` within 1–48 hours.
3. You open `index.html` and drag the zip in.
4. JavaScript parses the JSON files in your browser. Nothing leaves your machine.

## Run it

Just double-click `index.html` — that's it.

(Optional: if your browser blocks something on `file://`, run
`sh run.sh` and open <http://localhost:8000>.)

## Get your Instagram data export

In the Instagram **mobile app**:

1. **Settings** → **Centre de comptes** (Accounts Center)
2. **Vos informations et autorisations** (Your information and permissions)
3. **Télécharger vos informations** (Download your information)
4. Pick your Instagram account
5. **Quelques-unes** of your information *or* **Toutes**
6. Format: **JSON** (smaller, structured) — important, don't pick HTML
7. Quality: any · Date range: **Depuis le début** (since the beginning)
8. Submit. You'll get an email with a download link in 1–48h.
9. Download the `.zip`, drop it into the dashboard.

The English labels are the same in the same order: Settings → Accounts Center →
Your information and permissions → Download your information.

## What the dashboard shows

**From your export, the things you actually care about:**

- Profile (username, bio, post count) + headline stats
- **People who don't follow you back** (you follow them, they don't follow you)
- **Silent fans** (follow you, you don't follow them back)
- **Mutuals** count
- **Followers/following ratio**
- Followers gained over time (cumulative growth chart)
- Your posting activity by month
- **Recent followers** (the 20 newest)
- **Your most engaged accounts** (whose posts you liked or commented on most)
- Your 25 most recent posts (captions + dates + type)
- **Top 30 hashtags** you use in your captions

## What it can't show — and why

Instagram's export does **not** include:
- Like / comment / reach / impression counts on **your own** posts (those live behind the Insights tab in the IG app, or the Graph API)
- Who viewed your profile or stories — Instagram doesn't expose viewer identities anywhere, not in the export, not in the API. Tools that claim to are scraping (a TOS violation that can get accounts banned).

To track follower changes over time, download a new export every now and then
and compare. (A future version could diff two exports — ask if you want that.)

## Files

- `index.html` — markup
- `styles.css` — custom theme (glassmorphism, animated background)
- `app.js` — zip parsing + analytics + rendering
- `run.sh` — *optional* local HTTP server (`python3 -m http.server 8000`)
- `README.md` — this file

Tailwind, Chart.js, JSZip, and Lucide load from public CDNs — no install,
no build step.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| "Couldn't find any Instagram data in this zip" | You probably picked HTML format. Re-request with **JSON**. |
| Followers chart is empty / flat | Older Instagram exports don't include timestamps on follower entries. The lists still work; only the growth chart is affected. |
| Username doesn't show | The export structure varies; the dashboard falls back to the zip filename. Rename your zip to `instagram-USERNAME-DATE.zip` if needed. |
| Page is blank | Open the browser console (Cmd+Opt+J on Chrome). If you see a CDN error, run `sh run.sh` and use <http://localhost:8000>. |
# instagram-analytics
