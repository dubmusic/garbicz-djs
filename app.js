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
let _dbPromise = null;

function db() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise(function (resolve, reject) {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = function () {
      const d = req.result;
      if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = function () { resolve(req.result); };
    req.onerror = function () { reject(req.error); };
  });
  return _dbPromise;
}
function tx(mode) { return db().then(function (d) { return d.transaction(STORE, mode).objectStore(STORE); }); }
function idbGetAll() {
  return tx('readonly').then(function (s) {
    return new Promise(function (res, rej) {
      const r = s.getAll();
      r.onsuccess = function () { res(r.result || []); };
      r.onerror = function () { rej(r.error); };
    });
  });
}
function idbPut(rec) {
  return tx('readwrite').then(function (s) {
    return new Promise(function (res, rej) {
      const r = s.put(rec);
      r.onsuccess = function () { res(); };
      r.onerror = function () { rej(r.error); };
    });
  });
}
function idbDelete(id) {
  return tx('readwrite').then(function (s) {
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
  view: 'list',        // 'list' | 'calendar'
  search: '',
  sort: 'artist',
  status: 'offline',   // offline | syncing | online | error
  lastPull: 0,
};

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
const FESTIVAL_DAYS = ['2026-07-30', '2026-07-31', '2026-08-01', '2026-08-02'];

function parseSetTime(v) {
  const s = str(v);
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
function formatSetTimeChip(v) {
  const p = parseSetTime(v);
  if (!p.day) return str(v); // empty, or legacy free text — show as-is
  const label = formatDayLabel(p.day, false);
  return p.time ? label + ' · ' + p.time : label;
}

/* ---------- 7. Render list ---------------------------------------------- */
const ICON = {
  clock: '<path d="M12 2a10 10 0 100 20 10 10 0 000-20zm1 10V6h-2v7l5 3 1-1.7-4-2.3z"/>',
  pin: '<path d="M12 2a7 7 0 00-7 7c0 5 7 13 7 13s7-8 7-13a7 7 0 00-7-7zm0 9.5A2.5 2.5 0 1112 6a2.5 2.5 0 010 5.5z"/>',
  leaf: '<path d="M17 8C8 10 5.9 16.2 4 22l2 0c1-3.5 2.6-5.9 5-7.5C14.3 12.4 17 11 17 8z"/>',
  ig: '<path d="M12 2c2.7 0 3 0 4.1.1 1.1 0 1.8.2 2.4.5.7.2 1.2.6 1.7 1.1s.9 1 1.1 1.7c.3.6.5 1.3.5 2.4C22 8.9 22 9.3 22 12s0 3-.1 4.1c0 1.1-.2 1.8-.5 2.4a4.7 4.7 0 01-1.1 1.7 4.7 4.7 0 01-1.7 1.1c-.6.3-1.3.5-2.4.5-1.1.1-1.4.1-4.1.1s-3 0-4.1-.1c-1.1 0-1.8-.2-2.4-.5a4.7 4.7 0 01-1.7-1.1 4.7 4.7 0 01-1.1-1.7c-.3-.6-.5-1.3-.5-2.4C2 15 2 14.7 2 12s0-3 .1-4.1c0-1.1.2-1.8.5-2.4A4.7 4.7 0 013.7 3.8a4.7 4.7 0 011.7-1.1c.6-.3 1.3-.5 2.4-.5C8.9 2 9.3 2 12 2zm0 5a5 5 0 100 10 5 5 0 000-10zm0 8.2A3.2 3.2 0 1112 8.8a3.2 3.2 0 010 6.4zm5.3-8.4a1.2 1.2 0 11-2.4 0 1.2 1.2 0 012.4 0z"/>',
  ra: '<path d="M4 4h16v3H4zm0 5h16v3H4zm0 5h10v3H4z"/>',
};
function svg(path, cls) {
  return el('svg', { class: cls || '', viewBox: '0 0 24 24', 'aria-hidden': 'true', html: path });
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
    onclick: function () { openEditor(row.id); },
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
  const isCal = state.view === 'calendar';
  const tb = $('.toolbar'); if (tb) tb.classList.toggle('is-calendar', isCal);
  const tl = $('#tabList'), tc = $('#tabCalendar');
  if (tl) tl.classList.toggle('is-active', !isCal);
  if (tc) tc.classList.toggle('is-active', isCal);
  if (isCal) renderCalendar(); else renderList();
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
    onclick: function () { openEditor(r.id); },
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

function openEditor(id) {
  const isNew = !id;
  editing = isNew
    ? { id: (crypto.randomUUID ? crypto.randomUUID() : 'tmp-' + Date.now() + Math.random()), _new: true }
    : state.rows.find(function (r) { return r.id === id; });
  if (!editing) return;

  const mRater = rater('My rating (M)', F.m, editing[F.m]);
  const aRater = rater('Her rating (A)', F.a, editing[F.a]);

  const setTimeCtl = setTimeControl(editing[F.setTime]);

  // Text/URL/textarea fields; keep their wrappers so we can read inputs directly.
  const fields = [
    field('Artist', F.artist, editing[F.artist], { placeholder: 'Artist / act name' }),
    field('Stage', F.stage, editing[F.stage], { placeholder: 'e.g. Wooo, La Playa…' }),
    field('Style', F.style, editing[F.style], { placeholder: 'Genre / vibe' }),
    field('From', F.from, editing[F.from], { placeholder: 'City / country' }),
    field('Instagram', F.ig, editing[F.ig], { placeholder: '@handle or URL' }),
    field('Resident Advisor', F.ra, editing[F.ra], { placeholder: 'RA profile URL' }),
    field('Best DJ set', F.bestSet, editing[F.bestSet], { placeholder: 'Link to a set' }),
    field('Notes / biography', F.bio, editing[F.bio], { textarea: true, placeholder: 'Notes, why we like them…' }),
  ];
  const inputs = {};
  fields.forEach(function (w) { inputs[w._key] = w._input; });

  const body = el('div', { class: 'editor__body' }, [
    fields[0],                                  // Artist
    el('div', { class: 'field__row' }, [mRater, aRater]),
    setTimeCtl,                                 // Set time (day + 24h time)
    fields[1], fields[2], fields[3],            // stage, style, from
    fields[4], fields[5], fields[6],            // ig, ra, best set
    fields[7],                                  // notes
  ]);

  const bar = el('div', { class: 'editor__bar' }, [
    el('button', { class: 'editor__close', type: 'button', text: 'Cancel', onclick: closeEditor }),
    el('div', { class: 'editor__title', text: isNew ? 'New DJ' : 'Edit' }),
    el('button', { class: 'editor__save', type: 'button', text: 'Save',
      onclick: function () { saveEditor(inputs, setTimeCtl, mRater, aRater); } }),
  ]);

  const editor = $('#editor');
  editor.innerHTML = '';
  editor.appendChild(bar);
  editor.appendChild(body);
  editor.hidden = false;
  document.body.style.overflow = 'hidden';
}

function closeEditor() {
  $('#editor').hidden = true;
  document.body.style.overflow = '';
  editing = null;
}

async function saveEditor(inputs, setTimeCtl, mRater, aRater) {
  const rec = editing;
  const artist = (inputs[F.artist].value || '').trim();
  if (!artist) { toast('Add an artist name first', 'warn'); return; }

  // Pull all text fields from the form into the record (direct refs, so keys
  // with spaces like "Best DJ Set" work correctly).
  for (const key in inputs) rec[key] = inputs[key].value;
  rec[F.setTime] = setTimeCtl._read();
  rec[F.m] = mRater._read();
  rec[F.a] = aRater._read();

  rec._dirty = true;
  rec._clientModified = Date.now();
  if (rec.lastModified == null) rec.lastModified = 0;

  // Upsert into local state + IDB immediately (optimistic).
  const idx = state.rows.findIndex(function (r) { return r.id === rec.id; });
  if (idx > -1) state.rows[idx] = rec; else state.rows.push(rec);
  await idbPut(rec);
  render();
  closeEditor();

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
  render();
}

async function pushDirty() {
  const dirty = state.rows.filter(function (r) { return r._dirty; });
  if (!dirty.length) return;

  const payload = { rows: dirty.map(function (r) {
    const out = { id: r.id, clientModified: r._clientModified || Date.now() };
    USER_FIELDS.forEach(function (k) { out[k] = r[k] != null ? r[k] : ''; });
    return out;
  }) };

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
  $('#addBtn').addEventListener('click', function () { openEditor(null); });
  $('#syncPill').addEventListener('click', function () { syncNow({ userInitiated: true }); });

  window.addEventListener('online', function () { setStatus('syncing'); syncNow(); });
  window.addEventListener('offline', function () { setStatus('offline'); });
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && navigator.onLine && Date.now() - state.lastPull > 4000) syncNow();
  });

  // 1) Instant render from cache
  try { state.rows = await idbGetAll(); } catch (e) { state.rows = []; }
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
