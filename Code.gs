/**
 * Garbicz DJ List — Backend (Google Apps Script)
 *
 * Bound to the Google Sheet. Serves JSON and accepts write requests.
 *
 * Your columns (row 1 = header):
 *   Artist | M | A | From | Style | Biography | Best DJ Set | Resident Advisor | Instagram | Set Time | Stage
 *
 * The app also needs two helper columns for syncing. If they are missing,
 * the script appends them automatically and back-fills them:
 *   id           -> stable identifier for each row (survives sorting/reordering)
 *   lastModified -> server timestamp of the last change (drives conflict handling)
 *
 * Publish: Deploy > New deployment > Web app
 *   Execute as: Me
 *   Who has access: Anyone with the link
 */

const SHEET_NAME = 'DJs'; // adjust to your tab name if different

// Your visible columns, in order.
const USER_HEADERS = [
  'Artist', 'M', 'A', 'From', 'Style',
  'Biography', 'Best DJ Set', 'Resident Advisor', 'Instagram',
  'Set Time', 'Stage'
];

// Helper columns the sync logic relies on.
const META_HEADERS = ['id', 'lastModified'];

// Column that must stay literal text. "Set Time" holds a wall-clock string
// ("2026-07-30 23:30"); if Sheets is allowed to coerce it into a datetime, the
// JSON round-trip shifts it by the sheet's UTC offset.
const TEXT_COLUMN = 'Set Time';

// Full expected header, used only when the sheet is completely empty.
const HEADERS = USER_HEADERS.concat(META_HEADERS);

function getSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  return ss.getSheetByName(SHEET_NAME) || ss.getSheets()[0];
}

/**
 * Ensures the header row exists and that the meta columns (id, lastModified)
 * are present, appending them at the end if needed.
 * Returns the current header as an array of strings (real sheet order).
 */
function ensureSchema_(sheet) {
  const lastCol = Math.max(sheet.getLastColumn(), 1);
  let header = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(String);

  // Sheet is completely empty -> write the full header.
  if (header.join('') === '') {
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
    return HEADERS.slice();
  }

  // Append any missing expected columns (user + meta) at the end, in order.
  // This lets new columns like "Set Time"/"Stage" appear automatically on an
  // existing sheet without manual editing. Existing column order is preserved.
  HEADERS.forEach(function (key) {
    if (header.indexOf(key) === -1) {
      header.push(key);
      sheet.getRange(1, header.length).setValue(key);
    }
  });
  return header;
}

/** Assigns a UUID + timestamp to any row that is missing them. */
function ensureIds_(sheet, header) {
  const idCol = header.indexOf('id');
  const modCol = header.indexOf('lastModified');
  const numRows = sheet.getLastRow() - 1;
  if (numRows < 1) return;

  const range = sheet.getRange(2, 1, numRows, header.length);
  const values = range.getValues();
  let changed = false;
  const now = Date.now();

  for (let i = 0; i < values.length; i++) {
    if (values[i].join('') === '') continue; // skip blank rows
    if (!values[i][idCol]) { values[i][idCol] = Utilities.getUuid(); changed = true; }
    if (!values[i][modCol]) { values[i][modCol] = now; changed = true; }
  }
  if (changed) range.setValues(values);
}

/**
 * Normalizes a cell value for JSON output.
 *
 * Sheets silently coerces datetime-looking text (e.g. "2026-07-30 23:30") into
 * a real date value. JSON.stringify would then emit that Date as a UTC instant
 * ("2026-07-30T21:30:00.000Z"), shifting the wall-clock time by the sheet's UTC
 * offset — a 23:30 set would come back as 21:30. So format any date cell back
 * to plain wall-clock text in the spreadsheet's own timezone instead.
 */
function normalizeValue_(key, val) {
  if (key === 'lastModified') return (val instanceof Date) ? val.getTime() : val;
  if (!(val instanceof Date)) return val;

  const tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  const text = Utilities.formatDate(val, tz, 'yyyy-MM-dd HH:mm');
  // Midnight means "day chosen, no time" — that is how the app writes a
  // day-only value, and Sheets stores it as a date at 00:00. A real 00:00 set
  // is written as text and never reaches this branch.
  return text.slice(-5) === '00:00' ? text.slice(0, 10) : text;
}

/**
 * Writes a value as literal text: the plain-text number format ('@') stops
 * Sheets from re-interpreting "2026-07-30 23:30" as a timezone-bearing date.
 */
function setTextCell_(cell, val) {
  cell.setNumberFormat('@');
  cell.setValue(val === null || val === undefined ? '' : String(val));
}

/** Reads all rows and returns them as an array of objects keyed by header name. */
function readRows_(sheet) {
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];

  const header = values[0].map(String);
  const rows = [];
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    if (row.join('') === '') continue; // skip blank rows
    const obj = {};
    header.forEach(function (key, idx) {
      obj[key] = normalizeValue_(key, row[idx]);
    });
    rows.push(obj);
  }
  return rows;
}

/** GET: returns all DJ rows as JSON (also ensures schema + ids on first run). */
function doGet() {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const sheet = getSheet_();
    const header = ensureSchema_(sheet);
    ensureIds_(sheet, header);
    return jsonOutput_({ ok: true, rows: readRows_(sheet), serverTime: Date.now() });
  } finally {
    lock.releaseLock();
  }
}

/**
 * POST: accepts changed rows.
 * Body (JSON): { "rows": [ { id, Artist, M, A, From, Style, Biography,
 *                            "Best DJ Set", "Resident Advisor", Instagram,
 *                            clientModified } ] }
 *
 * "clientModified" = timestamp of the local change (ms).
 * Conflict rule: a change is applied only if clientModified >= the row's
 * server-side lastModified. Otherwise the server wins; the row is marked
 * "conflict" in the response and the current server version is returned.
 *
 * A row with no id (or an unknown id) is treated as new and appended,
 * with an id assigned by the server.
 */
function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000); // wait up to 30s so concurrent writes don't overlap
  try {
    const body = JSON.parse(e.postData.contents);
    const incoming = (body && body.rows) || [];
    const sheet = getSheet_();
    const header = ensureSchema_(sheet);

    const values = sheet.getDataRange().getValues();
    const idCol = header.indexOf('id');
    const modCol = header.indexOf('lastModified');

    // Map of id -> row number (1-based in the sheet)
    const idToRow = {};
    for (let i = 1; i < values.length; i++) {
      const id = String(values[i][idCol]);
      if (id) idToRow[id] = i + 1;
    }

    const results = [];
    const now = Date.now();

    incoming.forEach(function (item) {
      let id = item.id ? String(item.id) : '';
      const rowNum = id ? idToRow[id] : null;

      // New or unknown id -> append as a new row.
      if (!rowNum) {
        if (!id) id = Utilities.getUuid();
        const newRow = header.map(function (key) {
          if (key === 'id') return id;
          if (key === 'lastModified') return now;
          return item[key] != null ? item[key] : '';
        });
        sheet.appendRow(newRow);
        // Re-write Set Time as literal text (see setTextCell_).
        const stIdx = header.indexOf(TEXT_COLUMN);
        if (stIdx > -1 && newRow[stIdx] !== '') {
          setTextCell_(sheet.getRange(sheet.getLastRow(), stIdx + 1), newRow[stIdx]);
        }
        results.push({ id: id, status: 'inserted', lastModified: now });
        return;
      }

      // Conflict check: server timestamp vs. clientModified.
      let serverMod = values[rowNum - 1][modCol];
      if (serverMod instanceof Date) serverMod = serverMod.getTime();
      serverMod = Number(serverMod) || 0;
      const clientMod = Number(item.clientModified) || 0;

      if (clientMod < serverMod) {
        // Server is newer -> server wins, return current version.
        const current = {};
        header.forEach(function (key, idx) {
          current[key] = normalizeValue_(key, values[rowNum - 1][idx]);
        });
        results.push({ id: id, status: 'conflict', server: current });
        return;
      }

      // Apply the change (column-order independent).
      header.forEach(function (key, idx) {
        if (key === 'id') return;
        let val;
        if (key === 'lastModified') {
          val = now;
        } else {
          val = item[key] != null ? item[key] : values[rowNum - 1][idx];
        }
        const cell = sheet.getRange(rowNum, idx + 1);
        if (key === TEXT_COLUMN) {
          // Also migrates any legacy date cell to text on the next save.
          setTextCell_(cell, normalizeValue_(key, val));
        } else {
          cell.setValue(val);
        }
      });
      results.push({ id: id, status: 'updated', lastModified: now });
    });

    return jsonOutput_({ ok: true, results: results, serverTime: now });
  } catch (err) {
    return jsonOutput_({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

function jsonOutput_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
