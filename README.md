# Garbicz DJ Shortlist — PWA

An offline-first iPhone PWA for managing our DJ shortlist for **Garbicz
Festival**, backed by a Google Sheet. Read + write the Sheet, works offline at
the festival, two phones at once.

- **Backend:** Google Apps Script bound to the Sheet ([Code.gs](Code.gs)),
  published as a Web App (JSON on GET, row writes on POST).
- **Frontend:** static PWA — [index.html](index.html), [app.js](app.js),
  [styles.css](styles.css), [manifest.json](manifest.json),
  [service-worker.js](service-worker.js), [icons/](icons/).
- **Offline:** app shell cached by the service worker; data cached in
  IndexedDB. Cached rows show instantly, then refresh from the Sheet.
  Edits are queued locally and pushed when back online.
- **Concurrency:** last-write-wins by timestamp. If the server copy is newer,
  the app keeps the server version and shows a brief "changed by someone else"
  toast.

---

## Data schema

Sheet columns (row 1 = header):

```
Artist | M | A | From | Style | Biography | Best DJ Set | Resident Advisor | Instagram | Set Time | Stage | id | lastModified
```

- `M` / `A` — the two personal rating columns (Michael / partner).
- `Set Time`, `Stage` — festival scheduling. **Set Time** is stored canonically
  as `YYYY-MM-DD HH:mm` (e.g. `2026-07-30 23:30`) — the editor writes this via a
  festival-day dropdown (Jul 30 – Aug 2, 2026) plus a 24-hour time picker. That
  format sorts chronologically and drives the Calendar view.
- `id`, `lastModified` — sync helper columns, auto-added and back-filled by the
  backend. **Don't delete these.** Column order can change freely — the backend
  reads/writes by header name.

> **Ratings scale:** the edit screen uses a **1–5** stepper for M/A. If your
> Sheet already uses a different scale (e.g. 1–10), an existing value is shown
> as-is and is only overwritten if you actually tap a new rating for that DJ.
> Tell me if you'd prefer a different scale/control.

---

## Deploy

### 1. Backend (Google Apps Script)

1. Open the Sheet → **Extensions → Apps Script**.
2. Paste [Code.gs](Code.gs) into the editor (replace the default file).
3. Set `const SHEET_NAME` (top of the file) to your tab name (default `'DJs'`).
4. **Deploy → New deployment → Web app**
   - Execute as: **Me**
   - Who has access: **Anyone with the link**
5. Authorize when prompted, then **copy the Web App URL** (ends in `/exec`).
6. On first GET the script auto-adds `id`, `lastModified`, and the new
   `Set Time` / `Stage` columns and back-fills them.

> After any change to `Code.gs`, publish a **new version**
> (Manage deployments → edit → Version: New version) to go live at the same URL.

### 2. Frontend

1. Open [app.js](app.js) and set the config constant near the top:
   ```js
   const EXEC_URL = 'https://script.google.com/macros/s/XXXX/exec';
   ```
2. **Dev locally** (localhost is a secure context, so the service worker + PWA
   features work):
   ```sh
   cd PWA_Garbicz
   python3 -m http.server 8000
   # open http://localhost:8000
   ```
3. **Deploy** to any static host with automatic HTTPS — Cloudflare Pages,
   Netlify, Vercel, or GitHub Pages. HTTPS is required for PWA install +
   service workers on the phones. Just upload this folder as-is (no build step).

### 3. Install on each iPhone

1. Open the deployed **HTTPS URL in Safari** (iOS PWA install only works in
   Safari).
2. **Share → Add to Home Screen.**
3. Launch from the home-screen icon — it opens full-screen (standalone), not a
   Safari tab.

> To test on a real iPhone before deploying, expose localhost over HTTPS with a
> tunnel (`cloudflared tunnel --url http://localhost:8000` or `ngrok http 8000`)
> and open that URL in Safari.

---

## How it works day-to-day

- **List** view shows every DJ with ratings, set time, stage, style, and links
  to Instagram / Resident Advisor. Search by artist/style/from/stage; sort A–Z,
  by set time, by **stage**, or by rating (M / A).
- **Calendar** view (top tab) groups every DJ that has a set time under each
  festival day (Jul 30 – Aug 2, 2026), ordered by time — the day-by-day running
  order. Tap any entry to edit it.
- **Tap a card** to edit; **＋** adds a new DJ.
- Edits save **instantly and offline**. A small dot on a card = not yet synced.
  The pill in the top bar shows sync status (Offline / Syncing / Synced) — tap
  it to force a refresh.
- When two people edit the same DJ, the later write wins; the other phone gets
  a toast the next time it syncs.

---

## Notes / CORS

- Writes POST with `Content-Type: text/plain` on purpose — this keeps the
  request a CORS "simple request" so Apps Script (which doesn't answer
  preflight `OPTIONS`) accepts it. The backend `JSON.parse`s the body anyway.
- The `/exec` link is unguessable; for a two-person tool "Anyone with the link"
  is fine. Add auth later if the Sheet ever holds anything sensitive.

## Regenerating icons

Icons are pre-generated in [icons/](icons/). To rebuild them (pure Python, no
deps), see `make_icons.py` in the project scratchpad, then:
`python3 make_icons.py icons/icon-512.png && sips -z 192 192 …` (see the script).
