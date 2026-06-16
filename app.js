'use strict';

// ── State ─────────────────────────────────────────────────
// ── Connection monitoring ─────────────────────────────────
function setConnDot(ok){
  var el=document.getElementById('conn-dot');
  if(el){ el.style.background=ok?'#10B981':'#EF4444'; el.title=ok?'Connected to server':'Server unreachable'; }
}
window.addEventListener('online',  function(){ setConnDot(true);  });
window.addEventListener('offline', function(){ setConnDot(false); toast('📶 Internet connection lost'); });
// Health-check Supabase every 2 minutes
setInterval(async function(){
  if(!navigator.onLine) return;
  try {
    await Promise.race([
      db.from('companies').select('id').limit(1),
      new Promise(function(_,r){ setTimeout(function(){ r(new Error('timeout')); },6000); })
    ]);
    setConnDot(true);
  } catch(e){ setConnDot(false); toast('⚠️ Server unreachable — check your connection'); }
}, 120000);

var S = {
  worker: null, admin: null,
  companyId: null, companyName: null, companyCode: null, fromUrl: false,
  clockStatus: 'out', attendanceId: null,
  authMethod: 'pin',
  userLoc: null, geoWatcher: null,
  npPin: [], npTimer: null,
  homeClock: null
};
var _wCache = {};
var _cCache = {};
var _attData = null; // last loaded attendance report (for summary / print)
var ROLE_LABELS = { super_admin: 'Super Admin', admin: 'Admin', developer: 'Developer' };
var ROLE_COLORS = { super_admin: 'var(--green)', admin: 'var(--blue)', developer: 'var(--purple)' };

// ── Error tracking (Sentry — dormant until a DSN is set) ──
function initSentry() {
  if (typeof SENTRY_DSN === 'undefined' || !SENTRY_DSN) return; // off when blank
  var s = document.createElement('script');
  s.src = 'https://browser.sentry-cdn.com/8.45.1/bundle.min.js';
  s.crossOrigin = 'anonymous';
  s.onload = function () {
    if (!window.Sentry) return;
    Sentry.init({
      dsn: SENTRY_DSN,
      environment: 'production',
      release: 'workclock',
      tracesSampleRate: 0,            // errors only — no perf cost / no extra quota
      replaysSessionSampleRate: 0,
      replaysOnErrorSampleRate: 0
    });
  };
  s.onerror = function () {};         // never let monitoring break the app
  document.head.appendChild(s);
}

// ── Navigation ────────────────────────────────────────────
function showPg(id) {
  document.querySelectorAll('.pg').forEach(function(p) { p.classList.remove('active'); });
  var el = document.getElementById('pg-' + id);
  if (el) { el.classList.add('active'); window.scrollTo(0, 0); }
}

// ── Utilities ─────────────────────────────────────────────
function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise(function(_, r) { setTimeout(function() { r(new Error('timeout')); }, ms); })]);
}
function haversineM(la1, lo1, la2, lo2) {
  var R = 6371000, r = function(d) { return d * Math.PI / 180; };
  var a = Math.pow(Math.sin(r(la2 - la1) / 2), 2) + Math.cos(r(la1)) * Math.cos(r(la2)) * Math.pow(Math.sin(r(lo2 - lo1) / 2), 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
function b64(buf) { return btoa(String.fromCharCode.apply(null, new Uint8Array(buf))); }
function unb64(s) { var b = atob(s), a = new Uint8Array(b.length); for (var i = 0; i < b.length; i++) a[i] = b.charCodeAt(i); return a.buffer; }
function initials(n) { return (n || '??').split(' ').map(function(w) { return w[0]; }).join('').toUpperCase().slice(0, 2); }
function _tz() { return (S.admin && S.admin.co_timezone) || 'Africa/Johannesburg'; }
function fmtTime(iso) { return iso ? new Date(iso).toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit', timeZone: _tz() }) : '--:--'; }
function fmtDate(iso) { return iso ? new Date(iso).toLocaleDateString('en-ZA', { timeZone: _tz() }) : ''; }
function fmtDateShort(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('en-ZA', { weekday: 'short', day: 'numeric', month: 'short', timeZone: _tz() });
}
function vibrate(p) { if (navigator.vibrate) navigator.vibrate(p || 50); }
// Escape for safe insertion as HTML text/attribute content (prevents stored XSS).
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
// Escape for use inside a single-quoted JS string within an inline handler,
// then HTML-escape so the surrounding attribute can't be broken out of.
function escQ(s) { return esc(String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")); }

// ── Icon system (clean inline SVG, Lucide-style strokes) ──────
// Replaces emoji icons everywhere. Static markup uses
// <span class="ico" data-icon="name"></span> (hydrated on load);
// JS-rendered markup calls icon('name') directly.
var ICONS = {
  clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7.5V12l3 2"/>',
  user:'<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  users:'<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  settings:'<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
  dashboard:'<rect width="7" height="9" x="3" y="3" rx="1.5"/><rect width="7" height="5" x="14" y="3" rx="1.5"/><rect width="7" height="9" x="14" y="12" rx="1.5"/><rect width="7" height="5" x="3" y="16" rx="1.5"/>',
  clipboard:'<rect width="8" height="4" x="8" y="2" rx="1.5"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M12 11h4"/><path d="M12 16h4"/><path d="M8 11h.01"/><path d="M8 16h.01"/>',
  userx:'<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="m17 8 5 5"/><path d="m22 8-5 5"/>',
  key:'<circle cx="7.5" cy="15.5" r="4.5"/><path d="m21 2-9.6 9.6"/><path d="m15.5 7.5 3 3L22 7l-3-3"/>',
  archive:'<rect width="20" height="5" x="2" y="3" rx="1.5"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/>',
  menu:'<line x1="4" x2="20" y1="6" y2="6"/><line x1="4" x2="20" y1="12" y2="12"/><line x1="4" x2="20" y1="18" y2="18"/>',
  building:'<rect width="16" height="20" x="4" y="2" rx="2"/><path d="M9 22v-4h6v4"/><path d="M8 6h.01M16 6h.01M12 6h.01M12 10h.01M12 14h.01M16 10h.01M16 14h.01M8 10h.01M8 14h.01"/>',
  download:'<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>',
  pencil:'<path d="M21.17 6.83a2.83 2.83 0 0 0-4-4L4 16l-1.5 5.5L8 20z"/><path d="m15 5 4 4"/>',
  camera:'<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3z"/><circle cx="12" cy="13" r="3.2"/>',
  fingerprint:'<path d="M12 10a2 2 0 0 0-2 2c0 1.02-.1 2.51-.26 4"/><path d="M14 13.1c0 2.38 0 6.38-1 8.9"/><path d="M2 12a10 10 0 0 1 18-6"/><path d="M2 16h.01"/><path d="M21.8 16c.2-2 .13-5.35 0-6"/><path d="M5 19.5C5.5 18 6 15 6 12a6 6 0 0 1 .34-2"/><path d="M9 6.8a6 6 0 0 1 9 5.2v2"/>',
  shield:'<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10"/>',
  ban:'<circle cx="12" cy="12" r="9"/><path d="m5.6 5.6 12.8 12.8"/>',
  check:'<polyline points="20 6 9 17 4 12"/>',
  logout:'<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" x2="9" y1="12" y2="12"/>',
  chevron:'<polyline points="9 18 15 12 9 6"/>',
  back:'<line x1="19" x2="5" y1="12" y2="12"/><polyline points="12 19 5 12 12 5"/>',
  refresh:'<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M3 21v-5h5"/>',
  pin:'<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>',
  calendar:'<rect width="18" height="18" x="3" y="4" rx="2"/><line x1="16" x2="16" y1="2" y2="6"/><line x1="8" x2="8" y1="2" y2="6"/><line x1="3" x2="21" y1="10" y2="10"/>',
  plus:'<line x1="12" x2="12" y1="5" y2="19"/><line x1="5" x2="19" y1="12" y2="12"/>',
  x:'<line x1="18" x2="6" y1="6" y2="18"/><line x1="6" x2="18" y1="6" y2="18"/>',
  play:'<polygon points="6 4 20 12 6 20 6 4"/>',
  stop:'<rect width="13" height="13" x="5.5" y="5.5" rx="2.5"/>',
  lock:'<rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  chart:'<line x1="12" x2="12" y1="20" y2="10"/><line x1="18" x2="18" y1="20" y2="4"/><line x1="6" x2="6" y1="20" y2="16"/>',
  link:'<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  globe:'<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18"/>',
  copy:'<rect width="13" height="13" x="9" y="8" rx="2"/><path d="M5 15a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2"/>',
  briefcase:'<rect width="20" height="14" x="2" y="7" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/>',
  wifi:'<path d="M5 12.55a11 11 0 0 1 14 0"/><path d="M8.5 16.05a6 6 0 0 1 7 0"/><path d="M2 8.82a15 15 0 0 1 20 0"/><line x1="12" x2="12.01" y1="20" y2="20"/>',
  device:'<rect width="14" height="20" x="5" y="2" rx="2.5"/><path d="M12 18h.01"/>',
  search:'<circle cx="11" cy="11" r="7"/><path d="m21 21-4.35-4.35"/>',
  history:'<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>',
  printer:'<polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect width="12" height="8" x="6" y="14"/>'
};
function icon(name, size) {
  var p = ICONS[name]; if (!p) return '';
  var s = size || 22;
  return '<svg class="ico-svg" width="' + s + '" height="' + s + '" viewBox="0 0 24 24" fill="none" ' +
    'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + p + '</svg>';
}
function hydrateIcons(root) {
  (root || document).querySelectorAll('[data-icon]').forEach(function (el) {
    var n = el.getAttribute('data-icon');
    if (n && ICONS[n]) { el.innerHTML = icon(n, parseInt(el.getAttribute('data-size')) || 22); }
  });
}

// Column lists that deliberately exclude credential columns (pin, session_token,
// password_hash, reset_token, reset_expires) so they are never shipped to the browser.
var WORKER_COLS = 'id,employee_id,name,phone,email,workplace_id,biometric_credential_id,' +
  'biometric_enabled,is_active,job_title,company_id,face_descriptor,device_id,' +
  'failed_attempts,locked_until,force_pin_change';
var ADMIN_COLS = 'id,username,email,is_active,role,full_name,company_id,failed_attempts,locked_until';
async function sha256(str) {
  var buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(function(b) { return b.toString(16).padStart(2, '0'); }).join('');
}
function requireAdminCid() {
  if (!S.admin || !S.admin.company_id) {
    toast('Session expired — please log in again.');
    adminLogout(); return null;
  }
  return S.admin.company_id;
}

// ── Shifts & overtime ─────────────────────────────────────
var DEFAULT_SHIFT = { shift_start: '08:00', shift_end: '17:00', shift_grace_min: 10, shift_ot_mode: 'after_end', work_days: [1, 2, 3, 4, 5] };
var DOW_NAMES = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
function curShift() { return S.shift || DEFAULT_SHIFT; }
function hmToMin(t) { if (!t) return 0; var p = String(t).split(':'); return (parseInt(p[0]) || 0) * 60 + (parseInt(p[1]) || 0); }
function minToHM(m) { var h = Math.floor(m / 60), mm = m % 60; return (h < 10 ? '0' : '') + h + ':' + (mm < 10 ? '0' : '') + mm; }
function localMinsOfDay(iso) {
  var s = new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: _tz() });
  return hmToMin(s);
}
var _DOW = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
function localDow(iso) { return _DOW[new Date(iso).toLocaleDateString('en-US', { weekday: 'short', timeZone: _tz() })] || 0; }
function fmtHrs(h) { return (Math.round(h * 10) / 10) + 'h'; }
// Returns { hours, isWorkDay, late, lateMin, ot } for an attendance record.
function shiftCalc(rec) {
  var sh = curShift(), res = { hours: 0, isWorkDay: true, late: false, lateMin: 0, ot: 0 };
  if (!rec || !rec.clock_in_time) return res;
  res.isWorkDay = (sh.work_days || []).indexOf(localDow(rec.clock_in_time)) !== -1;
  var startMin = hmToMin(sh.shift_start), endMin = hmToMin(sh.shift_end), grace = sh.shift_grace_min || 0;
  var inMin = localMinsOfDay(rec.clock_in_time);
  if (res.isWorkDay && inMin > startMin + grace) { res.late = true; res.lateMin = inMin - startMin; }
  if (rec.clock_out_time) {
    res.hours = Math.max(0, (new Date(rec.clock_out_time) - new Date(rec.clock_in_time)) / 3600000);
    if (!res.isWorkDay) res.ot = res.hours;
    else if (sh.shift_ot_mode === 'daily_9') res.ot = Math.max(0, res.hours - 9);
    else if (sh.shift_ot_mode === 'daily_8') res.ot = Math.max(0, res.hours - 8);
    else if (sh.shift_ot_mode === 'weekly_45') res.ot = 0; // computed across the week at report level
    else { var outMin = localMinsOfDay(rec.clock_out_time); if (outMin > endMin) res.ot = (outMin - endMin) / 60; }
  }
  return res;
}
async function loadShift(companyId) {
  if (!companyId) return;
  if (S.shift && S.shift._cid === companyId) return; // cached
  try {
    var r = await withTimeout(db.from('companies').select('shift_start,shift_end,shift_grace_min,shift_ot_mode,work_days').eq('id', companyId).single(), 4000);
    if (r.data) {
      S.shift = {
        _cid: companyId,
        shift_start: (r.data.shift_start || '08:00').slice(0, 5),
        shift_end:   (r.data.shift_end   || '17:00').slice(0, 5),
        shift_grace_min: r.data.shift_grace_min != null ? r.data.shift_grace_min : 10,
        shift_ot_mode:   r.data.shift_ot_mode || 'after_end',
        work_days:       r.data.work_days || [1, 2, 3, 4, 5]
      };
    }
  } catch (e) {}
}

var _toastT;
function toast(msg, dur) {
  var el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg; el.classList.remove('hidden');
  clearTimeout(_toastT); _toastT = setTimeout(function() { el.classList.add('hidden'); }, dur || 3000);
}
function showErr(id, msg) {
  var el = document.getElementById(id); if (!el) return;
  el.textContent = msg || ''; el.classList.toggle('hidden', !msg);
}
function showMsg(id, msg, type) {
  var el = document.getElementById(id); if (!el) return;
  el.textContent = msg; el.className = 'msg ' + (type || ''); el.classList.remove('hidden');
  if (type === 'ok') setTimeout(function() { el.classList.add('hidden'); }, 3500);
}
function closeModal(id) { var el = document.getElementById(id); if (el) el.classList.add('hidden'); }

// ── Company ───────────────────────────────────────────────
function setCompany(co, fromUrl) {
  S.companyId   = co.id;
  S.companyName = co.name;
  S.companyCode = co.code;
  S.fromUrl     = !!fromUrl;
  localStorage.setItem('wc_company', JSON.stringify(co));
  updateHomeUI();
}
function updateHomeUI() {
  var actions = document.getElementById('home-actions');
  if (actions) actions.classList.remove('hidden');
}
async function initCompany() {
  var params = new URLSearchParams(window.location.search);
  var code   = params.get('c') || params.get('company');
  if (code) {
    try {
      var r = await withTimeout(
        db.from('companies').select('*').eq('code', code.toUpperCase()).eq('is_active', true).maybeSingle(),
        4000
      );
      if (r.data) { setCompany(r.data, true); return; }
    } catch (e) {}
  }
  var saved = localStorage.getItem('wc_company');
  if (saved) {
    try { setCompany(JSON.parse(saved), false); return; } catch (e) {}
  }
  updateHomeUI();
}

// ── Home Live Clock ───────────────────────────────────────
function startHomeClock() {
  function tick() {
    var el = document.getElementById('home-live-clock');
    if (!el) return;
    var n = new Date();
    el.textContent = n.toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit' });
  }
  tick();
  if (S.homeClock) clearInterval(S.homeClock);
  S.homeClock = setInterval(tick, 1000);
}

// ── Worker Live Clock (dashboard) ────────────────────────
function startClock() {
  var tick = function() {
    var n = new Date();
    var t = document.getElementById('live-time');
    var d = document.getElementById('live-date');
    if (t) t.textContent = n.toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    if (d) d.textContent = n.toLocaleDateString('en-ZA', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  };
  tick(); setInterval(tick, 1000);
}

// ── Security Utilities ────────────────────────────────────
function getDeviceId() {
  var id = localStorage.getItem('wc_device_id');
  if (!id) {
    if (typeof crypto.randomUUID === 'function') {
      id = crypto.randomUUID();
    } else {
      var arr = crypto.getRandomValues(new Uint8Array(16));
      arr[6] = (arr[6] & 0x0f) | 0x40; arr[8] = (arr[8] & 0x3f) | 0x80;
      id = Array.from(arr).map(function(b, i) {
        return ([4,6,8,10].indexOf(i) !== -1 ? '-' : '') + b.toString(16).padStart(2,'0');
      }).join('');
    }
    localStorage.setItem('wc_device_id', id);
  }
  return id;
}
// Human-readable device label for the sign-in/clock-in record. Browsers
// don't expose the exact model (privacy), so this is OS + type + browser,
// e.g. "Android phone · Chrome", "iPhone · Safari", "Windows desktop · Edge".
function deviceLabel() {
  try {
    var ua  = navigator.userAgent || '';
    var uad = navigator.userAgentData;
    var os;
    if (uad && uad.platform) os = uad.platform;
    else if (/Android/i.test(ua)) os = 'Android';
    else if (/iPhone|iPod/i.test(ua)) os = 'iPhone';
    else if (/iPad/i.test(ua)) os = 'iPad';
    else if (/Windows/i.test(ua)) os = 'Windows';
    else if (/Mac OS X|Macintosh/i.test(ua)) os = 'macOS';
    else if (/Linux/i.test(ua)) os = 'Linux';
    else os = '';
    var type = (uad && typeof uad.mobile === 'boolean')
      ? (uad.mobile ? 'phone' : 'desktop')
      : (/iPad|Tablet/i.test(ua) ? 'tablet' : (/Mobi|Android|iPhone/i.test(ua) ? 'phone' : 'desktop'));
    var br = 'Browser';
    if (/Edg\//i.test(ua))                br = 'Edge';
    else if (/OPR\/|Opera/i.test(ua))     br = 'Opera';
    else if (/SamsungBrowser/i.test(ua))  br = 'Samsung Internet';
    else if (/Chrome\//i.test(ua))        br = 'Chrome';
    else if (/Firefox\//i.test(ua))       br = 'Firefox';
    else if (/Safari\//i.test(ua))        br = 'Safari';
    var dev = os ? (/phone|tablet|desktop/.test(type) && !/iPhone|iPad/i.test(os) ? os + ' ' + type : os) : type;
    return (dev + ' · ' + br).slice(0, 80);
  } catch (e) { return 'Unknown device'; }
}
function genToken() {
  var arr = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(arr).map(function(b) { return b.toString(16).padStart(2,'0'); }).join('');
}
async function secureSignIn(method) {
  var w = S.worker;
  if (!w) return;
  var deviceId = getDeviceId();
  // Server issues the session token + enforces device binding (returns
  // 'wrong_device' if bound elsewhere). Token is generated client-side
  // and stored by the RPC, mirroring worker_login's success path.
  var sessionToken = genToken();
  try {
    var r = await withTimeout(db.rpc('worker_biometric_login', {
      p_worker_id: w.id, p_device_id: deviceId, p_new_token: sessionToken
    }), 5000);
    if (r.error) { showErr('err-pin', 'Connection error — please try again.'); return; }
    if (r.data === 'wrong_device') {
      showErr('err-pin', '🔒 This account is bound to another device. Ask your administrator to reset it.');
      setTimeout(function() { S.worker = null; showPg('wlogin'); }, 3000);
      return;
    }
    if (r.data !== 'ok') { showErr('err-pin', 'Account not available — ask your administrator.'); return; }
  } catch (e) { showErr('err-pin', 'Connection error — please try again.'); return; }
  if (!w.device_id) w.device_id = deviceId;
  localStorage.setItem('wc_session_token', sessionToken);
  S.authMethod = method;
  if (S.worker.force_pin_change) {
    document.getElementById('fp-pin1').value = '';
    document.getElementById('fp-pin2').value = '';
    document.getElementById('fp-msg').classList.add('hidden');
    document.getElementById('modal-pin-change').classList.remove('hidden');
    return;
  }
  enterWorkerDashboard();
}
async function saveForcedPin() {
  var p1 = (document.getElementById('fp-pin1').value || '').trim();
  var p2 = (document.getElementById('fp-pin2').value || '').trim();
  if (!p1 || p1.length < 4)    { showMsg('fp-msg', 'PIN must be at least 4 digits.', 'err'); return; }
  if (!/^\d+$/.test(p1))        { showMsg('fp-msg', 'PIN must be digits only.', 'err'); return; }
  if (p1 !== p2)                 { showMsg('fp-msg', 'PINs do not match.', 'err'); return; }
  var btn = document.getElementById('fp-save-btn');
  btn.disabled = true; btn.textContent = 'Saving…';
  try {
    var hashed = await sha256(p1);
    var r = await withTimeout(db.rpc('worker_set_pin', {
      p_worker_id: S.worker.id,
      p_session_token: localStorage.getItem('wc_session_token'),
      p_new_pin_hash: hashed
    }), 5000);
    if (r.error)            { showMsg('fp-msg', 'Error: ' + r.error.message, 'err'); return; }
    if (r.data !== 'ok')    { showMsg('fp-msg', 'Session expired — please sign in again.', 'err'); return; }
    S.worker.force_pin_change = false;
    document.getElementById('modal-pin-change').classList.add('hidden');
    enterWorkerDashboard();
  } catch(e) { showMsg('fp-msg', 'Error: ' + e.message, 'err'); }
  finally { btn.disabled = false; btn.textContent = 'Set PIN'; }
}
function openChangePinModal() {
  document.getElementById('cp-current').value = '';
  document.getElementById('cp-new1').value    = '';
  document.getElementById('cp-new2').value    = '';
  document.getElementById('cp-msg').classList.add('hidden');
  document.getElementById('modal-change-pin').classList.remove('hidden');
}
async function saveChangedPin() {
  var cur  = (document.getElementById('cp-current').value || '').trim();
  var new1 = (document.getElementById('cp-new1').value    || '').trim();
  var new2 = (document.getElementById('cp-new2').value    || '').trim();
  if (!cur)                      { showMsg('cp-msg', 'Enter your current PIN.', 'err'); return; }
  if (!new1 || new1.length < 4)  { showMsg('cp-msg', 'New PIN must be at least 4 digits.', 'err'); return; }
  if (!/^\d+$/.test(new1))       { showMsg('cp-msg', 'PIN must be digits only.', 'err'); return; }
  if (new1 !== new2)             { showMsg('cp-msg', 'PINs do not match.', 'err'); return; }
  var btn = document.getElementById('cp-save-btn');
  btn.disabled = true; btn.textContent = 'Saving…';
  try {
    var newHash = await sha256(new1);
    var r = await withTimeout(db.rpc('worker_set_pin', {
      p_worker_id: S.worker.id,
      p_session_token: localStorage.getItem('wc_session_token'),
      p_new_pin_hash: newHash,
      p_current_pin_hash: await sha256(cur)
    }), 5000);
    if (r.error)                 { showMsg('cp-msg', 'Error: ' + r.error.message, 'err'); return; }
    if (r.data === 'bad_current'){ showMsg('cp-msg', 'Current PIN is incorrect.', 'err'); return; }
    if (r.data === 'bad_session'){ showMsg('cp-msg', 'Session expired — please sign in again.', 'err'); return; }
    if (r.data !== 'ok')         { showMsg('cp-msg', 'Could not update PIN — please try again.', 'err'); return; }
    showMsg('cp-msg', '✅ PIN updated successfully!', 'ok');
    setTimeout(function() { closeModal('modal-change-pin'); }, 1500);
  } catch(e) { showMsg('cp-msg', 'Error: ' + e.message, 'err'); }
  finally { btn.disabled = false; btn.textContent = 'Update PIN'; }
}

// ── Worker Lookup ─────────────────────────────────────────
async function findWorker() {
  var id = (document.getElementById('inp-empid').value || '').trim().toUpperCase();
  showErr('err-empid', '');
  if (!id) { showErr('err-empid', 'Please enter your Employee ID.'); return; }
  try {
    var q = db.from('workers').select(WORKER_COLS + ', workplace:workplaces(*)').eq('employee_id', id).eq('is_active', true);
    if (S.companyId && S.fromUrl) q = q.eq('company_id', S.companyId);
    var r = await withTimeout(q.maybeSingle(), 5000);
    if (r.error && r.error.code === 'PGRST116') {
      showErr('err-empid', 'Multiple accounts found — open your employer\'s link.'); return;
    }
    if (!r.data) { showErr('err-empid', 'Employee ID not found. Check with your manager.'); return; }
    S.worker = r.data; goToAuth(r.data);
  } catch (e) { showErr('err-empid', 'Connection error. Check internet and try again.'); }
}
function goToAuth(w) {
  document.getElementById('auth-av').textContent    = initials(w.name);
  document.getElementById('auth-name').textContent  = w.name;
  document.getElementById('auth-empid').textContent = w.employee_id;
  document.getElementById('auth-job').textContent   = w.job_title || '';
  var bioWrap = document.getElementById('bio-auth-wrap');
  if (w.biometric_enabled && w.biometric_credential_id && window.PublicKeyCredential) {
    bioWrap.classList.remove('hidden');
  } else {
    bioWrap.classList.add('hidden');
  }
  showPg('auth'); npReset();
}
function backFromAuth() { S.worker = null; showPg('wlogin'); }

// ── PIN Numpad ────────────────────────────────────────────
function npReset() { S.npPin = []; clearTimeout(S.npTimer); renderDots(); showErr('err-pin', ''); }
function npKey(d) {
  if (S.npPin.length >= 6) return;
  S.npPin.push(d); renderDots(); vibrate(20); clearTimeout(S.npTimer);
  if (S.npPin.length >= 4) S.npTimer = setTimeout(verifyPin, 600);
}
function npBack()  { S.npPin.pop(); renderDots(); clearTimeout(S.npTimer); showErr('err-pin', ''); }
function npClear() { npReset(); }
function renderDots() {
  for (var i = 0; i < 6; i++) {
    var d = document.getElementById('pd' + i);
    if (d) d.classList.toggle('filled', i < S.npPin.length);
  }
}
async function verifyPin() {
  if (!S.worker) return;
  var enteredHash = await sha256(S.npPin.join(''));
  var deviceId = getDeviceId();
  var row;
  try {
    var r = await withTimeout(
      db.rpc('worker_login', { p_worker_id: S.worker.id, p_pin_hash: enteredHash, p_device_id: deviceId }),
      6000
    );
    if (r.error) { showErr('err-pin', 'Connection error — please try again.'); npReset(); return; }
    row = r.data && r.data[0];
  } catch (e) { showErr('err-pin', 'Connection error — please try again.'); npReset(); return; }
  if (!row) { showErr('err-pin', 'Something went wrong — please try again.'); npReset(); return; }

  if (row.result !== 'ok') {
    vibrate([50, 30, 50]);
    if (row.result === 'locked') {
      showErr('err-pin', '🔒 Account locked. Try again in ' + (row.locked_minutes || 30) + ' minute(s).');
    } else if (row.result === 'wrong_device') {
      showErr('err-pin', '🔒 This account is bound to another device. Ask your administrator to reset it.');
      setTimeout(function () { S.worker = null; showPg('wlogin'); }, 3000);
    } else if (row.result === 'bad_pin') {
      showErr('err-pin', 'Incorrect PIN. ' + (row.attempts_left != null ? row.attempts_left : 0) + ' attempt(s) remaining.');
    } else {
      showErr('err-pin', 'Account not found.');
    }
    npReset(); return;
  }

  // Success — token issued and verified server-side
  localStorage.setItem('wc_session_token', row.session_token);
  localStorage.setItem('wc_worker_id', S.worker.id);
  S.authMethod = 'pin';
  S.worker.force_pin_change = row.force_pin_change;
  if (row.face_descriptor != null) S.worker.face_descriptor = row.face_descriptor;
  if (!S.worker.device_id) S.worker.device_id = deviceId;
  if (S.worker.force_pin_change) {
    document.getElementById('fp-pin1').value = '';
    document.getElementById('fp-pin2').value = '';
    document.getElementById('fp-msg').classList.add('hidden');
    document.getElementById('modal-pin-change').classList.remove('hidden');
    return;
  }
  enterWorkerDashboard();
}

// ── Biometric ─────────────────────────────────────────────
async function homeBiometric() {
  if (!window.PublicKeyCredential) { toast('Biometric not supported on this device/browser'); return; }
  try {
    var cred = await navigator.credentials.get({ publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      allowCredentials: [], userVerification: 'required', timeout: 60000
    }});
    if (!cred) return;
    var workerId = new TextDecoder().decode(cred.response.userHandle);
    if (!workerId) { toast('Biometric not linked to an account. Use Employee ID.'); return; }
    var r = await withTimeout(
      db.from('workers').select(WORKER_COLS + ', workplace:workplaces(*)').eq('id', workerId).eq('is_active', true).maybeSingle(),
      5000
    );
    if (!r.data) { toast('Account not found.'); return; }
    S.worker = r.data; await secureSignIn('biometric');
  } catch (e) { if (e.name !== 'NotAllowedError') toast('Biometric error: ' + e.message); }
}
async function authBiometric() {
  showErr('err-pin', '');
  if (!window.PublicKeyCredential) { showErr('err-pin', 'Biometric not supported.'); return; }
  try {
    var cred = await navigator.credentials.get({ publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      allowCredentials: [{ id: unb64(S.worker.biometric_credential_id), type: 'public-key' }],
      userVerification: 'required', timeout: 60000
    }});
    if (cred) await secureSignIn('biometric');
  } catch (e) { if (e.name !== 'NotAllowedError') showErr('err-pin', 'Error: ' + e.message); }
}
async function workerRegBio() {
  if (!window.PublicKeyCredential) { showMsg('bio-reg-msg', 'Biometric not supported.', 'err'); return; }
  try {
    var cred = await navigator.credentials.create({ publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rp: { name: 'WorkClock', id: window.location.hostname || 'localhost' },
      user: { id: new TextEncoder().encode(S.worker.id), name: S.worker.employee_id, displayName: S.worker.name },
      pubKeyCredParams: [{ alg: -7, type: 'public-key' }, { alg: -257, type: 'public-key' }],
      authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'required', requireResidentKey: true },
      timeout: 60000
    }});
    if (!cred) return;
    var r = await db.rpc('worker_set_biometric', { p_worker_id: S.worker.id, p_token: localStorage.getItem('wc_session_token'), p_credential_id: b64(cred.rawId) });
    if (r.error) throw r.error;
    if (r.data !== 'ok') { showMsg('bio-reg-msg', 'Session expired — please sign in again.', 'err'); return; }
    S.worker.biometric_enabled = true;
    document.getElementById('bio-reg-card').style.display = 'none';
    showMsg('bio-reg-msg', '✅ Biometric registered! Use fingerprint to clock in next time.', 'ok');
  } catch (e) { if (e.name !== 'NotAllowedError') showMsg('bio-reg-msg', 'Error: ' + e.message, 'err'); }
}

// ── Worker Dashboard ──────────────────────────────────────
async function enterWorkerDashboard() {
  var w = S.worker;
  localStorage.setItem('wc_worker_id', w.id);

  // Populate header
  document.getElementById('wk-av').textContent    = initials(w.name);
  document.getElementById('wk-name').textContent  = w.name;
  document.getElementById('wk-empid').textContent = w.employee_id;
  document.getElementById('wk-job').textContent   = w.job_title || '';

  // Always resolve company name from the worker's own company_id — not URL context
  var coName = '';
  if (w.company_id) {
    if (w.company_id === S.companyId && S.companyName) {
      coName = S.companyName;
    } else {
      try {
        var coR = await withTimeout(
          db.from('companies').select('id,name,code').eq('id', w.company_id).maybeSingle(), 3000
        );
        if (coR.data) {
          coName        = coR.data.name;
          S.companyId   = coR.data.id;
          S.companyName = coR.data.name;
          S.companyCode = coR.data.code;
          localStorage.setItem('wc_company', JSON.stringify(coR.data));
        }
      } catch (e) {}
    }
  }
  document.getElementById('wk-co-name').textContent = coName;

  var hr = new Date().getHours();
  document.getElementById('wk-greeting').textContent =
    (hr < 12 ? 'Good morning' : hr < 17 ? 'Good afternoon' : 'Good evening') + ', ' + w.name.split(' ')[0] + '!';

  showPg('worker');
  startClock();

  // Optional cards
  document.getElementById('bio-reg-card').style.display  = (!w.biometric_enabled && window.PublicKeyCredential) ? '' : 'none';
  document.getElementById('face-reg-card').style.display = !w.face_descriptor ? '' : 'none';

  await loadShift(w.company_id);
  await loadTodayRecord();
  await loadAttendanceHistory();
  startLocationWatch();
}

// ── Today's Record ────────────────────────────────────────
async function loadTodayRecord() {
  var today = new Date(); today.setHours(0, 0, 0, 0);
  try {
    var r = await withTimeout(
      db.from('attendance').select('*').eq('worker_id', S.worker.id)
        .gte('clock_in_time', today.toISOString())
        .order('clock_in_time', { ascending: false }).limit(1),
      5000
    );
    var rec    = r.data && r.data[0];
    var card   = document.getElementById('today-card');
    var badge  = document.getElementById('wk-badge');
    if (rec) {
      card.style.display = '';
      document.getElementById('rec-in').textContent  = fmtTime(rec.clock_in_time);
      document.getElementById('rec-out').textContent = rec.clock_out_time ? fmtTime(rec.clock_out_time) : 'Still In';
      if (rec.clock_in_time && rec.clock_out_time) {
        var hrs = ((new Date(rec.clock_out_time) - new Date(rec.clock_in_time)) / 3600000).toFixed(1);
        document.getElementById('rec-hrs').textContent = hrs + 'h';
      } else {
        document.getElementById('rec-hrs').textContent = '--';
      }
      if (rec.status === 'active') {
        S.clockStatus = 'in'; S.attendanceId = rec.id;
        badge.className = 'badge badge-in'; badge.innerHTML = '<span class="dot"></span> Clocked In';
      } else {
        S.clockStatus = 'out';
        badge.className = 'badge badge-out'; badge.innerHTML = '<span class="dot"></span> Clocked Out';
      }
    } else {
      card.style.display = 'none'; S.clockStatus = 'out';
      badge.className = 'badge badge-out'; badge.innerHTML = '<span class="dot"></span> Clocked Out';
    }
  } catch (e) {}
}

// ── 14-Day Attendance History ─────────────────────────────
async function loadAttendanceHistory() {
  var histCard = document.getElementById('history-card');
  var histList = document.getElementById('history-list');
  if (!histCard || !histList) return;

  var cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 14);
  cutoff.setHours(0, 0, 0, 0);

  try {
    var r = await withTimeout(
      db.from('attendance').select('*').eq('worker_id', S.worker.id)
        .gte('clock_in_time', cutoff.toISOString())
        .order('clock_in_time', { ascending: false })
        .limit(30),
      6000
    );
    var recs = r.data || [];
    if (!recs.length) {
      histCard.style.display = 'none';
      return;
    }
    histCard.style.display = '';
    histList.innerHTML = recs.map(function(rec) {
      var cin   = rec.clock_in_time  ? new Date(rec.clock_in_time)  : null;
      var cout  = rec.clock_out_time ? new Date(rec.clock_out_time) : null;
      var hrs   = (cin && cout) ? ((cout - cin) / 3600000).toFixed(1) + 'h' : '--';
      var inStr  = cin  ? cin.toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit' })  : '--:--';
      var outStr = cout ? cout.toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit' }) : 'In';
      var dateStr = cin ? fmtDateShort(rec.clock_in_time) : '--';
      var isActive  = rec.status === 'active';
      var chipClass = isActive ? 'hist-chip hist-chip-active' : 'hist-chip hist-chip-done';
      var chipLabel = isActive ? 'Active' : 'Done';
      var meth = rec.auth_method ? (rec.auth_method.charAt(0).toUpperCase() + rec.auth_method.slice(1)) : '';
      var sc = shiftCalc(rec);
      var lateTag = sc.late ? ' <span class="hist-chip hist-chip-absent">Late ' + sc.lateMin + 'm</span>' : '';
      var otTag   = sc.ot >= 0.05 ? '<div class="hist-method" style="color:var(--amber)">OT ' + fmtHrs(sc.ot) + '</div>' : '';
      return '<div class="hist-row">' +
        '<div class="hist-left">' +
          '<div class="hist-date">' + dateStr + lateTag + '</div>' +
          '<div class="hist-times">' + inStr + ' → ' + outStr + '</div>' +
        '</div>' +
        '<div class="hist-right">' +
          '<div class="hist-hrs">' + hrs + '</div>' +
          otTag +
          '<div class="hist-method">' + meth + '</div>' +
          '<span class="' + chipClass + '">' + chipLabel + '</span>' +
        '</div>' +
        '</div>';
    }).join('');
  } catch (e) {
    histCard.style.display = 'none';
  }
}

// ── Location Watch ────────────────────────────────────────
function startLocationWatch() {
  var locCard = document.getElementById('loc-card');
  var locBlk  = document.getElementById('loc-blocked-card');
  locCard.style.display = ''; locBlk.classList.add('hidden');

  // Block immediately if no workplace — before any GPS attempt
  var wp = S.worker && S.worker.workplace;
  if (!wp || !wp.latitude || !wp.longitude) {
    document.getElementById('loc-status').innerHTML =
      '⚠️ <span style="color:var(--amber)">Workplace not configured — contact your admin</span>';
    setClockBtn(false);
    document.getElementById('clk-icon').textContent  = '📍';
    document.getElementById('clk-label').textContent = 'Workplace Not Set Up';
    return;
  }

  document.getElementById('loc-status').innerHTML = '<div class="checking"><div class="spin"></div> Getting your location…</div>';
  if (!navigator.geolocation) {
    document.getElementById('loc-status').textContent = '⚠️ Location not supported on this device';
    setClockBtn(false);
    document.getElementById('clk-icon').textContent  = '📍';
    document.getElementById('clk-label').textContent = 'Location Not Supported';
    return;
  }
  if (S.geoWatcher) navigator.geolocation.clearWatch(S.geoWatcher);
  S.geoWatcher = navigator.geolocation.watchPosition(
    function(pos) {
      S.userLoc = pos.coords;
      var dist   = Math.round(haversineM(pos.coords.latitude, pos.coords.longitude, wp.latitude, wp.longitude));
      var radius = wp.radius_meters || 100;
      var inside = dist <= radius;
      document.getElementById('loc-status').innerHTML = inside
        ? '✅ <strong>' + (wp.name || 'Workplace') + '</strong> — ' + dist + 'm away'
        : '❌ Too far — ' + dist + 'm from <strong>' + (wp.name || 'workplace') + '</strong> (max ' + radius + 'm)';
      setClockBtn(inside);
    },
    function(err) {
      if (err.code === 1) {
        locCard.style.display = 'none'; locBlk.classList.remove('hidden');
        setClockBtn(false);
      } else {
        document.getElementById('loc-status').textContent = '⚠️ GPS signal unavailable — clocking in without location';
        setClockBtn(true);
      }
    },
    { enableHighAccuracy: true, maximumAge: 15000, timeout: 20000 }
  );
}
function retryLocation() {
  document.getElementById('loc-blocked-card').classList.add('hidden');
  document.getElementById('loc-card').style.display = '';
  startLocationWatch();
}
function setClockBtn(enabled) {
  var btn = document.getElementById('clk-btn');
  if (!btn) return;
  if (enabled) {
    btn.disabled = false;
    if (S.clockStatus === 'in') {
      btn.className = 'clock-btn clk-out';
      document.getElementById('clk-icon').innerHTML   = icon('stop', 26);
      document.getElementById('clk-label').textContent = 'Clock Out';
    } else {
      btn.className = 'clock-btn clk-in';
      document.getElementById('clk-icon').innerHTML   = icon('play', 26);
      document.getElementById('clk-label').textContent = 'Clock In';
    }
  } else {
    btn.disabled = true; btn.className = 'clock-btn clk-wait';
    document.getElementById('clk-icon').innerHTML    = icon('clock', 26);
    document.getElementById('clk-label').textContent = 'Checking Location…';
  }
}

// ── Clock In / Out ────────────────────────────────────────
async function clockAction() {
  var btn = document.getElementById('clk-btn');
  btn.disabled = true;
  var action = S.clockStatus === 'in' ? 'out' : 'in';
  try {
    // Server-side clock: validates session token, active+non-expired
    // company and (on clock-in) the geofence — none of it trusted from
    // the browser. Requires the worker_clock_action RPC to be deployed
    // (phase2b_worker_clock_rpc.sql sections A+B) BEFORE this code ships.
    var clockArgs = {
      p_worker_id:   S.worker.id,
      p_token:       localStorage.getItem('wc_session_token'),
      p_action:      action,
      p_lat:         S.userLoc ? S.userLoc.latitude  : null,
      p_lng:         S.userLoc ? S.userLoc.longitude : null,
      p_auth_method: S.authMethod || 'pin'
    };
    var r = await withTimeout(db.rpc('worker_clock_action',
      Object.assign({ p_device_label: deviceLabel() }, clockArgs)), 8000);
    // Fallback for the brief window before the device-label DB migration is
    // applied (old 6-arg RPC won't accept p_device_label). Safe to remove once
    // phase2b_device_label.sql has been run.
    if (r.error && /PGRST202|p_device_label|find the function|schema cache/i.test(r.error.message || '')) {
      r = await withTimeout(db.rpc('worker_clock_action', clockArgs), 8000);
    }
    if (r.error) throw r.error;
    var res = r.data || {};
    if (!res.ok) {
      if (res.error === 'too_far') {
        toast('❌ Too far — ' + res.distance + 'm from workplace (max ' + res.radius + 'm)');
      } else if (res.error === 'expired') {
        toast('❌ This company’s subscription has expired. Contact your administrator.');
      } else if (res.error === 'inactive') {
        toast('❌ This account or company is no longer active.');
      } else if (res.error === 'bad_session') {
        toast('🔒 Session expired — please sign in again.');
        setTimeout(logoutWorker, 1500);
      } else if (res.error === 'no_open_session') {
        toast('No open session to clock out of.');
      } else {
        toast('❌ Could not clock ' + action + ' — please try again.');
      }
      btn.disabled = false; setClockBtn(true);
      return;
    }
    if (action === 'in') { S.attendanceId = res.attendance_id; S.clockStatus = 'in'; }
    else                 { S.clockStatus = 'out'; }
    vibrate([50, 30, 100]);
    showSuccess(action);
    await loadTodayRecord();
    await loadAttendanceHistory();
  } catch (e) { toast('❌ ' + e.message); }
  btn.disabled = false; setClockBtn(true);
}
function showSuccess(action) {
  var overlay = document.getElementById('success-overlay');
  var iconEl  = document.getElementById('succ-icon');
  iconEl.className  = 'succ-icon' + (action === 'out' ? ' out' : '');
  iconEl.innerHTML = icon(action === 'in' ? 'check' : 'stop', 48);
  document.getElementById('succ-action').textContent = action === 'in' ? 'Clocked In!'  : 'Clocked Out!';
  document.getElementById('succ-name').textContent   = S.worker.name;
  document.getElementById('succ-time').textContent   = new Date().toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit' });
  document.getElementById('succ-wp').textContent     = (S.worker.workplace && S.worker.workplace.name) || '';
  overlay.classList.remove('hidden');
  setTimeout(function() { overlay.classList.add('hidden'); }, 2500);
}

// ── Worker Sign Out ───────────────────────────────────────
async function logoutWorker() {
  if (S.geoWatcher) { navigator.geolocation.clearWatch(S.geoWatcher); S.geoWatcher = null; }
  if (S.worker) {
    try { await withTimeout(db.rpc('worker_logout', { p_worker_id: S.worker.id, p_token: localStorage.getItem('wc_session_token') }), 3000); } catch(e) {}
  }
  S.worker = null; S.userLoc = null; S.clockStatus = 'out'; S.attendanceId = null;
  localStorage.removeItem('wc_worker_id');
  localStorage.removeItem('wc_session_token');
  var inp = document.getElementById('inp-empid');
  if (inp) inp.value = '';
  showPg('home');
}

// ── Face Recognition ──────────────────────────────────────
var FACE_CDN = 'https://cdn.jsdelivr.net/gh/justadudewhohacks/face-api.js@0.22.2/weights';
var _faceApiPromise = null, _faceModelsLoaded = false, _faceModelsPromise = null;
var _faceStream = null, _faceRunning = false, _faceMatcher = null, _faceWorkerMap = {};

function ensureFaceApi() {
  if (typeof faceapi !== 'undefined') return Promise.resolve();
  if (_faceApiPromise) return _faceApiPromise;
  _faceApiPromise = new Promise(function(resolve, reject) {
    var s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/face-api.js@0.22.2/dist/face-api.min.js';
    s.onload = resolve;
    s.onerror = function() { _faceApiPromise = null; reject(new Error('Could not load face recognition library — check internet')); };
    document.head.appendChild(s);
  });
  return _faceApiPromise;
}
async function loadFaceModels() {
  await ensureFaceApi();
  if (_faceModelsLoaded) return;
  if (_faceModelsPromise) return _faceModelsPromise;
  _faceModelsPromise = Promise.all([
    faceapi.nets.tinyFaceDetector.loadFromUri(FACE_CDN),
    faceapi.nets.faceLandmark68TinyNet.loadFromUri(FACE_CDN),
    faceapi.nets.faceRecognitionNet.loadFromUri(FACE_CDN)
  ]).then(function() { _faceModelsLoaded = true; })
    .catch(function(e) { _faceModelsPromise = null; throw e; });
  return _faceModelsPromise;
}
function faceDetectOpts() { return new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 }); }

async function openFaceRecog() {
  showPg('face-scan');
  var statusEl = document.getElementById('face-status');
  var oval     = document.getElementById('face-oval');
  oval.classList.remove('found');
  if (!S.companyId) { statusEl.textContent = '⚠️ No company linked — open your employer\'s clock-in link first.'; return; }
  statusEl.textContent = '⏳ Loading face recognition…';
  try { await withTimeout(loadFaceModels(), 30000); }
  catch (e) { statusEl.textContent = '❌ ' + e.message; return; }
  statusEl.textContent = 'Loading enrolled faces…';
  try {
    var r = await withTimeout(
      db.from('workers').select('id,name,employee_id,face_descriptor')
        .eq('company_id', S.companyId).eq('is_active', true).not('face_descriptor', 'is', null),
      5000
    );
    if (!r.data || !r.data.length) { statusEl.textContent = '⚠️ No faces enrolled — ask your admin to enrol worker faces first.'; return; }
    var labeled = []; _faceWorkerMap = {};
    r.data.forEach(function(w) {
      try {
        labeled.push(new faceapi.LabeledFaceDescriptors(w.id, [new Float32Array(JSON.parse(w.face_descriptor))]));
        _faceWorkerMap[w.id] = w;
      } catch (e) {}
    });
    if (!labeled.length) { statusEl.textContent = '⚠️ Face data invalid — ask admin to re-enrol.'; return; }
    _faceMatcher = new faceapi.FaceMatcher(labeled, 0.50);
  } catch (e) { statusEl.textContent = '❌ Connection error: ' + e.message; return; }
  statusEl.textContent = 'Position your face inside the oval…';
  try {
    _faceStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } } });
    var video = document.getElementById('face-video');
    video.srcObject = _faceStream; await video.play();
    _faceRunning = true; requestAnimationFrame(faceFrame);
  } catch (e) { statusEl.textContent = e.name === 'NotAllowedError' ? '❌ Camera access denied' : '❌ ' + e.message; }
}
async function faceFrame() {
  if (!_faceRunning) return;
  var video    = document.getElementById('face-video');
  var statusEl = document.getElementById('face-status');
  var oval     = document.getElementById('face-oval');
  if (video.readyState !== video.HAVE_ENOUGH_DATA) { requestAnimationFrame(faceFrame); return; }
  try {
    var det = await faceapi.detectSingleFace(video, faceDetectOpts()).withFaceLandmarks(true).withFaceDescriptor();
    if (!det) { oval.classList.remove('found'); requestAnimationFrame(faceFrame); return; }
    var match = _faceMatcher.findBestMatch(det.descriptor);
    if (match.label === 'unknown') {
      oval.classList.remove('found');
      statusEl.textContent = '❓ Face not recognised — try again or use Employee ID';
      await new Promise(function(res) { setTimeout(res, 1500); });
      if (_faceRunning) statusEl.textContent = 'Position your face inside the oval…';
      requestAnimationFrame(faceFrame); return;
    }
    _faceRunning = false; oval.classList.add('found');
    statusEl.textContent = '✅ Recognised: ' + (_faceWorkerMap[match.label] ? _faceWorkerMap[match.label].name : 'Unknown');
    vibrate([50, 30, 100]);
    if (_faceStream) { _faceStream.getTracks().forEach(function(t) { t.stop(); }); _faceStream = null; }
    try {
      var r = await withTimeout(
        db.from('workers').select(WORKER_COLS + ', workplace:workplaces(*)').eq('id', match.label).eq('is_active', true).maybeSingle(),
        5000
      );
      if (!r.data) { statusEl.textContent = '❌ Account not found.'; setTimeout(function() { showPg('home'); }, 2000); return; }
      S.worker = r.data;
      setTimeout(function() { secureSignIn('face'); }, 900);
    } catch (e) { statusEl.textContent = '❌ Connection error'; setTimeout(function() { showPg('home'); }, 2000); }
  } catch (e) { requestAnimationFrame(faceFrame); }
}
function stopFaceRecog() {
  _faceRunning = false;
  if (_faceStream) { _faceStream.getTracks().forEach(function(t) { t.stop(); }); _faceStream = null; }
  showPg('home');
}

// ── Face Enrolment ────────────────────────────────────────
var _enrollStream = null, _enrollTarget = null;
async function adminEnrollFace(workerId, workerName, ctx) {
  _enrollTarget = { id: workerId, name: workerName, ctx: ctx || 'admin' };
  document.getElementById('enroll-title').textContent   = 'Enrol Face — ' + workerName;
  document.getElementById('enroll-status').textContent  = '⏳ Loading models…';
  document.getElementById('enroll-snap-btn').disabled   = true;
  document.getElementById('modal-face-enroll').classList.remove('hidden');
  try { await withTimeout(loadFaceModels(), 30000); }
  catch (e) { document.getElementById('enroll-status').textContent = '❌ Could not load models: ' + e.message; return; }
  document.getElementById('enroll-status').textContent = 'Opening camera…';
  try {
    _enrollStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } } });
    var video = document.getElementById('enroll-video');
    video.srcObject = _enrollStream; await video.play();
    document.getElementById('enroll-status').textContent = 'Position ' + workerName + '\'s face clearly, then tap Capture.';
    document.getElementById('enroll-snap-btn').disabled = false;
  } catch (e) { document.getElementById('enroll-status').textContent = e.name === 'NotAllowedError' ? '❌ Camera access denied' : '❌ ' + e.message; }
}
function workerEnrollFace() { if (S.worker) adminEnrollFace(S.worker.id, S.worker.name, 'worker'); }
async function captureEnroll() {
  var statusEl = document.getElementById('enroll-status');
  var btn      = document.getElementById('enroll-snap-btn');
  btn.disabled = true; statusEl.textContent = 'Detecting face…';
  var video = document.getElementById('enroll-video');
  try {
    var det = await faceapi.detectSingleFace(video, faceDetectOpts()).withFaceLandmarks(true).withFaceDescriptor();
    if (!det) { statusEl.textContent = '❌ No face detected — ensure good lighting.'; btn.disabled = false; return; }
    var descriptor = JSON.stringify(Array.from(det.descriptor));
    var r = _enrollTarget.ctx === 'worker'
      ? await withTimeout(db.rpc('worker_set_face', { p_worker_id: _enrollTarget.id, p_token: localStorage.getItem('wc_session_token'), p_descriptor: descriptor }), 5000)
      : await withTimeout(db.rpc('admin_worker_set_face', { p_actor_id: aId(), p_token: aTok(), p_id: _enrollTarget.id, p_descriptor: descriptor }), 5000);
    if (r.error) throw r.error;
    if (r.data !== 'ok') { statusEl.textContent = '❌ Not permitted — please sign in again.'; btn.disabled = false; return; }
    vibrate([50, 30, 100]); statusEl.textContent = '✅ Face enrolled for ' + _enrollTarget.name + '!';
    if (_enrollTarget.ctx === 'worker') {
      S.worker.face_descriptor = descriptor;
      document.getElementById('face-reg-card').style.display = 'none';
    }
    setTimeout(function() {
      closeFaceEnroll();
      if (_enrollTarget.ctx === 'dev') loadDevWorkers();
      else if (_enrollTarget.ctx === 'admin') loadWorkers();
      else if (_enrollTarget.ctx === 'nw') nwMarkFaceDone();
    }, 1400);
  } catch (e) { statusEl.textContent = '❌ ' + e.message; btn.disabled = false; }
}
function closeFaceEnroll() {
  if (_enrollStream) { _enrollStream.getTracks().forEach(function(t) { t.stop(); }); _enrollStream = null; }
  document.getElementById('modal-face-enroll').classList.add('hidden');
}

// ── Admin session helpers ─────────────────────────────────
function aId()  { return S.admin && S.admin.id; }
function aTok() { return S.admin && S.admin.session_token; }
// Map an RPC result string to a user message; returns true if it was 'ok'.
function rpcOk(res, msgEl) {
  if (res === 'ok') return true;
  var m;
  if (res === 'unauthorized')      m = 'Session expired or not permitted — please log in again.';
  else if (res === 'dupe')         m = 'That name/code/username is already in use.';
  else if (res === 'bad_role')     m = 'Invalid role.';
  else if (res === 'bad_company')  m = 'No company selected.';
  else                             m = 'Action failed — please try again.';
  if (msgEl) showMsg(msgEl, m, 'err'); else toast(m);
  return false;
}

// ── Admin Login ───────────────────────────────────────────
async function adminLogin() {
  var user = (document.getElementById('inp-auser').value || '').trim().toLowerCase();
  var pass = document.getElementById('inp-apass').value || '';
  showErr('err-admin', '');
  if (!user || !pass) { showErr('err-admin', 'Enter username and password.'); return; }
  var btn = document.getElementById('login-btn');
  btn.disabled = true; btn.textContent = 'Logging in…';
  try {
    var hashedPass = await sha256(pass);
    // Secure RPC: verifies password, tracks lockout and issues a session token,
    // all server-side. The password hash is never returned to the browser.
    var rpc = await withTimeout(db.rpc('admin_login_v2', { p_username: user, p_password_hash: hashedPass }), 8000);
    if (rpc.error) { showErr('err-admin', 'Database error: ' + rpc.error.message); return; }
    var row = rpc.data && rpc.data[0];
    if (!row || row.result !== 'ok') {
      var r = row && row.result;
      if (r === 'disabled')    showErr('err-admin', 'Account disabled. Contact your system administrator.');
      else if (r === 'locked') showErr('err-admin', '🔒 Account locked. Try again in ' + (row.locked_minutes || 30) + ' minute(s).');
      else                     showErr('err-admin', 'Invalid username or password.' + (row && row.attempts_left != null ? ' ' + row.attempts_left + ' attempt(s) remaining.' : ''));
      return;
    }
    row.co = { name: row.co_name, code: row.co_code };
    S.admin = row;
    localStorage.setItem('wc_admin_session', JSON.stringify(row));
    document.getElementById('inp-auser').value = '';
    document.getElementById('inp-apass').value = '';
    if (row.role === 'developer') {
      showPg('developer'); loadDevCos();
    } else {
      document.getElementById('admin-co-lbl').textContent = row.co_name || '';
      var isSA = row.role === 'super_admin';
      document.getElementById('tab-admins-btn').classList.toggle('hidden', !isSA);
      applyNavPins(getNavPins());
      showPg('admin'); loadDashboard();
    }
  } catch (e) { showErr('err-admin', 'Error: ' + e.message); }
  finally { btn.disabled = false; btn.textContent = 'Login'; }
}
function adminLogout() {
  try { if (aId() && aTok()) db.rpc('admin_logout', { p_id: aId(), p_token: aTok() }); } catch (e) {}
  S.admin = null; localStorage.removeItem('wc_admin_session'); localStorage.removeItem('wc_dash_cache'); showPg('home');
}

// ── Admin Forgot Password ─────────────────────────────────
function forgotPassword() {
  var panel = document.getElementById('forgot-pw-panel');
  if (panel) { panel.classList.remove('hidden'); document.getElementById('fpw-username').focus(); }
}
function hideForgotPw() {
  var panel = document.getElementById('forgot-pw-panel');
  if (panel) panel.classList.add('hidden');
  ['fpw-username', 'fpw-otp', 'fpw-newpw'].forEach(function(id) { var el = document.getElementById(id); if (el) el.value = ''; });
  ['fpw-send-msg', 'fpw-reset-msg'].forEach(function(id) { var el = document.getElementById(id); if (el) el.classList.add('hidden'); });
  var s1 = document.getElementById('fpw-step1'); if (s1) s1.classList.remove('hidden');
  var s2 = document.getElementById('fpw-step2'); if (s2) s2.classList.add('hidden');
}
async function sendOtp() {
  var username = (document.getElementById('fpw-username').value || '').trim().toLowerCase();
  if (!username) { showMsg('fpw-send-msg', 'Enter your username.', 'err'); return; }
  var btn = document.getElementById('send-otp-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
  showMsg('fpw-send-msg', '⏳ Sending…', 'ok');
  try {
    if (typeof emailjs === 'undefined' || EMAILJS_PUBLIC_KEY === 'YOUR_PUBLIC_KEY') {
      showMsg('fpw-send-msg', 'Email service not configured — contact your system administrator to reset your password.', 'err'); return;
    }
    // OTP is generated and stored (hashed) entirely server-side; the plain code is
    // returned only so the browser can email it. The stored hash is never exposed.
    var r = await withTimeout(db.rpc('request_password_reset', { p_username: username }), 6000);
    if (r.error) { showMsg('fpw-send-msg', 'Error: ' + r.error.message, 'err'); return; }
    var row = r.data && r.data[0];
    if (!row || !row.email) {
      showMsg('fpw-send-msg', 'No account with an email on file matches that username. Contact your system administrator.', 'err');
      return;
    }
    var timeStr = new Date(Date.now() + 15 * 60 * 1000).toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit' });
    await emailjs.send(EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, {
      to_email: row.email,
      to_name:  row.full_name || username,
      passcode: row.otp,
      time:     timeStr
    });
    var s1 = document.getElementById('fpw-step1'); if (s1) s1.classList.add('hidden');
    var s2 = document.getElementById('fpw-step2'); if (s2) s2.classList.remove('hidden');
    showMsg('fpw-reset-msg', '✅ Code sent to ' + esc(row.email) + ' (valid 15 min)', 'ok');
  } catch(e) { showMsg('fpw-send-msg', 'Error: ' + (e.text || e.message || 'Failed to send'), 'err'); }
  finally { if (btn) { btn.disabled = false; btn.textContent = 'Send Code'; } }
}
async function resetAdminPassword() {
  var username = (document.getElementById('fpw-username').value || '').trim().toLowerCase();
  var otp      = (document.getElementById('fpw-otp').value      || '').trim();
  var newpw    = (document.getElementById('fpw-newpw').value    || '').trim();
  if (!otp || otp.length !== 6) { showMsg('fpw-reset-msg', 'Enter the 6-digit code.', 'err'); return; }
  if (!newpw || newpw.length < 6) { showMsg('fpw-reset-msg', 'New password must be at least 6 characters.', 'err'); return; }
  showMsg('fpw-reset-msg', '⏳ Verifying…', 'ok');
  try {
    var r = await withTimeout(db.rpc('verify_password_reset', {
      p_username: username, p_otp: otp, p_new_pw_hash: await sha256(newpw)
    }), 6000);
    if (r.error) { showMsg('fpw-reset-msg', 'Error: ' + r.error.message, 'err'); return; }
    if (r.data === 'no_request') { showMsg('fpw-reset-msg', 'No reset request found — please start over.', 'err'); return; }
    if (r.data === 'expired')    { showMsg('fpw-reset-msg', 'Code expired — request a new one.', 'err'); return; }
    if (r.data === 'bad_code')   { showMsg('fpw-reset-msg', 'Incorrect code. Try again.', 'err'); return; }
    if (r.data !== 'ok')         { showMsg('fpw-reset-msg', 'Could not reset password — please try again.', 'err'); return; }
    showMsg('fpw-reset-msg', '✅ Password reset! You can now log in.', 'ok');
    setTimeout(hideForgotPw, 2000);
  } catch(e) { showMsg('fpw-reset-msg', 'Error: ' + e.message, 'err'); }
}

// ── Admin Tabs ────────────────────────────────────────────
function switchTab(btn, name) {
  document.querySelectorAll('#admin-tabs .bnav-item').forEach(function(t) { t.classList.remove('active'); });
  btn.classList.add('active');
  document.querySelectorAll('#pg-admin .tab-pane').forEach(function(p) { p.classList.remove('active'); });
  document.getElementById(name).classList.add('active');
  if (name === 'a-dash')     loadDashboard();
  if (name === 'a-workers')  loadWorkers();
  if (name === 'a-admins')   loadCoAdmins();
  if (name === 'a-absent')   loadAbsent();
  if (name === 'a-inactive') loadAdminInactive();
  if (name === 'a-audit')    loadAudit();
  if (name === 'a-setup')   loadSetup();
  if (name === 'a-att') {
    var today = new Date().toISOString().slice(0, 10);
    var ago   = new Date(); ago.setMonth(ago.getMonth() - 1);
    document.getElementById('att-from').value = ago.toISOString().slice(0, 10);
    document.getElementById('att-to').value   = today;
    loadWorkerOptions();
  }
}

// ── Dashboard ─────────────────────────────────────────────
async function loadDashboard() {
  var cid = requireAdminCid(); if (!cid) return;
  loadShift(cid);

  // ── Subscription banner ────────────────────────────────
  (async function() {
    try {
      var subR = await withTimeout(db.from('companies').select('subscription_expires_at').eq('id', cid).single(), 5000);
      var banner = document.getElementById('sub-banner');
      if (!banner) return;
      var expAt = subR.data && subR.data.subscription_expires_at ? new Date(subR.data.subscription_expires_at) : null;
      if (!expAt) { banner.classList.add('hidden'); return; }
      var daysLeft = Math.ceil((expAt - new Date()) / 86400000);
      if (daysLeft > 14) { banner.classList.add('hidden'); return; }
      banner.classList.remove('hidden');
      if (daysLeft < 0) {
        banner.style.cssText = 'border-radius:12px;padding:12px 16px;margin-bottom:14px;display:flex;align-items:center;gap:10px;font-size:13px;font-weight:600;background:#FEF2F2;border:1.5px solid #FECACA;color:#991B1B';
        banner.innerHTML = '🔴 <span>Your subscription expired on <strong>' + expAt.toLocaleDateString('en-ZA', {day:'numeric',month:'long',year:'numeric'}) + '</strong>. Please contact Reatlegile Solutions to renew.</span>';
      } else {
        banner.style.cssText = 'border-radius:12px;padding:12px 16px;margin-bottom:14px;display:flex;align-items:center;gap:10px;font-size:13px;font-weight:600;background:#FFFBEB;border:1.5px solid #FDE68A;color:#92400E';
        banner.innerHTML = '⚠️ <span>Subscription expires in <strong>' + daysLeft + ' day' + (daysLeft === 1 ? '' : 's') + '</strong> (' + expAt.toLocaleDateString('en-ZA', {day:'numeric',month:'long',year:'numeric'}) + '). Contact Reatlegile Solutions to renew.</span>';
      }
    } catch(e) {}
  })();
  // ──────────────────────────────────────────────────────

  // Show cached data immediately so the screen is never blank while loading
  var _dashCache = null;
  try { _dashCache = JSON.parse(localStorage.getItem('wc_dash_cache') || 'null'); } catch(e) {}
  if (_dashCache && _dashCache.cid === cid) {
    document.getElementById('s-present').textContent = _dashCache.present;
    document.getElementById('s-total').textContent   = _dashCache.total;
    document.getElementById('s-absent').textContent  = _dashCache.absent;
    document.getElementById('s-active').textContent  = _dashCache.active;
    if (_dashCache.html) document.getElementById('dash-activity').innerHTML = _dashCache.html;
  }

  var today = new Date(); today.setHours(0, 0, 0, 0);
  var tmrw  = new Date(today); tmrw.setDate(tmrw.getDate() + 1);
  try {
    var totR = await withTimeout(db.from('workers').select('id', { count: 'exact', head: true }).eq('is_active', true).eq('company_id', cid), 5000);
    var wkrR = await withTimeout(db.from('workers').select('id').eq('company_id', cid), 5000);
    var ids  = (wkrR.data || []).map(function(w) { return w.id; });
    var recs = [];
    if (ids.length) {
      var attR = await withTimeout(
        db.from('attendance').select('*, w:workers(name,employee_id)').in('worker_id', ids)
          .gte('clock_in_time', today.toISOString()).lt('clock_in_time', tmrw.toISOString())
          .order('clock_in_time', { ascending: false }),
        5000
      );
      recs = attR.data || [];
    }
    var present = recs.length;
    var stillin = recs.filter(function(r) { return r.status === 'active'; }).length;
    var total   = totR.count || 0;
    var absentCount = Math.max(0, total - present);
    document.getElementById('s-present').textContent = present;
    document.getElementById('s-total').textContent   = total;
    document.getElementById('s-absent').textContent  = absentCount;
    document.getElementById('s-active').textContent  = stillin;
    function makeCardLink(statId, tabName, title) {
      var card = document.getElementById(statId).closest('.stat-card');
      if (!card) return;
      card.classList.add('clickable');
      card.title = title;
      card.onclick = function() {
        var btn = document.querySelector('#admin-tabs .bnav-item[onclick*="' + tabName + '"]');
        if (btn) { btn.click(); return; }
        // Tab may be in More (overflow) — switch directly
        switchTab(document.getElementById('admin-more-btn') || document.querySelector('#admin-tabs .bnav-item'), tabName);
      };
    }
    makeCardLink('s-present', 'a-att',     'View today\'s attendance');
    makeCardLink('s-total',   'a-workers', 'View all workers');
    makeCardLink('s-absent',  'a-absent',  'View absent workers');
    makeCardLink('s-active',  'a-att',     'View workers still clocked in');
    var el = document.getElementById('dash-activity');
    el.innerHTML = recs.length
      ? recs.slice(0, 15).map(function(r) {
          return '<div class="act-item">' +
            '<div><div class="act-name">' + (r.w ? esc(r.w.name) : 'Unknown') + '</div>' +
            '<div class="act-time">' + fmtTime(r.clock_in_time) + (r.clock_out_time ? ' → ' + fmtTime(r.clock_out_time) : '') + ' · ' + (r.auth_method || '') + '</div></div>' +
            '<span class="act-tag ' + (r.clock_out_time ? 'tag-out' : 'tag-in') + '">' + (r.clock_out_time ? 'Done' : 'Active') + '</span>' +
            '</div>';
        }).join('')
      : '<div class="empty">No clock-ins today</div>';
    // Save to cache so the dashboard loads instantly on next visit
    try {
      localStorage.setItem('wc_dash_cache', JSON.stringify({
        cid: cid, present: present, total: total, absent: absentCount,
        active: stillin, html: el.innerHTML, at: Date.now()
      }));
    } catch(e) {}
  } catch (e) {
    if (!_dashCache || _dashCache.cid !== cid) {
      document.getElementById('dash-activity').innerHTML = '<div class="empty">Failed to load — check your connection</div>';
    } else {
      toast('⚠️ Showing last cached data — check your connection');
    }
  }
}

// ── Activity / Audit Log ──────────────────────────────────
function auditSummary(wmap, a) {
  var nd = a.new_data || {}, od = a.old_data || {};
  if (a.table_name === 'workers') {
    var nm = nd.name || od.name || 'Worker', emp = nd.employee_id || od.employee_id || '';
    if (a.operation === 'INSERT') return { who: nm, emp: emp, what: 'Worker added' };
    if (a.operation === 'DELETE') return { who: nm, emp: emp, what: 'Worker removed' };
    var ch = [];
    if (od.is_active !== nd.is_active)              ch.push(nd.is_active ? 'reactivated' : 'deactivated');
    if (od.name !== nd.name)                        ch.push('name → ' + (nd.name || '—'));
    if (od.job_title !== nd.job_title)              ch.push('job → ' + (nd.job_title || '—'));
    if (od.employee_id !== nd.employee_id)          ch.push('ID → ' + (nd.employee_id || '—'));
    if (!!od.device_id !== !!nd.device_id)          ch.push(nd.device_id ? 'device bound' : 'device reset');
    if (od.biometric_enabled !== nd.biometric_enabled) ch.push(nd.biometric_enabled ? 'biometric on' : 'biometric off');
    if ((od.locked_until || null) !== (nd.locked_until || null)) ch.push(nd.locked_until ? 'locked' : 'unlocked');
    if (!od.force_pin_change && nd.force_pin_change) ch.push('PIN reset');
    return { who: nm, emp: emp, what: ch.length ? 'Updated: ' + ch.join(', ') : 'Updated' };
  }
  if (a.table_name === 'attendance') {
    var wi = wmap[nd.worker_id || od.worker_id] || {};
    var nm2 = wi.name || 'Worker', emp2 = wi.emp || '';
    if (a.operation === 'INSERT') return { who: nm2, emp: emp2, what: 'Clocked in' };
    if (a.operation === 'DELETE') return { who: nm2, emp: emp2, what: 'Attendance deleted' };
    if (!od.clock_out_time && nd.clock_out_time) return { who: nm2, emp: emp2, what: 'Clocked out' };
    return { who: nm2, emp: emp2, what: 'Attendance updated' };
  }
  return { who: a.table_name, emp: '', what: a.operation };
}
function renderAuditRow(wmap, a) {
  var s = auditSummary(wmap, a);
  var col = a.operation === 'INSERT' ? 'var(--green)' : a.operation === 'DELETE' ? 'var(--red)' : 'var(--brand)';
  var when = a.changed_at ? new Date(a.changed_at).toLocaleString('en-ZA', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: _tz() }) : '';
  var ico = a.table_name === 'attendance' ? 'clock' : 'user';
  return '<div class="list-row"><div class="row-info">' +
    '<div class="av av-sm" style="background:' + col + '1f;color:' + col + '">' + icon(ico, 16) + '</div>' +
    '<div style="min-width:0"><div class="row-name">' + esc(s.who) + (s.emp ? ' <small style="color:var(--muted)">(' + esc(s.emp) + ')</small>' : '') + '</div>' +
    '<div class="row-meta">' + esc(s.what) + '</div></div></div>' +
    '<div class="hist-method" style="white-space:nowrap;align-self:flex-start">' + when + '</div></div>';
}
async function loadAudit() {
  var el = document.getElementById('audit-list'); if (!el) return;
  var cid = requireAdminCid(); if (!cid) return;
  el.innerHTML = '<div class="empty">Loading…</div>';
  try {
    var wR = await withTimeout(db.from('workers').select('id,name,employee_id').eq('company_id', cid), 5000);
    var wmap = {}; (wR.data || []).forEach(function(w) { wmap[w.id] = { name: w.name, emp: w.employee_id }; });
    var r = await withTimeout(
      db.from('audit_log').select('*').eq('company_id', cid).order('changed_at', { ascending: false }).limit(150),
      8000
    );
    var rows = r.data || [];
    if (!rows.length) { el.innerHTML = '<div class="card"><div class="empty">No activity recorded yet</div></div>'; return; }
    el.innerHTML = '<div class="card" style="padding:0 18px">' + rows.map(function(a) { return renderAuditRow(wmap, a); }).join('') + '</div>';
  } catch (e) { el.innerHTML = '<div class="empty">Error: ' + e.message + '</div>'; }
}

// ── Absent Today ──────────────────────────────────────────
async function loadAbsent() {
  var el = document.getElementById('absent-list');
  var countEl = document.getElementById('absent-count');
  if (!el) return;
  var cid = requireAdminCid(); if (!cid) return;
  el.innerHTML = '<div class="empty">Loading…</div>';
  var today = new Date(); today.setHours(0, 0, 0, 0);
  var tmrw  = new Date(today); tmrw.setDate(tmrw.getDate() + 1);
  try {
    var wR = await withTimeout(
      db.from('workers').select('id,name,employee_id,job_title').eq('company_id', cid).eq('is_active', true).order('name'),
      5000
    );
    var all = wR.data || [];
    if (!all.length) { el.innerHTML = '<div class="empty">No active workers</div>'; return; }
    var ids = all.map(function(w) { return w.id; });
    var aR  = await withTimeout(
      db.from('attendance').select('worker_id').in('worker_id', ids)
        .gte('clock_in_time', today.toISOString()).lt('clock_in_time', tmrw.toISOString()),
      5000
    );
    var presentMap = {};
    (aR.data || []).forEach(function(r) { presentMap[r.worker_id] = true; });
    var absent = all.filter(function(w) { return !presentMap[w.id]; });
    if (countEl) countEl.textContent = absent.length + ' of ' + all.length + ' workers not clocked in today';
    if (!absent.length) {
      el.innerHTML = '<div class="empty" style="color:var(--green);font-weight:600">✅ All workers have clocked in today!</div>';
      return;
    }
    el.innerHTML = '<div class="card" style="padding:0 18px">' + absent.map(function(w) {
      return '<div class="list-row">' +
        '<div class="row-info">' +
        '<div class="av av-sm" style="background:#fee2e2;color:var(--red)">' + initials(w.name) + '</div>' +
        '<div><div class="row-name">' + esc(w.name) + '</div>' +
        '<div class="row-meta">' + esc(w.employee_id) + (w.job_title ? ' · ' + esc(w.job_title) : '') + '</div></div>' +
        '</div>' +
        '<span class="badge-absent">Not In</span>' +
        '</div>';
    }).join('') + '</div>';
  } catch(e) { el.innerHTML = '<div class="empty">Error: ' + e.message + '</div>'; }
}

function _fmtLocalInput(d) {
  var p = function(n) { return (n < 10 ? '0' : '') + n; };
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
         ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}
async function forceClockOut(attId, workerName) {
  var rec = _attData && _attData.rows && _attData.rows.filter(function(x) { return x.id === attId; })[0];
  var inT = rec && rec.clock_in_time ? new Date(rec.clock_in_time) : null;
  // Admin enters the REAL clock-out time — never auto-fabricated.
  var ans = prompt(
    'Set the actual clock-out time for "' + workerName + '"\n' +
    'Format: YYYY-MM-DD HH:MM (24-hour)' +
    (inT ? '\nClocked in: ' + _fmtLocalInput(inT) : ''),
    _fmtLocalInput(inT || new Date())
  );
  if (!ans) return;
  var when = new Date(ans.trim().replace(' ', 'T'));
  if (isNaN(when.getTime())) { toast('Invalid date/time — use YYYY-MM-DD HH:MM'); return; }
  if (inT && when <= inT) { toast('Clock-out must be after clock-in.'); return; }
  try {
    var r = await withTimeout(db.rpc('admin_set_attendance_clockout', {
      p_actor_id: aId(), p_token: aTok(), p_id: attId, p_clock_out: when.toISOString()
    }), 5000);
    if (r.error) { toast('Error: ' + r.error.message); return; }
    if (r.data === 'bad_time') { toast('Clock-out must be after clock-in.'); return; }
    if (!rpcOk(r.data)) return;
    toast('✅ ' + workerName + ' clocked out'); loadAttendance();
  } catch(e) { toast('Error: ' + e.message); }
}

// ── Generic list search ───────────────────────────────────
// Client-side filter for the admin/dev lists. Matches the query against
// each row's visible text — which already contains name, company code,
// employee ID, username, role and email — so a single box searches them
// all. Hides a group header + its card when nothing in that group matches.
var _listQ = {}, _listObs = {};
function filterRows(input, containerId) {
  _listQ[containerId] = (input.value || '').trim().toLowerCase();
  // Watch the list once: when it re-renders (after an edit/toggle reload)
  // the observer reapplies the active query so the search isn't lost.
  if (!_listObs[containerId]) {
    var c = document.getElementById(containerId);
    if (c && window.MutationObserver) {
      _listObs[containerId] = new MutationObserver(function() { applyListFilter(containerId); });
      _listObs[containerId].observe(c, { childList: true, subtree: true });
    }
  }
  applyListFilter(containerId);
}
// Reapply the saved query for a list (only inline styles change, so this
// never triggers the childList observer above — no feedback loop).
function applyListFilter(containerId) {
  var c = document.getElementById(containerId);
  if (!c) return;
  var q = _listQ[containerId] || '';
  c.querySelectorAll('.list-row').forEach(function(row) {
    row.style.display = (!q || row.textContent.toLowerCase().indexOf(q) !== -1) ? '' : 'none';
  });
  c.querySelectorAll('.list-group-hd').forEach(function(hd) {
    var card = hd.nextElementSibling;
    if (!card) return;
    var rows = card.querySelectorAll('.list-row'), anyVisible = false;
    rows.forEach(function(r) { if (r.style.display !== 'none') anyVisible = true; });
    var show = !q || anyVisible || rows.length === 0;
    hd.style.display   = show ? '' : 'none';
    card.style.display = show ? '' : 'none';
  });
}

// ── Workers (Admin) ───────────────────────────────────────
async function loadWorkers() {
  var el = document.getElementById('workers-list');
  el.innerHTML = '<div class="empty">Loading…</div>';
  var cid = requireAdminCid(); if (!cid) return;
  try {
    // ── Show/hide limit banner ─────────────────────────────
    var coB  = await withTimeout(db.from('companies').select('worker_limit').eq('id', cid).single(), 5000);
    var cntB = await withTimeout(
      db.from('workers').select('*', { count: 'exact', head: true }).eq('company_id', cid).eq('is_active', true),
      5000
    );
    var banner = document.getElementById('worker-limit-banner');
    if (banner) {
      var atLimit = coB.data && coB.data.worker_limit !== null && (cntB.count || 0) >= coB.data.worker_limit;
      banner.classList.toggle('hidden', !atLimit);
    }
    // ──────────────────────────────────────────────────────
    var r = await withTimeout(db.from('workers').select(WORKER_COLS).eq('company_id', cid).eq('is_active', true).order('name'), 5000);
    if (r.error || !r.data) { el.innerHTML = '<div class="empty">Failed to load</div>'; return; }
    r.data.forEach(function(w) { _wCache[w.id] = Object.assign({}, w, { _ctx: 'admin' }); });
    if (!r.data.length) {
      el.innerHTML = '<div class="card"><div class="empty">No active workers — add one above</div></div>';
      return;
    }
    el.innerHTML =
      '<div class="list-group-hd">✅ Active Workers (' + r.data.length + ')</div>' +
      '<div class="card" style="padding:0 18px">' + r.data.map(function(w) {
        var isLocked = w.locked_until && new Date(w.locked_until) > new Date();
        var meta = esc(w.employee_id) + (w.job_title ? ' · ' + esc(w.job_title) : '')
          + (w.biometric_enabled ? ' ' + icon('fingerprint', 13) : '') + (w.face_descriptor ? ' ' + icon('camera', 13) : '')
          + (w.device_id         ? ' ' + icon('device', 13) : '') + (isLocked ? ' ' + icon('lock', 13) : '');
        return '<div class="list-row">' +
          '<div class="row-info"><div class="av av-sm">' + initials(w.name) + '</div>' +
          '<div><div class="row-name">' + esc(w.name) + '</div>' +
          '<div class="row-meta">' + meta + '</div></div></div>' +
          '<div class="row-btns">' +
          '<button class="icon-btn" title="Edit" onclick="openEditWorker(\'' + w.id + '\')">' + icon('pencil', 18) + '</button>' +
          '<button class="icon-btn ib-teal" title="Enrol face" onclick="adminEnrollFace(\'' + w.id + '\',\'' + escQ(w.name) + '\',\'admin\')">' + icon('camera', 18) + '</button>' +
          '<button class="icon-btn ib-violet" title="Register biometric" onclick="adminRegBio(\'' + w.id + '\',\'' + escQ(w.name) + '\')">' + icon('fingerprint', 18) + '</button>' +
          '<button class="icon-btn ib-warn" title="Reset device &amp; unlock" onclick="resetWorkerSecurity(\'' + w.id + '\',\'' + escQ(w.name) + '\')">' + icon('shield', 18) + '</button>' +
          '<button class="icon-btn ib-danger" title="Remove worker" onclick="toggleWorker(\'' + w.id + '\',true)">' + icon('ban', 18) + '</button>' +
          '</div></div>';
      }).join('') + '</div>';
  } catch (e) { el.innerHTML = '<div class="empty">Error: ' + e.message + '</div>'; }
}
var _newWorkerId = null, _newWorkerName = '', _newWorkerEmpId = '';
function toggleAddWorker() {
  var p = document.getElementById('add-worker-panel'); p.classList.toggle('hidden');
  if (!p.classList.contains('hidden')) {
    document.getElementById('nw-step1').classList.remove('hidden');
    document.getElementById('nw-step2').classList.add('hidden');
    document.getElementById('nw-id').focus();
    _newWorkerId = null; _newWorkerName = ''; _newWorkerEmpId = '';
  }
}
async function addWorker() {
  var empId = (document.getElementById('nw-id').value   || '').trim().toUpperCase();
  var name  = (document.getElementById('nw-name').value || '').trim();
  var job   = (document.getElementById('nw-job').value  || '').trim();
  var pin   = (document.getElementById('nw-pin').value  || '').trim();
  if (!empId || !name || !pin) { showMsg('nw-msg', 'Employee ID, Name and PIN are required.', 'err'); return; }
  if (pin.length < 4) { showMsg('nw-msg', 'PIN must be at least 4 digits.', 'err'); return; }
  var cid = requireAdminCid(); if (!cid) return;
  var btn = document.getElementById('add-worker-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  try {
    // Worker limit + uniqueness are enforced server-side in the RPC.
    var hashedPin = await sha256(pin);
    var r = await withTimeout(db.rpc('admin_worker_create', {
      p_actor_id: aId(), p_token: aTok(), p_company_id: cid,
      p_employee_id: empId, p_name: name, p_job_title: job || null,
      p_pin_hash: hashedPin
    }), 5000);
    if (r.error) { showMsg('nw-msg', 'Error: ' + r.error.message, 'err'); return; }
    if (r.data === 'dupe')         { showMsg('nw-msg', 'Employee ID already exists.', 'err'); return; }
    if (r.data === 'limit')        { showMsg('nw-msg', '⚠️ Worker limit reached. Please upgrade your subscription to add more workers.', 'err'); return; }
    if (r.data === 'unauthorized') { showMsg('nw-msg', 'Session expired or not permitted — please log in again.', 'err'); return; }
    _newWorkerId    = r.data;   // success = the new worker's UUID
    _newWorkerName  = name;
    _newWorkerEmpId = empId;
    ['nw-id', 'nw-name', 'nw-job', 'nw-pin'].forEach(function(id) { document.getElementById(id).value = ''; });
    document.getElementById('nw-s2-name').textContent  = _newWorkerName;
    document.getElementById('nw-s2-empid').textContent = 'Employee ID: ' + _newWorkerEmpId;
    document.getElementById('nw-face-row').classList.remove('method-done');
    document.getElementById('nw-bio-row').classList.remove('method-done');
    document.getElementById('nw-face-btn').disabled = false;
    document.getElementById('nw-bio-btn').disabled  = false;
    document.getElementById('nw-face-sub').textContent = 'Capture worker\'s face to enable';
    document.getElementById('nw-bio-sub').textContent  = 'Worker must be on this device';
    document.getElementById('nw-step1').classList.add('hidden');
    document.getElementById('nw-step2').classList.remove('hidden');
  } catch (e) { showMsg('nw-msg', 'Error: ' + e.message, 'err'); }
  finally { if (btn) { btn.disabled = false; btn.textContent = 'Save Worker'; } }
}
function nwEnrollFace() {
  if (_newWorkerId) adminEnrollFace(_newWorkerId, _newWorkerName, 'nw');
}
function nwEnrollBio() {
  if (_newWorkerId) adminRegBio(_newWorkerId, _newWorkerName, 'nw');
}
function nwMarkFaceDone() {
  var row = document.getElementById('nw-face-row'); if (!row) return;
  row.classList.add('method-done');
  document.getElementById('nw-face-sub').textContent = 'Face enrolled — linked to ' + _newWorkerName;
  var btn = document.getElementById('nw-face-btn'); btn.textContent = '✅'; btn.disabled = true;
}
function nwMarkBioDone() {
  var row = document.getElementById('nw-bio-row'); if (!row) return;
  row.classList.add('method-done');
  document.getElementById('nw-bio-sub').textContent = 'Biometric registered — linked to ' + _newWorkerName;
  var btn = document.getElementById('nw-bio-btn'); btn.textContent = '✅'; btn.disabled = true;
}
function nwDone() {
  document.getElementById('add-worker-panel').classList.add('hidden');
  document.getElementById('nw-step1').classList.remove('hidden');
  document.getElementById('nw-step2').classList.add('hidden');
  _newWorkerId = null; _newWorkerName = ''; _newWorkerEmpId = '';
  loadWorkers();
}
async function toggleWorker(id, cur) {
  var r = await withTimeout(db.rpc('admin_worker_toggle', { p_actor_id: aId(), p_token: aTok(), p_id: id, p_active: !cur }), 5000);
  if (!r.error && rpcOk(r.data)) {
    toast(cur ? 'Worker removed — moved to Inactive tab' : 'Worker restored to active');
    loadWorkers();
  }
}
async function resetWorkerSecurity(id, name) {
  if (!confirm('Reset security for "' + name + '"?\n\n• Removes device binding (they can register a new device)\n• Clears any account lockout\n• Invalidates active session')) return;
  try {
    var r = await withTimeout(
      db.rpc('admin_worker_reset_security', { p_actor_id: aId(), p_token: aTok(), p_id: id }),
      5000
    );
    if (r.error) { toast('Error: ' + r.error.message); return; }
    if (!rpcOk(r.data)) return;
    toast('Security reset for ' + name); loadWorkers();
  } catch(e) { toast('Error: ' + e.message); }
}
async function adminRegBio(workerId, workerName, ctx) {
  if (!window.PublicKeyCredential) { toast('WebAuthn not supported here'); return; }
  if (ctx !== 'nw' && !confirm('Register biometric for "' + workerName + '"?\n\nThe worker must be present on this device.')) return;
  try {
    var cred = await navigator.credentials.create({ publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rp: { name: 'WorkClock', id: window.location.hostname || 'localhost' },
      user: { id: new TextEncoder().encode(workerId), name: workerName, displayName: workerName },
      pubKeyCredParams: [{ alg: -7, type: 'public-key' }, { alg: -257, type: 'public-key' }],
      authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'required', requireResidentKey: true },
      timeout: 60000
    }});
    if (!cred) return;
    var r = await withTimeout(db.rpc('admin_worker_set_biometric', { p_actor_id: aId(), p_token: aTok(), p_id: workerId, p_credential_id: b64(cred.rawId) }), 5000);
    if (r.error) throw r.error;
    if (!rpcOk(r.data)) return;
    if (ctx === 'nw') { nwMarkBioDone(); return; }
    toast('✅ Biometric registered for ' + workerName); loadWorkers();
  } catch (e) { toast(e.name === 'NotAllowedError' ? 'Cancelled.' : '❌ ' + e.message); }
}

// ── Attendance Reports ────────────────────────────────────
async function loadWorkerOptions() {
  var sel = document.getElementById('att-worker');
  var cid = requireAdminCid(); if (!cid) return;
  try {
    var r = await withTimeout(
      db.from('workers').select('id,name,employee_id,job_title').eq('company_id', cid).order('name'),
      5000
    );
    sel.innerHTML = '<option value="">All Workers</option>' + (r.data || []).map(function(w) {
      return '<option value="' + w.id + '">' + esc(w.name) + (w.job_title ? ' · ' + esc(w.job_title) : '') + ' (' + esc(w.employee_id) + ')</option>';
    }).join('');
  } catch (e) {}
}
async function loadAttendance() {
  var from = document.getElementById('att-from').value;
  var to   = document.getElementById('att-to').value;
  var wkr  = document.getElementById('att-worker').value;
  var mth  = document.getElementById('att-method').value;
  var el   = document.getElementById('att-list');
  var sum  = document.getElementById('att-summary');
  if (!from || !to) { el.innerHTML = '<div class="empty">Select a date range</div>'; return; }
  var cid = requireAdminCid(); if (!cid) return;
  el.innerHTML = '<div class="empty">Loading…</div>'; sum.classList.add('hidden');
  var start = new Date(from); start.setHours(0, 0, 0, 0);
  var end   = new Date(to);   end.setHours(23, 59, 59, 999);
  try {
    var cWks = await withTimeout(db.from('workers').select('id').eq('company_id', cid), 5000);
    var allowed = wkr ? [wkr] : (cWks.data || []).map(function(w) { return w.id; });
    if (!allowed.length) { el.innerHTML = '<div class="empty">No workers found</div>'; return; }
    var q = db.from('attendance').select('*, w:workers(name,employee_id,job_title)')
      .in('worker_id', allowed).gte('clock_in_time', start.toISOString()).lte('clock_in_time', end.toISOString())
      .order('clock_in_time', { ascending: false });
    if (mth) q = q.eq('auth_method', mth);
    var r = await withTimeout(q, 10000);
    if (r.error) { el.innerHTML = '<div class="empty">Failed to load</div>'; return; }
    if (!r.data || !r.data.length) { _attData = null; el.innerHTML = '<div class="empty">No records match the filters</div>'; return; }
    _attData = { rows: r.data, from: from, to: to };
    var totalHrs = r.data.reduce(function(s, rec) {
      return s + (rec.clock_in_time && rec.clock_out_time ? (new Date(rec.clock_out_time) - new Date(rec.clock_in_time)) / 3600000 : 0);
    }, 0);
    var totalOt   = r.data.reduce(function(s, rec) { return s + shiftCalc(rec).ot; }, 0);
    var lateCount = r.data.filter(function(rec) { return shiftCalc(rec).late; }).length;
    var today0 = new Date(); today0.setHours(0, 0, 0, 0);
    var isMissed = function(rec) {
      return rec.status === 'missed' ||
             (rec.status === 'active' && rec.clock_in_time && new Date(rec.clock_in_time) < today0);
    };
    var stillin = r.data.filter(function(rec) { return rec.status === 'active' && !isMissed(rec); }).length;
    var missedCount = r.data.filter(isMissed).length;
    showMsg('att-summary', r.data.length + ' records · ' + totalHrs.toFixed(1) + 'h total · OT ' + fmtHrs(totalOt) + ' · ' + lateCount + ' late · ' + stillin + ' still in' + (missedCount ? ' · ⚠ ' + missedCount + ' need review' : ''), 'ok');
    el.innerHTML = '<div class="card" style="padding:0 18px">' + r.data.map(function(rec) {
      var hrs = (rec.clock_in_time && rec.clock_out_time) ? ((new Date(rec.clock_out_time) - new Date(rec.clock_in_time)) / 3600000).toFixed(1) + 'h' : '--';
      var sc = shiftCalc(rec);
      var missed = isMissed(rec);
      var outChip = rec.clock_out_time
        ? '<span class="chip chip-out">⏹ ' + fmtTime(rec.clock_out_time) + '</span>'
        : (missed ? '<span class="chip chip-late">⚠ Missed clock-out</span>'
                  : '<span class="chip chip-out">⏹ Still in</span>');
      return '<div class="att-row">' +
        '<div class="att-name">' + (rec.w ? esc(rec.w.name) : 'Unknown') +
          (rec.w && rec.w.employee_id ? ' <small style="color:var(--muted)">(' + esc(rec.w.employee_id) + ')</small>' : '') +
          (rec.w && rec.w.job_title   ? ' <small style="color:var(--blue)">· ' + esc(rec.w.job_title) + '</small>' : '') +
        '</div>' +
        '<div class="att-date">' + fmtDate(rec.clock_in_time) + '</div>' +
        '<div class="att-chips">' +
          '<span class="chip chip-in">▶ '  + fmtTime(rec.clock_in_time) + '</span>' +
          outChip +
          '<span class="chip chip-hrs">⏱ ' + hrs + '</span>' +
          (sc.late ? '<span class="chip chip-late">Late ' + sc.lateMin + 'm</span>' : '') +
          (sc.ot >= 0.05 ? '<span class="chip chip-ot">OT ' + fmtHrs(sc.ot) + '</span>' : '') +
          '<span class="chip chip-mth">'   + (rec.auth_method || '') + '</span>' +
          (rec.device_label ? '<span class="chip chip-mth" title="Sign-in device">📱 ' + esc(rec.device_label) + '</span>' : '') +
          (!rec.clock_out_time ? '<button class="btn btn-sm btn-outline" style="margin-left:6px;color:var(--red);border-color:var(--red);padding:2px 8px;font-size:.72rem" onclick="forceClockOut(\'' + rec.id + '\',\'' + escQ(rec.w ? rec.w.name : 'Worker') + '\')">' + (missed ? 'Set clock-out' : 'Force Out') + '</button>' : '') +
        '</div></div>';
    }).join('') + '</div>';
  } catch (e) { el.innerHTML = '<div class="empty">Error: ' + e.message + '</div>'; }
}
async function downloadCSV() {
  var from = document.getElementById('att-from').value;
  var to   = document.getElementById('att-to').value;
  if (!from || !to) { showMsg('csv-msg', 'Select a date range first.', 'err'); return; }
  var cid = requireAdminCid(); if (!cid) return;
  showMsg('csv-msg', '⏳ Preparing CSV…', 'ok');
  var start = new Date(from); start.setHours(0, 0, 0, 0);
  var end   = new Date(to);   end.setHours(23, 59, 59, 999);
  try {
    var cWks = await withTimeout(db.from('workers').select('id').eq('company_id', cid), 5000);
    var wkr     = document.getElementById('att-worker').value;
    var mth     = document.getElementById('att-method').value;
    var allowed = wkr ? [wkr] : (cWks.data || []).map(function(w) { return w.id; });
    var q = db.from('attendance').select('*, w:workers(name,employee_id,job_title)')
      .in('worker_id', allowed).gte('clock_in_time', start.toISOString()).lte('clock_in_time', end.toISOString()).order('clock_in_time');
    if (mth) q = q.eq('auth_method', mth);
    var r = await withTimeout(q, 10000);
    if (!r.data || !r.data.length) { showMsg('csv-msg', 'No records found.', 'err'); return; }
    await loadShift(cid);
    var hdr  = ['Worker Name', 'Employee ID', 'Job Title', 'Date', 'Clock In', 'Clock Out', 'Hours', 'Late (min)', 'Overtime (h)', 'Auth Method', 'Device', 'Status'];
    var rows = r.data.map(function(rec) {
      var cin  = rec.clock_in_time  ? new Date(rec.clock_in_time)  : null;
      var cout = rec.clock_out_time ? new Date(rec.clock_out_time) : null;
      var hrs  = (cin && cout) ? ((cout - cin) / 3600000).toFixed(2) : '';
      var sc   = shiftCalc(rec);
      return [
        rec.w ? rec.w.name : '', rec.w ? rec.w.employee_id : '', rec.w ? rec.w.job_title || '' : '',
        cin  ? fmtDate(rec.clock_in_time) : '',
        cin  ? fmtTime(rec.clock_in_time) : '',
        cout ? fmtTime(rec.clock_out_time) : 'Still In',
        hrs ? hrs + 'h' : '',
        sc.late ? String(sc.lateMin) : '',
        sc.ot >= 0.05 ? (Math.round(sc.ot * 100) / 100).toFixed(2) : '',
        rec.auth_method || '', rec.device_label || '', rec.status || ''
      ].map(function(v) { return '"' + String(v).replace(/"/g, '""') + '"'; }).join(',');
    });
    var csv  = '﻿' + [hdr.join(',')].concat(rows).join('\r\n');
    var blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    var url  = URL.createObjectURL(blob);
    var a    = document.createElement('a');
    a.href = url; a.download = 'attendance_' + from + '_to_' + to + '.csv';
    document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
    showMsg('csv-msg', '✅ Downloaded ' + r.data.length + ' records', 'ok');
  } catch (e) { showMsg('csv-msg', 'Export failed: ' + e.message, 'err'); }
}
// Per-worker hours/OT/late summary → printable (Save as PDF from the print dialog)
function printAttSummary() {
  if (!_attData || !_attData.rows.length) { showMsg('csv-msg', 'Run a report first, then print.', 'err'); return; }
  var byW = {};
  _attData.rows.forEach(function(rec) {
    var key = (rec.w && rec.w.employee_id) || rec.worker_id;
    if (!byW[key]) byW[key] = { name: rec.w ? rec.w.name : 'Unknown', emp: rec.w ? rec.w.employee_id : '', job: (rec.w && rec.w.job_title) || '', days: 0, hours: 0, ot: 0, late: 0 };
    var sc = shiftCalc(rec), w = byW[key];
    w.days += 1;
    w.hours += (rec.clock_in_time && rec.clock_out_time) ? (new Date(rec.clock_out_time) - new Date(rec.clock_in_time)) / 3600000 : 0;
    w.ot += sc.ot; if (sc.late) w.late += 1;
  });
  var list = Object.keys(byW).map(function(k) { return byW[k]; }).sort(function(a, b) { return a.name.localeCompare(b.name); });
  var tH = 0, tO = 0, tL = 0, tD = 0;
  list.forEach(function(w) { tH += w.hours; tO += w.ot; tL += w.late; tD += w.days; });
  var sh = curShift();
  var body = list.map(function(w) {
    return '<tr><td>' + esc(w.name) + '</td><td>' + esc(w.emp || '') + '</td><td>' + esc(w.job || '') + '</td>' +
      '<td class="c">' + w.days + '</td><td class="r">' + w.hours.toFixed(1) + '</td><td class="r">' + w.ot.toFixed(1) + '</td><td class="c">' + w.late + '</td></tr>';
  }).join('');
  document.getElementById('print-area').innerHTML =
    '<div class="pr-head"><h1>' + esc((S.admin && S.admin.co_name) || 'WorkClock') + '</h1>' +
    '<div class="pr-title">Attendance Summary</div>' +
    '<div class="pr-sub">' + esc(_attData.from) + ' to ' + esc(_attData.to) + ' &middot; Shift ' + sh.shift_start + '–' + sh.shift_end + ' &middot; OT: ' + sh.shift_ot_mode.replace('_', ' ') + '</div></div>' +
    '<table class="pr-table"><thead><tr><th>Worker</th><th>Emp ID</th><th>Job</th><th class="c">Days</th><th class="r">Hours</th><th class="r">OT (h)</th><th class="c">Late</th></tr></thead>' +
    '<tbody>' + body + '</tbody>' +
    '<tfoot><tr><td colspan="3">Total — ' + list.length + ' workers</td><td class="c">' + tD + '</td><td class="r">' + tH.toFixed(1) + '</td><td class="r">' + tO.toFixed(1) + '</td><td class="c">' + tL + '</td></tr></tfoot></table>' +
    '<div class="pr-foot">Generated ' + new Date().toLocaleString('en-ZA', { timeZone: _tz() }) + ' · WorkClock by Reatlegile Solutions</div>';
  window.print();
}

// ── Company Admins ────────────────────────────────────────
async function loadCoAdmins() {
  var el = document.getElementById('co-admins-list');
  el.innerHTML = '<div class="empty">Loading…</div>';
  var cid = requireAdminCid(); if (!cid) return;
  try {
    var r = await withTimeout(
      db.from('admin_users').select(ADMIN_COLS).eq('company_id', cid).neq('role', 'developer').order('full_name'),
      5000
    );
    if (r.error || !r.data) { el.innerHTML = '<div class="empty">Failed to load</div>'; return; }
    if (!r.data.length) { el.innerHTML = '<div class="empty">No admins yet — create one above</div>'; return; }
    el.innerHTML = '<div class="card" style="padding:0 18px">' + r.data.map(function(a) {
      var col = ROLE_COLORS[a.role] || 'var(--blue)';
      return '<div class="list-row">' +
        '<div class="row-info"><div class="av av-sm" style="background:' + col + '">' + initialsesc(a.full_name || a.username) + '</div>' +
        '<div><div class="row-name">' + esc(a.full_name || a.username) + ' <small style="color:var(--muted)">@' + esc(a.username) + '</small></div>' +
        '<div class="row-meta"><span class="role-pill" style="background:' + col + '22;color:' + col + '">' +
          (ROLE_LABELS[a.role] || a.role) + '</span>' +
          (a.email ? ' · ' + esc(a.email) : '') + (!a.is_active ? ' · <em>Inactive</em>' : '') +
        '</div></div></div>' +
        '<div class="row-btns">' +
        '<button class="icon-btn" onclick="openEditAcct(\'' + a.id + '\',\'' + escQ(a.full_name || '') + '\',\'' + escQ(a.email || '') + '\',\'' + a.role + '\',\'sa\')">' + icon('pencil', 18) + '</button>' +
        '<button class="icon-btn" onclick="resetPw(\'' + a.id + '\',\'' + escQ(a.username) + '\')">' + icon('key', 18) + '</button>' +
        '<button class="icon-btn" onclick="toggleAdmin(\'' + a.id + '\',' + a.is_active + ')">' + (a.is_active ? icon('ban', 18) : icon('check', 18)) + '</button>' +
        '</div></div>';
    }).join('') + '</div>';
  } catch (e) { el.innerHTML = '<div class="empty">Error: ' + e.message + '</div>'; }
}
function toggleAddAdmin() {
  var p = document.getElementById('add-admin-panel'); p.classList.toggle('hidden');
  if (!p.classList.contains('hidden')) document.getElementById('ca-name').focus();
}
async function addAdmin() {
  var name  = (document.getElementById('ca-name').value  || '').trim();
  var user  = (document.getElementById('ca-user').value  || '').trim().toLowerCase();
  var pass  = (document.getElementById('ca-pass').value  || '').trim();
  var email = (document.getElementById('ca-email').value || '').trim();
  var role  = document.getElementById('ca-role').value || 'admin';
  if (!name || !user || !pass) { showMsg('ca-msg', 'Name, username and password required.', 'err'); return; }
  if (pass.length < 6) { showMsg('ca-msg', 'Password must be at least 6 characters.', 'err'); return; }
  if (!/^[a-z0-9_]+$/.test(user)) { showMsg('ca-msg', 'Username: letters, numbers and underscores only.', 'err'); return; }
  var cid = requireAdminCid(); if (!cid) return;
  try {
    var r = await withTimeout(db.rpc('admin_manage_create', {
      p_actor_id: aId(), p_token: aTok(), p_company_id: cid,
      p_username: user, p_pw_hash: await sha256(pass), p_full_name: name, p_email: email || null, p_role: role
    }), 5000);
    if (r.error) { showMsg('ca-msg', 'Error: ' + r.error.message, 'err'); return; }
    if (r.data === 'dupe') { showMsg('ca-msg', 'Username already exists.', 'err'); return; }
    if (!rpcOk(r.data, 'ca-msg')) return;
    showMsg('ca-msg', '✅ ' + (ROLE_LABELS[role] || role) + ' "@' + user + '" created!', 'ok');
    ['ca-name', 'ca-user', 'ca-pass', 'ca-email'].forEach(function(id) { document.getElementById(id).value = ''; });
    setTimeout(function() { toggleAddAdmin(); loadCoAdmins(); }, 1400);
  } catch (e) { showMsg('ca-msg', 'Error: ' + e.message, 'err'); }
}
async function toggleAdmin(id, cur) {
  var r = await withTimeout(db.rpc('admin_manage_toggle', { p_actor_id: aId(), p_token: aTok(), p_target_id: id, p_active: !cur }), 5000);
  if (!r.error && rpcOk(r.data)) { toast(cur ? 'Admin deactivated' : 'Admin reactivated'); loadCoAdmins(); }
}

async function loadAdminInactive() {
  var el  = document.getElementById('admin-inactive-list');
  var cid = requireAdminCid(); if (!cid) return;
  el.innerHTML = '<div class="empty">Loading…</div>';
  try {
    var isSA = S.admin && S.admin.role === 'super_admin';
    var queries = [
      withTimeout(db.from('workers').select(WORKER_COLS).eq('company_id', cid).eq('is_active', false).order('name'), 5000)
    ];
    if (isSA) queries.push(withTimeout(db.from('admin_users').select(ADMIN_COLS).eq('company_id', cid).neq('role', 'developer').eq('is_active', false).order('full_name'), 5000));
    var results = await Promise.all(queries);
    var wks  = results[0].data || [];
    var accs = isSA ? (results[1].data || []) : [];

    if (!wks.length && !accs.length) {
      el.innerHTML =
        '<div class="card" style="text-align:center;padding:36px 18px">' +
          '<div style="font-size:2.5rem;margin-bottom:10px">✅</div>' +
          '<div style="font-weight:700;font-size:1rem;margin-bottom:4px">All Clear</div>' +
          '<div class="sub">No inactive records — everyone is currently active.</div>' +
        '</div>';
      return;
    }

    var html = '';

    // ── Summary card ──────────────────────────────────────
    html += '<div class="card" style="margin-bottom:16px">' +
      '<div class="sec-lbl" style="margin-bottom:12px">📊 Summary</div>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px">' +
        '<div style="background:#FEF2F2;border-radius:10px;padding:12px;text-align:center">' +
          '<div style="font-size:1.6rem;font-weight:800;color:#DC2626">' + wks.length + '</div>' +
          '<div style="font-size:.75rem;color:#991B1B;font-weight:600">Inactive Workers</div>' +
        '</div>' +
        (isSA ?
          '<div style="background:#FEF2F2;border-radius:10px;padding:12px;text-align:center">' +
            '<div style="font-size:1.6rem;font-weight:800;color:#DC2626">' + accs.length + '</div>' +
            '<div style="font-size:.75rem;color:#991B1B;font-weight:600">Inactive Accounts</div>' +
          '</div>' :
          '<div style="background:#F1F5F9;border-radius:10px;padding:12px;text-align:center">' +
            '<div style="font-size:1.6rem;font-weight:800;color:#94A3B8">' + (wks.length + accs.length) + '</div>' +
            '<div style="font-size:.75rem;color:#64748B;font-weight:600">Total Inactive</div>' +
          '</div>'
        ) +
      '</div>' +
      (wks.length ?
        '<button class="btn btn-outline btn-full" onclick="exportInactiveWorkers()">📥 Export Inactive Workers (CSV)</button>' :
        '') +
    '</div>';

    // ── Inactive Workers ──────────────────────────────────
    html += '<div class="list-group-hd list-group-hd-inactive" style="margin-top:0">👷 Inactive Workers (' + wks.length + ')</div>';
    if (wks.length) {
      wks.forEach(function(w) { _wCache[w.id] = Object.assign({}, w, { _ctx: 'admin-inactive' }); });
      html += '<div class="card" style="padding:0 18px;margin-bottom:16px">' + wks.map(function(w) {
        var badges = (w.biometric_enabled ? ' ' + icon('fingerprint', 13) : '') + (w.face_descriptor ? ' ' + icon('camera', 13) : '') + (w.device_id ? ' ' + icon('device', 13) : '');
        return '<div class="list-row">' +
          '<div class="row-info">' +
            '<div class="av av-sm" style="background:#94A3B8;opacity:.8">' + initials(w.name) + '</div>' +
            '<div style="min-width:0">' +
              '<div class="row-name" style="color:#64748B">' + esc(w.name) + '</div>' +
              '<div class="row-meta">' + esc(w.employee_id) + (w.job_title ? ' · ' + esc(w.job_title) : '') + badges + '</div>' +
            '</div>' +
          '</div>' +
          '<div class="row-btns">' +
            '<button class="icon-btn" title="Edit" onclick="openEditWorker(\'' + w.id + '\')">' + icon('pencil', 18) + '</button>' +
            '<button class="restore-btn" onclick="adminRestoreWorker(\'' + w.id + '\')">' + icon('check', 15) + ' Restore</button>' +
          '</div>' +
        '</div>';
      }).join('') + '</div>';
    } else {
      html += '<div class="card" style="margin-bottom:16px"><div class="empty" style="padding:12px 0">No inactive workers</div></div>';
    }

    // ── Inactive Accounts (super_admin only) ──────────────
    if (isSA) {
      html += '<div class="list-group-hd list-group-hd-inactive">👤 Inactive Admin Accounts (' + accs.length + ')</div>';
      if (accs.length) {
        html += '<div class="card" style="padding:0 18px;margin-bottom:16px">' + accs.map(function(a) {
          var col = ROLE_COLORS[a.role] || 'var(--blue)';
          return '<div class="list-row">' +
            '<div class="row-info">' +
              '<div class="av av-sm" style="background:#94A3B8;opacity:.8">' + initialsesc(a.full_name || a.username) + '</div>' +
              '<div style="min-width:0">' +
                '<div class="row-name" style="color:#64748B">' + esc(a.full_name || a.username) + ' <small>@' + esc(a.username) + '</small></div>' +
                '<div class="row-meta"><span class="role-pill" style="background:' + col + '22;color:' + col + '">' + (ROLE_LABELS[a.role] || a.role) + '</span>' + (a.email ? ' · ' + esc(a.email) : '') + '</div>' +
              '</div>' +
            '</div>' +
            '<div class="row-btns">' +
              '<button class="icon-btn" onclick="openEditAcct(\'' + a.id + '\',\'' + escQ(a.full_name || '') + '\',\'' + escQ(a.email || '') + '\',\'' + a.role + '\',\'admin-inactive\')">' + icon('pencil', 18) + '</button>' +
              '<button class="restore-btn" onclick="adminRestoreAccount(\'' + a.id + '\')">' + icon('check', 15) + ' Restore</button>' +
            '</div>' +
          '</div>';
        }).join('') + '</div>';
      } else {
        html += '<div class="card" style="margin-bottom:16px"><div class="empty" style="padding:12px 0">No inactive admin accounts</div></div>';
      }
    }

    el.innerHTML = html;
  } catch (e) { el.innerHTML = '<div class="empty">Error: ' + e.message + '</div>'; }
}

async function exportInactiveWorkers() {
  var cid = requireAdminCid(); if (!cid) return;
  try {
    var r = await withTimeout(db.from('workers').select(WORKER_COLS).eq('company_id', cid).eq('is_active', false).order('name'), 5000);
    if (!r.data || !r.data.length) { toast('No inactive workers to export.'); return; }
    var hdr = ['Name', 'Employee ID', 'Job Title', 'Biometric', 'Face Recognition', 'Device Bound'];
    var rows = r.data.map(function(w) {
      return [
        w.name, w.employee_id, w.job_title || '',
        w.biometric_enabled ? 'Yes' : 'No',
        w.face_descriptor   ? 'Yes' : 'No',
        w.device_id         ? 'Yes' : 'No'
      ].map(function(v) { return '"' + String(v).replace(/"/g, '""') + '"'; }).join(',');
    });
    var csv  = '﻿' + [hdr.join(',')].concat(rows).join('\r\n');
    var blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    var url  = URL.createObjectURL(blob);
    var a    = document.createElement('a'); a.href = url; a.download = 'inactive_workers.csv';
    document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
    toast('✅ Exported ' + r.data.length + ' inactive workers');
  } catch (e) { toast('Export failed: ' + e.message); }
}

async function adminRestoreWorker(id) {
  var r = await withTimeout(db.rpc('admin_worker_toggle', { p_actor_id: aId(), p_token: aTok(), p_id: id, p_active: true }), 5000);
  if (!r.error && rpcOk(r.data)) { toast('Worker restored'); loadAdminInactive(); }
}
async function adminRestoreAccount(id) {
  var r = await withTimeout(db.rpc('admin_manage_toggle', { p_actor_id: aId(), p_token: aTok(), p_target_id: id, p_active: true }), 5000);
  if (!r.error && rpcOk(r.data)) { toast('Account restored'); loadAdminInactive(); }
}

async function resetPw(id, username) {
  var pw = prompt('Set new password for @' + username + ':');
  if (!pw) return;
  if (pw.length < 6) { toast('Password must be at least 6 characters.'); return; }
  var r = await withTimeout(db.rpc('admin_manage_set_password', { p_actor_id: aId(), p_token: aTok(), p_target_id: id, p_new_hash: await sha256(pw) }), 5000);
  if (r.error) { toast('Error: ' + r.error.message); return; }
  if (rpcOk(r.data)) toast('✅ Password updated for @' + username);
}

// ── Setup ─────────────────────────────────────────────────
async function loadSetup() {
  var cid = requireAdminCid(); if (!cid) return;
  try {
    var wpR = await withTimeout(db.from('workplaces').select('*').eq('company_id', cid).limit(1), 5000);
    if (wpR.data && wpR.data[0]) {
      var w = wpR.data[0];
      document.getElementById('wp-name').value   = w.name      || '';
      document.getElementById('wp-addr').value   = w.address   || '';
      document.getElementById('wp-lat').value    = w.latitude  || '';
      document.getElementById('wp-lng').value    = w.longitude || '';
      document.getElementById('wp-radius').value = w.radius_meters || 100;
    }
  } catch (e) {}

  // Worker Portal Link — single unified link: index.html?c=CODE
  var code = S.admin.co && S.admin.co.code;
  var base = window.location.origin + window.location.pathname.replace(/[^/]*$/, '');
  var portalEl = document.getElementById('portal-link');
  if (portalEl) portalEl.textContent = code ? (base + 'index.html?c=' + code) : 'Company code not found.';

  document.getElementById('my-name').value  = S.admin.full_name || '';
  document.getElementById('my-email').value = S.admin.email     || '';

  // Load current timezone
  try {
    var tzR = await withTimeout(db.from('companies').select('timezone').eq('id', cid).single(), 5000);
    var coTz = (tzR.data && tzR.data.timezone) || 'Africa/Johannesburg';
    var tzSel = document.getElementById('co-timezone');
    if (tzSel) tzSel.value = coTz;
  } catch(e) {}

  // ── Work shift settings ────────────────────────────────
  S.shift = null; await loadShift(cid);
  var sh = curShift();
  if (document.getElementById('sh-start'))  document.getElementById('sh-start').value  = sh.shift_start;
  if (document.getElementById('sh-end'))    document.getElementById('sh-end').value    = sh.shift_end;
  if (document.getElementById('sh-grace'))  document.getElementById('sh-grace').value  = sh.shift_grace_min;
  if (document.getElementById('sh-otmode')) document.getElementById('sh-otmode').value = sh.shift_ot_mode;
  document.querySelectorAll('#sh-days .day-chip').forEach(function(c) {
    var d = parseInt(c.getAttribute('data-day'));
    c.classList.toggle('on', (sh.work_days || []).indexOf(d) !== -1);
    c.onclick = function() { c.classList.toggle('on'); };
  });

  // ── Worker usage display ───────────────────────────────
  try {
    var coR2    = await withTimeout(db.from('companies').select('worker_limit').eq('id', cid).single(), 5000);
    var cntR    = await withTimeout(
      db.from('workers').select('*', { count: 'exact', head: true }).eq('company_id', cid).eq('is_active', true),
      5000
    );
    var used    = cntR.count || 0;
    var limit   = (coR2.data && coR2.data.worker_limit !== null) ? coR2.data.worker_limit : null;
    var usageEl = document.getElementById('worker-usage-bar');
    var usageTx = document.getElementById('worker-usage-text');
    var upgEl   = document.getElementById('worker-upgrade-msg');
    if (usageTx) {
      usageTx.textContent = limit !== null
        ? (used + ' / ' + limit + ' workers used')
        : (used + ' workers  (unlimited)');
    }
    if (usageEl && limit !== null) {
      var pct = Math.min(100, Math.round((used / limit) * 100));
      usageEl.style.width = pct + '%';
      usageEl.style.background = pct >= 100 ? 'var(--red)' : pct >= 80 ? '#F59E0B' : 'var(--green)';
    }
    if (upgEl) upgEl.classList.toggle('hidden', limit === null || used < limit);
  } catch (e) {}

  // ── Subscription expiry display ────────────────────────
  try {
    var subR = await withTimeout(db.from('companies').select('subscription_expires_at').eq('id', cid).single(), 5000);
    var expAt = subR.data && subR.data.subscription_expires_at ? new Date(subR.data.subscription_expires_at) : null;
    var subEl = document.getElementById('sub-expiry-row');
    if (subEl) {
      if (!expAt) {
        subEl.innerHTML = '<span style="color:#94A3B8">No expiry date set</span>';
      } else if (expAt < new Date()) {
        var daysAgo = Math.ceil((new Date() - expAt) / 86400000);
        subEl.innerHTML = '<span style="color:var(--red);font-weight:700">⚠️ Expired ' + daysAgo + ' day' + (daysAgo === 1 ? '' : 's') + ' ago (' + expAt.toLocaleDateString('en-ZA', {day:'numeric',month:'long',year:'numeric'}) + ')</span>';
      } else {
        var daysLeft = Math.ceil((expAt - new Date()) / 86400000);
        var col = daysLeft <= 7 ? '#F59E0B' : 'var(--green)';
        subEl.innerHTML = '<span style="color:' + col + ';font-weight:700">✅ Paid until ' + expAt.toLocaleDateString('en-ZA', {day:'numeric',month:'long',year:'numeric'}) + (daysLeft <= 14 ? ' <span style="font-weight:400;font-size:.82em">(' + daysLeft + ' days left)</span>' : '') + '</span>';
      }
    }
  } catch (e) {}
  // ──────────────────────────────────────────────────────
}
async function saveWorkplace() {
  var name   = (document.getElementById('wp-name').value || '').trim();
  var addr   = (document.getElementById('wp-addr').value || '').trim();
  var lat    = parseFloat(document.getElementById('wp-lat').value);
  var lng    = parseFloat(document.getElementById('wp-lng').value);
  var radius = parseInt(document.getElementById('wp-radius').value) || 100;
  if (!name || isNaN(lat) || isNaN(lng)) { showMsg('wp-msg', 'Name, Latitude and Longitude are required.', 'err'); return; }
  var cid = requireAdminCid(); if (!cid) return;
  try {
    var exR  = await withTimeout(db.from('workplaces').select('id').eq('company_id', cid).limit(1), 5000);
    var wpId = (exR.data && exR.data.length) ? exR.data[0].id : null;
    // RPC upserts the workplace and backfills unassigned workers' workplace_id.
    var r = await withTimeout(db.rpc('admin_workplace_save', {
      p_actor_id: aId(), p_token: aTok(), p_company_id: cid, p_id: wpId,
      p_name: name, p_address: addr, p_lat: lat, p_lng: lng, p_radius: radius
    }), 5000);
    if (r.error) { showMsg('wp-msg', 'Save failed: ' + r.error.message, 'err'); return; }
    if (!rpcOk(r.data, 'wp-msg')) return;
    showMsg('wp-msg', '✅ Workplace saved!', 'ok');
  } catch (e) { showMsg('wp-msg', 'Error: ' + e.message, 'err'); }
}
async function saveTimezone() {
  var cid = requireAdminCid(); if (!cid) return;
  var tzSel = document.getElementById('co-timezone');
  var tz = tzSel ? tzSel.value : '';
  if (!tz) { showMsg('tz-msg', 'Please select a timezone.', 'err'); return; }
  try {
    var r = await withTimeout(db.rpc('admin_set_timezone', { p_actor_id: aId(), p_token: aTok(), p_timezone: tz }), 5000);
    if (r.error) { showMsg('tz-msg', 'Save failed: ' + r.error.message, 'err'); return; }
    if (!rpcOk(r.data, 'tz-msg')) return;
    if (S.admin) { S.admin.co_timezone = tz; localStorage.setItem('wc_admin_session', JSON.stringify(S.admin)); }
    showMsg('tz-msg', '✅ Timezone saved — times now display in ' + tz, 'ok');
  } catch(e) { showMsg('tz-msg', 'Error: ' + e.message, 'err'); }
}
async function saveShift() {
  var cid = requireAdminCid(); if (!cid) return;
  var start = document.getElementById('sh-start').value || '08:00';
  var end   = document.getElementById('sh-end').value   || '17:00';
  var grace = parseInt(document.getElementById('sh-grace').value); if (isNaN(grace) || grace < 0) grace = 10;
  var mode  = document.getElementById('sh-otmode').value || 'after_end';
  var days  = [];
  document.querySelectorAll('#sh-days .day-chip.on').forEach(function(c) { days.push(parseInt(c.getAttribute('data-day'))); });
  if (!days.length) { showMsg('sh-msg', 'Select at least one working day.', 'err'); return; }
  try {
    var r = await withTimeout(db.rpc('admin_set_shift', {
      p_actor_id: aId(), p_token: aTok(), p_start: start, p_end: end, p_grace: grace, p_ot_mode: mode, p_work_days: days
    }), 5000);
    if (r.error) { showMsg('sh-msg', 'Save failed: ' + r.error.message, 'err'); return; }
    if (!rpcOk(r.data, 'sh-msg')) return;
    S.shift = { _cid: cid, shift_start: start, shift_end: end, shift_grace_min: grace, shift_ot_mode: mode, work_days: days };
    showMsg('sh-msg', '✅ Shift settings saved!', 'ok');
  } catch(e) { showMsg('sh-msg', 'Error: ' + e.message, 'err'); }
}
function detectLocation() {
  if (!navigator.geolocation) { toast('Geolocation not available'); return; }
  toast('📍 Getting your location…');
  navigator.geolocation.getCurrentPosition(function(pos) {
    var lat = pos.coords.latitude.toFixed(7);
    var lng = pos.coords.longitude.toFixed(7);
    document.getElementById('wp-lat').value = lat;
    document.getElementById('wp-lng').value = lng;
    toast('📍 Location captured (±' + Math.round(pos.coords.accuracy) + 'm)');
    fetch('https://nominatim.openstreetmap.org/reverse?format=json&lat=' + lat + '&lon=' + lng, { headers: { 'Accept-Language': 'en' } })
      .then(function(res) { return res.json(); })
      .then(function(geo) { if (geo && geo.display_name) document.getElementById('wp-addr').value = geo.display_name; })
      .catch(function() {});
  }, function() { toast('Could not get location — enter coordinates manually.'); });
}
function copyPortalLink() {
  var code = S.admin.co && S.admin.co.code;
  if (!code) { showMsg('link-msg', 'Company code not found.', 'err'); return; }
  var base = window.location.origin + window.location.pathname.replace(/[^/]*$/, '');
  var link = base + 'index.html?c=' + code;
  navigator.clipboard.writeText(link)
    .then(function() { showMsg('link-msg', '✅ Worker Portal link copied!', 'ok'); })
    .catch(function() {
      var el = document.getElementById('portal-link');
      if (el) el.textContent = link;
      showMsg('link-msg', 'Copy the link above manually.', 'ok');
    });
}
async function saveProfile() {
  var name  = (document.getElementById('my-name').value  || '').trim();
  var email = (document.getElementById('my-email').value || '').trim();
  if (!name) { showMsg('profile-msg', 'Full name is required.', 'err'); return; }
  var r = await withTimeout(db.rpc('admin_self_update', { p_id: aId(), p_token: aTok(), p_full_name: name, p_email: email || null }), 5000);
  if (r.error) { showMsg('profile-msg', 'Failed: ' + r.error.message, 'err'); return; }
  if (!rpcOk(r.data, 'profile-msg')) return;
  S.admin.full_name = name; S.admin.email = email;
  localStorage.setItem('wc_admin_session', JSON.stringify(S.admin));
  showMsg('profile-msg', '✅ Profile updated!', 'ok');
}
async function changeAdminPw() {
  var pw = document.getElementById('new-pw').value;
  if (!pw || pw.length < 6) { showMsg('pw-msg', 'Password must be at least 6 characters.', 'err'); return; }
  var r = await withTimeout(db.rpc('admin_self_set_password', { p_id: aId(), p_token: aTok(), p_new_hash: await sha256(pw) }), 5000);
  if (r.error || !rpcOk(r.data, 'pw-msg')) { if (r.error) showMsg('pw-msg', 'Failed: ' + r.error.message, 'err'); return; }
  showMsg('pw-msg', '✅ Password updated!', 'ok'); document.getElementById('new-pw').value = '';
}

// ── Edit Worker Modal ─────────────────────────────────────
function openEditWorker(id) {
  var w = _wCache[id]; if (!w) { toast('Worker data not loaded — refresh the list.'); return; }
  document.getElementById('ewk-id').value    = id;
  document.getElementById('ewk-ctx').value   = w._ctx || 'admin';
  document.getElementById('ewk-empid').value = w.employee_id || '';
  document.getElementById('ewk-name').value  = w.name || '';
  document.getElementById('ewk-job').value   = w.job_title || '';
  document.getElementById('ewk-pin').value   = '';
  document.getElementById('ewk-msg').classList.add('hidden');
  document.getElementById('modal-edit-worker').classList.remove('hidden');
}
async function saveEditWorker() {
  var id    = document.getElementById('ewk-id').value;
  var ctx   = document.getElementById('ewk-ctx').value;
  var empId = (document.getElementById('ewk-empid').value || '').trim().toUpperCase();
  var name  = (document.getElementById('ewk-name').value  || '').trim();
  var job   = (document.getElementById('ewk-job').value   || '').trim();
  var pin   = (document.getElementById('ewk-pin').value   || '').trim();
  if (!empId || !name) { showMsg('ewk-msg', 'Employee ID and Name required.', 'err'); return; }
  if (pin && pin.length < 4) { showMsg('ewk-msg', 'PIN must be at least 4 digits.', 'err'); return; }
  var pinHash = pin ? await sha256(pin) : null;
  var btn = document.getElementById('edit-worker-save-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  try {
    var r = await withTimeout(db.rpc('admin_worker_update', {
      p_actor_id: aId(), p_token: aTok(), p_id: id,
      p_employee_id: empId, p_name: name, p_job_title: job || null, p_pin_hash: pinHash
    }), 5000);
    if (r.error) { showMsg('ewk-msg', 'Error: ' + r.error.message, 'err'); return; }
    if (r.data === 'dupe') { showMsg('ewk-msg', 'Employee ID already in use.', 'err'); return; }
    if (!rpcOk(r.data, 'ewk-msg')) return;
    showMsg('ewk-msg', '✅ Worker updated!', 'ok');
    setTimeout(function() {
      closeModal('modal-edit-worker');
      if (ctx === 'dev') loadDevWorkers();
      else if (ctx === 'admin-inactive') loadAdminInactive();
      else loadWorkers();
    }, 1200);
  } catch (e) { showMsg('ewk-msg', 'Error: ' + e.message, 'err'); }
  finally { if (btn) { btn.disabled = false; btn.textContent = 'Save'; } }
}

// ── Edit Account Modal ────────────────────────────────────
function openEditAcct(id, name, email, role, ctx) {
  document.getElementById('eac-id').value    = id;
  document.getElementById('eac-ctx').value   = ctx;
  document.getElementById('eac-name').value  = name;
  document.getElementById('eac-email').value = email;
  document.getElementById('eac-pw').value    = '';
  document.getElementById('eac-msg').classList.add('hidden');
  var wrap = document.getElementById('eac-role-wrap');
  if (ctx === 'dev' || ctx === 'sa') { wrap.classList.remove('hidden'); document.getElementById('eac-role').value = role; }
  else wrap.classList.add('hidden');
  document.getElementById('modal-edit-acct').classList.remove('hidden');
}
async function saveEditAcct() {
  var id    = document.getElementById('eac-id').value;
  var ctx   = document.getElementById('eac-ctx').value;
  var name  = (document.getElementById('eac-name').value  || '').trim();
  var email = (document.getElementById('eac-email').value || '').trim();
  var pw    = (document.getElementById('eac-pw').value    || '').trim();
  if (!name) { showMsg('eac-msg', 'Full name required.', 'err'); return; }
  if (pw && pw.length < 6) { showMsg('eac-msg', 'Password must be at least 6 characters.', 'err'); return; }
  var wrap = document.getElementById('eac-role-wrap');
  var role = !wrap.classList.contains('hidden') ? document.getElementById('eac-role').value : null;
  try {
    var r = await withTimeout(db.rpc('admin_manage_update', {
      p_actor_id: aId(), p_token: aTok(), p_target_id: id, p_full_name: name, p_email: email || null, p_role: role
    }), 5000);
    if (r.error) { showMsg('eac-msg', 'Failed: ' + r.error.message, 'err'); return; }
    if (!rpcOk(r.data, 'eac-msg')) return;
    if (pw) {
      var pr = await withTimeout(db.rpc('admin_manage_set_password', { p_actor_id: aId(), p_token: aTok(), p_target_id: id, p_new_hash: await sha256(pw) }), 5000);
      if (pr.error || !rpcOk(pr.data, 'eac-msg')) { if (pr.error) showMsg('eac-msg', 'Failed: ' + pr.error.message, 'err'); return; }
    }
    showMsg('eac-msg', '✅ Account updated!', 'ok');
    setTimeout(function() {
      closeModal('modal-edit-acct');
      if (ctx === 'dev') loadDevAccounts();
      else if (ctx === 'admin-inactive') loadAdminInactive();
      else loadCoAdmins();
    }, 1200);
  } catch (e) { showMsg('eac-msg', 'Error: ' + e.message, 'err'); }
}

// ── Developer Panel ───────────────────────────────────────
function devLogout() {
  try { if (aId() && aTok()) db.rpc('admin_logout', { p_id: aId(), p_token: aTok() }); } catch (e) {}
  S.admin = null; localStorage.removeItem('wc_admin_session'); localStorage.removeItem('wc_dash_cache'); showPg('home');
}
// ── Nav pin / customise system ────────────────────────────
var NAV_TABS = [
  { id: 'a-dash',     icon: 'dashboard', label: 'Dashboard',  saOnly: false },
  { id: 'a-workers',  icon: 'users',     label: 'Workers',    saOnly: false },
  { id: 'a-att',      icon: 'clipboard', label: 'Attendance', saOnly: false },
  { id: 'a-absent',   icon: 'userx',     label: 'Absent',     saOnly: false },
  { id: 'a-admins',   icon: 'key',       label: 'Admins',     saOnly: true  },
  { id: 'a-inactive', icon: 'archive',   label: 'Inactive',   saOnly: false },
  { id: 'a-audit',    icon: 'history',   label: 'Activity',   saOnly: false },
  { id: 'a-setup',    icon: 'settings',  label: 'Setup',      saOnly: false },
];
var DEFAULT_PINS = ['a-dash', 'a-workers', 'a-att', 'a-absent'];
var MAX_PINS = 4;
var _pendingPins = null;

function getNavPins() {
  try { return JSON.parse(localStorage.getItem('wc_nav_pins')) || DEFAULT_PINS.slice(); }
  catch(e) { return DEFAULT_PINS.slice(); }
}

function applyNavPins(pins) {
  var isSA = S.admin && S.admin.role === 'super_admin';
  document.querySelectorAll('#admin-tabs .bnav-item[data-tab]').forEach(function(btn) {
    var tab = btn.getAttribute('data-tab');
    var def = NAV_TABS.find(function(t) { return t.id === tab; });
    // Admins tab: always hidden unless super_admin
    if (def && def.saOnly && !isSA) { btn.classList.add('hidden'); return; }
    if (def && def.saOnly && isSA) btn.classList.remove('hidden');
    // Show in bar (remove overflow) or hide behind More (add overflow)
    if (pins.indexOf(tab) !== -1) btn.classList.remove('bnav-overflow');
    else btn.classList.add('bnav-overflow');
  });
}

function openMoreSheet() {
  var pins = getNavPins();
  var isSA = S.admin && S.admin.role === 'super_admin';
  var html = '';
  NAV_TABS.forEach(function(t) {
    if (t.saOnly && !isSA) return;
    if (pins.indexOf(t.id) !== -1) return; // already in bar
    html += '<button class="more-sheet-item" onclick="switchTab(document.getElementById(\'admin-more-btn\'),\'' + t.id + '\');closeMoreSheet()">'
          + '<span class="more-item-icon">' + icon(t.icon, 20) + '</span><span>' + t.label + '</span></button>';
  });
  document.getElementById('more-sheet-items').innerHTML = html ||
    '<p class="sub" style="padding:8px 18px 4px">All tabs are pinned to the bar.</p>';
  document.getElementById('admin-more-sheet').classList.add('is-open');
  document.body.style.overflow = 'hidden';
}
function closeMoreSheet() {
  document.getElementById('admin-more-sheet').classList.remove('is-open');
  document.body.style.overflow = '';
}

function openNavCustomize() {
  var pins = getNavPins();
  var isSA = S.admin && S.admin.role === 'super_admin';
  _pendingPins = pins.slice();
  var html = '';
  NAV_TABS.forEach(function(t) {
    if (t.saOnly && !isSA) return;
    var pinned = _pendingPins.indexOf(t.id) !== -1;
    html += '<div class="nav-pin-row">'
          + '<span class="nav-pin-icon">' + icon(t.icon, 18) + '</span>'
          + '<span class="nav-pin-name">' + t.label + '</span>'
          + '<button class="nav-pin-btn' + (pinned ? ' pinned' : '') + '" data-tab="' + t.id + '" onclick="toggleNavPin(this)">'
          + (pinned ? '★ Pinned' : '☆ Add') + '</button>'
          + '</div>';
  });
  document.getElementById('nav-customize-list').innerHTML = html;
  document.getElementById('modal-nav-customize').classList.remove('hidden');
}
function closeNavCustomize() {
  _pendingPins = null;
  document.getElementById('modal-nav-customize').classList.add('hidden');
}
function toggleNavPin(btn) {
  var tab = btn.getAttribute('data-tab');
  var idx = _pendingPins.indexOf(tab);
  if (idx !== -1) {
    _pendingPins.splice(idx, 1);
    btn.classList.remove('pinned'); btn.textContent = '☆ Add';
  } else {
    if (_pendingPins.length >= MAX_PINS) {
      toast('Maximum ' + MAX_PINS + ' tabs in the bar — unpin one first');
      return;
    }
    _pendingPins.push(tab);
    btn.classList.add('pinned'); btn.textContent = '★ Pinned';
  }
  // Update pin count hint on all buttons
  document.querySelectorAll('.nav-pin-btn:not(.pinned)').forEach(function(b) {
    b.style.opacity = _pendingPins.length >= MAX_PINS ? '.4' : '1';
    b.style.pointerEvents = _pendingPins.length >= MAX_PINS ? 'none' : '';
  });
  document.querySelectorAll('.nav-pin-btn.pinned').forEach(function(b) {
    b.style.opacity = ''; b.style.pointerEvents = '';
  });
}
function saveNavCustomize() {
  if (_pendingPins.length === 0) { toast('Pin at least one tab'); return; }
  localStorage.setItem('wc_nav_pins', JSON.stringify(_pendingPins));
  applyNavPins(_pendingPins);
  closeNavCustomize();
  toast('Navigation updated');
}
function resetNavCustomize() {
  localStorage.removeItem('wc_nav_pins');
  applyNavPins(DEFAULT_PINS.slice());
  closeNavCustomize();
  toast('Navigation reset to default');
}
function switchDevTab(btn, name) {
  document.querySelectorAll('#dev-tabs .bnav-item').forEach(function(t) { t.classList.remove('active'); });
  btn.classList.add('active');
  document.querySelectorAll('#pg-developer .tab-pane').forEach(function(p) { p.classList.remove('active'); });
  document.getElementById(name).classList.add('active');
  if (name === 'd-cos')      loadDevCos();
  if (name === 'd-accounts') loadDevAccounts();
  if (name === 'd-workers')  loadDevWorkers();
  if (name === 'd-inactive') loadDevInactive();
  if (name === 'd-system')   loadDevSystem();
}
async function loadDevCos() {
  var el = document.getElementById('dev-cos-list');
  el.innerHTML = '<div class="empty">Loading…</div>';
  try {
    var r = await withTimeout(db.from('companies').select('*').order('name'), 5000);
    if (r.error || !r.data) { el.innerHTML = '<div class="empty">Failed to load</div>'; return; }
    if (!r.data.length) { el.innerHTML = '<div class="empty">No companies yet</div>'; return; }
    r.data.forEach(function(c) { _cCache[c.id] = c; });

    // Fetch active worker counts for all companies in one query
    var wcR = await withTimeout(
      db.from('workers').select('company_id', { count: 'exact' }).eq('is_active', true),
      5000
    );
    var workerCounts = {};
    if (wcR.data) wcR.data.forEach(function(w) {
      workerCounts[w.company_id] = (workerCounts[w.company_id] || 0) + 1;
    });

    var active   = r.data.filter(function(c) { return c.is_active; });
    var inactive = r.data.filter(function(c) { return !c.is_active; });

    function renderCoRow(c) {
      var used    = workerCounts[c.id] || 0;
      var lim     = c.worker_limit;
      var atLimit = lim !== null && used >= lim;
      var empTxt  = lim !== null ? (used + ' / ' + lim + ' employees') : (used + ' employees (unlimited)');
      var empClr  = atLimit ? 'color:var(--red);font-weight:700' : 'color:var(--muted)';
      var monthly = lim !== null ? fmtRand(calcWlCost(lim)) + '/mo' : '—';
      var monClr  = lim !== null ? 'color:var(--green);font-weight:700' : 'color:var(--muted)';
      var expAt   = c.subscription_expires_at ? new Date(c.subscription_expires_at) : null;
      var subHtml;
      if (!expAt) {
        subHtml = '<span style="color:#94A3B8;font-size:.78rem">No expiry set</span>';
      } else if (expAt < new Date()) {
        subHtml = '<span style="color:var(--red);font-size:.78rem;font-weight:700">🔴 EXPIRED ' + expAt.toLocaleDateString('en-ZA', {day:'numeric',month:'short',year:'numeric'}) + '</span>';
      } else {
        var dl  = Math.ceil((expAt - new Date()) / 86400000);
        var col = dl <= 7 ? '#F59E0B' : 'var(--green)';
        subHtml = '<span style="color:' + col + ';font-size:.78rem;font-weight:700">✅ Paid until ' + expAt.toLocaleDateString('en-ZA', {day:'numeric',month:'short',year:'numeric'}) + (dl <= 14 ? ' (' + dl + 'd left)' : '') + '</span>';
      }
      return '<div class="list-row">' +
        '<div class="row-info"><div class="av av-sm" style="background:var(--purple)">' + c.code.slice(0, 2) + '</div>' +
        '<div><div class="row-name">' + esc(c.name) + '</div>' +
        '<div class="row-meta">Code: ' + esc(c.code) +
          ' · <span style="' + empClr + '">' + empTxt + '</span>' +
          ' · <span style="' + monClr + '">' + monthly + '</span>' +
        '</div>' +
        '<div class="row-meta">' + subHtml + '</div>' +
        '</div></div>' +
        '<div class="row-btns">' +
        '<button class="icon-btn" title="Set Subscription Expiry" onclick="openSubExpiryModal(\'' + c.id + '\')">' + icon('calendar', 18) + '</button>' +
        '<button class="icon-btn" title="Set Employee Limit" onclick="openWorkerLimitModal(\'' + c.id + '\',' + used + ')">' + icon('users', 18) + '</button>' +
        '<button class="icon-btn" onclick="openEditCo(\'' + c.id + '\')">' + icon('pencil', 18) + '</button>' +
        '<button class="icon-btn" onclick="devToggleCo(\'' + c.id + '\',' + c.is_active + ')">' + (c.is_active ? icon('ban', 18) : icon('check', 18)) + '</button>' +
        '</div></div>';
    }

    // Total monthly revenue from active companies with limits set
    var totalMonthly = active.reduce(function(sum, c) {
      return sum + (c.worker_limit ? calcWlCost(c.worker_limit) : 0);
    }, 0);
    var billingNote = active.filter(function(c){ return !c.worker_limit; }).length > 0
      ? ' <span style="font-size:.75rem;color:#64748B">(excludes unlimited)</span>' : '';

    var html = '';
    html += '<div class="list-group-hd">✅ Active Companies (' + active.length + ')</div>';
    html += '<div class="card" style="padding:0 18px;margin-bottom:0;border-radius:0">';
    html += active.length ? active.map(renderCoRow).join('') : '<div class="empty" style="padding:12px 0">No active companies</div>';
    html += '</div>';
    html += '<div style="background:#F0FDF4;border:1px solid #BBF7D0;border-radius:0 0 var(--r) var(--r);padding:10px 18px;margin-bottom:16px;display:flex;align-items:center;justify-content:space-between">' +
      '<span style="font-size:.82rem;color:#065F46;font-weight:600">💰 Total monthly revenue' + billingNote + '</span>' +
      '<span style="font-size:1rem;font-weight:800;color:#065F46">' + fmtRand(totalMonthly) + '</span>' +
      '</div>';
    if (inactive.length) {
      html += '<div class="list-group-hd list-group-hd-inactive">🗂 Inactive / Deactivated (' + inactive.length + ')</div>';
      html += '<div class="card" style="padding:0 18px">';
      html += inactive.map(renderCoRow).join('');
      html += '</div>';
    }
    el.innerHTML = html;
  } catch (e) { el.innerHTML = '<div class="empty">Error: ' + e.message + '</div>'; }
}

function openWorkerLimitModal(coId, usedCount) {
  var c = _cCache[coId]; if (!c) { toast('Company data not loaded — refresh.'); return; }
  document.getElementById('wl-co-id').value         = coId;
  document.getElementById('wl-co-name').textContent = c.name;
  var lim  = c.worker_limit;
  var cost = lim ? fmtRand(calcWlCost(lim)) : null;
  document.getElementById('wl-co-usage').textContent =
    'Active employees: ' + usedCount +
    (lim !== null ? '  ·  Limit: ' + lim + '  ·  Monthly: ' + cost : '  ·  Limit: Unlimited');
  document.getElementById('wl-custom').value = lim !== null ? lim : '';
  document.getElementById('wl-msg').classList.add('hidden');
  updateWlCost();
  document.getElementById('modal-worker-limit').classList.remove('hidden');
}

var WL_RATE = 50; // R per employee per month

function calcWlCost(n) {
  if (!n || n < 1) return null;
  return n * WL_RATE;
}
function fmtRand(n) {
  return 'R' + n.toLocaleString('en-ZA');
}
function updateWlCost() {
  var n   = parseInt(document.getElementById('wl-custom').value) || 0;
  var box = document.getElementById('wl-cost-display');
  var txt = document.getElementById('wl-cost-text');
  if (!box || !txt) return;
  if (n > 0) {
    txt.textContent = n + ' employees × R' + WL_RATE + ' = ' + fmtRand(n * WL_RATE) + ' / month';
    box.style.display = '';
  } else {
    box.style.display = 'none';
  }
}
function setWlQuick(val) {
  document.getElementById('wl-custom').value = val !== null ? val : '';
  updateWlCost();
}

async function saveWorkerLimit() {
  var coId    = document.getElementById('wl-co-id').value;
  var rawVal  = document.getElementById('wl-custom').value.trim();
  var newLimit = rawVal === '' ? null : parseInt(rawVal);
  if (rawVal !== '' && (isNaN(newLimit) || newLimit < 1)) {
    showMsg('wl-msg', 'Enter a valid number or leave blank for unlimited.', 'err'); return;
  }
  if (!S.admin || !S.admin.id) { showMsg('wl-msg', 'Session error — please log in again.', 'err'); return; }
  var btn = document.getElementById('wl-save-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  try {
    var r = await withTimeout(
      db.rpc('dev_set_worker_limit', {
        p_actor_id: aId(), p_token: aTok(), p_company_id: coId, p_new_limit: newLimit
      }),
      5000
    );
    if (r.error) { showMsg('wl-msg', 'Failed: ' + r.error.message, 'err'); return; }
    if (!rpcOk(r.data, 'wl-msg')) return;
    if (_cCache[coId]) _cCache[coId].worker_limit = newLimit;
    showMsg('wl-msg', '✅ Limit updated!', 'ok');
    setTimeout(function() { closeModal('modal-worker-limit'); loadDevCos(); }, 1200);
  } catch (e) { showMsg('wl-msg', 'Error: ' + e.message, 'err'); }
  finally { if (btn) { btn.disabled = false; btn.textContent = 'Save Limit'; } }
}
function openSubExpiryModal(coId) {
  var c = _cCache[coId]; if (!c) { toast('Company data not loaded — refresh.'); return; }
  document.getElementById('se-co-id').value = coId;
  document.getElementById('se-co-name').textContent = c.name;
  var expAt = c.subscription_expires_at ? c.subscription_expires_at.slice(0, 10) : '';
  document.getElementById('se-date').value = expAt;
  document.getElementById('se-msg').classList.add('hidden');
  document.getElementById('modal-sub-expiry').classList.remove('hidden');
}
function seQuick(months) {
  var d = new Date();
  d.setMonth(d.getMonth() + months);
  document.getElementById('se-date').value = d.toISOString().slice(0, 10);
}
async function saveSubExpiry() {
  var coId   = document.getElementById('se-co-id').value;
  var dateVal = document.getElementById('se-date').value;
  var btn = document.getElementById('se-save-btn');
  btn.disabled = true; btn.textContent = 'Saving…';
  showMsg('se-msg', '', '');
  try {
    var expires = dateVal ? new Date(dateVal + 'T23:59:59').toISOString() : null;
    var r = await withTimeout(db.rpc('dev_company_set_sub_expiry', { p_actor_id: aId(), p_token: aTok(), p_id: coId, p_expires: expires }), 5000);
    if (r.error) throw r.error;
    if (!rpcOk(r.data, 'se-msg')) { btn.disabled = false; btn.textContent = 'Save'; return; }
    if (_cCache[coId]) _cCache[coId].subscription_expires_at = expires;
    showMsg('se-msg', '✅ Saved!', 'ok');
    setTimeout(function() { closeModal('modal-sub-expiry'); loadDevCos(); }, 1000);
  } catch (e) {
    showMsg('se-msg', 'Error: ' + (e.message || 'Failed to save'), 'err');
  }
  btn.disabled = false; btn.textContent = 'Save';
}
function toggleAddCo() {
  var p = document.getElementById('add-co-panel'); p.classList.toggle('hidden');
  if (!p.classList.contains('hidden')) document.getElementById('nc-name').focus();
}
async function addCompany() {
  var name = (document.getElementById('nc-name').value || '').trim();
  var code = (document.getElementById('nc-code').value || '').trim().toUpperCase().replace(/\s+/g, '');
  if (!name || !code) { showMsg('nc-msg', 'Name and Code required.', 'err'); return; }
  if (!/^[A-Z0-9_]+$/.test(code)) { showMsg('nc-msg', 'Code: letters, numbers, underscores only.', 'err'); return; }
  var methods = ['pin'];
  if (document.getElementById('nc-face').checked) methods.push('face');
  if (document.getElementById('nc-bio').checked)  methods.push('biometric');
  var btn = document.getElementById('add-co-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Creating…'; }
  try {
    var r = await withTimeout(db.rpc('dev_company_create', { p_actor_id: aId(), p_token: aTok(), p_name: name, p_code: code, p_methods: methods }), 5000);
    if (r.error) { showMsg('nc-msg', 'Error: ' + r.error.message, 'err'); return; }
    if (r.data === 'dupe') { showMsg('nc-msg', 'Code already exists.', 'err'); return; }
    if (!rpcOk(r.data, 'nc-msg')) return;
    showMsg('nc-msg', '✅ Company "' + name + '" created!', 'ok');
    document.getElementById('nc-name').value = ''; document.getElementById('nc-code').value = '';
    document.getElementById('nc-face').checked = false; document.getElementById('nc-bio').checked = false;
    setTimeout(function() { toggleAddCo(); loadDevCos(); }, 1400);
  } catch (e) { showMsg('nc-msg', 'Error: ' + e.message, 'err'); }
  finally { if (btn) { btn.disabled = false; btn.textContent = 'Create Company'; } }
}
async function devToggleCo(id, cur) {
  var r = await withTimeout(db.rpc('dev_company_toggle', { p_actor_id: aId(), p_token: aTok(), p_id: id, p_active: !cur }), 5000);
  if (!r.error && rpcOk(r.data)) { toast(cur ? 'Company deactivated' : 'Company reactivated'); loadDevCos(); }
}
function openEditCo(id) {
  var c = _cCache[id]; if (!c) { toast('Company data not loaded — refresh.'); return; }
  document.getElementById('eco-id').value   = id;
  document.getElementById('eco-name').value = c.name || '';
  document.getElementById('eco-code').value = c.code || '';
  var methods = c.clock_methods || ['pin'];
  document.getElementById('eco-face').checked = methods.indexOf('face') !== -1;
  document.getElementById('eco-bio').checked  = methods.indexOf('biometric') !== -1;
  document.getElementById('eco-msg').classList.add('hidden');
  document.getElementById('modal-edit-co').classList.remove('hidden');
}
async function saveEditCo() {
  var id   = document.getElementById('eco-id').value;
  var name = (document.getElementById('eco-name').value || '').trim();
  var code = (document.getElementById('eco-code').value || '').trim().toUpperCase().replace(/\s+/g, '');
  if (!name || !code) { showMsg('eco-msg', 'Name and Code required.', 'err'); return; }
  if (!/^[A-Z0-9_]+$/.test(code)) { showMsg('eco-msg', 'Code: letters, numbers, underscores only.', 'err'); return; }
  var methods = ['pin'];
  if (document.getElementById('eco-face').checked) methods.push('face');
  if (document.getElementById('eco-bio').checked)  methods.push('biometric');
  try {
    var r = await withTimeout(db.rpc('dev_company_update', { p_actor_id: aId(), p_token: aTok(), p_id: id, p_name: name, p_code: code, p_methods: methods }), 5000);
    if (r.error) { showMsg('eco-msg', 'Error: ' + r.error.message, 'err'); return; }
    if (r.data === 'dupe') { showMsg('eco-msg', 'Code already exists.', 'err'); return; }
    if (!rpcOk(r.data, 'eco-msg')) return;
    showMsg('eco-msg', '✅ Company updated!', 'ok');
    setTimeout(function() { closeModal('modal-edit-co'); loadDevCos(); }, 1200);
  } catch (e) { showMsg('eco-msg', 'Error: ' + e.message, 'err'); }
}
async function loadDevAccounts() {
  var el        = document.getElementById('dev-accounts-list');
  var filterSel = document.getElementById('dev-filter-co');
  el.innerHTML  = '<div class="empty">Loading…</div>';
  if (filterSel.options.length <= 1) {
    try {
      var cosR = await withTimeout(db.from('companies').select('id,name').eq('is_active', true).order('name'), 5000);
      filterSel.innerHTML = '<option value="">All Companies</option>' + (cosR.data || []).map(function(c) {
        return '<option value="' + c.id + '">' + esc(c.name) + '</option>';
      }).join('');
    } catch (e) {}
  }
  try {
    var q   = db.from('admin_users').select(ADMIN_COLS + ', co:companies(name,code)').neq('role', 'developer').order('full_name');
    var fco = filterSel.value;
    if (fco) q = q.eq('company_id', fco);
    var r = await withTimeout(q, 5000);
    if (r.error || !r.data) { el.innerHTML = '<div class="empty">Failed to load</div>'; return; }
    if (!r.data.length) { el.innerHTML = '<div class="empty">No accounts yet</div>'; return; }

    var active   = r.data.filter(function(a) { return a.is_active; });
    var inactive = r.data.filter(function(a) { return !a.is_active; });

    function renderAcctRow(a) {
      var col = ROLE_COLORS[a.role] || 'var(--blue)';
      return '<div class="list-row">' +
        '<div class="row-info"><div class="av av-sm" style="background:' + col + '">' + initialsesc(a.full_name || a.username) + '</div>' +
        '<div><div class="row-name">' + esc(a.full_name || a.username) + ' <small style="color:var(--muted)">@' + esc(a.username) + '</small></div>' +
        '<div class="row-meta"><span class="role-pill" style="background:' + col + '22;color:' + col + '">' +
          (ROLE_LABELS[a.role] || a.role) + '</span> 🏢 ' + (a.co ? esc(a.co.name) : '—') +
        '</div></div></div>' +
        '<div class="row-btns">' +
        '<button class="icon-btn" onclick="openEditAcct(\'' + a.id + '\',\'' + escQ(a.full_name || '') + '\',\'' + escQ(a.email || '') + '\',\'' + a.role + '\',\'dev\')">' + icon('pencil', 18) + '</button>' +
        '<button class="icon-btn" onclick="resetPw(\'' + a.id + '\',\'' + escQ(a.username) + '\')">' + icon('key', 18) + '</button>' +
        '<button class="icon-btn" onclick="devToggleAcct(\'' + a.id + '\',' + a.is_active + ')">' + (a.is_active ? icon('ban', 18) : icon('check', 18)) + '</button>' +
        '</div></div>';
    }

    var html = '';
    html += '<div class="list-group-hd">✅ Active Accounts (' + active.length + ')</div>';
    html += '<div class="card" style="padding:0 18px;margin-bottom:16px">';
    html += active.length ? active.map(renderAcctRow).join('') : '<div class="empty" style="padding:12px 0">No active accounts</div>';
    html += '</div>';
    if (inactive.length) {
      html += '<div class="list-group-hd list-group-hd-inactive">🗂 Inactive / Deactivated (' + inactive.length + ')</div>';
      html += '<div class="card" style="padding:0 18px">';
      html += inactive.map(renderAcctRow).join('');
      html += '</div>';
    }
    el.innerHTML = html;
  } catch (e) { el.innerHTML = '<div class="empty">Error: ' + e.message + '</div>'; }
}
function toggleAddDevAcct() {
  var p = document.getElementById('add-dev-acct-panel'); p.classList.toggle('hidden');
  if (!p.classList.contains('hidden')) {
    withTimeout(db.from('companies').select('id,name').eq('is_active', true).order('name'), 5000)
      .then(function(r) {
        document.getElementById('da-company').innerHTML = '<option value="">Select Company…</option>' +
          (r.data || []).map(function(c) { return '<option value="' + c.id + '">' + esc(c.name) + '</option>'; }).join('');
      }).catch(function() {});
    document.getElementById('da-name').focus();
  }
}
async function addDevAcct() {
  var cid   = document.getElementById('da-company').value;
  var role  = document.getElementById('da-role').value;
  var name  = (document.getElementById('da-name').value  || '').trim();
  var user  = (document.getElementById('da-user').value  || '').trim().toLowerCase();
  var pass  = (document.getElementById('da-pass').value  || '').trim();
  var email = (document.getElementById('da-email').value || '').trim();
  if (!cid) { showMsg('da-msg', 'Select a company.', 'err'); return; }
  if (!name || !user || !pass) { showMsg('da-msg', 'Name, username and password required.', 'err'); return; }
  if (pass.length < 6) { showMsg('da-msg', 'Password must be at least 6 characters.', 'err'); return; }
  if (!/^[a-z0-9_]+$/.test(user)) { showMsg('da-msg', 'Username: letters, numbers and underscores only.', 'err'); return; }
  try {
    var r = await withTimeout(db.rpc('admin_manage_create', {
      p_actor_id: aId(), p_token: aTok(), p_company_id: cid,
      p_username: user, p_pw_hash: await sha256(pass), p_full_name: name, p_email: email || null, p_role: role
    }), 5000);
    if (r.error) { showMsg('da-msg', 'Error: ' + r.error.message, 'err'); return; }
    if (r.data === 'dupe') { showMsg('da-msg', 'Username already exists.', 'err'); return; }
    if (!rpcOk(r.data, 'da-msg')) return;
    showMsg('da-msg', '✅ ' + (ROLE_LABELS[role] || role) + ' "@' + user + '" created!', 'ok');
    ['da-name', 'da-user', 'da-pass', 'da-email'].forEach(function(id) { document.getElementById(id).value = ''; });
    setTimeout(function() { toggleAddDevAcct(); loadDevAccounts(); }, 1400);
  } catch (e) { showMsg('da-msg', 'Error: ' + e.message, 'err'); }
}
async function devToggleAcct(id, cur) {
  var r = await withTimeout(db.rpc('admin_manage_toggle', { p_actor_id: aId(), p_token: aTok(), p_target_id: id, p_active: !cur }), 5000);
  if (!r.error && rpcOk(r.data)) { toast(cur ? 'Account deactivated' : 'Account reactivated'); loadDevAccounts(); }
}
async function loadDevWorkers() {
  var el  = document.getElementById('dev-workers-list');
  var sel = document.getElementById('dev-filter-co-wk');
  if (sel.options.length <= 1) {
    try {
      var cosR = await withTimeout(db.from('companies').select('id,name').eq('is_active', true).order('name'), 5000);
      sel.innerHTML = '<option value="">Select a company…</option>' + (cosR.data || []).map(function(c) {
        return '<option value="' + c.id + '">' + esc(c.name) + '</option>';
      }).join('');
    } catch (e) {}
  }
  var cid = sel.value;
  if (!cid) { el.innerHTML = '<div class="empty">Select a company above</div>'; return; }
  el.innerHTML = '<div class="empty">Loading…</div>';
  try {
    var r = await withTimeout(db.from('workers').select(WORKER_COLS).eq('company_id', cid).order('name'), 5000);
    if (r.error || !r.data) { el.innerHTML = '<div class="empty">Failed to load</div>'; return; }
    if (!r.data.length) { el.innerHTML = '<div class="empty">No workers in this company</div>'; return; }
    r.data.forEach(function(w) { _wCache[w.id] = Object.assign({}, w, { _ctx: 'dev' }); });

    var active   = r.data.filter(function(w) { return w.is_active; });
    var inactive = r.data.filter(function(w) { return !w.is_active; });

    function renderWorkerRow(w) {
      return '<div class="list-row">' +
        '<div class="row-info"><div class="av av-sm">' + initials(w.name) + '</div>' +
        '<div><div class="row-name">' + esc(w.name) + '</div>' +
        '<div class="row-meta">' + esc(w.employee_id) + (w.job_title ? ' · ' + esc(w.job_title) : '') +
          (w.biometric_enabled ? ' ' + icon('fingerprint', 13) : '') + (w.face_descriptor ? ' ' + icon('camera', 13) : '') +
        '</div></div></div>' +
        '<div class="row-btns">' +
        '<button class="icon-btn" onclick="openEditWorker(\'' + w.id + '\')">' + icon('pencil', 18) + '</button>' +
        '<button class="icon-btn ib-teal" onclick="adminEnrollFace(\'' + w.id + '\',\'' + escQ(w.name) + '\',\'dev\')">' + icon('camera', 18) + '</button>' +
        '<button class="icon-btn" onclick="devToggleWorker(\'' + w.id + '\',' + w.is_active + ')">' + (w.is_active ? icon('ban', 18) : icon('check', 18)) + '</button>' +
        '</div></div>';
    }

    var html = '';
    html += '<div class="list-group-hd">✅ Active Workers (' + active.length + ')</div>';
    html += '<div class="card" style="padding:0 18px;margin-bottom:16px">';
    html += active.length ? active.map(renderWorkerRow).join('') : '<div class="empty" style="padding:12px 0">No active workers</div>';
    html += '</div>';
    if (inactive.length) {
      html += '<div class="list-group-hd list-group-hd-inactive">🗂 Inactive / Deactivated (' + inactive.length + ')</div>';
      html += '<div class="card" style="padding:0 18px">';
      html += inactive.map(renderWorkerRow).join('');
      html += '</div>';
    }
    el.innerHTML = html;
  } catch (e) { el.innerHTML = '<div class="empty">Error: ' + e.message + '</div>'; }
}
async function devToggleWorker(id, cur) {
  var r = await withTimeout(db.rpc('admin_worker_toggle', { p_actor_id: aId(), p_token: aTok(), p_id: id, p_active: !cur }), 5000);
  if (!r.error && rpcOk(r.data)) { toast(cur ? 'Worker deactivated' : 'Worker reactivated'); loadDevWorkers(); }
}

async function loadDevInactive() {
  var el = document.getElementById('dev-inactive-list');
  el.innerHTML = '<div class="empty">Loading…</div>';
  try {
    var [cosR, accR, wkR] = await Promise.all([
      withTimeout(db.from('companies').select('*').eq('is_active', false).order('name'), 5000),
      withTimeout(db.from('admin_users').select(ADMIN_COLS + ', co:companies(name,code)').neq('role', 'developer').eq('is_active', false).order('full_name'), 5000),
      withTimeout(db.from('workers').select(WORKER_COLS + ', co:companies(name)').eq('is_active', false).order('name'), 5000)
    ]);

    var cos  = cosR.data  || [];
    var accs = accR.data  || [];
    var wks  = wkR.data   || [];

    if (!cos.length && !accs.length && !wks.length) {
      el.innerHTML = '<div class="empty" style="padding:40px 0">No inactive records — everything is active ✅</div>';
      return;
    }

    var html = '';

    // ── Inactive Companies ────────────────────────────────
    html += '<div class="sec-lbl" style="margin-bottom:8px">🏢 Companies (' + cos.length + ')</div>';
    if (cos.length) {
      html += '<div class="card" style="padding:0 18px;margin-bottom:16px">' + cos.map(function(c) {
        var used = 0;
        return '<div class="list-row">' +
          '<div class="row-info"><div class="av av-sm" style="background:#94A3B8">' + c.code.slice(0, 2) + '</div>' +
          '<div><div class="row-name" style="color:var(--muted)">' + esc(c.name) + '</div>' +
          '<div class="row-meta">Code: ' + esc(c.code) + '</div></div></div>' +
          '<div class="row-btns">' +
          '<button class="icon-btn" onclick="openEditCo(\'' + c.id + '\')">' + icon('pencil', 18) + '</button>' +
          '<button class="btn btn-sm" style="background:#D1FAE5;color:#065F46;border:1px solid #6EE7B7;border-radius:8px;padding:4px 10px;font-size:.78rem;cursor:pointer" onclick="devRestoreCo(\'' + c.id + '\')">' + icon('check', 15) + ' Restore</button>' +
          '</div></div>';
      }).join('') + '</div>';
    } else {
      html += '<div class="card" style="margin-bottom:16px"><div class="empty" style="padding:12px 0">No inactive companies</div></div>';
    }

    // ── Inactive Accounts ─────────────────────────────────
    html += '<div class="sec-lbl" style="margin-bottom:8px">👤 Accounts (' + accs.length + ')</div>';
    if (accs.length) {
      html += '<div class="card" style="padding:0 18px;margin-bottom:16px">' + accs.map(function(a) {
        var col = ROLE_COLORS[a.role] || 'var(--blue)';
        return '<div class="list-row">' +
          '<div class="row-info"><div class="av av-sm" style="background:#94A3B8">' + initialsesc(a.full_name || a.username) + '</div>' +
          '<div><div class="row-name" style="color:var(--muted)">' + esc(a.full_name || a.username) + ' <small>@' + esc(a.username) + '</small></div>' +
          '<div class="row-meta"><span class="role-pill" style="background:' + col + '22;color:' + col + '">' + (ROLE_LABELS[a.role] || a.role) + '</span> 🏢 ' + (a.co ? esc(a.co.name) : '—') + '</div>' +
          '</div></div>' +
          '<div class="row-btns">' +
          '<button class="icon-btn" onclick="openEditAcct(\'' + a.id + '\',\'' + escQ(a.full_name || '') + '\',\'' + escQ(a.email || '') + '\',\'' + a.role + '\',\'dev\')">' + icon('pencil', 18) + '</button>' +
          '<button class="btn btn-sm" style="background:#D1FAE5;color:#065F46;border:1px solid #6EE7B7;border-radius:8px;padding:4px 10px;font-size:.78rem;cursor:pointer" onclick="devRestoreAcct(\'' + a.id + '\')">' + icon('check', 15) + ' Restore</button>' +
          '</div></div>';
      }).join('') + '</div>';
    } else {
      html += '<div class="card" style="margin-bottom:16px"><div class="empty" style="padding:12px 0">No inactive accounts</div></div>';
    }

    // ── Inactive Workers ──────────────────────────────────
    html += '<div class="sec-lbl" style="margin-bottom:8px">👷 Workers (' + wks.length + ')</div>';
    if (wks.length) {
      html += '<div class="card" style="padding:0 18px;margin-bottom:16px">' + wks.map(function(w) {
        return '<div class="list-row">' +
          '<div class="row-info"><div class="av av-sm" style="background:#94A3B8">' + initials(w.name) + '</div>' +
          '<div><div class="row-name" style="color:var(--muted)">' + esc(w.name) + '</div>' +
          '<div class="row-meta">' + esc(w.employee_id) + (w.job_title ? ' · ' + esc(w.job_title) : '') + ' · 🏢 ' + (w.co ? esc(w.co.name) : '—') + '</div>' +
          '</div></div>' +
          '<div class="row-btns">' +
          '<button class="icon-btn" onclick="openEditWorker(\'' + w.id + '\')">' + icon('pencil', 18) + '</button>' +
          '<button class="btn btn-sm" style="background:#D1FAE5;color:#065F46;border:1px solid #6EE7B7;border-radius:8px;padding:4px 10px;font-size:.78rem;cursor:pointer" onclick="devRestoreWorker(\'' + w.id + '\')">' + icon('check', 15) + ' Restore</button>' +
          '</div></div>';
      }).join('') + '</div>';
    } else {
      html += '<div class="card" style="margin-bottom:16px"><div class="empty" style="padding:12px 0">No inactive workers</div></div>';
    }

    el.innerHTML = html;
  } catch (e) { el.innerHTML = '<div class="empty">Error: ' + e.message + '</div>'; }
}

async function devRestoreCo(id) {
  var r = await withTimeout(db.rpc('dev_company_toggle', { p_actor_id: aId(), p_token: aTok(), p_id: id, p_active: true }), 5000);
  if (!r.error && rpcOk(r.data)) { toast('Company restored'); loadDevInactive(); }
}
async function devRestoreAcct(id) {
  var r = await withTimeout(db.rpc('admin_manage_toggle', { p_actor_id: aId(), p_token: aTok(), p_target_id: id, p_active: true }), 5000);
  if (!r.error && rpcOk(r.data)) { toast('Account restored'); loadDevInactive(); }
}
async function devRestoreWorker(id) {
  var r = await withTimeout(db.rpc('admin_worker_toggle', { p_actor_id: aId(), p_token: aTok(), p_id: id, p_active: true }), 5000);
  if (!r.error && rpcOk(r.data)) { toast('Worker restored'); loadDevInactive(); }
}

function loadDevSystem() {
  var el = document.getElementById('dev-acct-info');
  if (!S.admin || !el) return;
  el.innerHTML =
    '<div class="info-row"><span class="info-lbl">Username</span><span>@' + S.admin.username + '</span></div>' +
    '<div class="info-row"><span class="info-lbl">Role</span><span style="color:var(--purple);font-weight:700">Developer</span></div>' +
    '<div class="field" style="margin-top:12px"><label>Full Name</label>' +
      '<input id="dev-profile-name" type="text" class="input" value="' + (S.admin.full_name || '').replace(/"/g, '&quot;') + '" placeholder="Full Name"></div>' +
    '<div class="field"><label>Email</label>' +
      '<input id="dev-profile-email" type="email" class="input" value="' + (S.admin.email || '').replace(/"/g, '&quot;') + '" placeholder="Email"></div>' +
    '<button class="btn btn-outline btn-full" onclick="saveDevProfile()" style="margin-top:4px">Save Profile</button>' +
    '<p class="msg hidden" id="dev-profile-msg"></p>';
}
async function saveDevProfile() {
  var name  = (document.getElementById('dev-profile-name').value  || '').trim();
  var email = (document.getElementById('dev-profile-email').value || '').trim();
  if (!name) { showMsg('dev-profile-msg', 'Full name required.', 'err'); return; }
  var r = await withTimeout(db.rpc('admin_self_update', { p_id: aId(), p_token: aTok(), p_full_name: name, p_email: email || null }), 5000);
  if (r.error) { showMsg('dev-profile-msg', 'Failed: ' + r.error.message, 'err'); return; }
  if (!rpcOk(r.data, 'dev-profile-msg')) return;
  S.admin.full_name = name; S.admin.email = email;
  localStorage.setItem('wc_admin_session', JSON.stringify(S.admin));
  showMsg('dev-profile-msg', '✅ Profile updated!', 'ok');
}
async function changeDevPw() {
  var pw = document.getElementById('dev-new-pw').value;
  if (!pw || pw.length < 6) { showMsg('dev-pw-msg', 'Password must be at least 6 characters.', 'err'); return; }
  var r = await withTimeout(db.rpc('admin_self_set_password', { p_id: aId(), p_token: aTok(), p_new_hash: await sha256(pw) }), 5000);
  if (r.error || !rpcOk(r.data, 'dev-pw-msg')) { if (r.error) showMsg('dev-pw-msg', 'Failed: ' + r.error.message, 'err'); return; }
  showMsg('dev-pw-msg', '✅ Password updated!', 'ok'); document.getElementById('dev-new-pw').value = '';
}

// ── PWA Install ───────────────────────────────────────────
var _installPrompt = null;
window.addEventListener('beforeinstallprompt', function(e) {
  e.preventDefault(); _installPrompt = e;
  setTimeout(function() { var b = document.getElementById('install-banner'); if (b) b.classList.remove('hidden'); }, 3000);
});
window.addEventListener('appinstalled', function() {
  var b = document.getElementById('install-banner'); if (b) b.classList.add('hidden');
  _installPrompt = null; toast('✅ WorkClock installed!');
});
function installPWA() {
  if (!_installPrompt) return;
  _installPrompt.prompt();
  _installPrompt.userChoice.then(function(r) {
    if (r.outcome === 'accepted') { var b = document.getElementById('install-banner'); if (b) b.classList.add('hidden'); _installPrompt = null; }
  });
}
function checkIOSInstall() {
  if (/iphone|ipad|ipod/i.test(navigator.userAgent) && !window.navigator.standalone) {
    setTimeout(function() { var b = document.getElementById('ios-banner'); if (b) b.classList.remove('hidden'); }, 3000);
  }
}

// ── Bootstrap ─────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', function() {

  // 0. Start error tracking (no-op until a Sentry DSN is configured)
  initSentry();

  // 0. Replace all static [data-icon] placeholders with inline SVG
  hydrateIcons();

  // 1. Sync init from localStorage — instant, no Supabase needed
  try {
    var co = JSON.parse(localStorage.getItem('wc_company') || 'null');
    if (co && co.id) {
      S.companyId   = co.id;
      S.companyName = co.name;
      S.companyCode = co.code;
    }
  } catch (e) {}
  updateHomeUI();

  // 2. Restore admin/developer session if available, else show home page
  var _savedAdmin = null;
  try { _savedAdmin = JSON.parse(localStorage.getItem('wc_admin_session') || 'null'); } catch(e) {}
  if (_savedAdmin && _savedAdmin.id && _savedAdmin.role) {
    S.admin = _savedAdmin;
    if (_savedAdmin.role === 'developer') {
      showPg('developer');
    } else {
      document.getElementById('admin-co-lbl').textContent = _savedAdmin.co_name || '';
      var _isSA = _savedAdmin.role === 'super_admin';
      document.getElementById('tab-admins-btn').classList.toggle('hidden', !_isSA);
      applyNavPins(getNavPins());
      showPg('admin');
    }
  } else {
    showPg('home');
  }
  startHomeClock();

  // Initialize EmailJS if credentials are configured
  if (typeof emailjs !== 'undefined' && EMAILJS_PUBLIC_KEY !== 'YOUR_PUBLIC_KEY') {
    emailjs.init(EMAILJS_PUBLIC_KEY);
  }

  // 3. Remove splash — visual fade at 1.5s, hard remove at 3.5s
  var splash = document.getElementById('splash');
  if (splash) {
    setTimeout(function() {
      splash.style.opacity = '0';
      setTimeout(function() { splash.style.display = 'none'; }, 400);
    }, 1500);
    setTimeout(function() { splash.style.display = 'none'; }, 3500);
  }

  checkIOSInstall();

  // 4. Background async: load data after session restore + restore worker session
  (async function() {
    try { await withTimeout(initCompany(), 4000); } catch (e) {}

    // If admin session was restored, load their panel data now
    if (S.admin) {
      try {
        if (S.admin.role === 'developer') loadDevCos();
        else loadDashboard();
      } catch(e) {}
      return; // Admin and worker sessions are mutually exclusive on one device
    }

    var savedId    = localStorage.getItem('wc_worker_id');
    var savedToken = localStorage.getItem('wc_session_token');
    if (!savedId || !savedToken) return;
    try {
      // Use secure RPC — validates session_token server-side, never exposes it
      var sR = await withTimeout(
        db.rpc('restore_worker_session', { p_worker_id: savedId, p_session_token: savedToken }),
        5000
      );
      var row = sR.data && sR.data[0];
      if (row) {
        var savedDevice = localStorage.getItem('wc_device_id');
        if (row.device_id && savedDevice && row.device_id !== savedDevice) {
          localStorage.removeItem('wc_worker_id'); localStorage.removeItem('wc_session_token'); return;
        }
        // Reshape workplace into nested object for rest of app
        row.workplace = row.wp_id ? { id: row.wp_id, name: row.wp_name, latitude: row.wp_latitude, longitude: row.wp_longitude, radius_meters: row.wp_radius } : null;
        S.worker = row;
        enterWorkerDashboard();
      } else {
        localStorage.removeItem('wc_worker_id'); localStorage.removeItem('wc_session_token');
      }
    } catch (e) { localStorage.removeItem('wc_worker_id'); localStorage.removeItem('wc_session_token'); }
  })();
});
