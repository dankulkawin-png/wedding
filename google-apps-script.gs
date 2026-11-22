/**
 * Google Apps Script backend — การ์ดแต่งงาน ภัสก์วรินทร์ & กวินท์
 * เก็บ: ลงทะเบียน (แท็บ Registration) · คำอวยพร (Guestbook) · การตั้งค่าการ์ด (Settings)
 * รูปคู่และเพลงที่อัปโหลดจากหน้า "สำหรับผู้จัดงาน" จะเก็บใน Google Drive โฟลเดอร์ "Wedding Card Media"
 *
 * ── อัปเดตจากเวอร์ชันเดิม ─────────────────────────────────────────────
 * 1. เปิด Google Sheet > Extensions > Apps Script
 * 2. ลบโค้ดเดิมทั้งหมด วางไฟล์นี้แทน > กด Save
 * 3. Deploy > Manage deployments > กดไอคอนดินสอ ✏️ ที่ deployment เดิม
 *    > Version: เลือก "New version" > Deploy   (ลิงก์ Web app เหมือนเดิม ไม่ต้องแก้ไฟล์การ์ด)
 *    ถ้ามีหน้าขอสิทธิ์ ให้กด Advanced > Go to ... (unsafe) > Allow
 *
 * ── ตั้งค่าครั้งแรก ───────────────────────────────────────────────────
 * 1. สร้าง Google Sheet ใหม่ > Extensions > Apps Script > วางโค้ดนี้ > Save
 * 2. Deploy > New deployment > Web app · Execute as: Me · Who has access: Anyone
 * 3. คัดลอก Web app URL ไปใส่ที่ SHEETS_API_URL ในไฟล์การ์ด
 *
 * หมายเหตุ
 * - ข้อมูลลงทะเบียนอ่านได้เฉพาะผู้ใส่รหัส ADMIN_KEY · คำอวยพรและการตั้งค่าการ์ด (รูป เพลง เบอร์ พร้อมเพย์) แสดงบนการ์ดจึงอ่านได้ทุกคน
 * - ระบบจัดโต๊ะให้อัตโนมัติตามกลุ่มแขก (ดู ZONE_TABLES) · ย้ายโต๊ะได้จากหน้าผู้จัดงาน หรือแก้คอลัมน์ "โต๊ะ" ในแท็บ Registration
 * - แขกแต่ละคนได้ "รหัสบัตร" สำหรับ QR บัตรเข้างาน · เวลาเช็คอินบันทึกในคอลัมน์ "เช็คอิน"
 */

const EXPIRES = "2027-07-20";                                       // หลังวันนี้ ปิดรับลงทะเบียน/คำอวยพร (ตั้งจาก build.py)
const ADMIN_KEY = "0121";                                   // รหัสผ่านหน้า "สำหรับผู้จัดงาน" — เปลี่ยนได้
const PUBLIC_SHEETS = ['Guestbook'];
const WRITABLE_SHEETS = ['Registration', 'Guestbook', 'RSVP'];
const SETTINGS_SHEET = 'Settings';
const SETTING_KEYS = ['music', 'uploadedMusic', 'gallery', 'contacts', 'promptpay', 'accountName', 'bankName', 'accountNo', 'deadline',
                      'giftQr', 'giftName', 'giftBank', 'giftAccount', 'schedule'];
const REG_SHEET = 'Registration';
const SEATS_PER_TABLE = 10;
// กลุ่มแขก → หมายเลขโต๊ะ (ระบบเติมโต๊ะตามลำดับ) · โต๊ะ 8 สำรองแขก VIP ที่ไม่ได้ลงทะเบียน ระบบจะไม่จัดใครลงโต๊ะนี้
const ZONE_TABLES = {"vip": [5, 6, 7], "friends": [9, 10], "general": [1, 2, 3, 4]};
const RELATION_ZONE = {"ญาติเจ้าสาว": "vip", "ญาติเจ้าบ่าว": "vip", "เพื่อนเจ้าสาว": "friends", "เพื่อนเจ้าบ่าว": "general", "แขกฝั่งเจ้าสาว": "general", "แขกฝั่งเจ้าบ่าว": "general"};
const DEFAULT_ZONE = "general";
const ALL_TABLES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const STAFF_SHEET = 'Staff';
// อีเมลบัตรเข้างาน
const CARD_URL = "https://dankulkawin-png.github.io/wedding/";
const COUPLE_NAME = "ภัสก์วรินทร์ & กวินท์";
const EVENT_TEXT = "วันพฤหัสบดีที่ 21 มกราคม 2570 · ต้อนรับแขก 08.00 น.";
const VENUE_TEXT = "ริมธารา พระราม 3";
const PHOTO_FOLDER_NAME = 'Wedding Guestbook Photos';
const MEDIA_FOLDER_NAME = 'Wedding Card Media';
const MAX_TEXT = 3000;
// ซองช่วยงานออนไลน์ (แขกแนบสลิป)
const GIFT_SHEET = 'Gifts';
const GIFT_FOLDER_NAME = 'ซองช่วยงาน · สลิป (เฉพาะบ่าวสาว)';
const GIFT_NOTIFY = [];                              // อีเมลเพิ่มเติมที่ให้แจ้งเตือน (เจ้าของสคริปต์ได้รับเสมอ)
const MAX_SLIP_BYTES = 5 * 1024 * 1024;
const MAX_PHOTO_BYTES = 6 * 1024 * 1024;
const MAX_MUSIC_BYTES = 12 * 1024 * 1024;

/* ================================================================ GET */
function doGet(e) {
  const p = (e && e.parameter) || {};
  if (p.action === 'settings') return jsonOut({ ok: true, settings: readSettings() });
  if (p.action === 'media') return serveMedia(String(p.id || ''));
  if (p.action === 'ticket') return jsonOut(ticketInfo(p.id));

  const sheetName = String(p.sheet || '').trim();
  if (!sheetName) return jsonOut({ ok: false, error: 'missing sheet param' });
  const isPublic = PUBLIC_SHEETS.indexOf(sheetName) !== -1;
  if (!isPublic && p.key !== ADMIN_KEY) return jsonOut({ ok: false, error: 'unauthorized' });
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
  return jsonOut({ ok: true, auth: !isPublic, rows: sheet ? sheetToObjects(sheet) : [] });
}

// Sends the chosen song as base64 so it plays the same on every phone (iPhone included).
// Only the song currently set in Settings, stored in the card's own media folder, can be read.
function serveMedia(id) {
  const s = readSettings();
  const allowed = [s.music && s.music.id, s.uploadedMusic && s.uploadedMusic.id].filter(Boolean);
  if (!id || allowed.indexOf(id) === -1) return jsonOut({ ok: false, error: 'not allowed' });
  const file = DriveApp.getFileById(id);
  if (!inMediaFolder(file)) return jsonOut({ ok: false, error: 'not allowed' });
  const blob = file.getBlob();
  return jsonOut({ ok: true, mime: blob.getContentType(), name: file.getName(), data: Utilities.base64Encode(blob.getBytes()) });
}

/* ================================================================ POST */
function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const expired = EXPIRES && new Date() > new Date(EXPIRES + 'T23:59:59+07:00');
    if (expired && (body.action === 'register' || (!body.action && body.sheet))) return jsonOut({ ok: false, error: 'expired' });
    if (body.action === 'register') return jsonOut(registerGuest(body));
    if (body.action === 'gift') return jsonOut(expired ? { ok: false, error: 'expired' } : submitGift(body));
    if (body.action) return jsonOut(handleAdmin(body));

    const sheetName = String(body.sheet || '');
    const data = body.data || {};
    if (WRITABLE_SHEETS.indexOf(sheetName) === -1) return jsonOut({ ok: false, error: 'unknown sheet' });

    // guestbook photo -> Drive link
    if (typeof data.photo === 'string' && data.photo.indexOf('data:image') === 0) {
      try { data.photo = savePhotoToDrive(data.photo, data.name || 'guest'); } catch (photoErr) { data.photo = ''; }
    }
    const clean = {};
    Object.keys(data).forEach(function (k) {
      if (k === 'submittedAt') return;
      clean[k] = sanitize(data[k], k === 'photo');
    });
    withLock(function () { appendObjectAsRow(getOrCreateSheet(sheetName), clean); });
    return jsonOut({ ok: true });
  } catch (err) {
    return jsonOut({ ok: false, error: String(err) });
  }
}

// Organiser actions (password required)
// who is calling: the couple (ADMIN_KEY) or a door-staff account (PIN from the Staff sheet)
function authRole(key) {
  key = String(key || '').trim();
  if (!key) return null;
  if (key === ADMIN_KEY) return { role: 'admin', name: 'ผู้จัดงาน' };
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(STAFF_SHEET);
  if (!sh || sh.getLastRow() < 2) return null;
  const rows = sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues();
  for (let i = 0; i < rows.length; i++) if (String(rows[i][1]).trim() === key) return { role: 'staff', name: String(rows[i][0]) };
  return null;
}
const STAFF_ACTIONS = ['staffLogin', 'checkin', 'searchGuests', 'doorUpdate', 'walkIn', 'dashboard'];

function handleAdmin(body) {
  if (body.action === 'sendTicket') return sendTicketEmail(body, authRole(body.key));
  const who = authRole(body.key);
  if (!who) return { ok: false, error: 'unauthorized' };
  if (who.role !== 'admin' && STAFF_ACTIONS.indexOf(body.action) === -1) return { ok: false, error: 'unauthorized' };
  body._by = who.name;
  switch (body.action) {
    case 'staffLogin':
      return { ok: true, role: who.role, name: who.name };
    case 'searchGuests':
      return searchGuests(body.q);
    case 'doorUpdate':
      return doorUpdate(body);
    case 'walkIn':
      return walkIn(body);
    case 'dashboard':
      return dashboard();
    case 'listStaff':
      return listStaff();
    case 'addStaff':
      return addStaff(body.name);
    case 'removeStaff':
      return removeStaff(body.pin);
    case 'saveSettings':
      withLock(function () { writeSettings(body.settings || {}); });
      return { ok: true, settings: readSettings() };
    case 'upload':
      return uploadMedia(body);
    case 'checkin':
      return checkinGuest(body);
    case 'setTable':
      return setGuestTable(body);
    case 'autoAssign':
      return autoAssignTables();
    case 'gifts':
      return listGifts();
    case 'giftSlip':
      return giftSlip(body.id);
    case 'giftCheck':
      return giftCheck(body.id, body.checked);
    case 'deleteMedia': {
      const file = DriveApp.getFileById(String(body.id || ''));
      if (!inMediaFolder(file)) return { ok: false, error: 'not allowed' };
      file.setTrashed(true);
      return { ok: true };
    }
    default:
      return { ok: false, error: 'unknown action' };
  }
}

function uploadMedia(body) {
  const kind = body.kind === 'music' ? 'music' : 'photo';
  const m = String(body.data || '').match(/^data:([\w.+-]+\/[\w.+-]+);base64,(.+)$/);
  if (!m) return { ok: false, error: 'ไฟล์ไม่ถูกต้อง' };
  const mime = m[1];
  if (kind === 'photo' && !/^image\/(jpeg|png|webp|gif)$/.test(mime)) return { ok: false, error: 'รองรับเฉพาะรูป JPG/PNG/WebP' };
  if (kind === 'music' && !/^audio\//.test(mime)) return { ok: false, error: 'รองรับเฉพาะไฟล์เพลง' };
  const bytes = Utilities.base64Decode(m[2]);
  if (bytes.length > (kind === 'music' ? MAX_MUSIC_BYTES : MAX_PHOTO_BYTES)) return { ok: false, error: 'ไฟล์ใหญ่เกินไป' };
  const name = (kind + '-' + Date.now() + '-' + String(body.name || 'file')).replace(/[^\w.\-ก-๙]/g, '_').slice(0, 120);
  const file = getOrCreateFolder(MEDIA_FOLDER_NAME).createFile(Utilities.newBlob(bytes, mime, name));
  if (kind === 'photo') file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return { ok: true, id: file.getId(), name: name };
}

/* ================================================================ settings */
function readSettings() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SETTINGS_SHEET);
  const out = {};
  if (!sh || sh.getLastRow() < 2) return out;
  sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues().forEach(function (r) {
    const k = String(r[0] || '');
    if (SETTING_KEYS.indexOf(k) === -1) return;
    try { out[k] = JSON.parse(r[1]); } catch (e) { out[k] = r[1]; }
  });
  return out;
}
function writeSettings(obj) {
  const sh = getOrCreateSheet(SETTINGS_SHEET);
  if (sh.getLastRow() === 0) { sh.appendRow(['key', 'value']); sh.setFrozenRows(1); }
  const keys = sh.getLastRow() > 1 ? sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues().map(function (r) { return r[0]; }) : [];
  Object.keys(obj).forEach(function (k) {
    if (SETTING_KEYS.indexOf(k) === -1) return;
    const v = JSON.stringify(obj[k] === undefined ? null : obj[k]);
    if (v.length > 40000) throw new Error('ข้อมูลยาวเกินไป');
    const i = keys.indexOf(k);
    if (i >= 0) sh.getRange(i + 2, 2).setNumberFormat('@').setValue(v);
    else { sh.appendRow([k, '']); keys.push(k); sh.getRange(sh.getLastRow(), 2).setNumberFormat('@').setValue(v); }
  });
}

/* ================================================================ helpers */
function withLock(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}

// Trims long text and stops values like "=SUM(...)" from being run as sheet formulas.
function sanitize(v, isUrl) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  let s = String(v);
  if (!isUrl && s.length > MAX_TEXT) s = s.slice(0, MAX_TEXT);
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  return s;
}

function getOrCreateSheet(name) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  return ss.getSheetByName(name) || ss.insertSheet(name);
}

// Appends obj as a new row; creates headers on first use and adds columns for new fields.
function appendObjectAsRow(sheet, obj) {
  const keys = Object.keys(obj);
  let headers;
  if (sheet.getLastRow() === 0) {
    headers = ['Timestamp'].concat(keys);
    sheet.appendRow(headers);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');
  } else {
    headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    const missing = keys.filter(function (k) { return headers.indexOf(k) === -1; });
    if (missing.length) {
      sheet.getRange(1, headers.length + 1, 1, missing.length).setValues([missing]).setFontWeight('bold');
      headers = headers.concat(missing);
    }
  }
  sheet.appendRow(headers.map(function (h) {
    if (h === 'Timestamp') return new Date();
    return obj[h] !== undefined ? obj[h] : '';
  }));
}

function sheetToObjects(sheet) {
  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  if (lastRow < 2) return [];
  const values = sheet.getRange(1, 1, lastRow, lastCol).getValues();
  const headers = values[0];
  return values.slice(1).map(function (row) {
    const obj = {};
    headers.forEach(function (h, i) {
      if (h === '') return;
      const key = h === 'Timestamp' ? 'submittedAt' : h;
      if (key === 'submittedAt' && obj.submittedAt) return;
      obj[key] = row[i];
    });
    return obj;
  });
}

function savePhotoToDrive(dataUrl, label) {
  const match = dataUrl.match(/^data:(image\/\w+);base64,(.+)$/);
  if (!match) return '';
  const blob = Utilities.newBlob(Utilities.base64Decode(match[2]), match[1], label + '-' + Date.now() + '.jpg');
  const file = getOrCreateFolder(PHOTO_FOLDER_NAME).createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return 'https://drive.google.com/thumbnail?id=' + file.getId() + '&sz=w600';
}

function getOrCreateFolder(name) {
  const folders = DriveApp.getFoldersByName(name);
  return folders.hasNext() ? folders.next() : DriveApp.createFolder(name);
}

function inMediaFolder(file) {
  const parents = file.getParents();
  while (parents.hasNext()) {
    if (parents.next().getName() === MEDIA_FOLDER_NAME) return true;
  }
  return false;
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}


/* ================================================================ registration · tables · tickets */
function zoneOfRelation(rel) {
  return RELATION_ZONE[String(rel || '')] || DEFAULT_ZONE;
}
function normName(s) { return String(s || '').replace(/\s+/g, '').toLowerCase(); }
function tableNum(v) {
  const m = String(v === null || v === undefined ? '' : v).match(/^\s*(\d{1,2})\s*$/);
  const n = m ? +m[1] : 0;
  return ALL_TABLES.indexOf(n) !== -1 ? n : 0;
}
function newTicket(taken) {
  const L = 'ABCDEFGHJKMNPQRSTUVWXYZ', A = L + '23456789';
  let t;
  do {
    t = L.charAt(Math.floor(Math.random() * L.length));
    for (let i = 0; i < 5; i++) t += A.charAt(Math.floor(Math.random() * A.length));
  } while (taken[t]);
  return t;
}

// headers + data rows of the Registration sheet (adds any missing columns)
function regTable(sh, need) {
  let headers = sh.getLastRow() === 0 ? [] : sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
  const fresh = headers.length === 0;
  if (fresh) headers = ['Timestamp'];
  const missing = (need || []).filter(function (k) { return headers.indexOf(k) === -1; });
  if (fresh || missing.length) {
    headers = headers.concat(missing);
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  const rows = sh.getLastRow() > 1 ? sh.getRange(2, 1, sh.getLastRow() - 1, headers.length).getValues() : [];
  const col = function (k) { return headers.indexOf(k); };
  return { headers: headers, rows: rows, col: col };
}
// a guest may appear twice from old registrations: only the latest row per name counts
function latestRows(t) {
  const iN = t.col('ชื่อ-นามสกุล'), seen = {}, keep = {};
  for (let i = t.rows.length - 1; i >= 0; i--) {
    const n = normName(t.rows[i][iN]);
    if (!n || seen[n]) continue;
    seen[n] = 1; keep[i] = 1;
  }
  return keep;
}
function seatUsage(t, skip) {
  const keep = latestRows(t), used = {};
  const iT = t.col('โต๊ะ'), iA = t.col('เข้าร่วมงาน');
  t.rows.forEach(function (r, i) {
    if (!keep[i] || i === skip || r[iA] !== 'เข้าร่วม') return;
    const n = tableNum(r[iT]);
    if (n) used[n] = (used[n] || 0) + seatsOf(t, r);
  });
  return used;
}
// seats a party takes: the real head-count once staff have entered it at the door, else what was registered
function seatsOf(t, r) {
  const iM = t.col('มาจริง');
  const actual = iM >= 0 && r[iM] !== '' && r[iM] !== null ? parseInt(r[iM], 10) : NaN;
  return isNaN(actual) ? (parseInt(r[t.col('จำนวนคน')], 10) || 0) : actual;
}
function pickTable(zone, count, used, keepTable) {
  if (keepTable && (used[keepTable] || 0) + count <= SEATS_PER_TABLE) return keepTable;
  const list = ZONE_TABLES[zone] || [];
  for (let i = 0; i < list.length; i++) if ((used[list[i]] || 0) + count <= SEATS_PER_TABLE) return list[i];
  return '';   // group is full: the couple assigns a table from the organiser page
}
function findTicketRow(t, id) {
  const iK = t.col('รหัสบัตร');
  id = String(id || '').toUpperCase().trim();
  if (!id || iK < 0) return -1;
  for (let i = t.rows.length - 1; i >= 0; i--) if (String(t.rows[i][iK]).toUpperCase() === id) return i;
  return -1;
}
function takenTickets(t) {
  const iK = t.col('รหัสบัตร'), taken = {};
  t.rows.forEach(function (r) { if (r[iK]) taken[String(r[iK])] = 1; });
  return taken;
}
function fmtCheckin(v) {
  if (!v) return '';
  const d = v instanceof Date ? v : new Date(v);
  if (isNaN(d.getTime())) return String(v);
  return Utilities.formatDate(d, 'Asia/Bangkok', 'HH:mm') + ' น.';
}
function ticketFromRow(t, r) {
  const g = function (k) { const i = t.col(k); return i >= 0 ? r[i] : ''; };
  return {
    id: String(g('รหัสบัตร')), nickname: String(g('ชื่อเล่น')), fullName: String(g('ชื่อ-นามสกุล')),
    relation: String(g('ความสัมพันธ์')), attending: g('เข้าร่วมงาน') === 'เข้าร่วม',
    count: parseInt(g('จำนวนคน'), 10) || 0, table: tableNum(g('โต๊ะ')) || '', checkedIn: fmtCheckin(g('เช็คอิน')),
    checkedBy: String(g('เช็คอินโดย') || ''), allergy: String(g('แพ้อาหาร') || ''),
    actual: g('มาจริง') === '' || g('มาจริง') === null ? '' : (parseInt(g('มาจริง'), 10) || 0)
  };
}

// Public: a guest registers (or updates their registration). The table is chosen here, under a lock,
// so two guests registering at the same moment can't be given the same last seats.
function registerGuest(body) {
  const data = body.data || {};
  const clean = {};
  Object.keys(data).forEach(function (k) {
    if (['submittedAt', 'Timestamp', 'โต๊ะ', 'รหัสบัตร', 'เช็คอิน', 'เช็คอินโดย', 'ส่งบัตรทางอีเมล', 'ไฟล์บัตร'].indexOf(k) !== -1) return;
    clean[k] = sanitize(data[k], false);
  });
  if (!clean['ชื่อ-นามสกุล']) return { ok: false, error: 'missing name' };
  return withLock(function () {
    const sh = getOrCreateSheet(REG_SHEET);
    const t = regTable(sh, Object.keys(clean).concat(['โต๊ะ', 'รหัสบัตร', 'เช็คอิน', 'ส่งบัตรทางอีเมล']));
    let idx = findTicketRow(t, body.ticket);
    if (idx < 0) {
      const n = normName(clean['ชื่อ-นามสกุล']), iN = t.col('ชื่อ-นามสกุล');
      for (let i = t.rows.length - 1; i >= 0; i--) if (normName(t.rows[i][iN]) === n) { idx = i; break; }
    }
    const old = idx >= 0 ? t.rows[idx] : null;
    const attending = clean['เข้าร่วมงาน'] === 'เข้าร่วม';
    const count = attending ? Math.max(1, parseInt(clean['จำนวนคน'], 10) || 1) : 0;
    if (attending) clean['จำนวนคน'] = count;
    const zone = zoneOfRelation(clean['ความสัมพันธ์']);
    let table = '';
    if (attending) {
      let keep = old ? tableNum(old[t.col('โต๊ะ')]) : 0;
      const sameGroup = keep && (ZONE_TABLES[zone].indexOf(keep) !== -1 || String(old[t.col('ความสัมพันธ์')]) === clean['ความสัมพันธ์']);
      table = pickTable(zone, count, seatUsage(t, idx), sameGroup ? keep : 0);
    }
    const ticket = old && old[t.col('รหัสบัตร')] ? String(old[t.col('รหัสบัตร')]) : newTicket(takenTickets(t));
    const obj = Object.assign({}, clean, { 'โต๊ะ': table, 'รหัสบัตร': ticket });
    const row = t.headers.map(function (h, i) {
      if (h === 'Timestamp') return new Date();
      if (obj[h] !== undefined) return obj[h];
      return old ? old[i] : '';
    });
    if (idx >= 0) sh.getRange(idx + 2, 1, 1, row.length).setValues([row]);
    else sh.appendRow(row);
    return { ok: true, table: table, ticket: ticket, zone: attending ? zone : '' };
  });
}

// Public: what the entry ticket shows (scanned at the door)
function ticketInfo(id) {
  if (!/^[A-Za-z0-9]{4,12}$/.test(String(id || ''))) return { ok: false, error: 'not found' };
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(REG_SHEET);
  if (!sh || sh.getLastRow() < 2) return { ok: false, error: 'not found' };
  const t = regTable(sh, []);
  const i = findTicketRow(t, id);
  if (i < 0) return { ok: false, error: 'not found' };
  return { ok: true, ticket: ticketFromRow(t, t.rows[i]) };
}

// Organiser/staff: check a guest in at the door (undo: true clears it)
function checkinGuest(body) {
  return withLock(function () {
    const sh = getOrCreateSheet(REG_SHEET);
    const t = regTable(sh, ['เช็คอิน']);
    const i = findTicketRow(t, body.id);
    if (i < 0) return { ok: false, error: 'ไม่พบบัตรนี้' };
    const iC = t.col('เช็คอิน');
    const already = !!t.rows[i][iC];
    if (body.undo) t.rows[i][iC] = '';
    else if (!already) t.rows[i][iC] = new Date();
    sh.getRange(i + 2, iC + 1).setValue(t.rows[i][iC]);
    if (!already || body.undo) {
      const tb = regTable(sh, ['เช็คอินโดย']);
      sh.getRange(i + 2, tb.col('เช็คอินโดย') + 1).setValue(body.undo ? '' : (body._by || ''));
    }
    const tk = ticketFromRow(t, t.rows[i]);
    if (body.undo) tk.checkedBy = '';
    else if (!already) tk.checkedBy = body._by || '';
    return { ok: true, already: already && !body.undo, ticket: tk };
  });
}

// Organiser: move a guest to another table ('' = not seated yet)
function setGuestTable(body) {
  const n = body.table === '' || body.table === null ? '' : tableNum(body.table);
  if (n === 0) return { ok: false, error: 'หมายเลขโต๊ะไม่ถูกต้อง' };
  return withLock(function () {
    const sh = getOrCreateSheet(REG_SHEET);
    const t = regTable(sh, ['โต๊ะ', 'รหัสบัตร']);
    let i = findTicketRow(t, body.id);
    if (i < 0 && body.name) {
      const iN = t.col('ชื่อ-นามสกุล'), k = normName(body.name);
      for (let j = t.rows.length - 1; j >= 0; j--) if (normName(t.rows[j][iN]) === k) { i = j; break; }
    }
    if (i < 0) return { ok: false, error: 'ไม่พบรายชื่อนี้' };
    sh.getRange(i + 2, t.col('โต๊ะ') + 1).setValue(n);
    return { ok: true, table: n };
  });
}

// Organiser: give every guest without a table (e.g. registered before this version) a table + ticket
function autoAssignTables() {
  return withLock(function () {
    const sh = getOrCreateSheet(REG_SHEET);
    if (sh.getLastRow() < 2) return { ok: true, assigned: 0, pending: 0 };
    const t = regTable(sh, ['โต๊ะ', 'รหัสบัตร', 'เช็คอิน']);
    const keep = latestRows(t), used = seatUsage(t, -1), taken = takenTickets(t);
    const iT = t.col('โต๊ะ'), iK = t.col('รหัสบัตร'), iA = t.col('เข้าร่วมงาน'), iC = t.col('จำนวนคน'), iR = t.col('ความสัมพันธ์');
    let assigned = 0, pending = 0;
    t.rows.forEach(function (r, i) {
      if (!keep[i]) return;
      if (!r[iK]) { r[iK] = newTicket(taken); taken[r[iK]] = 1; }
      if (r[iA] !== 'เข้าร่วม') { if (!tableNum(r[iT])) r[iT] = ''; return; }
      if (tableNum(r[iT])) return;
      const count = parseInt(r[iC], 10) || 1;
      const n = pickTable(zoneOfRelation(r[iR]), count, used, 0);
      r[iT] = n;
      if (n) { used[n] = (used[n] || 0) + count; assigned++; } else pending++;
    });
    sh.getRange(2, iT + 1, t.rows.length, 1).setValues(t.rows.map(function (r) { return [r[iT]]; }));
    sh.getRange(2, iK + 1, t.rows.length, 1).setValues(t.rows.map(function (r) { return [r[iK]]; }));
    return { ok: true, assigned: assigned, pending: pending };
  });
}


/* ================================================================ door staff accounts */
function staffSheet() {
  const sh = getOrCreateSheet(STAFF_SHEET);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, 3).setValues([['ชื่อ', 'PIN', 'สร้างเมื่อ']]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}
function listStaff() {
  const sh = staffSheet();
  const rows = sh.getLastRow() > 1 ? sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues() : [];
  return { ok: true, staff: rows.filter(function (r) { return r[1]; }).map(function (r) { return { name: String(r[0]), pin: String(r[1]) }; }) };
}
function addStaff(name) {
  name = sanitize(name, false).slice(0, 40);
  if (!name) return { ok: false, error: 'กรุณาใส่ชื่อ' };
  return withLock(function () {
    const sh = staffSheet();
    const used = {};
    listStaff().staff.forEach(function (x) { used[x.pin] = 1; });
    let pin;
    do { pin = String(100000 + Math.floor(Math.random() * 900000)); } while (used[pin] || pin === ADMIN_KEY);
    sh.getRange(sh.getLastRow() + 1, 1, 1, 3).setNumberFormat('@').setValues([[name, pin, new Date().toISOString()]]);
    return { ok: true, name: name, pin: pin };
  });
}
function removeStaff(pin) {
  return withLock(function () {
    const sh = staffSheet();
    if (sh.getLastRow() < 2) return { ok: true };
    const rows = sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues();
    for (let i = rows.length - 1; i >= 0; i--) if (String(rows[i][1]) === String(pin)) sh.deleteRow(i + 2);
    return { ok: true };
  });
}
// door staff: find a guest by name / nickname / ticket code (for guests without their QR)
function searchGuests(q) {
  q = normName(q);
  if (q.length < 2) return { ok: true, guests: [] };
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(REG_SHEET);
  if (!sh || sh.getLastRow() < 2) return { ok: true, guests: [] };
  const t = regTable(sh, []);
  const keep = latestRows(t), out = [];
  t.rows.forEach(function (r, i) {
    if (!keep[i]) return;
    const hay = normName(r[t.col('ชื่อ-นามสกุล')]) + ' ' + normName(r[t.col('ชื่อเล่น')]) + ' ' + normName(r[t.col('รหัสบัตร')]);
    if (hay.indexOf(q) !== -1 && out.length < 20) out.push(ticketFromRow(t, r));
  });
  return { ok: true, guests: out };
}

/* ================================================================ e-mail the entry ticket */
// The ticket picture is drawn in the guest's browser (same design as on the card) and sent here.
// Guests can trigger this only for their own fresh registration; the couple can resend any time.
function authorizeMail() {   // run once from the editor to allow sending e-mail
  Logger.log('อีเมลที่ส่งได้วันนี้: ' + MailApp.getRemainingDailyQuota());
}
function sendTicketEmail(body, who) {
  const isAdmin = who && who.role === 'admin';
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(REG_SHEET);
  if (!sh) return { ok: false, error: 'not found' };
  const t = regTable(sh, ['ส่งบัตรทางอีเมล']);
  const i = findTicketRow(t, body.id);
  if (i < 0) return { ok: false, error: 'not found' };
  const row = t.rows[i];
  const email = String(row[t.col('อีเมล')] || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, error: 'no email' };
  if (row[t.col('เข้าร่วมงาน')] !== 'เข้าร่วม') return { ok: false, error: 'not attending' };
  if (!isAdmin) {
    const ts = row[t.col('Timestamp')];
    const fresh = ts instanceof Date && (Date.now() - ts.getTime()) < 15 * 60 * 1000;
    if (!fresh) return { ok: false, error: 'unauthorized' };
  }
  const m = String(body.image || '').match(/^data:(image\/(?:png|jpeg));base64,(.+)$/);
  if (!m || m[2].length > 3 * 1024 * 1024) return { ok: false, error: 'bad image' };
  if (MailApp.getRemainingDailyQuota() < 1) return { ok: false, error: 'quota' };
  const tk = ticketFromRow(t, row);
  const blob = Utilities.newBlob(Utilities.base64Decode(m[2]), m[1], 'ticket-' + tk.id + (m[1] === 'image/png' ? '.png' : '.jpg'));
  const link = CARD_URL + '?t=' + encodeURIComponent(tk.id);
  const esc = function (x) { return String(x).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  const html =
    '<div style="font-family:Tahoma,sans-serif;color:#4A3346;max-width:520px;margin:0 auto;padding:12px;">' +
    '<p style="font-size:16px;">เรียน คุณ' + esc(tk.nickname || tk.fullName) + '</p>' +
    '<p style="font-size:15px;line-height:1.7;">ขอบพระคุณที่ลงทะเบียนร่วมงานแต่งงานของ <b>' + COUPLE_NAME + '</b><br>' +
    'นี่คือบัตรเข้างานของท่าน กรุณาแสดง QR นี้ที่โต๊ะลงทะเบียนหน้างาน</p>' +
    '<p style="text-align:center;margin:18px 0;"><img src="cid:ticket" alt="บัตรเข้างาน" style="width:100%;max-width:400px;border-radius:6px;"></p>' +
    '<table style="font-size:15px;line-height:1.8;margin:0 auto;">' +
    '<tr><td style="color:#B8894A;padding-right:14px;white-space:nowrap;vertical-align:top;">วันงาน</td><td>' + EVENT_TEXT + '</td></tr>' +
    '<tr><td style="color:#B8894A;padding-right:14px;white-space:nowrap;vertical-align:top;">สถานที่</td><td>' + VENUE_TEXT + '</td></tr>' +
    '<tr><td style="color:#B8894A;padding-right:14px;white-space:nowrap;vertical-align:top;">โต๊ะ</td><td><b>' + (tk.table || 'บ่าวสาวจะแจ้งให้ทราบ') + '</b></td></tr>' +
    '<tr><td style="color:#B8894A;padding-right:14px;white-space:nowrap;vertical-align:top;">จำนวน</td><td>' + tk.count + ' ท่าน</td></tr>' +
    '<tr><td style="color:#B8894A;padding-right:14px;white-space:nowrap;vertical-align:top;">รหัสบัตร</td><td style="letter-spacing:3px;">' + esc(tk.id) + '</td></tr></table>' +
    '<p style="text-align:center;margin:22px 0;"><a href="' + link + '" style="background:#4A3346;color:#FFF1E3;padding:12px 22px;text-decoration:none;display:inline-block;">เปิดบัตรเข้างานออนไลน์</a></p>' +
    '<p style="font-size:13px;color:#7D6273;text-align:center;">ดูรายละเอียดงานและแผนที่ได้ที่ <a href="' + CARD_URL + '" style="color:#C9819E;">การ์ดเชิญออนไลน์</a></p>' +
    '</div>';
  try {
    MailApp.sendEmail({
      to: email, name: COUPLE_NAME,
      subject: 'บัตรเข้างานแต่งงาน ' + COUPLE_NAME + (tk.table ? ' · โต๊ะ ' + tk.table : ''),
      htmlBody: html,
      body: 'บัตรเข้างานของท่าน รหัส ' + tk.id + (tk.table ? ' โต๊ะ ' + tk.table : '') + '\n' + link,
      inlineImages: { ticket: blob },
      attachments: [blob]
    });
  } catch (err) {
    return { ok: false, error: 'send failed: ' + err };
  }
  withLock(function () {
    sh.getRange(i + 2, t.col('ส่งบัตรทางอีเมล') + 1).setValue(new Date());
  });
  return { ok: true, email: email };
}


/* ================================================================ at the door: real head-count, table, walk-ins, live dashboard */
function tableLoad(t) {      // people expected / arrived per table
  const keep = latestRows(t), out = {};
  ALL_TABLES.forEach(function (n) { out[n] = { n: n, expected: 0, arrived: 0, parties: 0, inParties: 0 }; });
  const iT = t.col('โต๊ะ'), iA = t.col('เข้าร่วมงาน'), iI = t.col('เช็คอิน');
  t.rows.forEach(function (r, i) {
    if (!keep[i] || r[iA] !== 'เข้าร่วม') return;
    const n = tableNum(r[iT]); if (!n) return;
    out[n].parties++;
    out[n].expected += parseInt(r[t.col('จำนวนคน')], 10) || 0;
    if (iI >= 0 && r[iI]) { out[n].inParties++; out[n].arrived += seatsOf(t, r); }
  });
  return out;
}
// staff: correct how many people actually came with this ticket, and/or move them to another table (checks them in too)
function doorUpdate(body) {
  return withLock(function () {
    const sh = getOrCreateSheet(REG_SHEET);
    const t = regTable(sh, ['มาจริง', 'เช็คอิน', 'เช็คอินโดย', 'โต๊ะ']);
    const i = findTicketRow(t, body.id);
    if (i < 0) return { ok: false, error: 'ไม่พบบัตรนี้' };
    const r = t.rows[i];
    if (body.actual !== undefined && body.actual !== '') {
      const a = parseInt(body.actual, 10);
      if (isNaN(a) || a < 0 || a > 40) return { ok: false, error: 'จำนวนไม่ถูกต้อง' };
      r[t.col('มาจริง')] = a;
    }
    if (body.table !== undefined) {
      const n = body.table === '' ? '' : tableNum(body.table);
      if (n === 0) return { ok: false, error: 'หมายเลขโต๊ะไม่ถูกต้อง' };
      r[t.col('โต๊ะ')] = n;
    }
    if (!r[t.col('เช็คอิน')]) { r[t.col('เช็คอิน')] = new Date(); r[t.col('เช็คอินโดย')] = body._by || ''; }
    sh.getRange(i + 2, 1, 1, t.headers.length).setValues([r]);
    const load = tableLoad(t)[tableNum(r[t.col('โต๊ะ')])] || null;
    return { ok: true, ticket: ticketFromRow(t, r), table: load };
  });
}
// staff: a guest who never registered (e.g. VIP for table 8) — recorded and checked in on the spot
function walkIn(body) {
  const name = sanitize(body.name, false).slice(0, 60);
  const count = parseInt(body.count, 10);
  const n = body.table === '' || body.table === undefined ? '' : tableNum(body.table);
  if (!name) return { ok: false, error: 'กรุณาใส่ชื่อ' };
  if (isNaN(count) || count < 1 || count > 40) return { ok: false, error: 'จำนวนไม่ถูกต้อง' };
  if (n === 0) return { ok: false, error: 'หมายเลขโต๊ะไม่ถูกต้อง' };
  return withLock(function () {
    const sh = getOrCreateSheet(REG_SHEET);
    const t = regTable(sh, ['ชื่อ-นามสกุล', 'ชื่อเล่น', 'ความสัมพันธ์', 'เข้าร่วมงาน', 'จำนวนคน', 'โต๊ะ', 'รหัสบัตร', 'เช็คอิน', 'เช็คอินโดย', 'มาจริง']);
    const obj = {
      'Timestamp': new Date(), 'ชื่อ-นามสกุล': name, 'ชื่อเล่น': name, 'ความสัมพันธ์': 'แขกหน้างาน',
      'เข้าร่วมงาน': 'เข้าร่วม', 'จำนวนคน': 0, 'มาจริง': count, 'โต๊ะ': n,
      'รหัสบัตร': newTicket(takenTickets(t)), 'เช็คอิน': new Date(), 'เช็คอินโดย': body._by || ''
    };
    const row = t.headers.map(function (h) { return obj[h] !== undefined ? obj[h] : ''; });
    sh.appendRow(row);
    return { ok: true, ticket: ticketFromRow(t, row) };
  });
}
// live numbers for the dashboard (polled every few seconds by the page)
function dashboard() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(REG_SHEET);
  const res = { ok: true, updatedAt: new Date().toISOString(), seats: SEATS_PER_TABLE,
    parties: 0, expected: 0, inParties: 0, arrived: 0, extra: 0, walkins: 0, walkinPeople: 0, notYet: 0, notYetPeople: 0, declined: 0,
    tables: [], recent: [] };
  if (!sh || sh.getLastRow() < 2) { res.tables = ALL_TABLES.map(function (n) { return { n: n, expected: 0, arrived: 0, parties: 0, inParties: 0 }; }); return res; }
  const t = regTable(sh, []);
  const keep = latestRows(t);
  const iA = t.col('เข้าร่วมงาน'), iI = t.col('เช็คอิน'), iR = t.col('ความสัมพันธ์');
  const recent = [];
  t.rows.forEach(function (r, i) {
    if (!keep[i]) return;
    if (r[iA] !== 'เข้าร่วม') { res.declined++; return; }
    const reg = parseInt(r[t.col('จำนวนคน')], 10) || 0;
    const walk = r[iR] === 'แขกหน้างาน';
    if (walk) { res.walkins++; res.walkinPeople += seatsOf(t, r); }
    else { res.parties++; res.expected += reg; }
    if (iI >= 0 && r[iI]) {
      const came = seatsOf(t, r);
      res.arrived += came;
      if (!walk) { res.inParties++; if (came > reg) res.extra += came - reg; }
      const at = r[iI] instanceof Date ? r[iI] : new Date(r[iI]);
      recent.push({ at: at.getTime() || 0, time: fmtCheckin(r[iI]), name: String(r[t.col('ชื่อเล่น')] || r[t.col('ชื่อ-นามสกุล')]),
        people: came, table: tableNum(r[t.col('โต๊ะ')]) || '', by: String(t.col('เช็คอินโดย') >= 0 ? r[t.col('เช็คอินโดย')] : ''), walk: walk });
    } else if (!walk) { res.notYet++; res.notYetPeople += reg; }
  });
  const load = tableLoad(t);
  res.tables = ALL_TABLES.map(function (n) { return load[n]; });
  recent.sort(function (a, b) { return b.at - a.at; });
  res.recent = recent.slice(0, 12);
  return res;
}

/* ================================================================ before going live */
// Run once from the editor (select resetTestData → Run) to clear test registrations, check-ins and wishes.
// A copy of each sheet is kept first, named "... (สำรองข้อมูลทดสอบ)", so nothing is lost by accident.
// Card settings (photos, music, schedule, gift QR) and staff accounts are not touched.
function resetTestData() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  [REG_SHEET, 'Guestbook'].forEach(function (name) {
    const sh = ss.getSheetByName(name);
    if (!sh || sh.getLastRow() < 2) { Logger.log(name + ': ไม่มีข้อมูล'); return; }
    const rows = sh.getLastRow() - 1;
    const backup = sh.copyTo(ss).setName(name + ' (สำรองข้อมูลทดสอบ ' + Utilities.formatDate(new Date(), 'Asia/Bangkok', 'd-M HH.mm') + ')');
    backup.hideSheet();
    sh.deleteRows(2, rows);
    Logger.log(name + ': ล้างแล้ว ' + rows + ' แถว (สำรองไว้ที่แท็บ "' + backup.getName() + '" ซ่อนไว้)');
  });
}


/* =====================================================================
   ซองช่วยงานออนไลน์ — แขกแนบสลิป → เก็บใน Drive (ส่วนตัว) + แถวในแท็บ Gifts
   → อีเมลแจ้งบ่าวสาวทันที (+ LINE ถ้าตั้ง Script properties LINE_TOKEN / LINE_TO)
   ===================================================================== */
function submitGift(body) {
  const name = String(body.name || '').trim().slice(0, 80);
  if (!name) return { ok: false, error: 'name' };
  const m = String(body.slip || '').match(/^data:(image\/(?:jpeg|png|webp));base64,(.+)$/);
  if (!m) return { ok: false, error: 'slip' };
  const bytes = Utilities.base64Decode(m[2]);
  if (bytes.length > MAX_SLIP_BYTES) return { ok: false, error: 'too large' };
  const md5 = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, bytes)
    .map(function (b) { return ('0' + (b & 255).toString(16)).slice(-2); }).join('');
  const hash = 'h' + md5;
  const amt = parseFloat(body.amount);
  const row = {
    id: '', name: sanitize(name), from: sanitize(String(body.from || '').slice(0, 80)),
    amount: isFinite(amt) && amt > 0 ? Math.round(amt * 100) / 100 : '',
    message: sanitize(String(body.message || '').slice(0, 600)), slipId: '', slipUrl: '', md5: hash, checked: ''
  };
  let dup = null, file = null;
  withLock(function () {
    const sh = getOrCreateSheet(GIFT_SHEET);
    const rows = sheetToObjects(sh);
    dup = rows.filter(function (r) { return r.md5 === hash; })[0] || null;
    if (dup) return;
    row.id = 'G' + ('00' + (rows.length + 1)).slice(-3);
    const ext = m[1] === 'image/png' ? 'png' : 'jpg';
    file = getOrCreateFolder(GIFT_FOLDER_NAME).createFile(Utilities.newBlob(bytes, m[1], row.id + ' ' + name.replace(/[\\/:*?"<>|]/g, '_') + '.' + ext));
    row.slipId = file.getId(); row.slipUrl = file.getUrl();
    appendObjectAsRow(sh, row);
    if (body.wish && row.message) appendObjectAsRow(getOrCreateSheet('Guestbook'), { name: row.name, from: row.from, message: row.message, photo: '' });
  });
  if (dup) return { ok: true, id: dup.id, dup: true };
  try { notifyGift_(row, file); } catch (err) { Logger.log('notify failed: ' + err); }
  return { ok: true, id: row.id };
}

function notifyGift_(row, file) {
  const rows = sheetToObjects(getOrCreateSheet(GIFT_SHEET));
  const total = rows.reduce(function (a, r) { return a + (parseFloat(r.amount) || 0); }, 0);
  const amt = row.amount !== '' ? Number(row.amount).toLocaleString('th-TH') + ' บาท' : 'ไม่ได้ระบุยอด';
  const owner = (function () { try { return Session.getEffectiveUser().getEmail(); } catch (e) { return ''; } })();
  const to = [owner].concat(GIFT_NOTIFY || []).filter(function (x, i, a) { return x && a.indexOf(x) === i; }).join(',');
  const esc = function (x) { return String(x || '').replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  if (to && MailApp.getRemainingDailyQuota() > 0) {
    MailApp.sendEmail({
      to: to,
      subject: '💌 ซองช่วยงานจาก ' + row.name + ' · ' + amt,
      htmlBody: '<div style="font-family:sans-serif;max-width:520px;margin:auto;border:1px solid #eadbc0;border-radius:14px;padding:22px;color:#3a2417">' +
        '<p style="letter-spacing:.2em;font-size:11px;color:#a0814f;margin:0">WEDDING GIFT · ' + esc(COUPLE_NAME) + '</p>' +
        '<h2 style="margin:6px 0 14px;font-weight:600">มีซองช่วยงานใหม่ 💌</h2>' +
        '<table style="font-size:15px;line-height:1.8"><tr><td style="color:#8a6a4a;padding-right:14px">จาก</td><td><b>' + esc(row.name) + '</b>' + (row.from ? ' · ' + esc(row.from) : '') + '</td></tr>' +
        '<tr><td style="color:#8a6a4a">ยอดที่แจ้ง</td><td><b>' + esc(amt) + '</b></td></tr>' +
        (row.message ? '<tr><td style="color:#8a6a4a;vertical-align:top">คำอวยพร</td><td>' + esc(row.message).replace(/\n/g, '<br>') + '</td></tr>' : '') +
        '<tr><td style="color:#8a6a4a">เลขที่ซอง</td><td>' + row.id + ' · รวมทั้งหมด ' + rows.length + ' ซอง · ' + total.toLocaleString('th-TH') + ' บาท</td></tr></table>' +
        '<p style="margin:16px 0 6px;font-size:13px;color:#8a6a4a">สลิป (ยอดเป็นตัวเลขที่แขกกรอก กรุณาเทียบกับแอปธนาคาร)</p>' +
        '<img src="cid:slip" style="max-width:100%;border-radius:8px;border:1px solid #eee">' +
        '<p style="font-size:12px;color:#a0814f;margin-top:14px"><a href="' + row.slipUrl + '">เปิดสลิปใน Drive</a>' + (CARD_URL ? ' · <a href="' + CARD_URL + '">เปิดการ์ด → สำหรับผู้จัดงาน → ซองช่วยงาน</a>' : '') + '</p></div>',
      inlineImages: { slip: file.getBlob() }
    });
  }
  const P = PropertiesService.getScriptProperties();
  const token = P.getProperty('LINE_TOKEN'), lineTo = P.getProperty('LINE_TO');
  if (token && lineTo) {
    UrlFetchApp.fetch('https://api.line.me/v2/bot/message/push', {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      headers: { Authorization: 'Bearer ' + token },
      payload: JSON.stringify({ to: lineTo, messages: [{ type: 'text', text: '💌 ซองช่วยงาน ' + row.id + '\nจาก ' + row.name + (row.from ? ' (' + row.from + ')' : '') + '\nยอด ' + amt + (row.message ? '\n“' + row.message.slice(0, 200) + '”' : '') + '\nรวม ' + rows.length + ' ซอง · ' + total.toLocaleString('th-TH') + ' บาท' }] })
    });
  }
}

function listGifts() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(GIFT_SHEET);
  const rows = sh ? sheetToObjects(sh) : [];
  return { ok: true, rows: rows.reverse().map(function (r) {
    return { id: r.id, submittedAt: r.submittedAt, name: r.name, from: r.from, amount: r.amount, message: r.message, checked: !!r.checked };
  }) };
}

function giftSlip(id) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(GIFT_SHEET);
  const r = sh && sheetToObjects(sh).filter(function (x) { return x.id === id; })[0];
  if (!r || !r.slipId) return { ok: false, error: 'ไม่พบสลิป' };
  const blob = DriveApp.getFileById(r.slipId).getBlob();
  return { ok: true, data: 'data:' + blob.getContentType() + ';base64,' + Utilities.base64Encode(blob.getBytes()) };
}

function giftCheck(id, checked) {
  return withLock(function () {
    const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(GIFT_SHEET);
    if (!sh) return { ok: false, error: 'ไม่พบข้อมูล' };
    const v = sh.getDataRange().getValues(), h = v[0], ci = h.indexOf('checked'), ii = h.indexOf('id');
    for (let i = 1; i < v.length; i++) if (v[i][ii] === id) { sh.getRange(i + 1, ci + 1).setValue(checked ? new Date() : ''); return { ok: true }; }
    return { ok: false, error: 'ไม่พบข้อมูล' };
  });
}

// กดรันครั้งเดียวหลังวางโค้ดใหม่ เพื่ออนุญาตสิทธิ์ส่งอีเมล/เก็บสลิป แล้วระบบจะส่งอีเมลทดสอบให้
function testGiftEmail() {
  getOrCreateFolder(GIFT_FOLDER_NAME);
  const me = Session.getEffectiveUser().getEmail();
  MailApp.sendEmail(me, 'ทดสอบแจ้งเตือนซองช่วยงาน · ' + COUPLE_NAME, 'ระบบซองช่วยงานพร้อมใช้งานแล้ว เมื่อแขกแนบสลิป อีเมลแจ้งเตือนจะส่งมาที่ ' + me);
  Logger.log('ส่งอีเมลทดสอบไปที่ ' + me + ' แล้ว');
}
