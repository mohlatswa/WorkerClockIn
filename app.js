'use strict';

// ── State ─────────────────────────────────────────────────
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
var ROLE_LABELS = { super_admin: 'Super Admin', admin: 'Admin', developer: 'Developer' };
var ROLE_COLORS = { super_admin: 'var(--green)', admin: 'var(--blue)', developer: 'var(--purple)' };

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
function fmtTime(iso) { return iso ? new Date(iso).toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit' }) : '--:--'; }
function fmtDate(iso) { return iso ? new Date(iso).toLocaleDateString('en-ZA') : ''; }
function fmtDateShort(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('en-ZA', { weekday: 'short', day: 'numeric', month: 'short' });
}
function vibrate(p) { if (navigator.vibrate) navigator.vibrate(p || 50); }
function escQ(s) { return (s || '').replace(/'/g, "\\'"); }
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
function genToken() {
  var arr = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(arr).map(function(b) { return b.toString(16).padStart(2,'0'); }).join('');
}
async function secureSignIn(method) {
  var w = S.worker;
  if (!w) return;
  var deviceId = getDeviceId();
  // Device binding: reject if registered to a different device
  if (w.device_id && w.device_id !== deviceId) {
    showErr('err-pin', '🔒 This account is bound to another device. Ask your administrator to reset it.');
    setTimeout(function() { S.worker = null; showPg('wlogin'); }, 3000);
    return;
  }
  // Issue a new session token and register device on first sign-in
  var sessionToken = genToken();
  var updates = { session_token: sessionToken, failed_attempts: 0, locked_until: null };
  if (!w.device_id) updates.device_id = deviceId;
  try { await withTimeout(db.from('workers').update(updates).eq('id', w.id), 5000); } catch(e) {}
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
    var r = await withTimeout(db.from('workers').update({ pin: hashed, force_pin_change: false }).eq('id', S.worker.id), 5000);
    if (r.error) { showMsg('fp-msg', 'Error: ' + r.error.message, 'err'); return; }
    S.worker.force_pin_change = false; S.worker.pin = hashed;
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
    if (await sha256(cur) !== S.worker.pin) { showMsg('cp-msg', 'Current PIN is incorrect.', 'err'); return; }
    var newHash = await sha256(new1);
    var r = await withTimeout(db.from('workers').update({ pin: newHash }).eq('id', S.worker.id), 5000);
    if (r.error) { showMsg('cp-msg', 'Error: ' + r.error.message, 'err'); return; }
    S.worker.pin = newHash;
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
    var q = db.from('workers').select('*, workplace:workplaces(*)').eq('employee_id', id).eq('is_active', true);
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
  // Check account lockout
  if (S.worker.locked_until && new Date(S.worker.locked_until) > new Date()) {
    var mins = Math.ceil((new Date(S.worker.locked_until) - new Date()) / 60000);
    showErr('err-pin', '🔒 Account locked. Try again in ' + mins + ' minute(s).');
    npReset(); return;
  }
  var enteredHash = await sha256(S.npPin.join(''));
  if (enteredHash !== S.worker.pin) {
    vibrate([50, 30, 50]);
    var attempts = (S.worker.failed_attempts || 0) + 1;
    var upd = { failed_attempts: attempts };
    var msg;
    if (attempts >= 5) {
      upd.locked_until    = new Date(Date.now() + 30 * 60 * 1000).toISOString();
      upd.failed_attempts = 0;
      msg = '🔒 Too many failed attempts — account locked for 30 minutes.';
    } else {
      msg = 'Incorrect PIN. ' + (5 - attempts) + ' attempt(s) remaining.';
    }
    try { await withTimeout(db.from('workers').update(upd).eq('id', S.worker.id), 3000); } catch(e) {}
    S.worker.failed_attempts = upd.failed_attempts;
    if (upd.locked_until) S.worker.locked_until = upd.locked_until;
    showErr('err-pin', msg); npReset(); return;
  }
  await secureSignIn('pin');
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
      db.from('workers').select('*, workplace:workplaces(*)').eq('id', workerId).eq('is_active', true).maybeSingle(),
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
    var r = await db.from('workers').update({ biometric_credential_id: b64(cred.rawId), biometric_enabled: true }).eq('id', S.worker.id);
    if (r.error) throw r.error;
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
      return '<div class="hist-row">' +
        '<div class="hist-left">' +
          '<div class="hist-date">' + dateStr + '</div>' +
          '<div class="hist-times">' + inStr + ' → ' + outStr + '</div>' +
        '</div>' +
        '<div class="hist-right">' +
          '<div class="hist-hrs">' + hrs + '</div>' +
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
  document.getElementById('loc-status').innerHTML = '<div class="checking"><div class="spin"></div> Getting your location…</div>';
  if (!navigator.geolocation) {
    document.getElementById('loc-status').textContent = '⚠️ Location not supported on this device';
    setClockBtn(true); return;
  }
  if (S.geoWatcher) navigator.geolocation.clearWatch(S.geoWatcher);
  S.geoWatcher = navigator.geolocation.watchPosition(
    function(pos) {
      S.userLoc = pos.coords;
      var wp = S.worker && S.worker.workplace;
      if (!wp || !wp.latitude || !wp.longitude) {
        document.getElementById('loc-status').innerHTML =
          '⚠️ <span style="color:var(--amber)">Workplace not configured — contact your admin</span>';
        setClockBtn(false);
        document.getElementById('clk-icon').textContent  = '📍';
        document.getElementById('clk-label').textContent = 'Workplace Not Set Up';
        return;
      }
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
        document.getElementById('loc-status').textContent = '⚠️ Location unavailable — clocking in without location';
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
      document.getElementById('clk-icon').textContent  = '⏹';
      document.getElementById('clk-label').textContent = 'Clock Out';
    } else {
      btn.className = 'clock-btn clk-in';
      document.getElementById('clk-icon').textContent  = '▶';
      document.getElementById('clk-label').textContent = 'Clock In';
    }
  } else {
    btn.disabled = true; btn.className = 'clock-btn clk-wait';
    document.getElementById('clk-icon').textContent  = '⏳';
    document.getElementById('clk-label').textContent = 'Checking Location…';
  }
}

// ── Clock In / Out ────────────────────────────────────────
async function clockAction() {
  var btn = document.getElementById('clk-btn');
  btn.disabled = true;
  var action = S.clockStatus === 'in' ? 'out' : 'in';
  try {
    if (action === 'in') {
      var todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
      try {
        await withTimeout(
          db.from('attendance').update({ status: 'completed', clock_out_time: todayStart.toISOString() })
            .eq('worker_id', S.worker.id).eq('status', 'active').lt('clock_in_time', todayStart.toISOString()),
          5000
        );
      } catch(e) {}
      var ins = await withTimeout(db.from('attendance').insert({
        worker_id:           S.worker.id,
        clock_in_time:       new Date().toISOString(),
        auth_method:         S.authMethod,
        status:              'active',
        clock_in_latitude:   S.userLoc ? S.userLoc.latitude  : null,
        clock_in_longitude:  S.userLoc ? S.userLoc.longitude : null
      }).select().single(), 8000);
      if (ins.error) throw ins.error;
      S.attendanceId = ins.data.id; S.clockStatus = 'in';
    } else {
      var upd = await withTimeout(db.from('attendance').update({
        clock_out_time:      new Date().toISOString(),
        status:              'completed',
        clock_out_latitude:  S.userLoc ? S.userLoc.latitude  : null,
        clock_out_longitude: S.userLoc ? S.userLoc.longitude : null
      }).eq('id', S.attendanceId), 8000);
      if (upd.error) throw upd.error;
      S.clockStatus = 'out';
    }
    vibrate([50, 30, 100]);
    showSuccess(action);
    await loadTodayRecord();
    await loadAttendanceHistory();
  } catch (e) { toast('❌ ' + e.message); }
  btn.disabled = false; setClockBtn(true);
}
function showSuccess(action) {
  var overlay = document.getElementById('success-overlay');
  var icon    = document.getElementById('succ-icon');
  icon.className  = 'succ-icon' + (action === 'out' ? ' out' : '');
  icon.textContent = action === 'in' ? '✓' : '⏹';
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
    try { await withTimeout(db.from('workers').update({ session_token: null }).eq('id', S.worker.id), 3000); } catch(e) {}
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
        db.from('workers').select('*, workplace:workplaces(*)').eq('id', match.label).eq('is_active', true).maybeSingle(),
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
    var r = await withTimeout(db.from('workers').update({ face_descriptor: descriptor }).eq('id', _enrollTarget.id), 5000);
    if (r.error) throw r.error;
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

// ── Admin Login ───────────────────────────────────────────
async function adminLogin() {
  var user = (document.getElementById('inp-auser').value || '').trim().toLowerCase();
  var pass = document.getElementById('inp-apass').value || '';
  showErr('err-admin', '');
  if (!user || !pass) { showErr('err-admin', 'Enter username and password.'); return; }
  var btn = document.getElementById('login-btn');
  btn.disabled = true; btn.textContent = 'Logging in…';
  try {
    // Lookup account to check lockout before verifying password
    var lookR = await withTimeout(
      db.from('admin_users').select('id,is_active,failed_attempts,locked_until').eq('username', user).maybeSingle(),
      5000
    );
    if (lookR.data) {
      if (!lookR.data.is_active) { showErr('err-admin', 'Account disabled. Contact your system administrator.'); return; }
      if (lookR.data.locked_until && new Date(lookR.data.locked_until) > new Date()) {
        var mins = Math.ceil((new Date(lookR.data.locked_until) - new Date()) / 60000);
        showErr('err-admin', '🔒 Account locked. Try again in ' + mins + ' minute(s).'); return;
      }
    }
    var hashedPass = await sha256(pass);
    // Use secure RPC — password_hash is never returned to the browser
    var rpc = await withTimeout(
      db.rpc('admin_login', { p_username: user, p_password_hash: hashedPass }),
      8000
    );
    if (rpc.error) { showErr('err-admin', 'Database error: ' + rpc.error.message); return; }
    var row = rpc.data && rpc.data[0];
    if (!row) {
      if (lookR.data) {
        var attempts = (lookR.data.failed_attempts || 0) + 1;
        var upd = { failed_attempts: attempts };
        if (attempts >= 5) {
          upd.locked_until    = new Date(Date.now() + 30 * 60 * 1000).toISOString();
          upd.failed_attempts = 0;
          showErr('err-admin', '🔒 Too many failed attempts. Account locked for 30 minutes.');
        } else {
          showErr('err-admin', 'Invalid username or password. ' + (5 - attempts) + ' attempt(s) remaining.');
        }
        try { await withTimeout(db.from('admin_users').update(upd).eq('id', lookR.data.id), 3000); } catch(e) {}
      } else {
        showErr('err-admin', 'Invalid username or password.');
      }
      return;
    }
    // Rebuild co object from flat RPC columns for compatibility with rest of app
    row.co = { name: row.co_name, code: row.co_code };
    // Success — clear lockout
    try { await withTimeout(db.from('admin_users').update({ failed_attempts: 0, locked_until: null }).eq('id', row.id), 3000); } catch(e) {}
    S.admin = row;
    document.getElementById('inp-auser').value = '';
    document.getElementById('inp-apass').value = '';
    if (row.role === 'developer') {
      showPg('developer'); loadDevCos();
    } else {
      document.getElementById('admin-co-lbl').textContent = row.co_name || '';
      var isSA = row.role === 'super_admin';
      document.getElementById('tab-admins-btn').classList.toggle('hidden', !isSA);
      showPg('admin'); loadDashboard();
    }
  } catch (e) { showErr('err-admin', 'Error: ' + e.message); }
  finally { btn.disabled = false; btn.textContent = 'Login'; }
}
function adminLogout() { S.admin = null; showPg('home'); }

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
  showMsg('fpw-send-msg', '⏳ Sending…', 'ok');
  try {
    var r = await withTimeout(
      db.from('admin_users').select('id,email,full_name').eq('username', username).eq('is_active', true).maybeSingle(),
      5000
    );
    if (!r.data)       { showMsg('fpw-send-msg', 'Username not found or account inactive.', 'err'); return; }
    if (!r.data.email) { showMsg('fpw-send-msg', 'No email on file for this account. Contact your system administrator.', 'err'); return; }
    var otp     = String(Math.floor(100000 + Math.random() * 900000));
    var hash    = await sha256(otp);
    var expires = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    var upd = await withTimeout(db.from('admin_users').update({ reset_token: hash, reset_expires: expires }).eq('id', r.data.id), 5000);
    if (upd.error) { showMsg('fpw-send-msg', 'Error: ' + upd.error.message, 'err'); return; }
    if (typeof emailjs === 'undefined' || EMAILJS_PUBLIC_KEY === 'YOUR_PUBLIC_KEY') {
      showMsg('fpw-send-msg', 'Email service not configured — contact your system administrator to reset your password.', 'err'); return;
    }
    await emailjs.send(EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, {
      to_email: r.data.email,
      to_name:  r.data.full_name || username,
      otp_code: otp
    });
    var s1 = document.getElementById('fpw-step1'); if (s1) s1.classList.add('hidden');
    var s2 = document.getElementById('fpw-step2'); if (s2) s2.classList.remove('hidden');
    showMsg('fpw-reset-msg', '✅ Code sent to ' + r.data.email + ' (valid 15 min)', 'ok');
  } catch(e) { showMsg('fpw-send-msg', 'Error: ' + (e.text || e.message || 'Failed to send'), 'err'); }
}
async function resetAdminPassword() {
  var username = (document.getElementById('fpw-username').value || '').trim().toLowerCase();
  var otp      = (document.getElementById('fpw-otp').value      || '').trim();
  var newpw    = (document.getElementById('fpw-newpw').value    || '').trim();
  if (!otp || otp.length !== 6) { showMsg('fpw-reset-msg', 'Enter the 6-digit code.', 'err'); return; }
  if (!newpw || newpw.length < 6) { showMsg('fpw-reset-msg', 'New password must be at least 6 characters.', 'err'); return; }
  showMsg('fpw-reset-msg', '⏳ Verifying…', 'ok');
  try {
    var r = await withTimeout(
      db.from('admin_users').select('id,reset_token,reset_expires').eq('username', username).eq('is_active', true).maybeSingle(),
      5000
    );
    if (!r.data || !r.data.reset_token)           { showMsg('fpw-reset-msg', 'No reset request found — please start over.', 'err'); return; }
    if (new Date(r.data.reset_expires) < new Date()) { showMsg('fpw-reset-msg', 'Code expired — request a new one.', 'err'); return; }
    if (await sha256(otp) !== r.data.reset_token)  { showMsg('fpw-reset-msg', 'Incorrect code. Try again.', 'err'); return; }
    await withTimeout(
      db.from('admin_users').update({ password_hash: await sha256(newpw), reset_token: null, reset_expires: null }).eq('id', r.data.id),
      5000
    );
    showMsg('fpw-reset-msg', '✅ Password reset! You can now log in.', 'ok');
    setTimeout(hideForgotPw, 2000);
  } catch(e) { showMsg('fpw-reset-msg', 'Error: ' + e.message, 'err'); }
}

// ── Admin Tabs ────────────────────────────────────────────
function switchTab(btn, name) {
  document.querySelectorAll('#admin-tabs .tab').forEach(function(t) { t.classList.remove('active'); });
  btn.classList.add('active');
  document.querySelectorAll('#pg-admin .tab-pane').forEach(function(p) { p.classList.remove('active'); });
  document.getElementById(name).classList.add('active');
  if (name === 'a-dash')    loadDashboard();
  if (name === 'a-workers') loadWorkers();
  if (name === 'a-admins')  loadCoAdmins();
  if (name === 'a-absent')  loadAbsent();
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
    var absentCard = document.getElementById('s-absent').closest('.stat-card');
    if (absentCard) {
      absentCard.style.cursor = 'pointer';
      absentCard.title = 'View absent workers';
      absentCard.onclick = function() {
        var btn = document.querySelector('#admin-tabs .tab[onclick*="a-absent"]');
        if (btn) { btn.click(); }
      };
    }
    var el = document.getElementById('dash-activity');
    el.innerHTML = recs.length
      ? recs.slice(0, 15).map(function(r) {
          return '<div class="act-item">' +
            '<div><div class="act-name">' + (r.w ? r.w.name : 'Unknown') + '</div>' +
            '<div class="act-time">' + fmtTime(r.clock_in_time) + (r.clock_out_time ? ' → ' + fmtTime(r.clock_out_time) : '') + ' · ' + (r.auth_method || '') + '</div></div>' +
            '<span class="act-tag ' + (r.clock_out_time ? 'tag-out' : 'tag-in') + '">' + (r.clock_out_time ? 'Done' : 'Active') + '</span>' +
            '</div>';
        }).join('')
      : '<div class="empty">No clock-ins today</div>';
  } catch (e) { document.getElementById('dash-activity').innerHTML = '<div class="empty">Failed to load</div>'; }
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
        '<div><div class="row-name">' + w.name + '</div>' +
        '<div class="row-meta">' + w.employee_id + (w.job_title ? ' · ' + w.job_title : '') + '</div></div>' +
        '</div>' +
        '<span class="badge-absent">Not In</span>' +
        '</div>';
    }).join('') + '</div>';
  } catch(e) { el.innerHTML = '<div class="empty">Error: ' + e.message + '</div>'; }
}

async function forceClockOut(attId, workerName) {
  if (!confirm('Force clock out "' + workerName + '"?\nClock-out time will be set to now.')) return;
  try {
    var r = await withTimeout(
      db.from('attendance').update({ clock_out_time: new Date().toISOString(), status: 'completed' }).eq('id', attId),
      5000
    );
    if (!r.error) { toast('✅ ' + workerName + ' clocked out'); loadAttendance(); }
    else toast('Error: ' + r.error.message);
  } catch(e) { toast('Error: ' + e.message); }
}

// ── Workers (Admin) ───────────────────────────────────────
async function loadWorkers() {
  var el = document.getElementById('workers-list');
  el.innerHTML = '<div class="empty">Loading…</div>';
  var cid = requireAdminCid(); if (!cid) return;
  try {
    var r = await withTimeout(db.from('workers').select('*').eq('company_id', cid).order('name'), 5000);
    if (r.error || !r.data) { el.innerHTML = '<div class="empty">Failed to load</div>'; return; }
    if (!r.data.length) { el.innerHTML = '<div class="empty">No workers yet — add one above</div>'; return; }
    r.data.forEach(function(w) { _wCache[w.id] = Object.assign({}, w, { _ctx: 'admin' }); });
    el.innerHTML = '<div class="card" style="padding:0 18px">' + r.data.map(function(w) {
      var isLocked = w.locked_until && new Date(w.locked_until) > new Date();
      var meta = w.employee_id + (w.job_title ? ' · ' + w.job_title : '')
        + (w.biometric_enabled ? ' · 🔏' : '') + (w.face_descriptor ? ' · 🤳' : '')
        + (w.device_id         ? ' · 📱' : '') + (isLocked ? ' · 🔒' : '')
        + (!w.is_active ? ' · <em>Inactive</em>' : '');
      return '<div class="list-row">' +
        '<div class="row-info"><div class="av av-sm">' + initials(w.name) + '</div>' +
        '<div><div class="row-name">' + w.name + '</div>' +
        '<div class="row-meta">' + meta + '</div></div></div>' +
        '<div class="row-btns">' +
        '<button class="icon-btn" title="Edit" onclick="openEditWorker(\'' + w.id + '\')">✏️</button>' +
        '<button class="icon-btn" title="Enrol face" onclick="adminEnrollFace(\'' + w.id + '\',\'' + escQ(w.name) + '\',\'admin\')">🤳</button>' +
        '<button class="icon-btn" title="Register biometric" onclick="adminRegBio(\'' + w.id + '\',\'' + escQ(w.name) + '\')">🔏</button>' +
        '<button class="icon-btn" title="Reset device &amp; unlock" onclick="resetWorkerSecurity(\'' + w.id + '\',\'' + escQ(w.name) + '\')">🛡</button>' +
        '<button class="icon-btn" title="' + (w.is_active ? 'Deactivate' : 'Activate') + '" onclick="toggleWorker(\'' + w.id + '\',' + w.is_active + ')">' + (w.is_active ? '🚫' : '✅') + '</button>' +
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
  try {
    var hashedPin = await sha256(pin);
    var wpR = await withTimeout(db.from('workplaces').select('id').eq('company_id', cid).limit(1), 5000);
    var r   = await withTimeout(db.from('workers').insert({
      employee_id:      empId,
      name:             name,
      job_title:        job || null,
      pin:              hashedPin,
      force_pin_change: true,
      workplace_id:     (wpR.data && wpR.data[0]) ? wpR.data[0].id : null,
      company_id:       cid,
      is_active:        true
    }).select('id,name,employee_id').single(), 5000);
    if (r.error) {
      showMsg('nw-msg', r.error.message.includes('unique') ? 'Employee ID already exists.' : r.error.message, 'err'); return;
    }
    _newWorkerId   = r.data.id;
    _newWorkerName = r.data.name;
    _newWorkerEmpId = r.data.employee_id;
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
  var r = await withTimeout(db.from('workers').update({ is_active: !cur }).eq('id', id), 5000);
  if (!r.error) { toast(cur ? 'Worker deactivated' : 'Worker reactivated'); loadWorkers(); }
}
async function resetWorkerSecurity(id, name) {
  if (!confirm('Reset security for "' + name + '"?\n\n• Removes device binding (they can register a new device)\n• Clears any account lockout\n• Invalidates active session')) return;
  try {
    var r = await withTimeout(
      db.from('workers').update({ device_id: null, session_token: null, failed_attempts: 0, locked_until: null }).eq('id', id),
      5000
    );
    if (r.error) { toast('Error: ' + r.error.message); return; }
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
    var r = await withTimeout(db.from('workers').update({ biometric_credential_id: b64(cred.rawId), biometric_enabled: true }).eq('id', workerId), 5000);
    if (r.error) throw r.error;
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
      return '<option value="' + w.id + '">' + w.name + (w.job_title ? ' · ' + w.job_title : '') + ' (' + w.employee_id + ')</option>';
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
    if (!r.data || !r.data.length) { el.innerHTML = '<div class="empty">No records match the filters</div>'; return; }
    var totalHrs = r.data.reduce(function(s, rec) {
      return s + (rec.clock_in_time && rec.clock_out_time ? (new Date(rec.clock_out_time) - new Date(rec.clock_in_time)) / 3600000 : 0);
    }, 0);
    var stillin = r.data.filter(function(rec) { return rec.status === 'active'; }).length;
    showMsg('att-summary', r.data.length + ' records · ' + totalHrs.toFixed(1) + 'h total · ' + stillin + ' still in', 'ok');
    el.innerHTML = '<div class="card" style="padding:0 18px">' + r.data.map(function(rec) {
      var hrs = (rec.clock_in_time && rec.clock_out_time) ? ((new Date(rec.clock_out_time) - new Date(rec.clock_in_time)) / 3600000).toFixed(1) + 'h' : '--';
      return '<div class="att-row">' +
        '<div class="att-name">' + (rec.w ? rec.w.name : 'Unknown') +
          (rec.w && rec.w.employee_id ? ' <small style="color:var(--muted)">(' + rec.w.employee_id + ')</small>' : '') +
          (rec.w && rec.w.job_title   ? ' <small style="color:var(--blue)">· ' + rec.w.job_title + '</small>' : '') +
        '</div>' +
        '<div class="att-date">' + fmtDate(rec.clock_in_time) + '</div>' +
        '<div class="att-chips">' +
          '<span class="chip chip-in">▶ '  + fmtTime(rec.clock_in_time) + '</span>' +
          '<span class="chip chip-out">⏹ ' + (rec.clock_out_time ? fmtTime(rec.clock_out_time) : 'Still in') + '</span>' +
          '<span class="chip chip-hrs">⏱ ' + hrs + '</span>' +
          '<span class="chip chip-mth">'   + (rec.auth_method || '') + '</span>' +
          (!rec.clock_out_time ? '<button class="btn btn-sm btn-outline" style="margin-left:6px;color:var(--red);border-color:var(--red);padding:2px 8px;font-size:.72rem" onclick="forceClockOut(\'' + rec.id + '\',\'' + escQ(rec.w ? rec.w.name : 'Worker') + '\')">Force Out</button>' : '') +
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
    var hdr  = ['Worker Name', 'Employee ID', 'Job Title', 'Date', 'Clock In', 'Clock Out', 'Hours', 'Auth Method', 'Status'];
    var rows = r.data.map(function(rec) {
      var cin  = rec.clock_in_time  ? new Date(rec.clock_in_time)  : null;
      var cout = rec.clock_out_time ? new Date(rec.clock_out_time) : null;
      var hrs  = (cin && cout) ? ((cout - cin) / 3600000).toFixed(2) : '';
      return [
        rec.w ? rec.w.name : '', rec.w ? rec.w.employee_id : '', rec.w ? rec.w.job_title || '' : '',
        cin  ? fmtDate(rec.clock_in_time) : '',
        cin  ? fmtTime(rec.clock_in_time) : '',
        cout ? fmtTime(rec.clock_out_time) : 'Still In',
        hrs ? hrs + 'h' : '', rec.auth_method || '', rec.status || ''
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

// ── Company Admins ────────────────────────────────────────
async function loadCoAdmins() {
  var el = document.getElementById('co-admins-list');
  el.innerHTML = '<div class="empty">Loading…</div>';
  var cid = requireAdminCid(); if (!cid) return;
  try {
    var r = await withTimeout(
      db.from('admin_users').select('*').eq('company_id', cid).neq('role', 'developer').order('full_name'),
      5000
    );
    if (r.error || !r.data) { el.innerHTML = '<div class="empty">Failed to load</div>'; return; }
    if (!r.data.length) { el.innerHTML = '<div class="empty">No admins yet — create one above</div>'; return; }
    el.innerHTML = '<div class="card" style="padding:0 18px">' + r.data.map(function(a) {
      var col = ROLE_COLORS[a.role] || 'var(--blue)';
      return '<div class="list-row">' +
        '<div class="row-info"><div class="av av-sm" style="background:' + col + '">' + initials(a.full_name || a.username) + '</div>' +
        '<div><div class="row-name">' + (a.full_name || a.username) + ' <small style="color:var(--muted)">@' + a.username + '</small></div>' +
        '<div class="row-meta"><span class="role-pill" style="background:' + col + '22;color:' + col + '">' +
          (ROLE_LABELS[a.role] || a.role) + '</span>' +
          (a.email ? ' · ' + a.email : '') + (!a.is_active ? ' · <em>Inactive</em>' : '') +
        '</div></div></div>' +
        '<div class="row-btns">' +
        '<button class="icon-btn" onclick="openEditAcct(\'' + a.id + '\',\'' + escQ(a.full_name || '') + '\',\'' + escQ(a.email || '') + '\',\'' + a.role + '\',\'sa\')">✏️</button>' +
        '<button class="icon-btn" onclick="resetPw(\'' + a.id + '\',\'' + escQ(a.username) + '\')">🔑</button>' +
        '<button class="icon-btn" onclick="toggleAdmin(\'' + a.id + '\',' + a.is_active + ')">' + (a.is_active ? '🚫' : '✅') + '</button>' +
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
    var r = await withTimeout(db.from('admin_users').insert({
      username: user, password_hash: await sha256(pass), full_name: name, email: email || null,
      role: role, company_id: cid, is_active: true
    }), 5000);
    if (r.error) { showMsg('ca-msg', r.error.message.includes('unique') ? 'Username already exists.' : r.error.message, 'err'); return; }
    showMsg('ca-msg', '✅ ' + (ROLE_LABELS[role] || role) + ' "@' + user + '" created!', 'ok');
    ['ca-name', 'ca-user', 'ca-pass', 'ca-email'].forEach(function(id) { document.getElementById(id).value = ''; });
    setTimeout(function() { toggleAddAdmin(); loadCoAdmins(); }, 1400);
  } catch (e) { showMsg('ca-msg', 'Error: ' + e.message, 'err'); }
}
async function toggleAdmin(id, cur) {
  var r = await withTimeout(db.from('admin_users').update({ is_active: !cur }).eq('id', id), 5000);
  if (!r.error) { toast(cur ? 'Admin deactivated' : 'Admin reactivated'); loadCoAdmins(); }
}
async function resetPw(id, username) {
  var pw = prompt('Set new password for @' + username + ':');
  if (!pw) return;
  if (pw.length < 6) { toast('Password must be at least 6 characters.'); return; }
  var r = await withTimeout(db.from('admin_users').update({ password_hash: await sha256(pw) }).eq('id', id), 5000);
  if (!r.error) toast('✅ Password updated for @' + username);
  else toast('Error: ' + r.error.message);
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
    var exR     = await withTimeout(db.from('workplaces').select('id').eq('company_id', cid).limit(1), 5000);
    var payload = { name: name, address: addr, latitude: lat, longitude: lng, radius_meters: radius, company_id: cid };
    var r = exR.data && exR.data.length
      ? await withTimeout(db.from('workplaces').update(payload).eq('id', exR.data[0].id), 5000)
      : await withTimeout(db.from('workplaces').insert(payload), 5000);
    if (r.error) { showMsg('wp-msg', 'Save failed: ' + r.error.message, 'err'); return; }
    showMsg('wp-msg', '✅ Workplace saved!', 'ok');
    var wpR = await withTimeout(db.from('workplaces').select('id').eq('company_id', cid).limit(1), 5000);
    if (wpR.data && wpR.data[0]) {
      await withTimeout(db.from('workers').update({ workplace_id: wpR.data[0].id }).eq('company_id', cid).is('workplace_id', null), 5000);
    }
  } catch (e) { showMsg('wp-msg', 'Error: ' + e.message, 'err'); }
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
  var r = await withTimeout(db.from('admin_users').update({ full_name: name, email: email || null }).eq('id', S.admin.id), 5000);
  if (r.error) { showMsg('profile-msg', 'Failed: ' + r.error.message, 'err'); return; }
  S.admin.full_name = name; S.admin.email = email;
  showMsg('profile-msg', '✅ Profile updated!', 'ok');
}
async function changeAdminPw() {
  var pw = document.getElementById('new-pw').value;
  if (!pw || pw.length < 6) { showMsg('pw-msg', 'Password must be at least 6 characters.', 'err'); return; }
  var r = await withTimeout(db.from('admin_users').update({ password_hash: await sha256(pw) }).eq('id', S.admin.id), 5000);
  if (r.error) showMsg('pw-msg', 'Failed: ' + r.error.message, 'err');
  else { showMsg('pw-msg', '✅ Password updated!', 'ok'); document.getElementById('new-pw').value = ''; }
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
  var updates = { employee_id: empId, name: name, job_title: job || null };
  if (pin) { updates.pin = await sha256(pin); updates.force_pin_change = false; }
  try {
    var r = await withTimeout(db.from('workers').update(updates).eq('id', id), 5000);
    if (r.error) { showMsg('ewk-msg', r.error.message.includes('unique') ? 'Employee ID already in use.' : r.error.message, 'err'); return; }
    showMsg('ewk-msg', '✅ Worker updated!', 'ok');
    setTimeout(function() {
      closeModal('modal-edit-worker');
      if (ctx === 'dev') loadDevWorkers(); else loadWorkers();
    }, 1200);
  } catch (e) { showMsg('ewk-msg', 'Error: ' + e.message, 'err'); }
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
  var updates = { full_name: name, email: email || null };
  if (pw) updates.password_hash = await sha256(pw);
  var wrap = document.getElementById('eac-role-wrap');
  if (!wrap.classList.contains('hidden')) updates.role = document.getElementById('eac-role').value;
  try {
    var r = await withTimeout(db.from('admin_users').update(updates).eq('id', id), 5000);
    if (r.error) { showMsg('eac-msg', 'Failed: ' + r.error.message, 'err'); return; }
    showMsg('eac-msg', '✅ Account updated!', 'ok');
    setTimeout(function() {
      closeModal('modal-edit-acct');
      if (ctx === 'dev') loadDevAccounts(); else loadCoAdmins();
    }, 1200);
  } catch (e) { showMsg('eac-msg', 'Error: ' + e.message, 'err'); }
}

// ── Developer Panel ───────────────────────────────────────
function devLogout() { S.admin = null; showPg('home'); }
function switchDevTab(btn, name) {
  document.querySelectorAll('#dev-tabs .tab').forEach(function(t) { t.classList.remove('active'); });
  btn.classList.add('active');
  document.querySelectorAll('#pg-developer .tab-pane').forEach(function(p) { p.classList.remove('active'); });
  document.getElementById(name).classList.add('active');
  if (name === 'd-cos')      loadDevCos();
  if (name === 'd-accounts') loadDevAccounts();
  if (name === 'd-workers')  loadDevWorkers();
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
    el.innerHTML = '<div class="card" style="padding:0 18px">' + r.data.map(function(c) {
      return '<div class="list-row">' +
        '<div class="row-info"><div class="av av-sm" style="background:var(--purple)">' + c.code.slice(0, 2) + '</div>' +
        '<div><div class="row-name">' + c.name + '</div><div class="row-meta">Code: ' + c.code + (!c.is_active ? ' · <em>Inactive</em>' : '') + '</div></div></div>' +
        '<div class="row-btns">' +
        '<button class="icon-btn" onclick="openEditCo(\'' + c.id + '\')">✏️</button>' +
        '<button class="icon-btn" onclick="devToggleCo(\'' + c.id + '\',' + c.is_active + ')">' + (c.is_active ? '🚫' : '✅') + '</button>' +
        '</div></div>';
    }).join('') + '</div>';
  } catch (e) { el.innerHTML = '<div class="empty">Error: ' + e.message + '</div>'; }
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
  try {
    var r = await withTimeout(db.from('companies').insert({ name: name, code: code, is_active: true, clock_methods: methods }), 5000);
    if (r.error) { showMsg('nc-msg', r.error.message.includes('unique') ? 'Code already exists.' : r.error.message, 'err'); return; }
    showMsg('nc-msg', '✅ Company "' + name + '" created!', 'ok');
    document.getElementById('nc-name').value = ''; document.getElementById('nc-code').value = '';
    document.getElementById('nc-face').checked = false; document.getElementById('nc-bio').checked = false;
    setTimeout(function() { toggleAddCo(); loadDevCos(); }, 1400);
  } catch (e) { showMsg('nc-msg', 'Error: ' + e.message, 'err'); }
}
async function devToggleCo(id, cur) {
  var r = await withTimeout(db.from('companies').update({ is_active: !cur }).eq('id', id), 5000);
  if (!r.error) { toast(cur ? 'Company deactivated' : 'Company reactivated'); loadDevCos(); }
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
    var r = await withTimeout(db.from('companies').update({ name: name, code: code, clock_methods: methods }).eq('id', id), 5000);
    if (r.error) { showMsg('eco-msg', r.error.message.includes('unique') ? 'Code already exists.' : r.error.message, 'err'); return; }
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
        return '<option value="' + c.id + '">' + c.name + '</option>';
      }).join('');
    } catch (e) {}
  }
  try {
    var q   = db.from('admin_users').select('*, co:companies(name,code)').neq('role', 'developer').order('full_name');
    var fco = filterSel.value;
    if (fco) q = q.eq('company_id', fco);
    var r = await withTimeout(q, 5000);
    if (r.error || !r.data) { el.innerHTML = '<div class="empty">Failed to load</div>'; return; }
    if (!r.data.length) { el.innerHTML = '<div class="empty">No accounts yet</div>'; return; }
    el.innerHTML = '<div class="card" style="padding:0 18px">' + r.data.map(function(a) {
      var col = ROLE_COLORS[a.role] || 'var(--blue)';
      return '<div class="list-row">' +
        '<div class="row-info"><div class="av av-sm" style="background:' + col + '">' + initials(a.full_name || a.username) + '</div>' +
        '<div><div class="row-name">' + (a.full_name || a.username) + ' <small style="color:var(--muted)">@' + a.username + '</small></div>' +
        '<div class="row-meta"><span class="role-pill" style="background:' + col + '22;color:' + col + '">' +
          (ROLE_LABELS[a.role] || a.role) + '</span> 🏢 ' + (a.co ? a.co.name : '—') +
          (!a.is_active ? ' · <em>Inactive</em>' : '') +
        '</div></div></div>' +
        '<div class="row-btns">' +
        '<button class="icon-btn" onclick="openEditAcct(\'' + a.id + '\',\'' + escQ(a.full_name || '') + '\',\'' + escQ(a.email || '') + '\',\'' + a.role + '\',\'dev\')">✏️</button>' +
        '<button class="icon-btn" onclick="resetPw(\'' + a.id + '\',\'' + escQ(a.username) + '\')">🔑</button>' +
        '<button class="icon-btn" onclick="devToggleAcct(\'' + a.id + '\',' + a.is_active + ')">' + (a.is_active ? '🚫' : '✅') + '</button>' +
        '</div></div>';
    }).join('') + '</div>';
  } catch (e) { el.innerHTML = '<div class="empty">Error: ' + e.message + '</div>'; }
}
function toggleAddDevAcct() {
  var p = document.getElementById('add-dev-acct-panel'); p.classList.toggle('hidden');
  if (!p.classList.contains('hidden')) {
    withTimeout(db.from('companies').select('id,name').eq('is_active', true).order('name'), 5000)
      .then(function(r) {
        document.getElementById('da-company').innerHTML = '<option value="">Select Company…</option>' +
          (r.data || []).map(function(c) { return '<option value="' + c.id + '">' + c.name + '</option>'; }).join('');
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
    var r = await withTimeout(db.from('admin_users').insert({
      username: user, password_hash: await sha256(pass), full_name: name, email: email || null,
      role: role, company_id: cid, is_active: true
    }), 5000);
    if (r.error) { showMsg('da-msg', r.error.message.includes('unique') ? 'Username already exists.' : r.error.message, 'err'); return; }
    showMsg('da-msg', '✅ ' + (ROLE_LABELS[role] || role) + ' "@' + user + '" created!', 'ok');
    ['da-name', 'da-user', 'da-pass', 'da-email'].forEach(function(id) { document.getElementById(id).value = ''; });
    setTimeout(function() { toggleAddDevAcct(); loadDevAccounts(); }, 1400);
  } catch (e) { showMsg('da-msg', 'Error: ' + e.message, 'err'); }
}
async function devToggleAcct(id, cur) {
  var r = await withTimeout(db.from('admin_users').update({ is_active: !cur }).eq('id', id), 5000);
  if (!r.error) { toast(cur ? 'Account deactivated' : 'Account reactivated'); loadDevAccounts(); }
}
async function loadDevWorkers() {
  var el  = document.getElementById('dev-workers-list');
  var sel = document.getElementById('dev-filter-co-wk');
  if (sel.options.length <= 1) {
    try {
      var cosR = await withTimeout(db.from('companies').select('id,name').eq('is_active', true).order('name'), 5000);
      sel.innerHTML = '<option value="">Select a company…</option>' + (cosR.data || []).map(function(c) {
        return '<option value="' + c.id + '">' + c.name + '</option>';
      }).join('');
    } catch (e) {}
  }
  var cid = sel.value;
  if (!cid) { el.innerHTML = '<div class="empty">Select a company above</div>'; return; }
  el.innerHTML = '<div class="empty">Loading…</div>';
  try {
    var r = await withTimeout(db.from('workers').select('*').eq('company_id', cid).order('name'), 5000);
    if (r.error || !r.data) { el.innerHTML = '<div class="empty">Failed to load</div>'; return; }
    if (!r.data.length) { el.innerHTML = '<div class="empty">No workers in this company</div>'; return; }
    r.data.forEach(function(w) { _wCache[w.id] = Object.assign({}, w, { _ctx: 'dev' }); });
    el.innerHTML = '<div class="card" style="padding:0 18px">' + r.data.map(function(w) {
      return '<div class="list-row">' +
        '<div class="row-info"><div class="av av-sm">' + initials(w.name) + '</div>' +
        '<div><div class="row-name">' + w.name + '</div>' +
        '<div class="row-meta">' + w.employee_id + (w.job_title ? ' · ' + w.job_title : '') +
          (w.biometric_enabled ? ' · 🔏' : '') + (w.face_descriptor ? ' · 🤳' : '') +
          (!w.is_active ? ' · <em>Inactive</em>' : '') +
        '</div></div></div>' +
        '<div class="row-btns">' +
        '<button class="icon-btn" onclick="openEditWorker(\'' + w.id + '\')">✏️</button>' +
        '<button class="icon-btn" onclick="adminEnrollFace(\'' + w.id + '\',\'' + escQ(w.name) + '\',\'dev\')">🤳</button>' +
        '<button class="icon-btn" onclick="devToggleWorker(\'' + w.id + '\',' + w.is_active + ')">' + (w.is_active ? '🚫' : '✅') + '</button>' +
        '</div></div>';
    }).join('') + '</div>';
  } catch (e) { el.innerHTML = '<div class="empty">Error: ' + e.message + '</div>'; }
}
async function devToggleWorker(id, cur) {
  var r = await withTimeout(db.from('workers').update({ is_active: !cur }).eq('id', id), 5000);
  if (!r.error) { toast(cur ? 'Worker deactivated' : 'Worker reactivated'); loadDevWorkers(); }
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
  var r = await withTimeout(db.from('admin_users').update({ full_name: name, email: email || null }).eq('id', S.admin.id), 5000);
  if (r.error) { showMsg('dev-profile-msg', 'Failed: ' + r.error.message, 'err'); return; }
  S.admin.full_name = name; S.admin.email = email;
  showMsg('dev-profile-msg', '✅ Profile updated!', 'ok');
}
async function changeDevPw() {
  var pw = document.getElementById('dev-new-pw').value;
  if (!pw || pw.length < 6) { showMsg('dev-pw-msg', 'Password must be at least 6 characters.', 'err'); return; }
  var r = await withTimeout(db.from('admin_users').update({ password_hash: await sha256(pw) }).eq('id', S.admin.id), 5000);
  if (r.error) showMsg('dev-pw-msg', 'Failed: ' + r.error.message, 'err');
  else { showMsg('dev-pw-msg', '✅ Password updated!', 'ok'); document.getElementById('dev-new-pw').value = ''; }
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

  // 2. Show home page immediately and start home clock
  showPg('home');
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

  // 4. Background async: verify company from Supabase + restore worker session
  (async function() {
    try { await withTimeout(initCompany(), 4000); } catch (e) {}

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
