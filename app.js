/* ============================================================
   Garbicz DJ Shortlist — frontend logic
   Offline-first PWA over a Google Apps Script backend.
   ============================================================ */

/* ---------- 1. CONFIG ----------------------------------------------------
   Paste your deployed Apps Script Web App URL here (ends in /exec).
   Deploy: Sheet > Extensions > Apps Script > paste Code.gs >
           Deploy > New deployment > Web app >
           Execute as: Me, Who has access: Anyone with the link.
------------------------------------------------------------------------- */
const EXEC_URL = 'https://script.google.com/macros/s/AKfycbyxsJQsQKq5M7B5UOn5KF1m-l60l07ELZ91IneVXGsFBkZpoUvk0x0z2haWxyuv3pHUNg/exec';

const IS_CONFIGURED = /^https:\/\/script\.google(usercontent)?\.com\//.test(EXEC_URL);

/* Sheet field keys (some contain spaces). */
const F = {
  artist: 'Artist', m: 'M', a: 'A', from: 'From', style: 'Style',
  bio: 'Biography', bestSet: 'Best DJ Set', ra: 'Resident Advisor',
  ig: 'Instagram', setTime: 'Set Time', stage: 'Stage',
};
const USER_FIELDS = Object.values(F);

/* ---------- 2. Tiny DOM helper ------------------------------------------ */
function el(tag, props, children) {
  const node = document.createElement(tag);
  if (props) {
    for (const k in props) {
      if (k === 'class') node.className = props[k];
      else if (k === 'text') node.textContent = props[k];
      else if (k === 'html') node.innerHTML = props[k];
      else if (k.startsWith('on') && typeof props[k] === 'function') {
        node.addEventListener(k.slice(2).toLowerCase(), props[k]);
      } else if (props[k] != null && props[k] !== false) {
        node.setAttribute(k, props[k]);
      }
    }
  }
  (children || []).forEach(function (c) {
    if (c == null) return;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  });
  return node;
}
const $ = function (sel) { return document.querySelector(sel); };

/* ---------- 3. IndexedDB -------------------------------------------------
   One store "djs" keyed by "id". Records hold the sheet fields plus local
   meta: _dirty (pending push), _clientModified (edit timestamp), _new.
------------------------------------------------------------------------- */
const DB_NAME = 'garbicz-djs';
const STORE = 'djs';
const STAGE_STORE = 'stages';   // keyed by stage name
let _dbPromise = null;

function db() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise(function (resolve, reject) {
    const req = indexedDB.open(DB_NAME, 2);
    req.onupgradeneeded = function () {
      const d = req.result;
      if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE, { keyPath: 'id' });
      if (!d.objectStoreNames.contains(STAGE_STORE)) d.createObjectStore(STAGE_STORE, { keyPath: 'Stage' });
    };
    req.onsuccess = function () { resolve(req.result); };
    req.onerror = function () { reject(req.error); };
  });
  return _dbPromise;
}
function tx(mode, store) {
  const name = store || STORE;
  return db().then(function (d) { return d.transaction(name, mode).objectStore(name); });
}
function idbGetAll(store) {
  return tx('readonly', store).then(function (s) {
    return new Promise(function (res, rej) {
      const r = s.getAll();
      r.onsuccess = function () { res(r.result || []); };
      r.onerror = function () { rej(r.error); };
    });
  });
}
function idbPut(rec, store) {
  return tx('readwrite', store).then(function (s) {
    return new Promise(function (res, rej) {
      const r = s.put(rec);
      r.onsuccess = function () { res(); };
      r.onerror = function () { rej(r.error); };
    });
  });
}
function idbDelete(id, store) {
  return tx('readwrite', store).then(function (s) {
    return new Promise(function (res, rej) {
      const r = s.delete(id);
      r.onsuccess = function () { res(); };
      r.onerror = function () { rej(r.error); };
    });
  });
}

/* ---------- 4. App state ------------------------------------------------ */
const state = {
  rows: [],            // array of records (from IDB)
  stages: [],          // [{ Stage, lat, lng, accuracy, lastModified, _dirty }]
  view: 'list',        // 'list' | 'calendar' | 'map'
  search: '',
  sort: 'artist',
  status: 'offline',   // offline | syncing | online | error
  lastPull: 0,
  // Location / compass (map view only, started on demand to save battery)
  pos: null,           // { lat, lng, acc, t }
  geoError: null,
  geoWatch: null,
  heading: null,       // degrees from true north, when the compass is enabled
  compass: 'off',      // off | on | denied | unsupported
  autoTarget: false,   // point at the next set we rated highly (opt-in)
};

/* The auto-target choice is a preference, so it survives app restarts. */
try {
  state.autoTarget = localStorage.getItem('garbicz.autoTarget') === '1';
} catch (e) { /* private mode — fall back to off */ }
function setAutoTarget(on) {
  state.autoTarget = !!on;
  try { localStorage.setItem('garbicz.autoTarget', on ? '1' : '0'); } catch (e) {}
  renderMap();
}

/* ---------- 5. Sync status UI ------------------------------------------- */
function setStatus(status, label) {
  state.status = status;
  const pill = $('#syncPill');
  pill.setAttribute('data-state', status);
  $('#syncPillText').textContent = label || ({
    offline: 'Offline', syncing: 'Syncing…', online: 'Synced', error: 'Retry',
  }[status]);
}

/* ---------- 6. Value helpers -------------------------------------------- */
function str(v) { return v == null ? '' : String(v).trim(); }
function ratingNum(v) {
  const n = parseFloat(str(v));
  return isNaN(n) ? null : n;
}
function igUrl(v) {
  v = str(v); if (!v) return null;
  if (/^https?:\/\//i.test(v)) return v;
  return 'https://instagram.com/' + v.replace(/^@/, '').replace(/\s+/g, '');
}
function webUrl(v) {
  v = str(v); if (!v) return null;
  if (/^https?:\/\//i.test(v)) return v;
  return v.indexOf('.') > -1 ? 'https://' + v : null;
}

/* ---------- 6b. Set-time helpers ----------------------------------------
   "Set Time" is stored canonically as "YYYY-MM-DD HH:mm" (or just the date
   if no time). That form sorts chronologically as plain text and is easy to
   group by day for the calendar. The festival runs Jul 30 – Aug 2, 2026.
------------------------------------------------------------------------- */
// The official timetable runs Wed 29 July through Mon 3 August 2026.
const FESTIVAL_DAYS = [
  '2026-07-29', '2026-07-30', '2026-07-31',
  '2026-08-01', '2026-08-02', '2026-08-03',
];
const FESTIVAL_TZ = 'Europe/Warsaw';

/* The festival's stages, named as the official timetable names them, so a
   stage always matches its map coordinates and its acts. Music stages first,
   then the Lichtung and Junkyard areas. */
const STAGES = [
  'Wald', 'Wiese', 'Buk Corner', 'See', 'Loco Paraiso',
  'Pleasure Island', 'Juicy', 'Ambient Floor', 'Weinbar',
  'Performances',
  'Lichtung Teebar', 'Lichtung Amphitheater', 'Lichtung Moontent',
  'Lichtung Dome', 'Lichtung Sober Space', 'Lichtung Playground',
  'Junkyard Kneipe', 'Junkyard Amphitheater', 'Junkyard Schuppen',
];

// Safety net for values that came back as a UTC instant rather than wall-clock
// text (Sheets used to coerce "Set Time" into a real date, which JSON encodes
// as e.g. "2026-07-30T21:30:00.000Z"). Re-express those in festival local time
// so a 23:30 set reads as 23:30. Plain wall-clock text is left untouched.
function isoInstantToWallClock(s) {
  const d = new Date(s);
  if (isNaN(d.getTime())) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: FESTIVAL_TZ,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(d).reduce(function (o, p) { o[p.type] = p.value; return o; }, {});
    const hh = parts.hour === '24' ? '00' : parts.hour; // some engines emit 24
    return parts.year + '-' + parts.month + '-' + parts.day + ' ' + hh + ':' + parts.minute;
  } catch (e) {
    return null;
  }
}

function parseSetTime(v) {
  let s = str(v);
  // Only true instants (trailing Z or ±HH:MM offset) need converting.
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}.*(Z|[+-]\d{2}:?\d{2})$/.test(s)) {
    s = isoInstantToWallClock(s) || s;
  }
  const m = s.match(/^(\d{4}-\d{2}-\d{2})(?:[ T](\d{1,2}:\d{2}))?/);
  if (!m) return { day: '', time: '' };
  return { day: m[1], time: m[2] || '' };
}
function buildSetTime(day, time) {
  if (!day) return '';
  return time ? day + ' ' + time : day;
}
function formatDayLabel(dateStr, long) {
  const p = str(dateStr).split('-');
  if (p.length !== 3) return str(dateStr);
  const dt = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
  if (isNaN(dt.getTime())) return str(dateStr);
  return dt.toLocaleDateString('en-GB', {
    weekday: long ? 'long' : 'short', day: 'numeric', month: long ? 'long' : 'short',
  });
}
/* Auto-targeting only fires for a set at least one of us rates this highly —
   the point is to help when we're undecided, not to nag. */
const TARGET_MIN_RATING = 3;
const TARGET_LOOKAHEAD_MIN = 8 * 60;  // ignore anything further off than this
const TARGET_GRACE_MIN = 90;          // a set that started recently is still on

/** Parses "YYYY-MM-DD HH:mm" as a naive local Date (no timezone applied). */
function wallClockToDate(s) {
  const m = str(s).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
}

/** "Now" as festival wall-clock, so this is right from any timezone. */
function festivalNow() {
  return isoInstantToWallClock(new Date().toISOString());
}

function formatCountdown(mins) {
  if (mins <= 0 && mins > -TARGET_GRACE_MIN) return 'on now';
  if (mins < 60) return 'in ' + mins + ' min';
  const h = Math.floor(mins / 60), m = mins % 60;
  return 'in ' + h + 'h' + (m ? ' ' + m + 'm' : '');
}

/**
 * The next set worth walking to: soonest upcoming act rated >= 3 by either of
 * us. Returns null when there is nothing coming up, which is the signal to
 * show no arrow at all.
 */
function nextTarget() {
  const nowStr = festivalNow();
  const now = nowStr ? wallClockToDate(nowStr) : null;
  if (!now) return null;

  let best = null;
  state.rows.forEach(function (r) {
    const p = parseSetTime(r[F.setTime]);
    if (!p.day || !p.time) return;
    const rating = Math.max(ratingNum(r[F.m]) || 0, ratingNum(r[F.a]) || 0);
    if (rating < TARGET_MIN_RATING) return;
    const when = wallClockToDate(p.day + ' ' + p.time);
    if (!when) return;
    const mins = Math.round((when - now) / 60000);
    if (mins < -TARGET_GRACE_MIN || mins > TARGET_LOOKAHEAD_MIN) return;
    if (!best || mins < best.minutes) best = { row: r, minutes: mins, rating: rating };
  });
  if (!best) return null;

  const name = str(best.row[F.stage]);
  best.stageName = name;
  best.stage = state.stages.find(function (s) { return s.Stage === name; }) || null;
  return best;
}

function formatSetTimeChip(v) {
  const p = parseSetTime(v);
  if (!p.day) return str(v); // empty, or legacy free text — show as-is
  const label = formatDayLabel(p.day, false);
  return p.time ? label + ' · ' + p.time : label;
}

/* ---------- 6c. Geo helpers ----------------------------------------------
   All of this is pure math on two coordinates — it needs no network, which is
   why the map keeps working with no signal at the festival.
------------------------------------------------------------------------- */
const R_EARTH = 6371000; // metres
const toRad = function (d) { return d * Math.PI / 180; };
const toDeg = function (r) { return r * 180 / Math.PI; };

/** Great-circle distance in metres. */
function distanceM(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const la1 = toRad(a.lat), la2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial bearing from a to b, degrees clockwise from true north. */
function bearingDeg(a, b) {
  const la1 = toRad(a.lat), la2 = toRad(b.lat);
  const dLng = toRad(b.lng - a.lng);
  const y = Math.sin(dLng) * Math.cos(la2);
  const x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLng);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

function formatDistance(m) {
  if (m == null) return '';
  if (m < 1000) return Math.round(m / 5) * 5 + ' m';
  return (m / 1000).toFixed(m < 10000 ? 1 : 0) + ' km';
}

function stageCoords(stage) {
  const lat = parseFloat(stage && stage.lat);
  const lng = parseFloat(stage && stage.lng);
  if (isNaN(lat) || isNaN(lng)) return null;
  return { lat: lat, lng: lng };
}

/* ---------- 7. Render list ---------------------------------------------- */
const ICON = {
  clock: '<path d="M12 2a10 10 0 100 20 10 10 0 000-20zm1 10V6h-2v7l5 3 1-1.7-4-2.3z"/>',
  pin: '<path d="M12 2a7 7 0 00-7 7c0 5 7 13 7 13s7-8 7-13a7 7 0 00-7-7zm0 9.5A2.5 2.5 0 1112 6a2.5 2.5 0 010 5.5z"/>',
  leaf: '<path d="M17 8C8 10 5.9 16.2 4 22l2 0c1-3.5 2.6-5.9 5-7.5C14.3 12.4 17 11 17 8z"/>',
  ig: '<path d="M12 2c2.7 0 3 0 4.1.1 1.1 0 1.8.2 2.4.5.7.2 1.2.6 1.7 1.1s.9 1 1.1 1.7c.3.6.5 1.3.5 2.4C22 8.9 22 9.3 22 12s0 3-.1 4.1c0 1.1-.2 1.8-.5 2.4a4.7 4.7 0 01-1.1 1.7 4.7 4.7 0 01-1.7 1.1c-.6.3-1.3.5-2.4.5-1.1.1-1.4.1-4.1.1s-3 0-4.1-.1c-1.1 0-1.8-.2-2.4-.5a4.7 4.7 0 01-1.7-1.1 4.7 4.7 0 01-1.1-1.7c-.3-.6-.5-1.3-.5-2.4C2 15 2 14.7 2 12s0-3 .1-4.1c0-1.1.2-1.8.5-2.4A4.7 4.7 0 013.7 3.8a4.7 4.7 0 011.7-1.1c.6-.3 1.3-.5 2.4-.5C8.9 2 9.3 2 12 2zm0 5a5 5 0 100 10 5 5 0 000-10zm0 8.2A3.2 3.2 0 1112 8.8a3.2 3.2 0 010 6.4zm5.3-8.4a1.2 1.2 0 11-2.4 0 1.2 1.2 0 012.4 0z"/>',
  ra: '<path d="M4 4h16v3H4zm0 5h16v3H4zm0 5h10v3H4z"/>',
  play: '<path d="M8 5v14l11-7z"/>',
};
/**
 * Builds an icon.
 *
 * SVG must be created in the SVG namespace — document.createElement('svg')
 * yields an HTMLUnknownElement that never renders, which is why these icons
 * (and the map arrows) were invisible while the inline SVGs in index.html,
 * parsed as real SVG by the HTML parser, worked fine.
 */
const SVG_NS = 'http://www.w3.org/2000/svg';
function svg(markup, cls) {
  const node = document.createElementNS(SVG_NS, 'svg');
  node.setAttribute('viewBox', '0 0 24 24');
  node.setAttribute('aria-hidden', 'true');
  if (cls) node.setAttribute('class', cls); // .className is read-only on SVG
  const re = /<path[^>]*\bd="([^"]+)"/g;
  let m;
  while ((m = re.exec(markup)) !== null) {
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', m[1]);
    node.appendChild(p);
  }
  return node;
}

function ratingBadge(value, kind) {
  const n = ratingNum(value);
  const raw = str(value);
  return el('div', { class: 'rating rating--' + kind }, [
    el('span', {
      class: 'rating__val' + (raw ? '' : ' rating__val--empty'),
      text: raw ? raw : '–',
    }),
    el('span', { class: 'rating__lbl', text: kind === 'm' ? 'M' : 'A' }),
  ]);
}

function card(row) {
  const links = [];
  const ig = igUrl(row[F.ig]);
  if (ig) links.push(el('a', { class: 'linkbtn linkbtn--ig', href: ig, target: '_blank', rel: 'noopener' }, [svg(ICON.ig), 'Instagram']));
  const ra = webUrl(row[F.ra]);
  if (ra) links.push(el('a', { class: 'linkbtn linkbtn--ra', href: ra, target: '_blank', rel: 'noopener' }, [svg(ICON.ra), 'RA']));

  const chips = [];
  if (str(row[F.setTime])) chips.push(el('span', { class: 'chip chip--time' }, [svg(ICON.clock), formatSetTimeChip(row[F.setTime])]));
  if (str(row[F.stage])) chips.push(el('span', { class: 'chip chip--stage' }, [svg(ICON.pin), str(row[F.stage])]));
  if (str(row[F.style])) chips.push(el('span', { class: 'chip chip--style' }, [str(row[F.style])]));

  const children = [
    el('div', { class: 'card__top' }, [
      el('div', { style: 'flex:1 1 auto; min-width:0' }, [
        el('h2', { class: 'card__name', text: str(row[F.artist]) || 'Untitled' }),
        str(row[F.from]) ? el('span', { class: 'card__from', text: '📍 ' + str(row[F.from]) }) : null,
      ]),
      el('div', { class: 'ratings' }, [ratingBadge(row[F.m], 'm'), ratingBadge(row[F.a], 'a')]),
    ]),
  ];
  if (chips.length) children.push(el('div', { class: 'chips' }, chips));
  if (links.length) children.push(el('div', { class: 'card__links' }, links));
  if (row._dirty) children.push(el('span', { class: 'card__pending', title: 'Not yet synced' }));

  return el('div', {
    class: 'card', role: 'button', tabindex: '0',
    onclick: function () { openDetail(row.id); },
  }, children);
}

function visibleRows() {
  let rows = state.rows.filter(matchesSearch);
  const byArtist = function (a, b) { return str(a[F.artist]).localeCompare(str(b[F.artist])); };
  const bySort = {
    artist: byArtist,
    setTime: function (a, b) { return blankLast(str(a[F.setTime]), str(b[F.setTime])) || byArtist(a, b); },
    stage: function (a, b) { return blankLast(str(a[F.stage]), str(b[F.stage])) || byArtist(a, b); },
    ratingM: function (a, b) { return numDesc(ratingNum(a[F.m]), ratingNum(b[F.m])); },
    ratingA: function (a, b) { return numDesc(ratingNum(a[F.a]), ratingNum(b[F.a])); },
  };
  return rows.sort(bySort[state.sort] || bySort.artist);
}
function numDesc(a, b) {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return b - a;
}
function blankLast(a, b) {
  if (!a && !b) return 0; if (!a) return 1; if (!b) return -1;
  return a.localeCompare(b);
}

function renderList() {
  const list = $('#list');
  list.innerHTML = '';
  const rows = visibleRows();
  if (!rows.length) {
    const configured = IS_CONFIGURED;
    list.appendChild(el('div', { class: 'state' }, [
      el('div', { class: 'state__title', text: state.search ? 'Nothing found' : 'No DJs yet' }),
      el('div', {
        class: 'state__hint',
        text: state.search ? 'Try a different search.'
          : (configured ? 'Tap + to add your first DJ.' : 'Set EXEC_URL in app.js to load your Sheet.'),
      }),
    ]));
    return;
  }
  rows.forEach(function (r) { list.appendChild(card(r)); });
}

/* Dispatch between the list and calendar views, and sync the chrome. */
function render() {
  const view = state.view;
  const tb = $('.toolbar');
  if (tb) {
    tb.classList.toggle('is-calendar', view === 'calendar');
    tb.hidden = (view === 'map');   // search/sort don't apply to the map
  }
  const tabs = { list: $('#tabList'), calendar: $('#tabCalendar'), map: $('#tabMap') };
  for (const k in tabs) if (tabs[k]) tabs[k].classList.toggle('is-active', k === view);

  const fab = $('#addBtn');
  if (fab) fab.hidden = (view === 'map');   // adding DJs is a list action

  // Location and the countdown tick only run while the map is open.
  if (view === 'map') { startGeo(); startTargetTick(); }
  else { stopGeo(); stopTargetTick(); }

  if (view === 'map') renderMap();
  else if (view === 'calendar') renderCalendar();
  else renderList();
}

function matchesSearch(r) {
  const q = state.search.toLowerCase();
  if (!q) return true;
  return [F.artist, F.style, F.from, F.stage].some(function (k) {
    return str(r[k]).toLowerCase().indexOf(q) > -1;
  });
}

function calRow(r) {
  const t = parseSetTime(r[F.setTime]).time || '—';
  return el('div', {
    class: 'cal-row', role: 'button', tabindex: '0',
    onclick: function () { openDetail(r.id); },
  }, [
    el('span', { class: 'cal-row__time', text: t }),
    el('div', { class: 'cal-row__main' }, [
      el('span', { class: 'cal-row__artist', text: str(r[F.artist]) || 'Untitled' }),
      str(r[F.stage]) ? el('span', { class: 'cal-row__stage', text: str(r[F.stage]) }) : null,
    ]),
    el('div', { class: 'cal-row__ratings' }, [
      el('span', { class: 'cal-tag cal-tag--m', text: 'M ' + (str(r[F.m]) || '–') }),
      el('span', { class: 'cal-tag cal-tag--a', text: 'A ' + (str(r[F.a]) || '–') }),
    ]),
  ]);
}

function renderCalendar() {
  const list = $('#list');
  list.innerHTML = '';

  // Bucket every DJ that has a set time by its day.
  const buckets = {};
  state.rows.forEach(function (r) {
    if (!str(r[F.setTime]) || !matchesSearch(r)) return;
    const key = parseSetTime(r[F.setTime]).day || 'other';
    (buckets[key] = buckets[key] || []).push(r);
  });

  // Show all four festival days always; append any stray days, then "other".
  const extra = Object.keys(buckets)
    .filter(function (k) { return k !== 'other' && FESTIVAL_DAYS.indexOf(k) === -1; }).sort();
  const dayKeys = FESTIVAL_DAYS.concat(extra);
  if (buckets.other) dayKeys.push('other');

  let anyScheduled = false;
  dayKeys.forEach(function (key) {
    const rows = (buckets[key] || []).slice().sort(function (a, b) {
      return blankLast(parseSetTime(a[F.setTime]).time, parseSetTime(b[F.setTime]).time)
        || str(a[F.artist]).localeCompare(str(b[F.artist]));
    });
    // Festival days always render (even if empty); stray days only when populated.
    if (!rows.length && FESTIVAL_DAYS.indexOf(key) === -1) return;

    const section = el('div', { class: 'cal-day' }, [
      el('div', { class: 'cal-day__head' }, [
        el('span', { class: 'cal-day__title', text: key === 'other' ? 'Other times' : formatDayLabel(key, true) }),
        rows.length ? el('span', { class: 'cal-day__count', text: String(rows.length) }) : null,
      ]),
    ]);
    if (!rows.length) {
      section.appendChild(el('div', { class: 'cal-empty', text: 'Nothing scheduled yet' }));
    } else {
      anyScheduled = true;
      rows.forEach(function (r) { section.appendChild(calRow(r)); });
    }
    list.appendChild(section);
  });

  if (!anyScheduled && state.search) {
    list.insertBefore(el('div', { class: 'state' }, [
      el('div', { class: 'state__hint', text: 'No scheduled DJs match “' + state.search + '”.' }),
    ]), list.firstChild);
  }
}

/* ---------- 7b. Map view -------------------------------------------------
   Location and compass run only while this view is open (battery), and every
   capture is stored locally first — so pinning stages works with no signal.
------------------------------------------------------------------------- */
function startGeo() {
  if (!navigator.geolocation) { state.geoError = 'This device has no location support.'; return; }
  if (state.geoWatch != null) return;
  state.geoWatch = navigator.geolocation.watchPosition(
    function (p) {
      state.pos = { lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy, t: Date.now() };
      state.geoError = null;
      if (state.view === 'map') renderMap();
    },
    function (err) {
      state.geoError = err.code === 1
        ? 'Location permission denied — enable it in Settings to pin stages.'
        : 'Waiting for GPS… (go outside for a faster fix)';
      if (state.view === 'map') renderMap();
    },
    { enableHighAccuracy: true, maximumAge: 3000, timeout: 25000 }
  );
}
function stopGeo() {
  if (state.geoWatch != null) { navigator.geolocation.clearWatch(state.geoWatch); state.geoWatch = null; }
}

/* Keeps the countdown honest while the map sits open. */
let _targetTick = null;
function startTargetTick() {
  if (_targetTick != null) return;
  _targetTick = setInterval(function () {
    if (state.view === 'map' && state.autoTarget) renderMap();
  }, 30000);
}
function stopTargetTick() {
  if (_targetTick != null) { clearInterval(_targetTick); _targetTick = null; }
}

function onOrientation(e) {
  let h = null;
  if (typeof e.webkitCompassHeading === 'number' && !isNaN(e.webkitCompassHeading)) {
    h = e.webkitCompassHeading;               // iOS: already relative to true north
  } else if (e.absolute && typeof e.alpha === 'number') {
    h = (360 - e.alpha) % 360;                // Android / standards path
  }
  if (h == null) return;
  state.heading = h;
  state.compass = 'on';
  if (state.view === 'map') updateArrows();
}

async function enableCompass() {
  try {
    const DOE = window.DeviceOrientationEvent;
    if (!DOE) { state.compass = 'unsupported'; renderMap(); return; }
    // iOS 13+ requires an explicit grant, triggered by a user gesture.
    if (typeof DOE.requestPermission === 'function') {
      const res = await DOE.requestPermission();
      if (res !== 'granted') { state.compass = 'denied'; renderMap(); return; }
    }
    window.addEventListener('deviceorientation', onOrientation, true);
    window.addEventListener('deviceorientationabsolute', onOrientation, true);
    state.compass = 'on';
    // If no reading arrives shortly, the sensor is not usable here.
    setTimeout(function () {
      if (state.heading == null) { state.compass = 'unsupported'; renderMap(); }
    }, 2500);
    renderMap();
  } catch (err) {
    state.compass = 'denied';
    renderMap();
  }
}

/** Rotates just the arrows, so compass updates don't rebuild the whole list. */
function updateArrows() {
  const arrows = document.querySelectorAll('.stage-row__arrow, .target__arrow');
  for (let i = 0; i < arrows.length; i++) {
    const b = parseFloat(arrows[i].getAttribute('data-bearing'));
    if (isNaN(b)) continue;
    const rot = state.heading == null ? b : (b - state.heading + 360) % 360;
    arrows[i].style.transform = 'rotate(' + rot + 'deg)';
  }
}

async function captureStage(name) {
  if (!state.pos) { toast('No GPS fix yet — wait a moment and try again', 'warn'); return; }
  let rec = state.stages.find(function (s) { return s.Stage === name; });
  if (!rec) { rec = { Stage: name }; state.stages.push(rec); }
  rec.lat = state.pos.lat;
  rec.lng = state.pos.lng;
  rec.accuracy = Math.round(state.pos.acc);
  rec._dirty = true;
  rec._clientModified = Date.now();
  if (rec.lastModified == null) rec.lastModified = 0;

  await idbPut(rec, STAGE_STORE);
  renderMap();
  toast(name + ' pinned (±' + Math.round(state.pos.acc) + ' m)', 'good');
  if (navigator.onLine && IS_CONFIGURED) syncNow();
}

function stageRow(stage) {
  const coords = stageCoords(stage);
  const here = state.pos;
  const dist = (coords && here) ? distanceM(here, coords) : null;
  const bear = (coords && here) ? bearingDeg(here, coords) : null;

  // An arrow only means something once the stage is pinned and we have a fix;
  // until then show a dimmed pin so the row doesn't look broken.
  const arrow = el('div', {
    class: 'stage-row__arrow' + (bear == null ? ' is-idle' : ''),
    'data-bearing': bear == null ? '' : String(bear),
  }, [svg(bear == null ? ICON.pin : '<path d="M12 2l7 19-7-5-7 5z"/>')]);
  if (bear != null) {
    const rot = state.heading == null ? bear : (bear - state.heading + 360) % 360;
    arrow.style.transform = 'rotate(' + rot + 'deg)';
  }

  const meta = coords
    ? (dist == null ? 'Pinned · waiting for your position' : formatDistance(dist) + ' away')
    : 'No location yet';

  return el('div', { class: 'stage-row' }, [
    arrow,
    el('div', { class: 'stage-row__main' }, [
      el('span', { class: 'stage-row__name', text: stage.Stage }),
      el('span', { class: 'stage-row__meta' + (coords ? '' : ' is-empty'), text: meta }),
    ]),
    el('button', {
      class: 'stage-row__btn' + (coords ? ' is-set' : ''),
      type: 'button',
      text: coords ? 'Update' : 'Set here',
      onclick: function () { captureStage(stage.Stage); },
    }),
    stage._dirty ? el('span', { class: 'card__pending', title: 'Not yet synced' }) : null,
  ]);
}

/** Big pointer card for the next set worth walking to. */
function targetCard(t) {
  const coords = t.stage ? stageCoords(t.stage) : null;
  const here = state.pos;
  const dist = (coords && here) ? distanceM(here, coords) : null;
  const bear = (coords && here) ? bearingDeg(here, coords) : null;

  const arrow = el('div', {
    class: 'target__arrow' + (bear == null ? ' is-idle' : ''),
    'data-bearing': bear == null ? '' : String(bear),
  }, [svg(bear == null ? ICON.pin : '<path d="M12 2l7 19-7-5-7 5z"/>')]);
  if (bear != null) {
    const rot = state.heading == null ? bear : (bear - state.heading + 360) % 360;
    arrow.style.transform = 'rotate(' + rot + 'deg)';
  }

  let sub;
  if (!t.stageName) sub = 'No stage listed for this set';
  else if (!coords) sub = t.stageName + ' · not pinned yet — tap “Set here” when you find it';
  else if (dist == null) sub = t.stageName + ' · waiting for your position';
  else sub = t.stageName + ' · ' + formatDistance(dist) + ' away';

  return el('div', { class: 'target', role: 'button', tabindex: '0',
    onclick: function () { openDetail(t.row.id); } }, [
    arrow,
    el('div', { class: 'target__main' }, [
      el('div', { class: 'target__label', text: 'Next up · ' + formatCountdown(t.minutes) }),
      el('div', { class: 'target__artist', text: str(t.row[F.artist]) || 'Untitled' }),
      el('div', { class: 'target__sub', text: sub }),
    ]),
    el('div', { class: 'target__rating' }, [
      el('span', { class: 'cal-tag cal-tag--m', text: 'M ' + (str(t.row[F.m]) || '–') }),
      el('span', { class: 'cal-tag cal-tag--a', text: 'A ' + (str(t.row[F.a]) || '–') }),
    ]),
  ]);
}

function renderMap() {
  const list = $('#list');
  list.innerHTML = '';

  // Auto-target: opt-in, and only ever fires for a set rated >= 3 by one of us.
  const target = state.autoTarget ? nextTarget() : null;
  list.appendChild(el('div', { class: 'auto-toggle' + (state.autoTarget ? ' is-on' : '') }, [
    el('div', { class: 'auto-toggle__text' }, [
      el('span', { class: 'auto-toggle__title', text: 'Point me to the next set' }),
      el('span', { class: 'auto-toggle__hint', text: 'Only for sets rated ' + TARGET_MIN_RATING + '+ by either of us' }),
    ]),
    el('button', {
      class: 'switch' + (state.autoTarget ? ' is-on' : ''),
      type: 'button',
      role: 'switch',
      'aria-checked': state.autoTarget ? 'true' : 'false',
      'aria-label': 'Auto-target the next set',
      onclick: function () { setAutoTarget(!state.autoTarget); },
    }, [el('span', { class: 'switch__knob' })]),
  ]));

  if (state.autoTarget) {
    list.appendChild(target
      ? targetCard(target)
      : el('div', { class: 'target target--none' }, [
          el('div', { class: 'target__sub', text: 'Nothing rated ' + TARGET_MIN_RATING + '+ coming up — wander freely.' }),
        ]));
  }

  // GPS status
  const pos = state.pos;
  const fixText = pos
    ? 'Location found · accurate to about ' + Math.round(pos.acc) + ' m'
    : (state.geoError || 'Getting your location…');
  list.appendChild(el('div', { class: 'geo-card' }, [
    el('div', { class: 'geo-card__row' }, [
      el('span', { class: 'geo-dot' + (pos ? ' is-live' : '') }),
      el('span', { class: 'geo-card__text', text: fixText }),
    ]),
    pos ? el('div', { class: 'geo-card__coords', text: pos.lat.toFixed(5) + ', ' + pos.lng.toFixed(5) }) : null,
    // Compass state / enable button
    state.compass === 'on'
      ? el('div', { class: 'geo-card__hint', text: state.heading == null
          ? 'Compass on · waiting for a heading…'
          : 'Compass on · facing ' + Math.round(state.heading) + '°' })
      : el('button', {
          class: 'geo-card__enable', type: 'button',
          text: state.compass === 'denied' ? 'Compass blocked — tap to retry'
            : state.compass === 'unsupported' ? 'Compass unavailable — tap to retry'
            : 'Enable compass arrows',
          onclick: enableCompass,
        }),
    el('div', {
      class: 'geo-card__hint',
      text: state.stages.some(function (s) { return stageCoords(s); })
        ? 'Arrows point to pinned stages. Works offline — pins sync when you get signal.'
        : 'No stages pinned yet. Walk to a stage and tap “Set here” — arrows appear once a stage has a location.',
    }),
  ]));

  // One row per stage: known stages first, then any extras from the sheet.
  const byName = {};
  state.stages.forEach(function (s) { byName[s.Stage] = s; });
  const ordered = STAGES.map(function (n) { return byName[n] || { Stage: n }; });
  state.stages.forEach(function (s) {
    if (STAGES.indexOf(s.Stage) === -1) ordered.push(s);
  });

  // Nearest first once we have a fix, so the closest stage is at the top.
  if (state.pos) {
    ordered.sort(function (a, b) {
      const ca = stageCoords(a), cb = stageCoords(b);
      if (ca && cb) return distanceM(state.pos, ca) - distanceM(state.pos, cb);
      if (ca) return -1;
      if (cb) return 1;
      return a.Stage.localeCompare(b.Stage);
    });
  }
  ordered.forEach(function (s) { list.appendChild(stageRow(s)); });
}

/* ---------- 8. Editor --------------------------------------------------- */
let editing = null; // current record being edited

// Field keys can contain spaces (e.g. "Set Time"), which are invalid in DOM
// ids / CSS selectors — so we keep a direct reference to each input on the
// wrapper (wrap._input / wrap._key) instead of looking it up by id later.
function safeId(key) { return 'f_' + key.replace(/[^A-Za-z0-9]+/g, '_'); }

function field(label, key, value, opts) {
  opts = opts || {};
  const id = safeId(key);
  const input = el(opts.textarea ? 'textarea' : 'input', {
    class: opts.textarea ? 'field__textarea' : 'field__input',
    id: id,
    type: opts.type || 'text',
    inputmode: opts.inputmode || null,
    placeholder: opts.placeholder || '',
  });
  input.value = str(value);
  const wrap = el('div', { class: 'field' }, [
    el('label', { class: 'field__label', for: id, text: label }),
    input,
  ]);
  wrap._input = input;
  wrap._key = key;
  return wrap;
}

function rater(label, key, value) {
  const current = { val: str(value) };
  const btns = [];
  function refresh() {
    btns.forEach(function (b, i) {
      b.classList.toggle('is-active', String(i + 1) === current.val);
    });
  }
  for (let i = 1; i <= 5; i++) {
    const b = el('button', {
      class: 'rater__num', type: 'button', text: String(i),
      onclick: function () { current.val = String(i); refresh(); },
    });
    btns.push(b);
  }
  const wrap = el('div', { class: 'field' }, [
    el('label', { class: 'field__label', text: label }),
    el('div', { class: 'rater' }, [
      el('div', { class: 'rater__btns' }, btns),
      el('button', { class: 'rater__clear', type: 'button', text: 'clear',
        onclick: function () { current.val = ''; refresh(); } }),
    ]),
  ]);
  refresh();
  wrap._read = function () { return current.val; };
  wrap._key = key;
  return wrap;
}

// Structured set-time editor: festival-day dropdown + a 24h time (HH:mm).
function setTimeControl(value) {
  const p = parseSetTime(value);
  const daySel = el('select', { class: 'field__input st__day' }, [
    el('option', { value: '', text: '— no set time —' }),
  ]);
  FESTIVAL_DAYS.forEach(function (d) {
    daySel.appendChild(el('option', { value: d, text: formatDayLabel(d, true) }));
  });
  // Preserve any stray/legacy day that isn't one of the four festival days.
  if (p.day && FESTIVAL_DAYS.indexOf(p.day) === -1) {
    daySel.appendChild(el('option', { value: p.day, text: formatDayLabel(p.day, true) }));
  }
  daySel.value = p.day || '';

  const timeInput = el('input', { class: 'field__input st__time', type: 'time' });
  timeInput.value = p.time || '';

  const wrap = el('div', { class: 'field' }, [
    el('label', { class: 'field__label', text: 'Set time' }),
    el('div', { class: 'st' }, [daySel, timeInput]),
  ]);
  wrap._read = function () { return buildSetTime(daySel.value, timeInput.value); };
  return wrap;
}

// Open a DJ: existing rows show the read-only profile first; new rows go
// straight to the edit form.
// Stage picker. Any value already in the sheet that is not one of STAGES is
// kept as an extra option so existing data is never silently dropped.
function stageControl(value) {
  const current = str(value);
  const sel = el('select', { class: 'field__input stage-select' }, [
    el('option', { value: '', text: '— no stage —' }),
  ]);
  STAGES.forEach(function (s) { sel.appendChild(el('option', { value: s, text: s })); });
  if (current && STAGES.indexOf(current) === -1) {
    sel.appendChild(el('option', { value: current, text: current + ' (not a listed stage)' }));
  }
  sel.value = current;

  const wrap = el('div', { class: 'field' }, [
    el('label', { class: 'field__label', text: 'Stage' }),
    sel,
  ]);
  wrap._read = function () { return sel.value; };
  return wrap;
}

function openDetail(id) {
  const isNew = !id;
  editing = isNew
    ? { id: (crypto.randomUUID ? crypto.randomUUID() : 'tmp-' + Date.now() + Math.random()), _new: true }
    : state.rows.find(function (r) { return r.id === id; });
  if (!editing) return;

  const editor = $('#editor');
  editor.hidden = false;
  document.body.style.overflow = 'hidden';
  if (isNew) showEdit(true); else showView();
}

function swapSheet(bar, body) {
  const editor = $('#editor');
  editor.innerHTML = '';
  editor.appendChild(bar);
  editor.appendChild(body);
  editor.scrollTop = 0;
}

// ---- Read-only profile (default view) ----
function showView() {
  const rec = editing;

  const links = [];
  const ig = igUrl(rec[F.ig]);
  if (ig) links.push(el('a', { class: 'linkbtn linkbtn--ig', href: ig, target: '_blank', rel: 'noopener' }, [svg(ICON.ig), 'Instagram']));
  const ra = webUrl(rec[F.ra]);
  if (ra) links.push(el('a', { class: 'linkbtn linkbtn--ra', href: ra, target: '_blank', rel: 'noopener' }, [svg(ICON.ra), 'Resident Advisor']));
  const best = webUrl(rec[F.bestSet]);
  if (best) links.push(el('a', { class: 'linkbtn linkbtn--set', href: best, target: '_blank', rel: 'noopener' }, [svg(ICON.play), 'Best set']));

  const chips = [];
  if (str(rec[F.setTime])) chips.push(el('span', { class: 'chip chip--time' }, [svg(ICON.clock), formatSetTimeChip(rec[F.setTime])]));
  if (str(rec[F.stage])) chips.push(el('span', { class: 'chip chip--stage' }, [svg(ICON.pin), str(rec[F.stage])]));
  if (str(rec[F.style])) chips.push(el('span', { class: 'chip chip--style' }, [str(rec[F.style])]));

  const empty = !chips.length && !links.length && !str(rec[F.bio]);
  const body = el('div', { class: 'editor__body' }, [
    el('div', { class: 'profile__top' }, [
      el('div', { class: 'ratings' }, [ratingBadge(rec[F.m], 'm'), ratingBadge(rec[F.a], 'a')]),
      str(rec[F.from]) ? el('div', { class: 'profile__from', text: '📍 ' + str(rec[F.from]) }) : null,
    ]),
    chips.length ? el('div', { class: 'chips' }, chips) : null,
    links.length ? el('div', { class: 'card__links profile__links' }, links) : null,
    str(rec[F.bio]) ? el('div', { class: 'profile__notes' }, [
      el('div', { class: 'field__label', text: 'Notes' }),
      el('p', { class: 'profile__bio', text: str(rec[F.bio]) }),
    ]) : null,
    empty ? el('div', { class: 'cal-empty', text: 'No details yet — tap Edit to add some.' }) : null,
  ]);

  const bar = el('div', { class: 'editor__bar' }, [
    el('button', { class: 'editor__close', type: 'button', text: 'Close', onclick: closeEditor }),
    el('div', { class: 'editor__title editor__title--name', text: str(rec[F.artist]) || 'Untitled' }),
    el('button', { class: 'editor__save', type: 'button', text: 'Edit', onclick: function () { showEdit(false); } }),
  ]);

  swapSheet(bar, body);
}

// ---- Edit form ----
function showEdit(isNew) {
  const rec = editing;
  const persisted = state.rows.some(function (r) { return r.id === rec.id; });

  // Non-text controls expose a _read() instead of an .value.
  const mRater = rater('My rating (M)', F.m, rec[F.m]);
  const aRater = rater('Her rating (A)', F.a, rec[F.a]);
  const setTimeCtl = setTimeControl(rec[F.setTime]);
  const stageCtl = stageControl(rec[F.stage]);
  const readers = {};
  readers[F.setTime] = setTimeCtl._read;
  readers[F.stage] = stageCtl._read;
  readers[F.m] = mRater._read;
  readers[F.a] = aRater._read;

  // Text/URL/textarea fields; keep their wrappers so we can read inputs directly.
  const fArtist = field('Artist', F.artist, rec[F.artist], { placeholder: 'Artist / act name' });
  const fStyle = field('Style', F.style, rec[F.style], { placeholder: 'Genre / vibe' });
  const fFrom = field('From', F.from, rec[F.from], { placeholder: 'City / country' });
  const fIg = field('Instagram', F.ig, rec[F.ig], { placeholder: '@handle or URL' });
  const fRa = field('Resident Advisor', F.ra, rec[F.ra], { placeholder: 'RA profile URL' });
  const fBest = field('Best DJ set', F.bestSet, rec[F.bestSet], { placeholder: 'Link to a set' });
  const fBio = field('Notes / biography', F.bio, rec[F.bio], { textarea: true, placeholder: 'Notes, why we like them…' });

  const inputs = {};
  [fArtist, fStyle, fFrom, fIg, fRa, fBest, fBio].forEach(function (w) { inputs[w._key] = w._input; });

  const body = el('div', { class: 'editor__body' }, [
    fArtist,
    el('div', { class: 'field__row' }, [mRater, aRater]),
    setTimeCtl,
    stageCtl,
    fStyle, fFrom,
    fIg, fRa, fBest,
    fBio,
  ]);

  const bar = el('div', { class: 'editor__bar' }, [
    el('button', { class: 'editor__close', type: 'button', text: 'Cancel',
      onclick: function () { if (persisted) showView(); else closeEditor(); } }),
    el('div', { class: 'editor__title', text: isNew ? 'New DJ' : 'Edit' }),
    el('button', { class: 'editor__save', type: 'button', text: 'Save',
      onclick: function () { saveEditor(inputs, readers); } }),
  ]);

  swapSheet(bar, body);
}

function closeEditor() {
  $('#editor').hidden = true;
  document.body.style.overflow = '';
  editing = null;
}

async function saveEditor(inputs, readers) {
  const rec = editing;
  const artist = (inputs[F.artist].value || '').trim();
  if (!artist) { toast('Add an artist name first', 'warn'); return; }

  // Pull all text fields from the form into the record (direct refs, so keys
  // with spaces like "Best DJ Set" work correctly), then the pickers/steppers.
  for (const key in inputs) rec[key] = inputs[key].value;
  for (const key in readers) rec[key] = readers[key]();

  rec._dirty = true;
  rec._clientModified = Date.now();
  if (rec.lastModified == null) rec.lastModified = 0;

  // Upsert into local state + IDB immediately (optimistic).
  const idx = state.rows.findIndex(function (r) { return r.id === rec.id; });
  if (idx > -1) state.rows[idx] = rec; else state.rows.push(rec);
  await idbPut(rec);
  render();
  // Return to the read-only profile so the saved result (and links) are shown.
  if (editing === rec) showView();

  if (navigator.onLine && IS_CONFIGURED) {
    syncNow();
  } else {
    toast('Saved offline — will sync when back online', 'good');
    setStatus('offline');
  }
}

/* ---------- 9. Sync (pull + push) --------------------------------------- */
let _syncing = false;

async function syncNow(opts) {
  opts = opts || {};
  if (!IS_CONFIGURED) { setStatus('error', 'Set URL'); return; }
  if (!navigator.onLine) { setStatus('offline'); return; }
  if (_syncing) return;
  _syncing = true;
  setStatus('syncing');
  try {
    await pushDirty();
    if (opts.pull !== false) await pull();
    setStatus('online', 'Synced');
    state.lastPull = Date.now();
  } catch (err) {
    console.warn('sync failed', err);
    setStatus(navigator.onLine ? 'error' : 'offline');
    if (opts.userInitiated) toast('Sync failed — will retry', 'error');
  } finally {
    _syncing = false;
  }
}

async function pull() {
  const res = await fetch(EXEC_URL, { method: 'GET', cache: 'no-store', redirect: 'follow' });
  const data = await res.json();
  if (!data || !data.ok) throw new Error('GET not ok');

  const serverById = {};
  data.rows.forEach(function (r) { serverById[String(r.id)] = r; });

  // Merge server rows in, preserving un-pushed local edits.
  const localById = {};
  state.rows.forEach(function (r) { localById[r.id] = r; });

  const merged = [];
  // server rows -> authoritative unless we hold a dirty local copy
  for (const id in serverById) {
    const local = localById[id];
    if (local && local._dirty) { merged.push(local); }
    else {
      const sr = serverById[id];
      sr._dirty = false; sr._new = false; sr._clientModified = null;
      merged.push(sr);
      await idbPut(sr);
    }
  }
  // local-only rows: keep if still pending (new/dirty), else it was deleted upstream
  for (const id in localById) {
    if (serverById[id]) continue;
    const local = localById[id];
    if (local._dirty || local._new) merged.push(local);
    else await idbDelete(id);
  }

  state.rows = merged;

  // Stages: same rule — a local capture that hasn't been pushed yet wins.
  if (data.stages) {
    const localStage = {};
    state.stages.forEach(function (s) { localStage[s.Stage] = s; });
    const mergedStages = [];
    for (const s of data.stages) {
      const local = localStage[s.Stage];
      if (local && local._dirty) { mergedStages.push(local); continue; }
      s._dirty = false; s._clientModified = null;
      mergedStages.push(s);
      await idbPut(s, STAGE_STORE);
    }
    // Keep any stage the server did not return. Unlike DJ rows, stages are
    // seeded and never deleted upstream, so a missing one means "not synced
    // yet", never "deleted" — dropping it would lose a capture.
    state.stages.forEach(function (s) {
      if (!data.stages.some(function (d) { return d.Stage === s.Stage; })) mergedStages.push(s);
    });
    state.stages = mergedStages;
  }

  render();
}

async function pushDirty() {
  const dirty = state.rows.filter(function (r) { return r._dirty; });
  const dirtyStages = state.stages.filter(function (s) { return s._dirty; });
  if (!dirty.length && !dirtyStages.length) return;

  const payload = {
    rows: dirty.map(function (r) {
      const out = { id: r.id, clientModified: r._clientModified || Date.now() };
      USER_FIELDS.forEach(function (k) { out[k] = r[k] != null ? r[k] : ''; });
      return out;
    }),
    stages: dirtyStages.map(function (s) {
      return {
        Stage: s.Stage, lat: s.lat, lng: s.lng, accuracy: s.accuracy,
        clientModified: s._clientModified || Date.now(),
      };
    }),
  };

  // Content-Type text/plain keeps this a CORS "simple request" (no preflight),
  // which Apps Script web apps handle. The backend JSON.parse()s the body anyway.
  const res = await fetch(EXEC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(payload),
    redirect: 'follow',
  });
  const data = await res.json();
  if (!data || !data.ok) throw new Error('POST not ok');

  // Stage capture results (same last-write-wins handling as the rows).
  for (const sr of (data.stageResults || [])) {
    const local = state.stages.find(function (s) { return s.Stage === sr.Stage; });
    if (!local) continue;
    if (sr.status === 'conflict' && sr.server) {
      const srv = sr.server;
      srv._dirty = false; srv._clientModified = null;
      state.stages[state.stages.indexOf(local)] = srv;
      await idbPut(srv, STAGE_STORE);
      toast(sr.Stage + ' was pinned by someone else — kept their location', 'warn');
    } else {
      local._dirty = false;
      local._clientModified = null;
      if (sr.lastModified != null) local.lastModified = sr.lastModified;
      await idbPut(local, STAGE_STORE);
    }
  }

  const byId = {};
  state.rows.forEach(function (r) { byId[r.id] = r; });

  for (const result of data.results) {
    const row = byId[result.id];
    if (!row) continue;
    if (result.status === 'conflict' && result.server) {
      const srv = result.server;
      srv._dirty = false; srv._new = false; srv._clientModified = null;
      const idx = state.rows.findIndex(function (r) { return r.id === result.id; });
      if (idx > -1) state.rows[idx] = srv;
      await idbPut(srv);
      toast('“' + (str(srv[F.artist]) || 'A DJ') + '” was changed by someone else — kept their version', 'warn');
    } else {
      // updated or inserted
      row._dirty = false; row._new = false;
      row._clientModified = null;
      if (result.lastModified != null) row.lastModified = result.lastModified;
      await idbPut(row);
    }
  }
  render();
}

/* ---------- 10. Toasts -------------------------------------------------- */
function toast(msg, kind) {
  const t = el('div', { class: 'toast' + (kind ? ' toast--' + kind : ''), text: msg });
  $('#toasts').appendChild(t);
  setTimeout(function () {
    t.style.transition = 'opacity .3s'; t.style.opacity = '0';
    setTimeout(function () { t.remove(); }, 300);
  }, kind === 'warn' || kind === 'error' ? 4200 : 2600);
}

/* ---------- 11. Boot ---------------------------------------------------- */
async function boot() {
  // Wire controls
  $('#search').addEventListener('input', function (e) { state.search = e.target.value; render(); });
  $('#sort').addEventListener('change', function (e) { state.sort = e.target.value; render(); });
  $('#tabList').addEventListener('click', function () { state.view = 'list'; render(); });
  $('#tabCalendar').addEventListener('click', function () { state.view = 'calendar'; render(); });
  $('#tabMap').addEventListener('click', function () { state.view = 'map'; render(); });
  $('#addBtn').addEventListener('click', function () { openDetail(null); });
  $('#syncPill').addEventListener('click', function () { syncNow({ userInitiated: true }); });

  window.addEventListener('online', function () { setStatus('syncing'); syncNow(); });
  window.addEventListener('offline', function () { setStatus('offline'); });
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && navigator.onLine && Date.now() - state.lastPull > 4000) syncNow();
  });

  // 1) Instant render from cache
  try { state.rows = await idbGetAll(); } catch (e) { state.rows = []; }
  try { state.stages = await idbGetAll(STAGE_STORE); } catch (e) { state.stages = []; }
  render();
  setStatus(navigator.onLine ? 'online' : 'offline', navigator.onLine ? '' : 'Offline');

  if (!IS_CONFIGURED) {
    setStatus('error', 'Set URL');
    toast('Set your Apps Script URL (EXEC_URL) in app.js', 'warn');
  }

  // 2) Refresh from the Sheet in the background
  if (navigator.onLine && IS_CONFIGURED) syncNow();
}

/* Register the service worker (offline app shell). */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('service-worker.js').catch(function (e) {
      console.warn('SW registration failed', e);
    });
  });
}

boot();
