# Garbicz DJ App — Handoff Brief

A self-contained spec for resuming this project cold in an IDE / coding agent.
No prior chat context required.

---

## Goal

An **iPhone PWA** that my wife and I use to manage our DJ shortlist for the
**Garbicz Festival** (Poland). We already keep the DJs in a **Google Sheet**
with ratings and notes. The app must **read and write** that Sheet, work
**offline** at the festival (patchy signal), and let us **update set times**
on the ground. Both of us use it at the same time on separate phones.

---

## Architecture (decided)

- **Backend:** Google Apps Script bound to the Sheet, published as a Web App.
  Serves JSON on GET, accepts row writes on POST. This avoids OAuth — the PWA
  talks to a single `/exec` URL. **Already written — see `Code.gs`.**
- **Frontend:** A static PWA (`index.html`, `app.js`, `styles.css`,
  `manifest.json`, `service-worker.js`). **Still to build.**
- **Offline:** App shell cached by the service worker; data cached in
  IndexedDB. Show cached data instantly on launch, refresh from the Sheet in
  the background, queue local edits and sync when back online.
- **Concurrency:** "Last write wins" using timestamps (details below).
- **Hosting:** A free static host with automatic HTTPS (Cloudflare Pages /
  Netlify / Vercel / GitHub Pages). HTTPS is **required** for PWA install +
  service workers. Localhost is a secure context on the laptop only, so the
  laptop is for dev; the phones install from the deployed HTTPS URL.

---

## Data schema (Google Sheet)

Visible columns (row 1 = header), in this order:

`Artist | M | A | From | Style | Biography | Best DJ Set | Resident Advisor | Instagram`

- `M` and `A` are our two personal rating columns (Michael / [wife]).
- The backend auto-adds two helper columns the app needs and back-fills them
  on first run — **do not remove these**:
  - `id` — stable UUID per row (survives sorting/reordering).
  - `lastModified` — server timestamp (ms) of the last change.

Rows are addressed by `id`, never by row number. The backend reads/writes by
**header name**, so column order can change freely.

> Note: header names contain spaces, so JSON keys do too. Reference them as
> `row["Best DJ Set"]` and `row["Resident Advisor"]`, not dot notation.

---

## Backend API contract (`Code.gs`, already implemented)

**GET** `<web-app-url>/exec`
Returns all rows.
```json
{
  "ok": true,
  "rows": [
    {
      "id": "uuid",
      "Artist": "…", "M": "…", "A": "…", "From": "…", "Style": "…",
      "Biography": "…", "Best DJ Set": "…", "Resident Advisor": "…",
      "Instagram": "…",
      "lastModified": 1720800000000
    }
  ],
  "serverTime": 1720800000000
}
```

**POST** `<web-app-url>/exec`
Body — one or more changed rows. Include `clientModified` (ms timestamp of the
local edit). Omit `id` (or send an unknown one) to create a new row.
```json
{
  "rows": [
    {
      "id": "uuid",
      "Artist": "…", "M": "…", "A": "…", "set fields as needed": "…",
      "clientModified": 1720800005000
    }
  ]
}
```

Response — per-row status:
```json
{
  "ok": true,
  "serverTime": 1720800006000,
  "results": [
    { "id": "uuid", "status": "updated",  "lastModified": 1720800006000 },
    { "id": "uuid", "status": "inserted", "lastModified": 1720800006000 },
    { "id": "uuid", "status": "conflict", "server": { /* current row */ } }
  ]
}
```

**Conflict rule:** the server applies a change only if
`clientModified >= lastModified`. If the server's copy is newer, it returns
`status: "conflict"` with the current server row. The client should then show
that server version won and surface a brief notice (e.g. "changed by someone
else").

The script uses `LockService` so concurrent writes don't overlap.

---

## Frontend — still to build

1. **List view** of all DJs (Artist, ratings M/A, From, Style, Instagram link,
   Resident Advisor link). Sortable/filterable is nice-to-have.
2. **Edit** a row: at minimum ratings (M, A), set time, notes/biography.
   (Set time can live in a dedicated column later if wanted; for now edits go
   through the existing fields — confirm whether a `Set Time` column should be
   added to the schema.)
3. **Offline-first flow:**
   - On launch, render cached rows from IndexedDB immediately.
   - Fetch fresh rows in the background; reconcile into IndexedDB.
   - On edit: write locally, stamp `clientModified = Date.now()`, mark row
     `dirty`.
   - When online (`navigator.onLine` / Background Sync), POST all dirty rows,
     then clear `dirty` on success and handle `conflict` results.
4. **PWA install requirements (iOS):**
   - `manifest.json` with `"display": "standalone"`.
   - Meta tag `apple-mobile-web-app-capable`.
   - `apple-touch-icon` (home-screen icon).
   - Without these, iOS opens it as a plain Safari tab, not full-screen.
5. **Config:** a single constant for the Apps Script `/exec` URL.

---

## Look & feel — Garbicz Festival

Natural, handmade lakeside/forest aesthetic: earthy palette (forest green,
ochre/terracotta, warm cream, wood tones), organic shapes, soft rounded
corners, a playful but legible near-handwritten display typeface rather than
clean corporate/tech UI. Check the official Garbicz branding for reference.

---

## Setup / deploy checklist

**Backend**
1. Sheet → Extensions → Apps Script. Paste `Code.gs`.
2. Set `const SHEET_NAME` to the tab name.
3. Deploy → New deployment → Web app → Execute as **Me**,
   Who has access **Anyone with the link** → authorize → copy the `/exec` URL.
4. Any code change requires publishing a **new version**
   (Manage deployments → edit → New version) to go live at the same URL.

**Frontend**
1. Build the files above; put the `/exec` URL in the config constant.
2. Dev locally against `http://localhost` (secure context on the laptop).
3. Deploy to Cloudflare Pages / Netlify / Vercel / GitHub Pages (auto HTTPS).
4. On each iPhone: open the HTTPS URL **in Safari** → Share → Add to Home
   Screen. (iOS PWA install works only in Safari.)
5. To test on a physical iPhone before deploying, use a tunnel
   (`cloudflared` / `ngrok`) for a temporary HTTPS URL — or just deploy.

---

## Open decisions

- Add a dedicated `Set Time` (and maybe `Stage`) column to the schema, or reuse
  existing fields? (Festival use case implies yes — likely add both.)
- Any auth needed, or is "Anyone with the link" fine for a two-person tool?
  (Link is unguessable; probably fine. Revisit if the Sheet holds anything
  sensitive.)
- Conflict UX: silent server-wins + toast, or a small "review differences"
  prompt?
