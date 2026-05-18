# Deployment & integrations guide

This guide covers everything that needs an external account or DNS change.
Each section is independent — pick the ones you actually want.

| Section | What you'll set up | Effort | Cost |
|---|---|---|---|
| [Custom domain](#1-custom-domain) | `pulse.yourdomain.com` instead of `instagram-analytics-omega.vercel.app` | 5 min | Free if you own the domain |
| [Meta App (Instagram Live API)](#2-meta-app--instagram-live-api) | Fix "Facebook Login unavailable" errors | 10-30 min | Free |
| [Supabase auth](#3-supabase-auth) | Real user accounts + sync across devices | 15 min | Free tier covers most use |
| [Stripe billing](#4-stripe-billing) | Activate the Pricing page CTAs | 10 min | 2.9% + 30¢ per transaction |
| [Self-host alternatives](#5-self-host-alternatives) | Railway / Fly / Render if you want to keep the long-running Python server | 10 min | $5-7/mo |

---

## 1. Custom domain

The deployment lives at `instagram-analytics-omega.vercel.app` by default.
To point a custom subdomain at it:

1. **Buy a domain** (Namecheap, Porkbun, Cloudflare Registrar — all fine).
2. Open the Vercel dashboard → your project → **Settings → Domains**.
3. Click **Add**, paste `pulse.yourdomain.com` (or whatever you want).
4. Vercel shows you a **CNAME** record:
   ```
   Type:   CNAME
   Name:   pulse
   Value:  cname.vercel-dns.com
   TTL:    Auto
   ```
5. In your domain registrar's DNS settings, add that record.
6. Wait 1-30 minutes for DNS propagation. Vercel auto-issues an HTTPS cert.
7. Update your Meta App's **OAuth Redirect URIs** + **App Domains** to use the new domain (see Section 2).

For an apex domain (`pulse.com` instead of `pulse.example.com`):
- Use an `A` record pointing to `76.76.21.21` (Vercel's IP), or
- Use `ALIAS` / `ANAME` if your registrar supports it.

---

## 2. Meta App (Instagram Live API)

If you see **"Facebook Login is currently unavailable for this application"**, one of these is the cause.

### 2a. App role check (most common fix)

If your app is in **Development** mode, only listed developers/testers can log in.

1. https://developers.facebook.com/apps → your app
2. **App Roles → Roles** in the left sidebar
3. Click **Add People** → add the Facebook account you're trying to log in with as **Developer** or **Tester**
4. They'll get a notification on Facebook — accept it
5. Try login again

### 2b. Required Basic Settings

In **Settings → Basic**, every required field must be filled:

| Field | What to use |
|---|---|
| Display name | `Pulse Instagram Analytics` (or your brand) |
| App domains | Your deployment hostname, e.g. `instagram-analytics-omega.vercel.app` (NO `https://`, NO trailing slash) |
| Privacy Policy URL | `https://<your-domain>/privacy` |
| Terms of Service URL | `https://<your-domain>/terms` |
| User Data Deletion | `https://<your-domain>/privacy` (the privacy page documents how to delete) |
| Category | `Business and Pages` (or closest match) |
| Icon | 1024×1024 PNG (any logo, even a placeholder works) |

After saving, wait 2-3 minutes and retry login.

### 2c. Use Cases (new Meta app workflow)

Newer Meta apps require **Use Cases** instead of raw "products". In the left sidebar:

1. Click **Use Cases**
2. **Add use case** → **Authenticate and request data from users with Facebook Login**
3. In that use case, **Customize**:
   - Enable **Facebook Login for Business**
   - Under permissions: enable `email`, `public_profile`, `pages_show_list`, `pages_read_engagement`, `business_management`
4. **Add use case** → **Access tools and APIs available for the Instagram platform**
5. In that use case, enable:
   - `instagram_business_basic`
   - `instagram_business_manage_insights`

### 2d. OAuth redirect URIs

**Settings → Use cases → Facebook Login for Business → Settings**, paste into **Valid OAuth Redirect URIs**:

```
https://<your-domain>/
```

If you're running a local tunnel for dev: also add the tunnel URL (e.g. `https://xxx.trycloudflare.com/`).

### 2e. Going Live

Once in development everything works for testers, but **anyone** can log in only after the app is switched to **Live** mode.

Top of the App dashboard: toggle **In Development** → **Live**. Meta will block this until all Basic Settings (2b) are complete.

### 2f. App Review (for production with arbitrary users)

For real users to log in (not testers), you need to submit specific permissions for review:

- `instagram_business_basic`
- `instagram_business_manage_insights`
- `pages_show_list`
- `pages_read_engagement`

In **App Review → Permissions and Features**, for each permission click **Request advanced access** → provide a screencast showing the integration in your app.

Approval typically takes 3-10 business days.

---

## 3. Supabase auth

The dashboard's **Sign in** button is wired but currently runs in demo mode (no backend). To enable real magic-link auth across devices:

1. Go to [supabase.com](https://supabase.com) → **New project** → free tier
2. Once provisioned, copy from **Settings → API**:
   - Project URL (e.g. `https://xxxxx.supabase.co`)
   - **anon public** key
3. In **Authentication → URL Configuration**, add your deployment URL (e.g. `https://instagram-analytics-omega.vercel.app/`) to the **Site URL** and to the **Redirect URLs** allowlist
4. In **Authentication → Email Templates**, customize the magic-link email if you want
5. Open `index.html` in this repo. Just before the closing `</body>` tag (or near the top of the body), add this script:

   ```html
   <script>
     window.PULSE_AUTH_CONFIG = {
       supabaseUrl: "https://YOUR-PROJECT.supabase.co",
       supabaseAnonKey: "YOUR-ANON-KEY"
     };
   </script>
   ```

6. Commit + push. Vercel auto-redeploys. The **Sign in** button now sends real magic-link emails.

The dashboard frontend automatically picks up the access_token when the user clicks the link in their email — no further code changes needed.

### Syncing data to Supabase (optional, advanced)

The Watchlist, Concept Studio history, and Discover saved queries currently live in `localStorage` per browser. To sync them:

1. In Supabase **Database → Tables**, create:
   - `watchlist (user_id uuid, username text, added_at timestamp)`
   - `concept_history (user_id uuid, username text, snapshot jsonb)`
   - `discover_saved (user_id uuid, query jsonb)`
2. Enable **Row Level Security** on each, with policies allowing users to read/write only their own rows.
3. Update `loadWatchlist()` / `saveWatchlist()` etc. in `app.js` to fall through to Supabase when a user is signed in. Ask your AI of choice — that's a ~100-line refactor.

---

## 4. Stripe billing

The Pricing page (`/pricing`) has buttons wired but they currently just show "Not configured yet". To accept payments:

1. Sign up at [stripe.com](https://stripe.com) (free, no upfront cost — only 2.9% + 30¢ per transaction)
2. **Products → + Add product** → create:
   - **Pulse Pro** — $19/month recurring
   - **Pulse Team** — $49/month recurring
3. For each product, click the price → **Create payment link**
4. Copy the two payment-link URLs (they look like `https://buy.stripe.com/xxx`)
5. Open `pricing.html` in this repo. Find this block near the top:

   ```js
   window.PULSE_PRICING_CONFIG = {
     stripePro: "",     // e.g. "https://buy.stripe.com/xxx"
     stripeTeam: "",    // e.g. "https://buy.stripe.com/yyy"
     contactEmail: "",  // e.g. "you@example.com"
   };
   ```

6. Paste your two payment-link URLs in. Add your support email.
7. Commit + push. CTAs now go to live Stripe checkout.

### Receiving webhooks (for granting access on successful payment)

Stripe payment links work without webhooks — Stripe shows a success page and emails the customer. To actually *grant access* in your app on successful payment, you need:

1. A webhook endpoint to handle `checkout.session.completed` events
2. A way to associate the email → Supabase user → "Pro" or "Team" tier in your DB

This is a ~50-line addition. Add `api/stripe-webhook.py` as a new Vercel function. Reach for an AI of your choice for the boilerplate — Stripe has good docs and the pattern is well-known.

---

## 5. Self-host alternatives

The full local Python server (`server.py`) includes features that don't work on Vercel:

- Persistent disk cache (`./data/lookups/*.json`)
- Cloudflared/localhost.run tunnel manager
- Server-side export-zip path parsing

If you want those, deploy to a long-running host instead of Vercel.

### Railway (recommended for simplicity)
```sh
# Install Railway CLI
npm i -g @railway/cli
railway login
railway init      # in the repo
railway up        # deploys server.py
```
Set the start command to `python3 server.py` in the Railway dashboard. ~$5/mo.

### Fly.io
Add a `Dockerfile`:
```dockerfile
FROM python:3.11-slim
WORKDIR /app
COPY . .
EXPOSE 8000
CMD ["python3", "server.py"]
```
Then:
```sh
fly launch
fly deploy
```

### Render
Connect the GitHub repo, choose **Web Service**, **Python** runtime, start command `python3 server.py`. Free tier sleeps after 15 min of inactivity; $7/mo for always-on.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Custom domain shows "Invalid SSL certificate" for 30 min after adding | Wait — Vercel is provisioning the cert. If it persists, re-add the domain. |
| Stripe checkout opens then says "Something went wrong" | Your payment link is in test mode; use the live key after enabling your Stripe account. |
| Supabase magic link email never arrives | Check **Authentication → Logs** in Supabase dashboard. Most common cause: site URL not in the redirect allowlist. |
| Meta App still blocks login after fixes | The cached redirect URL list on Meta's end takes 5-10 min to refresh. |
| `Vercel function timeout` on Discover | Discover sequentially looks up many accounts; on Vercel's 10s limit (Hobby plan) you may hit timeouts. Reduce the count, or upgrade to Pro for 60s. |

---

## Useful URLs

- **Live app**: https://instagram-analytics-omega.vercel.app/
- **GitHub repo**: https://github.com/MOUBI9A/instagram-analytics
- **Vercel dashboard**: https://vercel.com/dashboard
- **Meta App dashboard**: https://developers.facebook.com/apps/
- **Supabase dashboard**: https://supabase.com/dashboard
- **Stripe dashboard**: https://dashboard.stripe.com
