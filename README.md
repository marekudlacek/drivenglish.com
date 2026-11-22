# drivenglish.com

Vocabulary learning app for learning English while driving — plays words aloud (English → Czech) so you can practice hands-free.

🔗 **Live app:** [https://drivenglish.com](https://drivenglish.com)

![DrivEnglish app screenshot](public/images/app.png)

## Features

- Text-to-speech playback of English words followed by Czech translations
- Voice control (start/stop/pause/next/back) via speech recognition
- Words stored in **Cloudflare D1**, organised into **categories**; each word has an optional **description**
- Pick one or more categories to play (shuffled mix)
- Bulk import: `english = czech | description`, one per line
- Login via **Cloudflare Access** (one-time PIN to e-mail), **30-day free trial**, then a paywall (manual unlock for now)

## Stack

- `public/` — static frontend (single `index.html`, vanilla JS, no build step)
- `src/worker.js` — Cloudflare Worker serving `/api/*`, verifies the Access JWT, talks to D1
- `migrations/` — D1 schema (`users`, `categories`, `words`)

## Local development

```bash
npm i -g wrangler            # or use npx
cp .dev.vars.example .dev.vars   # sets DEV_USER_EMAIL, bypasses Access on localhost only
wrangler d1 migrations apply drivenglish --local
wrangler dev
```

Open http://localhost:8787.

## Deployment (Cloudflare)

1. `wrangler d1 create drivenglish` → put the `database_id` into `wrangler.toml`.
2. `wrangler d1 migrations apply drivenglish --remote`
3. Zero Trust → Access → Applications → **Add self-hosted app** for `drivenglish.com` (path `/*`), policy **Allow / Everyone**, login method **One-time PIN**.
   Copy the **Application Audience (AUD) tag** → `ACCESS_AUD`, team domain (`<team>.cloudflareaccess.com`) → `ACCESS_TEAM_DOMAIN` in `wrangler.toml`.
4. `wrangler deploy`, then attach the custom domain `drivenglish.com` to the Worker (Workers → drivenglish → Settings → Domains & Routes) and detach it from the old Pages project.

> Free Zero Trust plan covers up to 50 users.

## Trial & unlocking a paid user

Trial length is `TRIAL_DAYS` in `wrangler.toml` (default 30). After it ends the API returns `402` and the app shows the paywall. To unlock a user:

```bash
wrangler d1 execute drivenglish --remote --command "UPDATE users SET paid_until='2027-12-31' WHERE email='user@example.com'"
```

List users and their status:

```bash
wrangler d1 execute drivenglish --remote --command "SELECT email, first_seen, paid_until FROM users ORDER BY first_seen DESC"
```
