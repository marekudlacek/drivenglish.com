# DrivEnglish

Vocabulary learning app for learning English while driving. Static frontend (no build step, no npm deps) + Cloudflare Worker API + D1 (SQLite). Whole site sits behind Cloudflare Access.

## Architecture

```
public/index.html     frontend: HTML + CSS + vanilla ES2020 in one file
public/_headers       security headers (CSP, X-Frame-Options, Permissions-Policy: microphone=(self))
public/images/        donate_qr.png (donate + paywall), app.png (README)
src/worker.js         Worker: /api/* router, Access JWT verification, trial/paywall, D1 queries
src/seed.js           103 default words, seeded lazily into category "Default" for each new user
migrations/*.sql      D1 schema
wrangler.toml         Worker + static assets + D1 binding (DB) + vars
```

- Static assets served by the Worker's assets binding; `run_worker_first = ["/api/*"]`, SPA fallback via `not_found_handling`.
- **CSS** — custom properties in `:root`, dark theme with cyan (`--accent` = `#00d4ff`) and orange (`--accent2` = `#ff6b35`).
- **Fonts** — Rajdhani (headings/labels) + Nunito (body) via Google Fonts CDN.

## Data model (D1)

| Table | Columns |
|---|---|
| `users` | `email` PK, `first_seen` (ISO, UTC), `paid_until` (nullable), `note` |
| `categories` | `id`, `user_email` → users, `name` (unique per user) |
| `words` | `id`, `category_id` → categories (cascade), `en`, `cs`, `description` |

Every query is scoped by `user_email` (ownership via `JOIN categories`). Always `.bind()` — no string-built SQL with user values.

## Auth & trial

- Cloudflare Access (self-hosted app, policy Allow Everyone, One-time PIN) protects the whole domain.
- Worker verifies `Cf-Access-Jwt-Assertion` (RS256 vs `https://$ACCESS_TEAM_DOMAIN/cdn-cgi/access/certs`, checks `aud`, `exp`, `iss`). Email from the JWT = user id.
- Local dev: `DEV_USER_EMAIL` from `.dev.vars`, honoured **only** when hostname is `localhost`/`127.0.0.1`.
- Trial: `first_seen + TRIAL_DAYS` (default 30). Access OK if in trial or `paid_until > now`, else all `/api/*` except `/api/me` return **402** → frontend shows paywall overlay.
- No payment provider yet — unlock manually via `wrangler d1 execute … UPDATE users SET paid_until=…` (see README).
- Mutating endpoints require `Content-Type: application/json` (415 otherwise) — also blocks simple cross-site form posts.

## API

| Method | Path | Notes |
|---|---|---|
| GET | `/api/me` | `{email, status: trial|paid|expired, trial_days, trial_ends_at, paid_until}` |
| GET/POST | `/api/categories` | GET includes `word_count`, seeds "Default" on first call |
| PATCH/DELETE | `/api/categories/:id` | DELETE removes its words |
| GET | `/api/words?category=1,2` | words from user's categories |
| POST | `/api/words` | `{category_id, en, cs, description?}` |
| POST | `/api/words/bulk` | `{category_id, lines:[{en,cs,description?}]}`, max 1000 |
| PATCH/DELETE | `/api/words/:id` | PATCH may move to another own category |

Limits: name ≤ 60, en/cs ≤ 200, description ≤ 1000.

## Frontend key features

| Feature | Implementation |
|---|---|
| TTS playback | `window.speechSynthesis` — EN → 3s pause → CZ (+ description shown, not spoken) → 1s gap → loop |
| Categories | Chips, multi-select; selection kept per device in `localStorage` `drivenglish_selected_categories` |
| Word editor | "My Words" panel: category select + new/rename/delete, add/edit/delete word, bulk import textarea (`english = czech \| description`, `//` comments) |
| Legacy migration | Old `localStorage` key `driveenglish_custom` → offered import into category "My words", then removed |
| Voice control | `SpeechRecognition` (Chromium/Safari), `cs-CZ`, auto-restart |
| Progress | Linear progress bar, timer SVG arc (94.2 dasharray = 2πr, r=15) |
| Shuffle on STOP | `stopPlayback()` calls `shuffle(words)` before resetting to index 0 |
| Trial/paywall | `renderTrialBanner()`, `showPaywall()`; `api()` throws `PaywallError` on 402 |
| Donate modal | `openDonate()` / `closeDonate()` |

## Voice commands

| Spoken word(s) | Action |
|---|---|
| stop / zastavit / zastav / konec | `stopPlayback()` + shuffle |
| start / continue / pokračuj / hraj / resume | `resumePlayback()` (only when paused) |
| pause / pauza / pozastav / počkej | `pausePlayback()` |
| next / další / přeskočit / skip | `togglePlay()` — skips current word |
| back / zpět / předchozí | `prevWord()` |

## Keyboard shortcuts (ignored while typing in inputs)

| Key | Action |
|---|---|
| Space | togglePlay() |
| ArrowLeft | prevWord() |
| Escape | stopPlayback() |

## Playback flow

```
playWord(idx)
  → speak EN (en-GB)
  → delay 3 s + timer arc
  → show CZ + description, speak CZ (cs-CZ)
  → delay 1 s
  → playWord(idx + 1)   // recursive, guarded by playGen
```

`playGen` is incremented on every new `playWord` call (and in `reloadPlayback()`); each async step checks `playGen !== gen` — the cancellation mechanism.

## Dev & deploy

- Local: `npm run dev` (= `wrangler d1 migrations apply --local && wrangler dev`). `package.json` has scripts only, no dependencies — wrangler via `npx wrangler@4`.
- Prod: Cloudflare Workers Builds connected to the repo, branch `main`, deploy command `npm run deploy` (= `d1 migrations apply --remote && wrangler deploy`). Schema changes go into a new `migrations/000N_*.sql`, never edit an applied migration.
- `wrangler.toml` holds D1 `database_id` and `ACCESS_TEAM_DOMAIN` (not secrets). `ACCESS_AUD` = Application Audience tag of the Access app "DrivEnglish" (policy Allow / Everyone).

## Known limitations / gotchas

- **SpeechSynthesis voices** load async; first word on some mobile browsers may use a fallback voice.
- **Safari** requires `SpeechRecognition.continuous = false` — handled with manual restart in `r.onend`.
- **Microphone permission** `not-allowed` disables voice control and shows an error state.
- Zero Trust free plan: max 50 users.
- `users.paid_until` accepts `YYYY-MM-DD` (treated as end of that day UTC) or full ISO timestamp.

## Security notes

- No `innerHTML` with user/DB data — everything via `textContent` / DOM APIs.
- Never trust `Cf-Access-Authenticated-User-Email` alone — identity comes from the verified JWT.
- `workers_dev = false` so the Worker isn't reachable outside the Access-protected domain.
- CSP in `_headers`: scripts `'self' 'unsafe-inline'`, `connect-src 'self'`, fonts from Google only.
