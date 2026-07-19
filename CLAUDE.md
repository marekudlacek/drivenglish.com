# DrivEnglish

Single-page vocabulary learning app for learning English while driving. No build step, no dependencies — one HTML file.

## Architecture

Everything lives in `index.html` (= `drivenglish.html`):
- **CSS** — CSS custom properties in `:root`, dark theme with cyan (`--accent` = `#00d4ff`) and orange (`--accent2` = `#ff6b35`) accents
- **JS** — vanilla ES2020, no frameworks
- **Fonts** — Rajdhani (headings/labels) + Nunito (body) via Google Fonts CDN
- **Assets** — `images/donate_qr.png` (donate QR code)

## Key features

| Feature | Implementation |
|---|---|
| TTS playback | `window.speechSynthesis` — EN → 3s pause → CZ → 1s gap → loop |
| Voice control | `SpeechRecognition` (Chromium/Safari), `cs-CZ` lang, auto-restart |
| Word editor | Textarea, format `english = czech`, one pair per line, `//` comments |
| Persistence | `localStorage` key `driveenglish_custom` |
| Progress | Linear progress bar, timer SVG arc (94.2 dasharray = 2πr, r=15) |
| Shuffle on STOP | `stopPlayback()` calls `shuffle(words)` before resetting to index 0 |
| Donate modal | `openDonate()` / `closeDonate()` — overlay with QR from `images/donate_qr.png` |
| Contact button | Hover reveal — shows "CONTACT" by default, reveals `sw@marekudlacek.cz` on hover |

## UI colors

| Element | Color |
|---|---|
| "Driv" in logo | cyan `--accent` |
| "English" in logo | white `#ffffff` |
| Czech translations | cyan `--accent` |
| Donate button text | white `#ffffff` |
| Contact button (default) | muted `--muted` |
| Contact button (hover) | cyan `--accent` |

## Voice commands

| Spoken word(s) | Action |
|---|---|
| stop / zastavit / zastav / konec | `stopPlayback()` + shuffle |
| start / continue / pokračuj / hraj / resume | `resumePlayback()` (only when paused) |
| pause / pauza / pozastav / počkej | `pausePlayback()` |
| next / další / přeskočit / skip | `togglePlay()` — skips current word |
| back / zpět / předchozí | `prevWord()` |

## Keyboard shortcuts

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
  → show CZ translation + speak CZ (cs-CZ)
  → delay 1 s
  → playWord(idx + 1)   // recursive, guarded by playGen
```

`playGen` is incremented on every new `playWord` call. Each async chain checks `playGen !== gen` before proceeding — this is the cancellation mechanism.

## Cloudflare deployment

Files needed:
- `index.html` — entry point
- `_headers` — security headers (CSP, X-Frame-Options, `Permissions-Policy: microphone=(self)`)
- `_redirects` — SPA fallback (`/* /index.html 200`)
- `images/donate_qr.png` — required for donate modal

Deploy via Cloudflare Workers & Pages → Upload assets (drag-and-drop folder).
The app is fully static, no workers or KV needed.

## Known limitations / gotchas

- **SpeechSynthesis voices** load async — `onvoiceschanged` is wired but no retry logic if voices load after first `speak()` call. On Chrome this is usually fine; on some mobile browsers the first word may use a fallback voice.
- **Safari** requires `SpeechRecognition.continuous = false` — the app handles this with manual restart in `r.onend`.
- **Microphone permission** must be granted by the user; `not-allowed` error disables voice control and shows an error state.
- CSS custom properties were previously broken (en-dash `–` instead of `--` in `var()` calls). Fixed 2026-04.

## Security notes

- No `innerHTML` with user input — words are set via `textContent` only (XSS-safe)
- `localStorage` stores only the textarea content (plain text, no eval)
- External dependencies: Google Fonts CDN only (style + font files)
- CSP in `_headers` restricts scripts to `'self' 'unsafe-inline'` (inline script required since no bundler)
