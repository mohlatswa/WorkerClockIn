'use strict';

// ── App State ────────────────────────────────────────
const S = {
  worker:       null,
  admin:        null,
  workplace:    null,
  userLoc:      null,
  geoWatcher:   null,
  clockStatus:  'out',
  attendanceId: null,
  authMethod:   'pin',
  scanStream:   null,
  scanRunning:  false,
  nfcReader:    null,
  npPin:        [],
  npAutoTimer:  null,
  authSource:   'manual', // 'manual' | 'card'
};

// ── Navigation ───────────────────────────────────────
function showPage(id) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  const el = document.getElementById(`page-${id}`);
  if (el) { el.classList.add('active'); window.scrollTo(0, 0); }
}

// ── Utilities ────────────────────────────────────────
const initials = n => (n || '??').split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);

function haversineM(la1, lo1, la2, lo2) {
  const R = 6_371_000, r = d => d * Math.PI / 180;
  const dlat = r(la2 - la1), dlon = r(lo2 - lo1);
  const a = Math.sin(dlat/2)**2 + Math.cos(r(la1)) * Math.cos(r(la2)) * Math.sin(dlon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const b64    = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64  = s   => { const b = atob(s); const a = new Uint8Array(b.length); for (let i=0;i<b.length;i++) a[i]=b.charCodeAt(i); return a.buffer; };

let _toast;
function toast(msg, dur = 3000) {
  const el = document.getElementById('toast');
  el.textContent = msg; el.classList.remove('hidden');
  clearTimeout(_toast);
  _toast = setTimeout(() => el.classList.add('hidden'), dur);
}

function showErr(id, msg) {
  const el = document.getElementById(id);
  if (!el) return;
  if (!msg) { el.classList.add('hidden'); return; }
  el.textContent = msg; el.classList.remove('hidden');
}

function showMsg(id, msg, type) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = msg; el.className = `msg ${type}`; el.classList.remove('hidden');
  if (type === 'ok') setTimeout(() => el.classList.add('hidden'), 3500);
}

function vibrate(ms = 50) { navigator.vibrate?.(ms); }

// ── Live Clock ───────────────────────────────────────
function startClock() {
  const tick = () => {
    const n = new Date();
    const t = document.getElementById('live-time');
    const d = document.getElementById('live-date');
    if (t) t.textContent = n.toLocaleTimeString('en-ZA', { hour:'2-digit', minute:'2-digit', second:'2-digit' });
    if (d) d.textContent = n.toLocaleDateString('en-ZA', { weekday:'long', year:'numeric', month:'long', day:'numeric' });
  };
  tick(); setInterval(tick, 1000);
}

// ════════════════════════════════════════════════════
//  QR SCANNER
// ════════════════════════════════════════════════════
async function openScanner() {
  showPage('scan');
  document.getElementById('scan-status').textContent = 'Searching for QR code…';

  try {
    S.scanStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } }
    });
    const video = document.getElementById('qr-video');
    video.srcObject = S.scanStream;
    await video.play();
    S.scanRunning = true;
    requestAnimationFrame(scanFrame);
  } catch (err) {
    document.getElementById('scan-status').textContent =
      err.name === 'NotAllowedError'
        ? '❌ Camera access denied — allow camera in your browser settings'
        : '❌ Could not open camera: ' + err.message;
  }
}

function scanFrame() {
  if (!S.scanRunning) return;
  const video  = document.getElementById('qr-video');
  const canvas = document.getElementById('qr-canvas');
  if (video.readyState === video.HAVE_ENOUGH_DATA) {
    canvas.width  = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0);
    const img  = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const code = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
    if (code) {
      vibrate(80);
      stopScanner();
      handleCardRead(code.data.trim().toUpperCase());
      return;
    }
  }
  requestAnimationFrame(scanFrame);
}

function stopScanner() {
  S.scanRunning = false;
  if (S.scanStream) { S.scanStream.getTracks().forEach(t => t.stop()); S.scanStream = null; }
}

// ════════════════════════════════════════════════════
//  NFC READER
// ════════════════════════════════════════════════════
async function openNFC() {
  if (!('NDEFReader' in window)) {
    // Show NFC page with "not supported" message
    showPage('nfc');
    document.getElementById('nfc-hint').textContent = '⚠️ NFC is not supported on this browser (requires Android + Chrome)';
    showErr('nfc-err', 'NFC is not available. Please use QR scan or Enter ID instead.');
    return;
  }
  showPage('nfc');
  document.getElementById('nfc-hint').textContent = 'Ready — tap your NFC card to the back of the phone';
  try {
    S.nfcReader = new NDEFReader();
    await S.nfcReader.scan();
    S.nfcReader.addEventListener('reading', ({ message }) => {
      const dec = new TextDecoder();
      for (const rec of message.records) {
        if (rec.recordType === 'text') {
          const empId = dec.decode(rec.data).trim().toUpperCase();
          vibrate(80);
          stopNFC();
          handleCardRead(empId);
          return;
        }
      }
      showErr('nfc-err', 'Card read but no employee ID found. Check NFC card format.');
    });
    S.nfcReader.addEventListener('readingerror', () => {
      showErr('nfc-err', 'Could not read NFC card. Try again.');
    });
  } catch (err) {
    const msg = err.name === 'NotAllowedError'
      ? 'NFC permission denied. Allow NFC in browser settings.'
      : err.message;
    showErr('nfc-err', msg);
  }
}

function stopNFC() {
  S.nfcReader = null; // NDEFReader has no explicit stop; reassigning clears handlers
}

// ════════════════════════════════════════════════════
//  CARD READ (from QR or NFC) → lookup worker
// ════════════════════════════════════════════════════
async function handleCardRead(empId) {
  toast('🔍 Looking up card…');
  S.authSource = 'card';
  document.getElementById('inp-empid').value = empId;
  await findWorker(empId);
}

// ════════════════════════════════════════════════════
//  WORKER LOOKUP
// ════════════════════════════════════════════════════
async function findWorker(overrideId) {
  const id = overrideId
    ? overrideId
    : (document.getElementById('inp-empid').value || '').trim().toUpperCase();

  showErr('err-empid', '');
  if (!id) { showErr('err-empid', 'Please enter your Employee ID.'); return; }

  try {
    const { data, error } = await db
      .from('workers')
      .select('*, workplace:workplaces(*)')
      .eq('employee_id', id)
      .eq('is_active', true)
      .maybeSingle();

    if (error || !data) {
      if (S.authSource === 'card') {
        toast(`❌ Card not recognised (${id})`);
        showPage('home');
      } else {
        showErr('err-empid', 'Employee ID not found. Check with your manager.');
      }
      return;
    }

    S.worker = data;
    goToAuth(data);
  } catch {
    if (S.authSource === 'card') { toast('❌ Connection error'); showPage('home'); }
    else showErr('err-empid', 'Connection error. Check internet and try again.');
  }
}

// ── Move to auth screen ──────────────────────────────
function goToAuth(worker) {
  document.getElementById('auth-avatar').textContent = initials(worker.name);
  document.getElementById('auth-name').textContent   = worker.name;
  document.getElementById('auth-empid').textContent  = worker.employee_id;

  const bioWrap = document.getElementById('bio-btn-wrap');
  if (worker.biometric_enabled && worker.biometric_credential_id && window.PublicKeyCredential) {
    bioWrap.classList.remove('hidden');
    // Fast flow for card: auto-prompt biometric immediately
    if (S.authSource === 'card') {
      showPage('auth');
      npReset();
      setTimeout(authenticateWithBiometric, 400);
      return;
    }
  } else {
    bioWrap.classList.add('hidden');
  }

  showPage('auth');
  npReset();
}

function backFromAuth() {
  S.worker     = null;
  S.authSource = 'manual';
  showPage('home');
}

// ════════════════════════════════════════════════════
//  PIN NUMPAD
// ════════════════════════════════════════════════════
function npReset() {
  S.npPin = [];
  clearTimeout(S.npAutoTimer);
  renderDots();
  showErr('err-auth', '');
}

function npPress(d) {
  if (S.npPin.length >= 6) return;
  S.npPin.push(d);
  renderDots();
  vibrate(20);
  clearTimeout(S.npAutoTimer);
  if (S.npPin.length >= 4) {
    S.npAutoTimer = setTimeout(verifyPin, 600);
  }
}

function npBack() {
  S.npPin.pop();
  renderDots();
  clearTimeout(S.npAutoTimer);
  showErr('err-auth', '');
}

function npClear() {
  npReset();
}

function renderDots() {
  for (let i = 0; i < 6; i++) {
    const dot = document.getElementById(`pd${i}`);
    if (dot) dot.classList.toggle('filled', i < S.npPin.length);
  }
}

function verifyPin() {
  const entered = S.npPin.join('');
  if (!S.worker) return;
  if (entered !== String(S.worker.pin)) {
    vibrate([50, 30, 50]);
    showErr('err-auth', 'Incorrect PIN — try again');
    npReset();
    return;
  }
  showErr('err-auth', '');
  S.authMethod = 'pin';
  enterClockScreen();
}

// ════════════════════════════════════════════════════
//  BIOMETRIC (WebAuthn)
// ════════════════════════════════════════════════════
async function authenticateWithBiometric() {
  showErr('err-auth', '');
  if (!window.PublicKeyCredential) { showErr('err-auth', 'Biometric not supported on this browser.'); return; }

  try {
    const challenge = crypto.getRandomValues(new Uint8Array(32));
    const cred = await navigator.credentials.get({
      publicKey: {
        challenge,
        allowCredentials: [{ id: unb64(S.worker.biometric_credential_id), type: 'public-key', transports: ['internal'] }],
        userVerification: 'required',
        timeout: 60000,
      },
    });
    if (cred) { S.authMethod = 'biometric'; enterClockScreen(); }
  } catch (err) {
    if (err.name === 'NotAllowedError') showErr('err-auth', 'Biometric cancelled — please use PIN instead.');
    else showErr('err-auth', 'Biometric error: ' + err.message);
  }
}

// ════════════════════════════════════════════════════
//  CLOCK SCREEN
// ════════════════════════════════════════════════════
async function enterClockScreen() {
  const w = S.worker;
  document.getElementById('clock-avatar').textContent   = initials(w.name);
  document.getElementById('clock-name').textContent     = w.name;
  document.getElementById('clock-empid').textContent    = w.employee_id;
  document.getElementById('clock-greeting').textContent = `Hello, ${w.name.split(' ')[0]}!`;
  S.workplace = w.workplace || null;

  showPage('clock');
  startClock();
  await refreshClockStatus();
  startGeoWatch();

  // Show biometric registration if not yet set and WebAuthn supported
  document.getElementById('bio-reg-card').style.display =
    (!w.biometric_enabled && window.PublicKeyCredential) ? 'block' : 'none';
}

// ── Geolocation watcher ──────────────────────────────
function startGeoWatch() {
  const locEl = document.getElementById('loc-status');
  locEl.innerHTML = '<div class="checking"><div class="spin-sm"></div> Getting your location…</div>';

  if (!navigator.geolocation) {
    showLocationBlocked('This device does not support GPS. Location is required to clock in.');
    return;
  }

  if (S.geoWatcher) navigator.geolocation.clearWatch(S.geoWatcher);

  // Check permission state before watching (Permissions API)
  if (navigator.permissions) {
    try {
      const perm = await navigator.permissions.query({ name: 'geolocation' });
      if (perm.state === 'denied') { showLocationBlocked(); return; }
      perm.onchange = () => { if (perm.state === 'denied') showLocationBlocked(); };
    } catch {}
  }

  S.geoWatcher = navigator.geolocation.watchPosition(
    pos => {
      S.userLoc = { lat: pos.coords.latitude, lng: pos.coords.longitude, acc: Math.round(pos.coords.accuracy) };
      hideLocationBlocked();
      refreshLocUI();
    },
    err => {
      if (err.code === 1) {
        // Permission denied — hard block
        showLocationBlocked();
      } else if (err.code === 2) {
        // Position unavailable (GPS off at device level)
        showLocationBlocked('Location services appear to be OFF on your device. Turn on GPS to clock in.');
      } else {
        document.getElementById('loc-status').innerHTML = '<span class="loc-err">❌ Location timed out — move to an open area and retry</span>';
        setClockBtn(false);
      }
    },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 5000 }
  );
}

function showLocationBlocked(customMsg) {
  document.getElementById('loc-card').classList.add('hidden');
  document.getElementById('loc-blocked-card').classList.remove('hidden');
  document.getElementById('clock-btn').disabled = true;
  document.getElementById('clock-btn').className = 'clock-btn disabled';
  document.getElementById('clock-label').textContent = 'Location Required';
  document.getElementById('clock-icon').textContent = '📍';
  if (customMsg) {
    document.querySelector('.loc-blocked-card p').textContent = customMsg;
  }
}

function hideLocationBlocked() {
  document.getElementById('loc-card').classList.remove('hidden');
  document.getElementById('loc-blocked-card').classList.add('hidden');
}

function retryLocation() {
  hideLocationBlocked();
  S.userLoc = null;
  startGeoWatch();
}

function refreshLocUI() {
  if (!S.workplace || !S.userLoc) return;
  const locEl = document.getElementById('loc-status');
  const dist   = Math.round(haversineM(S.userLoc.lat, S.userLoc.lng, +S.workplace.latitude, +S.workplace.longitude));
  const radius = S.workplace.radius_meters || 100;
  const ok     = dist <= radius;

  if (ok) {
    locEl.innerHTML = `<div class="loc-ok">✅ You're within range</div>
      <div class="loc-dist">${dist}m from <strong>${S.workplace.name}</strong> · GPS ±${S.userLoc.acc}m</div>`;
  } else {
    locEl.innerHTML = `<div class="loc-err">❌ Too far from workplace</div>
      <div class="loc-dist">You are <strong>${dist}m</strong> away (max ${radius}m from ${S.workplace.name})</div>`;
  }
  setClockBtn(ok);
}

function setClockBtn(enabled) {
  const btn  = document.getElementById('clock-btn');
  const lbl  = document.getElementById('clock-label');
  const icon = document.getElementById('clock-icon');
  if (enabled) {
    btn.disabled  = false;
    btn.className = `clock-btn ${S.clockStatus === 'out' ? 'clock-in' : 'clock-out'}`;
    lbl.textContent  = S.clockStatus === 'out' ? 'Clock In'   : 'Clock Out';
    icon.textContent = S.clockStatus === 'out' ? '▶'           : '⬛';
  } else {
    btn.disabled  = true;
    btn.className = 'clock-btn disabled';
    lbl.textContent  = S.userLoc ? 'Not in Range' : 'Checking Location…';
    icon.textContent = '📍';
  }
}

// ── Check today's status ─────────────────────────────
async function refreshClockStatus() {
  if (!S.worker) return;
  const today = new Date(); today.setHours(0,0,0,0);
  const tmrw  = new Date(today); tmrw.setDate(tmrw.getDate()+1);

  const { data } = await db
    .from('attendance').select('*')
    .eq('worker_id', S.worker.id)
    .gte('clock_in_time', today.toISOString())
    .lt('clock_in_time', tmrw.toISOString())
    .order('clock_in_time', { ascending: false }).limit(1);

  const badge = document.getElementById('status-badge');
  const card  = document.getElementById('today-card');

  if (data?.length) {
    const r = data[0];
    if (r.status === 'active' && !r.clock_out_time) {
      S.clockStatus = 'in'; S.attendanceId = r.id;
      badge.className = 'badge badge-in'; badge.innerHTML = '<span class="dot"></span> Clocked In';
    } else {
      S.clockStatus = 'out'; S.attendanceId = null;
      badge.className = 'badge badge-out'; badge.innerHTML = '<span class="dot"></span> Clocked Out';
    }
    card.style.display = 'block';
    document.getElementById('rec-in').textContent  = r.clock_in_time  ? fmtTime(r.clock_in_time)  : '--:--';
    document.getElementById('rec-out').textContent = r.clock_out_time ? fmtTime(r.clock_out_time) : '--:--';
    if (r.clock_in_time && r.clock_out_time) {
      document.getElementById('rec-hrs').textContent = ((new Date(r.clock_out_time)-new Date(r.clock_in_time))/3_600_000).toFixed(1)+'h';
    }
  } else {
    S.clockStatus = 'out'; S.attendanceId = null;
    badge.className = 'badge badge-out'; badge.innerHTML = '<span class="dot"></span> Clocked Out';
    card.style.display = 'none';
  }
  refreshLocUI();
}

const fmtTime = iso => new Date(iso).toLocaleTimeString('en-ZA', { hour:'2-digit', minute:'2-digit' });

// ── Clock In / Out ───────────────────────────────────
async function clockAction() {
  const btn = document.getElementById('clock-btn');
  if (btn.disabled) return;
  btn.disabled = true;
  S.clockStatus === 'out' ? await doClockIn() : await doClockOut();
}

async function doClockIn() {
  try {
    const { data, error } = await db.from('attendance').insert({
      worker_id: S.worker.id, workplace_id: S.workplace?.id || null,
      clock_in_time: new Date().toISOString(),
      clock_in_latitude: S.userLoc?.lat, clock_in_longitude: S.userLoc?.lng,
      auth_method: S.authMethod, status: 'active',
    }).select().single();

    if (error) throw error;
    S.attendanceId = data.id; S.clockStatus = 'in';
    vibrate([50, 30, 100]);
    showSuccess('in');
    await refreshClockStatus();
  } catch (err) { toast('❌ Failed to clock in — ' + err.message); }
  document.getElementById('clock-btn').disabled = false;
}

async function doClockOut() {
  if (!S.attendanceId) { toast('No active clock-in found.'); return; }
  try {
    const { error } = await db.from('attendance').update({
      clock_out_time: new Date().toISOString(),
      clock_out_latitude: S.userLoc?.lat, clock_out_longitude: S.userLoc?.lng,
      status: 'completed',
    }).eq('id', S.attendanceId);

    if (error) throw error;
    S.clockStatus = 'out'; S.attendanceId = null;
    vibrate([50, 30, 50, 30, 100]);
    showSuccess('out');
    await refreshClockStatus();
  } catch (err) { toast('❌ Failed to clock out — ' + err.message); }
  document.getElementById('clock-btn').disabled = false;
}

// ── Success overlay ──────────────────────────────────
function showSuccess(type) {
  const ov = document.getElementById('success-overlay');
  ov.className = `success-overlay ${type}-type`;
  document.getElementById('success-icon').textContent   = type === 'in' ? '✓' : '✓';
  document.getElementById('success-action').textContent = type === 'in' ? 'Clocked In!' : 'Clocked Out!';
  document.getElementById('success-name').textContent   = S.worker.name;
  document.getElementById('success-time').textContent   = new Date().toLocaleTimeString('en-ZA', { hour:'2-digit', minute:'2-digit' });
  document.getElementById('success-wp').textContent     = S.workplace?.name || '';
  ov.classList.remove('hidden');
  setTimeout(() => ov.classList.add('hidden'), 2800);
}

// ── Worker registers own biometric ───────────────────
async function workerRegisterBiometric() {
  const w = S.worker;
  try {
    const cred = await navigator.credentials.create({ publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rp:   { name: 'WorkClock', id: window.location.hostname || 'localhost' },
      user: { id: new TextEncoder().encode(w.id), name: w.employee_id, displayName: w.name },
      pubKeyCredParams: [{ alg: -7, type: 'public-key' }, { alg: -257, type: 'public-key' }],
      authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required' },
      timeout: 60000,
    }});
    if (!cred) return;
    const credId = b64(cred.rawId);
    const { error } = await db.from('workers')
      .update({ biometric_credential_id: credId, biometric_enabled: true }).eq('id', w.id);
    if (error) throw error;
    S.worker.biometric_enabled = true; S.worker.biometric_credential_id = credId;
    document.getElementById('bio-reg-card').style.display = 'none';
    showMsg('bio-reg-msg', '✅ Registered! Use fingerprint to clock in next time.', 'ok');
    toast('✅ Biometric registered!');
  } catch (err) {
    if (err.name !== 'NotAllowedError') showMsg('bio-reg-msg', 'Error: ' + err.message, 'err');
    else showMsg('bio-reg-msg', 'Registration cancelled.', 'err');
  }
}

// ── Worker logout ────────────────────────────────────
function logoutWorker() {
  if (S.geoWatcher) { navigator.geolocation.clearWatch(S.geoWatcher); S.geoWatcher = null; }
  Object.assign(S, { worker: null, userLoc: null, clockStatus: 'out', attendanceId: null, authSource: 'manual' });
  document.getElementById('inp-empid').value = '';
  showPage('home');
}

// ════════════════════════════════════════════════════
//  ADMIN
// ════════════════════════════════════════════════════
async function adminLogin() {
  const user = (document.getElementById('inp-auser').value || '').trim();
  const pass =  document.getElementById('inp-apass').value || '';
  showErr('err-admin', '');
  if (!user || !pass) { showErr('err-admin', 'Enter username and password.'); return; }

  // Guard: verify db client loaded correctly
  if (typeof db === 'undefined' || !db) {
    showErr('err-admin', 'App failed to initialise. Hold Ctrl and press F5 to force-reload, then try again.');
    return;
  }

  try {
    const { data, error } = await db.from('admin_users')
      .select('*').eq('username', user).eq('password_hash', pass).eq('is_active', true).maybeSingle();
    if (error) { showErr('err-admin', 'Database error: ' + error.message); return; }
    if (!data)  { showErr('err-admin', 'Invalid username or password.'); return; }
    S.admin = data;
    document.getElementById('inp-auser').value = '';
    document.getElementById('inp-apass').value = '';
    showPage('admin');
    loadDashboard();
  } catch(err) { showErr('err-admin', 'Error: ' + (err?.message || String(err))); }
}

function adminLogout() { S.admin = null; showPage('home'); }

function switchTab(name, btn) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active')); btn.classList.add('active');
  document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
  document.getElementById(`tab-${name}`).classList.add('active');
  if (name === 'workers')    loadWorkers();
  if (name === 'attendance') {
    const today = new Date().toISOString().slice(0, 10);
    document.getElementById('att-date').value = today;
    // Default CSV range: 8 months ago → today
    const eightMonthsAgo = new Date(); eightMonthsAgo.setMonth(eightMonthsAgo.getMonth() - 8);
    document.getElementById('csv-from').value = eightMonthsAgo.toISOString().slice(0, 10);
    document.getElementById('csv-to').value   = today;
    loadAttendance();
  }
  if (name === 'setup')      loadWorkplaceSetting();
}

// ── Dashboard ────────────────────────────────────────
async function loadDashboard() {
  const today = new Date(); today.setHours(0,0,0,0);
  const tmrw  = new Date(today); tmrw.setDate(tmrw.getDate()+1);

  const [{ count: total }, { data: recs }] = await Promise.all([
    db.from('workers').select('id', { count:'exact', head:true }).eq('is_active', true),
    db.from('attendance').select('*, w:workers(name,employee_id)')
      .gte('clock_in_time', today.toISOString()).lt('clock_in_time', tmrw.toISOString())
      .order('clock_in_time', { ascending: false }),
  ]);

  const present = recs?.length ?? 0;
  const stillin = recs?.filter(r => r.status === 'active').length ?? 0;
  document.getElementById('s-present').textContent = present;
  document.getElementById('s-total').textContent   = total ?? '--';
  document.getElementById('s-absent').textContent  = Math.max(0, (total??0) - present);
  document.getElementById('s-active').textContent  = stillin;

  const el = document.getElementById('activity-list');
  el.innerHTML = recs?.length
    ? '<div class="act-list">' + recs.slice(0,12).map(r => `
        <div class="act-item">
          <div>
            <div class="act-name">${r.w?.name ?? 'Unknown'}</div>
            <div class="act-time">${fmtTime(r.clock_in_time)}${r.clock_out_time?' → '+fmtTime(r.clock_out_time):''} · ${r.auth_method??''}</div>
          </div>
          <span class="act-tag ${r.clock_out_time?'tag-out':'tag-in'}">${r.clock_out_time?'Done':'Active'}</span>
        </div>`).join('') + '</div>'
    : '<div class="empty">No clock-ins today</div>';
}

// ── Workers ──────────────────────────────────────────
async function loadWorkers() {
  const el = document.getElementById('workers-list');
  el.innerHTML = '<div class="empty">Loading…</div>';
  const { data, error } = await db.from('workers').select('*').order('name');
  if (error || !data) { el.innerHTML = '<div class="empty">Failed to load</div>'; return; }
  if (!data.length)   { el.innerHTML = '<div class="empty">No workers yet — add one above</div>'; return; }

  el.innerHTML = '<div class="workers-list">' + data.map(w => `
    <div class="wr-row">
      <div class="wr-info">
        <div class="avatar sm">${initials(w.name)}</div>
        <div>
          <div class="wr-name">${w.name}</div>
          <div class="wr-meta">${w.employee_id}${w.biometric_enabled?' · 🔏':''} ${!w.is_active?'· <em>Inactive</em>':''}</div>
        </div>
      </div>
      <div class="wr-btns">
        <button class="icon-btn" title="Print ID Card" onclick="openCardModal('${w.id}','${w.employee_id}','${w.name.replace(/'/g,"\\'")}')">🪪</button>
        <button class="icon-btn" title="Register Biometric" onclick="adminRegisterBio('${w.id}','${w.name.replace(/'/g,"\\'")}')">🔏</button>
        <button class="icon-btn" title="${w.is_active?'Deactivate':'Reactivate'}" onclick="toggleWorker('${w.id}',${w.is_active})">${w.is_active?'🚫':'✅'}</button>
      </div>
    </div>`).join('') + '</div>';
}

function toggleAddWorker() {
  const p = document.getElementById('add-worker-panel');
  p.classList.toggle('hidden');
  if (!p.classList.contains('hidden')) document.getElementById('nw-id').focus();
}

async function addWorker() {
  const empId = (document.getElementById('nw-id').value   || '').trim().toUpperCase();
  const name  = (document.getElementById('nw-name').value || '').trim();
  const phone = (document.getElementById('nw-phone').value|| '').trim();
  const email = (document.getElementById('nw-email').value|| '').trim();
  const pin   = (document.getElementById('nw-pin').value  || '').trim();

  if (!empId || !name || !pin) { showMsg('nw-msg', 'Employee ID, Name and PIN are required.', 'err'); return; }
  if (pin.length < 4)          { showMsg('nw-msg', 'PIN must be at least 4 digits.', 'err');           return; }

  const { data: wps } = await db.from('workplaces').select('id').limit(1);
  const { error } = await db.from('workers').insert({
    employee_id: empId, name, phone: phone||null, email: email||null, pin,
    workplace_id: wps?.[0]?.id ?? null, is_active: true,
  });

  if (error) {
    showMsg('nw-msg', error.code === '23505' ? 'Employee ID already exists.' : error.message, 'err');
    return;
  }
  showMsg('nw-msg', '✅ Worker added successfully!', 'ok');
  setTimeout(() => { toggleAddWorker(); loadWorkers(); }, 1300);
}

async function toggleWorker(id, cur) {
  const { error } = await db.from('workers').update({ is_active: !cur }).eq('id', id);
  if (!error) { toast(cur ? 'Worker deactivated' : 'Worker reactivated'); loadWorkers(); }
}

// ── Admin-initiated biometric registration ───────────
async function adminRegisterBio(workerId, workerName) {
  if (!window.PublicKeyCredential) { toast('WebAuthn not supported here'); return; }
  if (!confirm(`Register biometric for "${workerName}"?\n\nThe worker must be present on this device.`)) return;
  try {
    const cred = await navigator.credentials.create({ publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rp:   { name: 'WorkClock', id: window.location.hostname || 'localhost' },
      user: { id: new TextEncoder().encode(workerId), name: workerName, displayName: workerName },
      pubKeyCredParams: [{ alg: -7, type: 'public-key' }, { alg: -257, type: 'public-key' }],
      authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required' },
      timeout: 60000,
    }});
    if (!cred) return;
    const { error } = await db.from('workers')
      .update({ biometric_credential_id: b64(cred.rawId), biometric_enabled: true }).eq('id', workerId);
    if (error) throw error;
    toast(`✅ Biometric registered for ${workerName}`); loadWorkers();
  } catch (err) {
    toast(err.name === 'NotAllowedError' ? 'Cancelled.' : 'Error: ' + err.message);
  }
}

// ── Print / QR Card ──────────────────────────────────
async function openCardModal(workerId, empId, name) {
  document.getElementById('pc-name').textContent = name;
  document.getElementById('pc-id').textContent   = empId;
  document.getElementById('card-modal').classList.remove('hidden');

  const canvas = document.getElementById('qr-gen-canvas');
  try {
    await QRCode.toCanvas(canvas, empId, { width: 180, margin: 2, color: { dark: '#1E293B', light: '#FFFFFF' } });
  } catch (err) {
    toast('QR generation failed: ' + err.message);
  }
}

function closeCardModal(e) {
  if (!e || e.target === document.getElementById('card-modal'))
    document.getElementById('card-modal').classList.add('hidden');
}

function printCard() { window.print(); }

// ── CSV Export ───────────────────────────────────────
async function downloadCSV() {
  const from = document.getElementById('csv-from').value;
  const to   = document.getElementById('csv-to').value;
  const msgEl = document.getElementById('csv-msg');

  if (!from || !to) { showMsg('csv-msg', 'Please select both a From and To date.', 'err'); return; }
  if (new Date(from) > new Date(to)) { showMsg('csv-msg', 'From date must be before To date.', 'err'); return; }

  showMsg('csv-msg', '⏳ Fetching records…', 'ok');

  const start = new Date(from); start.setHours(0, 0, 0, 0);
  const end   = new Date(to);   end.setHours(23, 59, 59, 999);

  try {
    const { data, error } = await db
      .from('attendance')
      .select('*, w:workers(name, employee_id)')
      .gte('clock_in_time', start.toISOString())
      .lte('clock_in_time', end.toISOString())
      .order('clock_in_time');

    if (error) throw error;
    if (!data?.length) { showMsg('csv-msg', 'No records found for this date range.', 'err'); return; }

    const headers = ['Worker Name', 'Employee ID', 'Date', 'Clock In', 'Clock Out', 'Hours Worked', 'Auth Method', 'Status'];
    const rows = data.map(r => {
      const cin  = r.clock_in_time  ? new Date(r.clock_in_time)  : null;
      const cout = r.clock_out_time ? new Date(r.clock_out_time) : null;
      const hrs  = (cin && cout) ? ((cout - cin) / 3_600_000).toFixed(2) : '';
      return [
        r.w?.name        || 'Unknown',
        r.w?.employee_id || '',
        cin  ? cin.toLocaleDateString('en-ZA')  : '',
        cin  ? cin.toLocaleTimeString('en-ZA',  { hour:'2-digit', minute:'2-digit' }) : '',
        cout ? cout.toLocaleTimeString('en-ZA', { hour:'2-digit', minute:'2-digit' }) : 'Still In',
        hrs  ? hrs + 'h' : '',
        r.auth_method || '',
        r.status || ''
      ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(',');
    });

    const csv  = '﻿' + [headers.join(','), ...rows].join('\r\n'); // BOM for Excel
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `attendance_${from}_to_${to}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    showMsg('csv-msg', `✅ Downloaded ${data.length} record${data.length !== 1 ? 's' : ''}`, 'ok');
  } catch (err) {
    showMsg('csv-msg', 'Export failed: ' + err.message, 'err');
  }
}

// ── Attendance ───────────────────────────────────────
async function loadAttendance() {
  const ds = document.getElementById('att-date').value;
  const el = document.getElementById('att-list');
  el.innerHTML = '<div class="empty">Loading…</div>';
  if (!ds) return;

  const start = new Date(ds); start.setHours(0,0,0,0);
  const end   = new Date(start); end.setDate(end.getDate()+1);

  const { data, error } = await db.from('attendance')
    .select('*, w:workers(name,employee_id)')
    .gte('clock_in_time', start.toISOString()).lt('clock_in_time', end.toISOString())
    .order('clock_in_time');

  if (error)         { el.innerHTML = '<div class="empty">Failed to load</div>'; return; }
  if (!data?.length) { el.innerHTML = '<div class="empty">No records for this date</div>'; return; }

  el.innerHTML = '<div class="att-list">' + data.map(r => {
    const cin  = r.clock_in_time  ? fmtTime(r.clock_in_time)  : '--';
    const cout = r.clock_out_time ? fmtTime(r.clock_out_time) : 'Still in';
    const hrs  = (r.clock_in_time && r.clock_out_time)
      ? ((new Date(r.clock_out_time)-new Date(r.clock_in_time))/3_600_000).toFixed(1)+'h' : '--';
    return `<div class="att-item">
      <div class="att-name">${r.w?.name??'Unknown'} <small style="color:#94a3b8">${r.w?.employee_id??''}</small></div>
      <div class="att-times">
        <span class="t-in">▶ ${cin}</span>
        <span class="t-out">⬛ ${cout}</span>
        <span class="t-hrs">⏱ ${hrs}</span>
        <span class="t-meth">${r.auth_method??''}</span>
      </div>
    </div>`;
  }).join('') + '</div>';
}

// ── Workplace Setup ──────────────────────────────────
async function loadWorkplaceSetting() {
  const { data } = await db.from('workplaces').select('*').limit(1);
  if (data?.[0]) {
    const w = data[0];
    document.getElementById('wp-name').value   = w.name ?? '';
    document.getElementById('wp-addr').value   = w.address ?? '';
    document.getElementById('wp-lat').value    = w.latitude ?? '';
    document.getElementById('wp-lng').value    = w.longitude ?? '';
    document.getElementById('wp-radius').value = w.radius_meters ?? 100;
  }
}

async function saveWorkplace() {
  const name   = (document.getElementById('wp-name').value   || '').trim();
  const addr   = (document.getElementById('wp-addr').value   || '').trim();
  const lat    = parseFloat(document.getElementById('wp-lat').value);
  const lng    = parseFloat(document.getElementById('wp-lng').value);
  const radius = parseInt(document.getElementById('wp-radius').value) || 100;

  if (!name || isNaN(lat) || isNaN(lng)) { showMsg('wp-msg', 'Name, Latitude and Longitude are required.', 'err'); return; }

  const { data: ex } = await db.from('workplaces').select('id').limit(1);
  const payload = { name, address: addr, latitude: lat, longitude: lng, radius_meters: radius, updated_at: new Date() };
  const { error } = ex?.length
    ? await db.from('workplaces').update(payload).eq('id', ex[0].id)
    : await db.from('workplaces').insert(payload);

  if (error) { showMsg('wp-msg', 'Save failed: ' + error.message, 'err'); return; }
  showMsg('wp-msg', '✅ Workplace saved!', 'ok');

  // Link workers without a workplace
  const { data: wp } = await db.from('workplaces').select('id').limit(1);
  if (wp?.[0]?.id) await db.from('workers').update({ workplace_id: wp[0].id }).is('workplace_id', null);
}

function captureAdminLocation() {
  if (!navigator.geolocation) { toast('Geolocation not supported'); return; }
  toast('Getting location…');
  navigator.geolocation.getCurrentPosition(
    p => { document.getElementById('wp-lat').value = p.coords.latitude.toFixed(7); document.getElementById('wp-lng').value = p.coords.longitude.toFixed(7); toast(`📍 Captured (±${Math.round(p.coords.accuracy)}m)`); },
    () => toast('Could not get location — enter manually.')
  );
}

async function changeAdminPw() {
  const pw = document.getElementById('new-pw').value;
  if (!pw || pw.length < 6) { showMsg('pw-msg', 'Password must be at least 6 characters.', 'err'); return; }
  const { error } = await db.from('admin_users').update({ password_hash: pw }).eq('id', S.admin.id);
  if (error) showMsg('pw-msg', 'Failed: ' + error.message, 'err');
  else { showMsg('pw-msg', '✅ Password updated!', 'ok'); document.getElementById('new-pw').value = ''; }
}

// ── Bootstrap ────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('att-date').value = new Date().toISOString().slice(0, 10);
  setTimeout(() => showPage('home'), 1500);
});
