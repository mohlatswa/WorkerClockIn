'use strict';

// ── App State ────────────────────────────────────────
const S = {
  worker:         null,
  admin:          null,
  workplace:      null,
  userLoc:        null,
  geoWatcher:     null,
  clockStatus:    'out',
  attendanceId:   null,
  authMethod:     'pin',
  scanStream:     null,
  scanRunning:    false,
  nfcReader:      null,
  npPin:          [],
  npAutoTimer:    null,
  authSource:     'manual',
  companyId:      null,
  companyName:    null,
  companyFromUrl: false, // true only when ?c=CODE is in the URL
};

// ── Navigation ───────────────────────────────────────
function showPage(id) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  const el = document.getElementById(`page-${id}`);
  if (el) { el.classList.add('active'); window.scrollTo(0, 0); }
}

// ── Company (set from URL or localStorage — workers never pick manually) ─
function setCompany(co, fromUrl = false) {
  S.companyId      = co.id;
  S.companyName    = co.name;
  S.companyFromUrl = fromUrl;
  localStorage.setItem('wc_company', JSON.stringify(co));
  updateHomeCompanyUI();
}

function updateHomeCompanyUI() {
  const nameEl  = document.getElementById('home-company-name');
  const noCard  = document.getElementById('no-company-card');
  const methods = document.getElementById('clock-methods');
  if (S.companyId) {
    if (nameEl)  nameEl.textContent = S.companyName;
    if (noCard)  noCard.classList.add('hidden');
    if (methods) methods.classList.remove('hidden');
  } else {
    if (nameEl)  nameEl.textContent = '';
    if (noCard)  noCard.classList.remove('hidden');
    if (methods) methods.classList.add('hidden');
  }
}

async function initCompany() {
  // 1. URL param ?c=CODE — authoritative, marks company as "from URL"
  const params = new URLSearchParams(window.location.search);
  const code   = params.get('c') || params.get('company');
  if (code) {
    try {
      const { data } = await withTimeout(
        db.from('companies').select('*').eq('code', code.toUpperCase()).eq('is_active', true).maybeSingle(),
        4000
      );
      if (data) { setCompany(data, true); return; }
    } catch {}
  }
  // 2. localStorage fallback — company is set but NOT from URL (no strict filter)
  const saved = localStorage.getItem('wc_company');
  if (saved) { try { setCompany(JSON.parse(saved), false); return; } catch {} }
  updateHomeCompanyUI();
}

// ── Utilities ────────────────────────────────────────
const initials = n => (n || '??').split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);

function withTimeout(promise, ms) {
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);
}

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
//  HOME-SCREEN BIOMETRIC (discoverable credentials)
// ════════════════════════════════════════════════════
async function homeScreenBiometric() {
  if (!window.PublicKeyCredential) { toast('Biometric not supported on this browser'); return; }
  try {
    const challenge = crypto.getRandomValues(new Uint8Array(32));
    const cred = await navigator.credentials.get({
      publicKey: {
        challenge,
        allowCredentials: [], // empty = device picks any registered credential
        userVerification: 'required',
        timeout: 60000,
      },
    });
    if (!cred) return;
    const workerId = new TextDecoder().decode(cred.response.userHandle);
    if (!workerId) { toast('❌ Biometric not linked. Use Employee ID instead.'); return; }
    toast('Authenticated — loading your account…');
    S.authSource  = 'biometric';
    S.authMethod  = 'biometric';
    let q = db.from('workers').select('*, workplace:workplaces(*)').eq('id', workerId).eq('is_active', true);
    if (S.companyId && S.companyFromUrl) q = q.eq('company_id', S.companyId);
    const { data, error } = await q.maybeSingle();
    if (error || !data) { toast('❌ Account not found. Use Employee ID instead.'); return; }
    S.worker = data;
    enterClockScreen();
  } catch (err) {
    if (err.name !== 'NotAllowedError') toast('Biometric error: ' + err.message);
  }
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
    let q = db.from('workers').select('*, workplace:workplaces(*)')
      .eq('employee_id', id).eq('is_active', true);
    // Only scope by company when the company URL param was used (?c=CODE).
    // If company came from localStorage only, don't filter — avoids "not found"
    // errors when a worker opens the app without their employer's link.
    if (S.companyId && S.companyFromUrl) q = q.eq('company_id', S.companyId);
    const { data, error } = await q.maybeSingle();

    if (error?.code === 'PGRST116') {
      showErr('err-empid', 'Multiple accounts share this ID. Please use your employer's sign-in link (?c=CODE).');
      return;
    }
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
  document.getElementById('auth-avatar').textContent   = initials(worker.name);
  document.getElementById('auth-name').textContent     = worker.name;
  document.getElementById('auth-empid').textContent    = worker.employee_id;
  document.getElementById('auth-jobtitle').textContent = worker.job_title || '';

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
  document.getElementById('clock-avatar').textContent    = initials(w.name);
  document.getElementById('clock-name').textContent      = w.name;
  document.getElementById('clock-empid').textContent     = w.employee_id;
  document.getElementById('clock-jobtitle').textContent  = w.job_title || '';
  document.getElementById('clock-greeting').textContent  = `Hello, ${w.name.split(' ')[0]}!`;
  S.workplace = w.workplace || null;

  // Persist session so worker stays logged in across page reloads / app restarts
  localStorage.setItem('wc_worker_id', w.id);

  showPage('clock');
  startClock();
  await refreshClockStatus();
  startGeoWatch();

  // Show biometric / face registration cards if not yet enrolled
  document.getElementById('bio-reg-card').style.display =
    (!w.biometric_enabled && window.PublicKeyCredential) ? 'block' : 'none';
  document.getElementById('face-reg-card').style.display =
    !w.face_descriptor ? 'block' : 'none';
}

// ── Geolocation watcher ──────────────────────────────
async function startGeoWatch() {
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
      authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'required', requireResidentKey: true },
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
  localStorage.removeItem('wc_worker_id');
  document.getElementById('inp-empid').value = '';
  showPage('home');
}

// ════════════════════════════════════════════════════
//  ADMIN
// ════════════════════════════════════════════════════
async function adminLogin() {
  const user = (document.getElementById('inp-auser').value || '').trim().toLowerCase();
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
      .select('*, co:companies(name,code)').eq('username', user).eq('password_hash', pass).eq('is_active', true).maybeSingle();
    if (error) { showErr('err-admin', 'Database error: ' + error.message); return; }
    if (!data)  { showErr('err-admin', 'Invalid username or password.'); return; }
    S.admin = data;
    document.getElementById('inp-auser').value = '';
    document.getElementById('inp-apass').value = '';
    if (data.role === 'developer') {
      showPage('developer');
      loadDevCompanies();
    } else {
      // Scope all operations to this admin's company
      document.getElementById('admin-company-label').textContent = data.co?.name || '';
      // Show/hide super_admin-only tabs
      const isSA = data.role === 'super_admin';
      document.getElementById('tab-btn-admins').classList.toggle('hidden', !isSA);
      document.getElementById('tab-btn-setup').classList.toggle('hidden', !isSA);
      showPage('admin');
      loadDashboard();
    }
  } catch(err) { showErr('err-admin', 'Error: ' + (err?.message || String(err))); }
}

function adminLogout() { S.admin = null; showPage('home'); }

// ── Forgot Password (OTP via EmailJS) ────────────────
const _otp = { code: null, expiry: null };

function toggleForgot() {
  const p = document.getElementById('forgot-panel');
  p.classList.toggle('hidden');
  // Reset to step 1 when opening
  if (!p.classList.contains('hidden')) {
    document.getElementById('forgot-step1').classList.remove('hidden');
    document.getElementById('forgot-step2').classList.add('hidden');
    document.getElementById('forgot-step3').classList.add('hidden');
    document.getElementById('forgot-msg').classList.add('hidden');
  }
}

async function sendResetOTP() {
  const btn = document.getElementById('send-otp-btn');
  if (typeof EMAILJS_PUBLIC_KEY === 'undefined' || EMAILJS_PUBLIC_KEY === 'YOUR_PUBLIC_KEY') {
    showMsg('forgot-msg', '⚠️ Email reset is not configured yet. See setup instructions.', 'err');
    return;
  }
  btn.disabled = true;
  btn.textContent = 'Sending…';
  showMsg('forgot-msg', '', '');

  _otp.code   = String(Math.floor(100000 + Math.random() * 900000));
  _otp.expiry = Date.now() + 10 * 60 * 1000; // 10 minutes

  try {
    emailjs.init(EMAILJS_PUBLIC_KEY);
    await emailjs.send(EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, {
      to_email: ADMIN_RECOVERY_EMAIL,
      otp:      _otp.code,
      app_name: 'WorkClock',
    });
    document.getElementById('forgot-step1').classList.add('hidden');
    document.getElementById('forgot-step2').classList.remove('hidden');
    showMsg('forgot-msg', `✅ Code sent to ${ADMIN_RECOVERY_EMAIL} — check your inbox (and spam folder)`, 'ok');
  } catch (err) {
    showMsg('forgot-msg', 'Failed to send email: ' + (err?.text || err?.message || String(err)), 'err');
  }
  btn.disabled = false;
  btn.textContent = '📧 Send Reset Code';
}

function verifyResetOTP() {
  const entered = (document.getElementById('inp-otp').value || '').trim();
  if (!_otp.code) { showMsg('forgot-msg', 'Please request a new code first.', 'err'); return; }
  if (Date.now() > _otp.expiry) { showMsg('forgot-msg', 'Code has expired — request a new one.', 'err'); _otp.code = null; return; }
  if (entered !== _otp.code) { showMsg('forgot-msg', 'Incorrect code — try again.', 'err'); return; }
  document.getElementById('forgot-step2').classList.add('hidden');
  document.getElementById('forgot-step3').classList.remove('hidden');
  showMsg('forgot-msg', '✅ Identity verified — set your new password below.', 'ok');
}

async function applyNewPassword() {
  const pw = (document.getElementById('inp-newpw').value || '').trim();
  if (!pw || pw.length < 6) { showMsg('forgot-msg', 'Password must be at least 6 characters.', 'err'); return; }
  const { error } = await db.from('admin_users').update({ password_hash: pw }).eq('username', 'admin');
  if (error) { showMsg('forgot-msg', 'Failed to update: ' + error.message, 'err'); return; }
  _otp.code = null;
  showMsg('forgot-msg', '✅ Password updated! Please log in with your new password.', 'ok');
  document.getElementById('forgot-step3').classList.add('hidden');
  setTimeout(() => {
    document.getElementById('forgot-panel').classList.add('hidden');
    document.getElementById('inp-newpw').value = '';
  }, 2500);
}

function switchTab(name, btn) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active')); btn.classList.add('active');
  document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
  document.getElementById(`tab-${name}`).classList.add('active');
  if (name === 'workers')         loadWorkers();
  if (name === 'company-admins')  loadCompanyAdmins();
  if (name === 'attendance') {
    const today = new Date().toISOString().slice(0, 10);
    const eightMonthsAgo = new Date(); eightMonthsAgo.setMonth(eightMonthsAgo.getMonth() - 8);
    document.getElementById('att-from').value = eightMonthsAgo.toISOString().slice(0, 10);
    document.getElementById('att-to').value   = today;
    loadWorkerOptions();
  }
  if (name === 'setup')           loadWorkplaceSetting();
}

// ── Dashboard ────────────────────────────────────────
async function loadDashboard() {
  const today = new Date(); today.setHours(0,0,0,0);
  const tmrw  = new Date(today); tmrw.setDate(tmrw.getDate()+1);

  const cid = S.admin?.company_id;
  const [{ count: total }, { data: wkrs }] = await Promise.all([
    db.from('workers').select('id', { count:'exact', head:true }).eq('is_active', true).eq('company_id', cid),
    db.from('workers').select('id').eq('company_id', cid),
  ]);
  const workerIds = wkrs?.map(w => w.id) || [];
  const { data: recs } = workerIds.length
    ? await db.from('attendance').select('*, w:workers(name,employee_id)')
        .in('worker_id', workerIds)
        .gte('clock_in_time', today.toISOString()).lt('clock_in_time', tmrw.toISOString())
        .order('clock_in_time', { ascending: false })
    : { data: [] };

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

// ── Shared edit caches (worker + company) ────────────
const _wCache = {};
const _cCache = {};

// ── Workers ──────────────────────────────────────────
async function loadWorkers() {
  const el = document.getElementById('workers-list');
  el.innerHTML = '<div class="empty">Loading…</div>';
  const { data, error } = await db.from('workers').select('*').eq('company_id', S.admin?.company_id).order('name');
  if (error || !data) { el.innerHTML = '<div class="empty">Failed to load</div>'; return; }
  if (!data.length)   { el.innerHTML = '<div class="empty">No workers yet — add one above</div>'; return; }

  data.forEach(w => { _wCache[w.id] = { ...w, _ctx: 'admin' }; });

  el.innerHTML = '<div class="workers-list">' + data.map(w => `
    <div class="wr-row">
      <div class="wr-info">
        <div class="avatar sm">${initials(w.name)}</div>
        <div>
          <div class="wr-name">${w.name}</div>
          <div class="wr-meta">${w.employee_id}${w.job_title?' · '+w.job_title:''}${w.biometric_enabled?' · 🔏':''}${w.face_descriptor?' · 🤳':''} ${!w.is_active?'· <em>Inactive</em>':''}</div>
        </div>
      </div>
      <div class="wr-btns">
        <button class="icon-btn" title="Edit Worker" onclick="openEditWorkerById('${w.id}')">✏️</button>
        <button class="icon-btn" title="Enrol Face" onclick="adminEnrollFace('${w.id}','${w.name.replace(/'/g,"\\'")}','admin')">🤳</button>
        <button class="icon-btn" title="Print ID Card" onclick="openCardModal('${w.id}','${w.employee_id}','${w.name.replace(/'/g,"\\'")}','${(w.job_title||'').replace(/'/g,"\\'")}')">🪪</button>
        <button class="icon-btn" title="Register Fingerprint/Face ID" onclick="adminRegisterBio('${w.id}','${w.name.replace(/'/g,"\\'")}')">🔏</button>
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
  const empId    = (document.getElementById('nw-id').value      || '').trim().toUpperCase();
  const name     = (document.getElementById('nw-name').value    || '').trim();
  const jobTitle = (document.getElementById('nw-jobtitle').value|| '').trim();
  const phone    = (document.getElementById('nw-phone').value   || '').trim();
  const email    = (document.getElementById('nw-email').value   || '').trim();
  const pin      = (document.getElementById('nw-pin').value     || '').trim();

  if (!empId || !name || !pin) { showMsg('nw-msg', 'Employee ID, Name and PIN are required.', 'err'); return; }
  if (pin.length < 4)          { showMsg('nw-msg', 'PIN must be at least 4 digits.', 'err');           return; }

  const cid = S.admin?.company_id;
  const { data: wps } = await db.from('workplaces').select('id').eq('company_id', cid).limit(1);
  const { error } = await db.from('workers').insert({
    employee_id: empId, name, job_title: jobTitle||null, phone: phone||null, email: email||null, pin,
    workplace_id: wps?.[0]?.id ?? null, company_id: cid, is_active: true,
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
      authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'required', requireResidentKey: true },
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
async function openCardModal(workerId, empId, name, jobTitle) {
  document.getElementById('pc-name').textContent     = name;
  document.getElementById('pc-jobtitle').textContent = jobTitle || '';
  document.getElementById('pc-id').textContent       = empId;
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
  const from   = document.getElementById('att-from').value;
  const to     = document.getElementById('att-to').value;
  const worker = document.getElementById('att-worker').value;
  const method = document.getElementById('att-method').value;

  if (!from || !to) { showMsg('csv-msg', 'Please select a date range first.', 'err'); return; }
  if (new Date(from) > new Date(to)) { showMsg('csv-msg', 'From date must be before To date.', 'err'); return; }

  showMsg('csv-msg', '⏳ Fetching records…', 'ok');

  const start = new Date(from); start.setHours(0, 0, 0, 0);
  const end   = new Date(to);   end.setHours(23, 59, 59, 999);

  try {
    const { data: cWorkers } = await db.from('workers').select('id').eq('company_id', S.admin?.company_id);
    const cIds = cWorkers?.map(w => w.id) || [];
    const allowed = worker ? [worker] : cIds;
    if (!allowed.length) { showMsg('csv-msg', 'No workers found for this company.', 'err'); return; }

    let q = db.from('attendance')
      .select('*, w:workers(name, employee_id, job_title)')
      .in('worker_id', allowed)
      .gte('clock_in_time', start.toISOString())
      .lte('clock_in_time', end.toISOString())
      .order('clock_in_time');

    if (method) q = q.eq('auth_method', method);
    const { data, error } = await q;

    if (error) throw error;
    if (!data?.length) { showMsg('csv-msg', 'No records found for this date range.', 'err'); return; }

    const headers = ['Worker Name', 'Employee ID', 'Job Title', 'Date', 'Clock In', 'Clock Out', 'Hours Worked', 'Auth Method', 'Status'];
    const rows = data.map(r => {
      const cin  = r.clock_in_time  ? new Date(r.clock_in_time)  : null;
      const cout = r.clock_out_time ? new Date(r.clock_out_time) : null;
      const hrs  = (cin && cout) ? ((cout - cin) / 3_600_000).toFixed(2) : '';
      return [
        r.w?.name        || 'Unknown',
        r.w?.employee_id || '',
        r.w?.job_title   || '',
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

// ── Attendance report (filterable) ───────────────────
async function loadWorkerOptions() {
  const sel = document.getElementById('att-worker');
  try {
    const { data } = await db.from('workers').select('id, name, employee_id, job_title').eq('company_id', S.admin?.company_id).order('name');
    if (!data) return;
    sel.innerHTML = '<option value="">All Workers</option>' +
      data.map(w => `<option value="${w.id}">${w.name}${w.job_title ? ' · '+w.job_title : ''} (${w.employee_id})</option>`).join('');
  } catch { /* keep default */ }
}

async function loadAttendanceReport() {
  const from   = document.getElementById('att-from').value;
  const to     = document.getElementById('att-to').value;
  const worker = document.getElementById('att-worker').value;
  const method = document.getElementById('att-method').value;
  const el     = document.getElementById('att-list');
  const sum    = document.getElementById('att-summary');

  if (!from || !to) { el.innerHTML = '<div class="empty">Please select a date range</div>'; return; }

  el.innerHTML = '<div class="empty">Loading…</div>';
  sum.classList.add('hidden');

  const start = new Date(from); start.setHours(0, 0, 0, 0);
  const end   = new Date(to);   end.setHours(23, 59, 59, 999);

  try {
    const { data: cWorkers } = await db.from('workers').select('id').eq('company_id', S.admin?.company_id);
    const cIds = cWorkers?.map(w => w.id) || [];
    const allowed = worker ? [worker] : cIds;
    if (!allowed.length) { el.innerHTML = '<div class="empty">No workers found</div>'; return; }

    let q = db.from('attendance')
      .select('*, w:workers(name, employee_id, job_title)')
      .in('worker_id', allowed)
      .gte('clock_in_time', start.toISOString())
      .lte('clock_in_time', end.toISOString())
      .order('clock_in_time', { ascending: false });

    if (method) q = q.eq('auth_method', method);
    const { data, error } = await q;

    if (error) { el.innerHTML = '<div class="empty">Failed to load records</div>'; return; }
    if (!data?.length) { el.innerHTML = '<div class="empty">No records match your filters</div>'; return; }

    const totalHrs = data.reduce((s, r) =>
      s + (r.clock_in_time && r.clock_out_time
        ? (new Date(r.clock_out_time) - new Date(r.clock_in_time)) / 3_600_000 : 0), 0);
    const stillIn = data.filter(r => r.status === 'active').length;
    sum.textContent = `${data.length} record${data.length !== 1 ? 's' : ''} · ${totalHrs.toFixed(1)}h total · ${stillIn} still clocked in`;
    sum.classList.remove('hidden');

    el.innerHTML = '<div class="att-list">' + data.map(r => {
      const cin  = r.clock_in_time  ? fmtTime(r.clock_in_time)  : '--';
      const cout = r.clock_out_time ? fmtTime(r.clock_out_time) : 'Still in';
      const date = r.clock_in_time  ? new Date(r.clock_in_time).toLocaleDateString('en-ZA') : '';
      const hrs  = (r.clock_in_time && r.clock_out_time)
        ? ((new Date(r.clock_out_time) - new Date(r.clock_in_time)) / 3_600_000).toFixed(1) + 'h' : '--';
      return `<div class="att-item">
        <div class="att-name">${r.w?.name ?? 'Unknown'} <small style="color:#94a3b8">${r.w?.employee_id ?? ''}</small>${r.w?.job_title ? ` <small style="color:#2563EB">· ${r.w.job_title}</small>` : ''}</div>
        <div class="att-date">${date}</div>
        <div class="att-times">
          <span class="t-in">▶ ${cin}</span>
          <span class="t-out">⬛ ${cout}</span>
          <span class="t-hrs">⏱ ${hrs}</span>
          <span class="t-meth">${r.auth_method ?? ''}</span>
        </div>
      </div>`;
    }).join('') + '</div>';
  } catch (err) { el.innerHTML = `<div class="empty">Error: ${err.message}</div>`; }
}

// ── Workplace Setup ──────────────────────────────────
async function loadWorkplaceSetting() {
  const { data } = await db.from('workplaces').select('*').eq('company_id', S.admin?.company_id).limit(1);
  if (data?.[0]) {
    const w = data[0];
    document.getElementById('wp-name').value   = w.name ?? '';
    document.getElementById('wp-addr').value   = w.address ?? '';
    document.getElementById('wp-lat').value    = w.latitude ?? '';
    document.getElementById('wp-lng').value    = w.longitude ?? '';
    document.getElementById('wp-radius').value = w.radius_meters ?? 100;
  }
  // Populate clock-in link box
  const code    = S.admin?.co?.code;
  const linkBox = document.getElementById('clockin-link-box');
  if (linkBox) {
    if (code) {
      const base = window.location.origin + window.location.pathname;
      linkBox.textContent = `${base}?c=${code}`;
    } else {
      linkBox.textContent = 'Company code not found — contact developer.';
    }
  }
  // Populate My Profile fields
  const nameEl  = document.getElementById('my-name');
  const emailEl = document.getElementById('my-email');
  if (nameEl)  nameEl.value  = S.admin?.full_name || '';
  if (emailEl) emailEl.value = S.admin?.email     || '';
}

function copyClockInLink() {
  const code = S.admin?.co?.code;
  if (!code) { showMsg('link-copy-msg', 'Company code not found.', 'err'); return; }
  const base = window.location.origin + window.location.pathname;
  const link = `${base}?c=${code}`;
  navigator.clipboard.writeText(link).then(() => {
    showMsg('link-copy-msg', '✅ Link copied!', 'ok');
  }).catch(() => {
    document.getElementById('clockin-link-box').textContent = link;
    showMsg('link-copy-msg', 'Copy the link above manually.', 'ok');
  });
}

async function saveMyProfile() {
  const name  = (document.getElementById('my-name').value  || '').trim();
  const email = (document.getElementById('my-email').value || '').trim();
  if (!name) { showMsg('profile-msg', 'Full name is required.', 'err'); return; }
  const { error } = await db.from('admin_users').update({ full_name: name, email: email || null }).eq('id', S.admin.id);
  if (error) { showMsg('profile-msg', 'Failed: ' + error.message, 'err'); return; }
  S.admin.full_name = name; S.admin.email = email;
  showMsg('profile-msg', '✅ Profile updated!', 'ok');
}

async function saveWorkplace() {
  const name   = (document.getElementById('wp-name').value   || '').trim();
  const addr   = (document.getElementById('wp-addr').value   || '').trim();
  const lat    = parseFloat(document.getElementById('wp-lat').value);
  const lng    = parseFloat(document.getElementById('wp-lng').value);
  const radius = parseInt(document.getElementById('wp-radius').value) || 100;

  if (!name || isNaN(lat) || isNaN(lng)) { showMsg('wp-msg', 'Name, Latitude and Longitude are required.', 'err'); return; }

  const cid = S.admin?.company_id;
  const { data: ex } = await db.from('workplaces').select('id').eq('company_id', cid).limit(1);
  const payload = { name, address: addr, latitude: lat, longitude: lng, radius_meters: radius, company_id: cid, updated_at: new Date() };
  const { error } = ex?.length
    ? await db.from('workplaces').update(payload).eq('id', ex[0].id)
    : await db.from('workplaces').insert(payload);

  if (error) { showMsg('wp-msg', 'Save failed: ' + error.message, 'err'); return; }
  showMsg('wp-msg', '✅ Workplace saved!', 'ok');

  const { data: wp } = await db.from('workplaces').select('id').eq('company_id', cid).limit(1);
  if (wp?.[0]?.id) await db.from('workers').update({ workplace_id: wp[0].id }).eq('company_id', cid).is('workplace_id', null);
}

function captureAdminLocation() {
  if (!navigator.geolocation) { toast('Geolocation not supported'); return; }
  toast('📍 Getting your location…');
  navigator.geolocation.getCurrentPosition(
    async pos => {
      const lat = pos.coords.latitude.toFixed(7);
      const lng = pos.coords.longitude.toFixed(7);
      document.getElementById('wp-lat').value = lat;
      document.getElementById('wp-lng').value = lng;
      toast(`📍 Location captured (±${Math.round(pos.coords.accuracy)}m)`);
      // Reverse geocode to fill in address automatically
      try {
        const res = await fetch(
          `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}`,
          { headers: { 'Accept-Language': 'en' } }
        );
        const geo = await res.json();
        if (geo?.display_name) {
          document.getElementById('wp-addr').value = geo.display_name;
          toast(`📍 Address detected — review and save`);
        }
      } catch { /* address stays blank if reverse geocode fails */ }
    },
    () => toast('Could not get location — enter coordinates manually.')
  );
}

async function changeAdminPw() {
  const pw = document.getElementById('new-pw').value;
  if (!pw || pw.length < 6) { showMsg('pw-msg', 'Password must be at least 6 characters.', 'err'); return; }
  const { error } = await db.from('admin_users').update({ password_hash: pw }).eq('id', S.admin.id);
  if (error) showMsg('pw-msg', 'Failed: ' + error.message, 'err');
  else { showMsg('pw-msg', '✅ Password updated!', 'ok'); document.getElementById('new-pw').value = ''; }
}

// ════════════════════════════════════════════════════
//  DEVELOPER PANEL
// ════════════════════════════════════════════════════
function devLogout() { S.admin = null; showPage('home'); }

function switchDevTab(name, btn) {
  document.querySelectorAll('#page-developer .tab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  document.querySelectorAll('#page-developer .tab-pane').forEach(p => p.classList.remove('active'));
  document.getElementById(`tab-${name}`).classList.add('active');
  if (name === 'dev-companies')   loadDevCompanies();
  if (name === 'dev-superadmins') loadDevSuperAdmins();
  if (name === 'dev-workers')     loadDevWorkers();
  if (name === 'dev-info')        loadDevInfo();
}

// ── Companies ────────────────────────────────────────
async function loadDevCompanies() {
  const el = document.getElementById('companies-list');
  el.innerHTML = '<div class="empty">Loading…</div>';
  const { data, error } = await db.from('companies').select('*').order('name');
  if (error || !data) { el.innerHTML = '<div class="empty">Failed to load</div>'; return; }
  if (!data.length)   { el.innerHTML = '<div class="empty">No companies yet — create one above</div>'; return; }
  data.forEach(c => { _cCache[c.id] = c; });
  el.innerHTML = '<div class="workers-list">' + data.map(c => `
    <div class="wr-row">
      <div class="wr-info">
        <div class="avatar sm" style="background:var(--purple)">${c.code.slice(0,2)}</div>
        <div>
          <div class="wr-name">${c.name}</div>
          <div class="wr-meta">Code: ${c.code}${!c.is_active?' · <em>Inactive</em>':''}</div>
        </div>
      </div>
      <div class="wr-btns">
        <button class="icon-btn" title="Edit Company" onclick="openEditCompanyById('${c.id}')">✏️</button>
        <button class="icon-btn" title="${c.is_active?'Deactivate':'Reactivate'}" onclick="devToggleCompany('${c.id}',${c.is_active})">${c.is_active?'🚫':'✅'}</button>
      </div>
    </div>`).join('') + '</div>';
}

function toggleAddCompany() {
  const p = document.getElementById('add-company-panel');
  p.classList.toggle('hidden');
  if (!p.classList.contains('hidden')) document.getElementById('nc-name').focus();
}

async function addCompany() {
  const name = (document.getElementById('nc-name').value || '').trim();
  const code = (document.getElementById('nc-code').value || '').trim().toUpperCase().replace(/\s+/g,'');
  if (!name || !code) { showMsg('nc-msg', 'Name and Code are required.', 'err'); return; }
  if (!/^[A-Z0-9_]+$/.test(code)) { showMsg('nc-msg', 'Code may only contain letters, numbers and underscores.', 'err'); return; }
  const { error } = await db.from('companies').insert({ name, code, is_active: true });
  if (error) { showMsg('nc-msg', error.code === '23505' ? 'Company code already exists.' : error.message, 'err'); return; }
  showMsg('nc-msg', `✅ Company "${name}" created! Code: ${code}`, 'ok');
  ['nc-name','nc-code'].forEach(id => document.getElementById(id).value = '');
  setTimeout(() => { toggleAddCompany(); loadDevCompanies(); }, 1400);
}

async function devToggleCompany(id, cur) {
  const { error } = await db.from('companies').update({ is_active: !cur }).eq('id', id);
  if (!error) { toast(cur ? 'Company deactivated' : 'Company reactivated'); loadDevCompanies(); }
}

// ── Company Accounts ─────────────────────────────────
const ROLE_LABELS = { super_admin: 'Super Admin', admin: 'Admin', developer: 'Developer' };
const ROLE_COLORS = { super_admin: 'var(--green)', admin: 'var(--blue)', developer: 'var(--purple)' };

async function loadDevSuperAdmins() {
  const el        = document.getElementById('superadmins-list');
  const filterSel = document.getElementById('dev-filter-company');
  el.innerHTML    = '<div class="empty">Loading…</div>';

  // Populate filter dropdown if empty
  if (filterSel.options.length <= 1) {
    const { data: cos } = await db.from('companies').select('id,name').eq('is_active', true).order('name');
    filterSel.innerHTML = '<option value="">All Companies</option>' +
      (cos||[]).map(c => `<option value="${c.id}">${c.name}</option>`).join('');
  }

  let q = db.from('admin_users')
    .select('*, co:companies(name,code)')
    .neq('role', 'developer')
    .order('full_name');
  const filterCid = filterSel?.value;
  if (filterCid) q = q.eq('company_id', filterCid);

  const { data, error } = await q;
  if (error || !data) { el.innerHTML = '<div class="empty">Failed to load</div>'; return; }
  if (!data.length)   { el.innerHTML = '<div class="empty">No accounts yet — create one above</div>'; return; }

  el.innerHTML = '<div class="workers-list">' + data.map(a => `
    <div class="wr-row">
      <div class="wr-info">
        <div class="avatar sm" style="background:${ROLE_COLORS[a.role]||'var(--blue)'}">${(a.full_name||a.username).slice(0,2).toUpperCase()}</div>
        <div>
          <div class="wr-name">${a.full_name||a.username} <small style="color:var(--muted)">@${a.username}</small></div>
          <div class="wr-meta">
            <span class="role-pill" style="background:${ROLE_COLORS[a.role]||'var(--blue)'}22;color:${ROLE_COLORS[a.role]||'var(--blue)'};">${ROLE_LABELS[a.role]||a.role}</span>
            🏢 ${a.co?.name||'—'}${!a.is_active?' · <em>Inactive</em>':''}
          </div>
        </div>
      </div>
      <div class="wr-btns">
        <button class="icon-btn" title="Edit Account" onclick="openEditAccount('${a.id}','${(a.full_name||'').replace(/'/g,"\\'")}','${(a.email||'').replace(/'/g,"\\'")}','${a.role}',true)">✏️</button>
        <button class="icon-btn" title="Reset Password" onclick="devResetAdminPw('${a.id}','${a.username}')">🔑</button>
        <button class="icon-btn" title="${a.is_active?'Deactivate':'Reactivate'}" onclick="devToggleSA('${a.id}',${a.is_active})">${a.is_active?'🚫':'✅'}</button>
      </div>
    </div>`).join('') + '</div>';
}

function toggleAddSuperAdmin() {
  const p = document.getElementById('add-superadmin-panel');
  p.classList.toggle('hidden');
  if (!p.classList.contains('hidden')) {
    db.from('companies').select('id,name').eq('is_active',true).order('name').then(({ data }) => {
      const sel = document.getElementById('nsa-company');
      sel.innerHTML = '<option value="">Select Company…</option>' +
        (data||[]).map(c=>`<option value="${c.id}">${c.name}</option>`).join('');
    });
    document.getElementById('nsa-name').focus();
  }
}

async function addSuperAdmin() {
  const cid   = document.getElementById('nsa-company').value;
  const role  = document.getElementById('nsa-role').value;
  const name  = (document.getElementById('nsa-name').value || '').trim();
  const user  = (document.getElementById('nsa-user').value || '').trim().toLowerCase();
  const pass  = (document.getElementById('nsa-pass').value || '').trim();
  const email = (document.getElementById('nsa-email').value|| '').trim();
  if (!cid)  { showMsg('nsa-msg','Please select a company.','err'); return; }
  if (!name||!user||!pass) { showMsg('nsa-msg','Name, username and password are required.','err'); return; }
  if (pass.length < 6)     { showMsg('nsa-msg','Password must be at least 6 characters.','err'); return; }
  if (!/^[a-z0-9_]+$/.test(user)) { showMsg('nsa-msg','Username may only contain letters, numbers and underscores.','err'); return; }
  const { error } = await db.from('admin_users').insert({
    username: user, password_hash: pass, full_name: name,
    email: email||null, role, company_id: cid, is_active: true,
  });
  if (error) { showMsg('nsa-msg', error.code==='23505'?'Username already exists.':error.message,'err'); return; }
  showMsg('nsa-msg', `✅ ${ROLE_LABELS[role]||role} "@${user}" created!`,'ok');
  ['nsa-name','nsa-user','nsa-pass','nsa-email'].forEach(id => document.getElementById(id).value='');
  setTimeout(() => { toggleAddSuperAdmin(); loadDevSuperAdmins(); }, 1400);
}

async function devChangeRole(id, username, currentRole, companyId) {
  // Build role options excluding developer
  const roles = [
    { value: 'super_admin', label: 'Super Admin — full company access' },
    { value: 'admin',       label: 'Admin — workers & attendance' },
  ];
  const opts = roles.map(r => `${r.value === currentRole ? '✓ ' : ''}${r.label}`).join('\n');
  const choice = prompt(`Change role for @${username}.\n\nCurrent: ${ROLE_LABELS[currentRole]||currentRole}\n\nEnter new role:\n1 = Super Admin\n2 = Admin`);
  if (!choice) return;
  const roleMap = { '1': 'super_admin', '2': 'admin' };
  const newRole = roleMap[choice.trim()];
  if (!newRole) { toast('Invalid choice — enter 1 or 2'); return; }
  if (newRole === currentRole) { toast('Role unchanged'); return; }
  const { error } = await db.from('admin_users').update({ role: newRole }).eq('id', id);
  if (!error) { toast(`✅ @${username} is now ${ROLE_LABELS[newRole]}`); loadDevSuperAdmins(); }
  else toast('Error: ' + error.message);
}

async function devToggleSA(id, cur) {
  const { error } = await db.from('admin_users').update({ is_active: !cur }).eq('id', id);
  if (!error) { toast(cur ? 'Account deactivated' : 'Account reactivated'); loadDevSuperAdmins(); }
}

async function devResetAdminPw(id, username) {
  const pw = prompt(`Set new password for @${username}:`);
  if (!pw) return;
  if (pw.length < 6) { toast('Password must be at least 6 characters.'); return; }
  const { error } = await db.from('admin_users').update({ password_hash: pw }).eq('id', id);
  if (!error) toast(`✅ Password updated for @${username}`);
  else toast('Error: ' + error.message);
}

async function loadDevInfo() {
  const el = document.getElementById('dev-account-info');
  if (!S.admin) return;
  el.innerHTML = `
    <div class="info-row"><span class="info-lbl">Username</span><span>@${S.admin.username}</span></div>
    <div class="info-row" style="margin-bottom:12px"><span class="info-lbl">Role</span><span style="color:var(--purple);font-weight:700">Developer</span></div>
    <div class="field"><label>Full Name</label>
      <input id="dev-profile-name" type="text" class="input" value="${(S.admin.full_name||'').replace(/"/g,'&quot;')}" placeholder="Full Name">
    </div>
    <div class="field"><label>Email</label>
      <input id="dev-profile-email" type="email" class="input" value="${(S.admin.email||'').replace(/"/g,'&quot;')}" placeholder="Email address">
    </div>
    <button class="btn btn-outline btn-full" onclick="saveDevProfile()" style="margin-top:4px">Save Profile</button>
    <div id="dev-profile-msg" class="msg hidden"></div>`;
}

async function saveDevProfile() {
  const name  = (document.getElementById('dev-profile-name').value  || '').trim();
  const email = (document.getElementById('dev-profile-email').value || '').trim();
  if (!name) { showMsg('dev-profile-msg', 'Full name is required.', 'err'); return; }
  const { error } = await db.from('admin_users').update({ full_name: name, email: email || null }).eq('id', S.admin.id);
  if (error) { showMsg('dev-profile-msg', 'Failed: ' + error.message, 'err'); return; }
  S.admin.full_name = name; S.admin.email = email;
  showMsg('dev-profile-msg', '✅ Profile updated!', 'ok');
}

async function changeDevPw() {
  const pw = document.getElementById('dev-new-pw').value;
  if (!pw || pw.length < 6) { showMsg('dev-pw-msg','Password must be at least 6 characters.','err'); return; }
  const { error } = await db.from('admin_users').update({ password_hash: pw }).eq('id', S.admin.id);
  if (error) showMsg('dev-pw-msg','Failed: '+error.message,'err');
  else { showMsg('dev-pw-msg','✅ Password updated!','ok'); document.getElementById('dev-new-pw').value=''; }
}

// ── Super Admin: manage company admins ───────────────
function toggleAddCompanyAdmin() {
  const p = document.getElementById('add-company-admin-panel');
  p.classList.toggle('hidden');
  if (!p.classList.contains('hidden')) document.getElementById('ca-name').focus();
}

async function loadCompanyAdmins() {
  const el = document.getElementById('company-admins-list');
  el.innerHTML = '<div class="empty">Loading…</div>';
  const { data, error } = await db.from('admin_users')
    .select('*').eq('company_id', S.admin?.company_id).eq('role','admin').order('username');
  if (error || !data) { el.innerHTML = '<div class="empty">Failed to load</div>'; return; }
  if (!data.length)   { el.innerHTML = '<div class="empty">No admins yet — create one above</div>'; return; }
  el.innerHTML = '<div class="workers-list">' + data.map(a => `
    <div class="wr-row">
      <div class="wr-info">
        <div class="avatar sm">${(a.full_name||a.username).slice(0,2).toUpperCase()}</div>
        <div>
          <div class="wr-name">${a.full_name||a.username}</div>
          <div class="wr-meta">@${a.username}${a.email?' · '+a.email:''}${!a.is_active?' · <em>Inactive</em>':''}</div>
        </div>
      </div>
      <div class="wr-btns">
        <button class="icon-btn" title="Edit Profile" onclick="openEditAccount('${a.id}','${(a.full_name||'').replace(/'/g,"\\'")}','${(a.email||'').replace(/'/g,"\\'")}','${a.role}',false)">✏️</button>
        <button class="icon-btn" title="Reset Password" onclick="devResetAdminPw('${a.id}','${a.username}')">🔑</button>
        <button class="icon-btn" onclick="caToggle('${a.id}',${a.is_active})">${a.is_active?'🚫':'✅'}</button>
      </div>
    </div>`).join('') + '</div>';
}

async function addCompanyAdmin() {
  const name  = (document.getElementById('ca-name').value || '').trim();
  const user  = (document.getElementById('ca-user').value || '').trim().toLowerCase();
  const pass  = (document.getElementById('ca-pass').value || '').trim();
  const email = (document.getElementById('ca-email').value|| '').trim();
  if (!name||!user||!pass) { showMsg('ca-msg','Name, username and password are required.','err'); return; }
  if (pass.length < 6)     { showMsg('ca-msg','Password must be at least 6 characters.','err'); return; }
  const { error } = await db.from('admin_users').insert({
    username: user, password_hash: pass, full_name: name,
    email: email||null, role: 'admin', company_id: S.admin?.company_id, is_active: true,
  });
  if (error) { showMsg('ca-msg', error.code==='23505'?'Username already exists.':error.message,'err'); return; }
  showMsg('ca-msg',`✅ Admin "@${user}" created!`,'ok');
  ['ca-name','ca-user','ca-pass','ca-email'].forEach(id => document.getElementById(id).value='');
  setTimeout(() => { toggleAddCompanyAdmin(); loadCompanyAdmins(); }, 1400);
}

async function caToggle(id, cur) {
  const { error } = await db.from('admin_users').update({ is_active: !cur }).eq('id', id);
  if (!error) { toast(cur?'Admin deactivated':'Admin reactivated'); loadCompanyAdmins(); }
}

// ── Edit Account Modal (developer + super admin) ─────
let _editCtx = null; // 'dev' or 'admin'

function openEditAccount(id, name, email, role, isDevCtx) {
  _editCtx = isDevCtx ? 'dev' : 'admin';
  document.getElementById('edit-acct-id').value    = id;
  document.getElementById('edit-acct-name').value  = name;
  document.getElementById('edit-acct-email').value = email;
  document.getElementById('edit-acct-pw').value    = '';
  document.getElementById('edit-acct-msg').classList.add('hidden');
  const roleWrap = document.getElementById('edit-acct-role-wrap');
  if (isDevCtx) {
    roleWrap.classList.remove('hidden');
    document.getElementById('edit-acct-role').value = role;
  } else {
    roleWrap.classList.add('hidden');
  }
  document.getElementById('edit-account-modal').classList.remove('hidden');
}

function closeEditAccount(e) {
  if (!e || e.target === document.getElementById('edit-account-modal'))
    document.getElementById('edit-account-modal').classList.add('hidden');
}

async function saveEditAccount() {
  const id    = document.getElementById('edit-acct-id').value;
  const name  = (document.getElementById('edit-acct-name').value  || '').trim();
  const email = (document.getElementById('edit-acct-email').value || '').trim();
  const pw    = (document.getElementById('edit-acct-pw').value    || '').trim();
  const roleWrap = document.getElementById('edit-acct-role-wrap');

  if (!name) { showMsg('edit-acct-msg', 'Full name is required.', 'err'); return; }
  if (pw && pw.length < 6) { showMsg('edit-acct-msg', 'Password must be at least 6 characters.', 'err'); return; }

  const updates = { full_name: name, email: email || null };
  if (pw) updates.password_hash = pw;
  if (!roleWrap.classList.contains('hidden')) updates.role = document.getElementById('edit-acct-role').value;

  const { error } = await db.from('admin_users').update(updates).eq('id', id);
  if (error) { showMsg('edit-acct-msg', 'Failed: ' + error.message, 'err'); return; }

  showMsg('edit-acct-msg', '✅ Account updated!', 'ok');
  setTimeout(() => {
    closeEditAccount();
    if (_editCtx === 'dev') loadDevSuperAdmins();
    else loadCompanyAdmins();
  }, 1200);
}

// ── Edit Company (developer) ─────────────────────────
function openEditCompanyById(id) {
  const c = _cCache[id];
  if (!c) return;
  document.getElementById('edit-co-id').value   = id;
  document.getElementById('edit-co-name').value = c.name || '';
  document.getElementById('edit-co-code').value = c.code || '';
  document.getElementById('edit-co-msg').classList.add('hidden');
  document.getElementById('edit-company-modal').classList.remove('hidden');
}

function closeEditCompany(e) {
  if (!e || e.target === document.getElementById('edit-company-modal'))
    document.getElementById('edit-company-modal').classList.add('hidden');
}

async function saveEditCompany() {
  const id   = document.getElementById('edit-co-id').value;
  const name = (document.getElementById('edit-co-name').value || '').trim();
  const code = (document.getElementById('edit-co-code').value || '').trim().toUpperCase().replace(/\s+/g, '');
  if (!name || !code) { showMsg('edit-co-msg', 'Name and Code are required.', 'err'); return; }
  if (!/^[A-Z0-9_]+$/.test(code)) { showMsg('edit-co-msg', 'Code may only contain letters, numbers and underscores.', 'err'); return; }
  const { error } = await db.from('companies').update({ name, code }).eq('id', id);
  if (error) { showMsg('edit-co-msg', error.code === '23505' ? 'Company code already exists.' : error.message, 'err'); return; }
  showMsg('edit-co-msg', '✅ Company updated!', 'ok');
  setTimeout(() => { closeEditCompany(); loadDevCompanies(); }, 1200);
}

// ── Edit Worker (employer + developer) ───────────────
function openEditWorkerById(id) {
  const w = _wCache[id];
  if (!w) return;
  document.getElementById('edit-wk-id').value       = id;
  document.getElementById('edit-wk-ctx').value      = w._ctx || 'admin';
  document.getElementById('edit-wk-empid').value    = w.employee_id || '';
  document.getElementById('edit-wk-name').value     = w.name || '';
  document.getElementById('edit-wk-jobtitle').value = w.job_title || '';
  document.getElementById('edit-wk-phone').value    = w.phone || '';
  document.getElementById('edit-wk-email').value    = w.email || '';
  document.getElementById('edit-wk-pin').value      = '';
  document.getElementById('edit-wk-msg').classList.add('hidden');
  document.getElementById('edit-worker-modal').classList.remove('hidden');
}

function closeEditWorker(e) {
  if (!e || e.target === document.getElementById('edit-worker-modal'))
    document.getElementById('edit-worker-modal').classList.add('hidden');
}

async function saveEditWorker() {
  const id       = document.getElementById('edit-wk-id').value;
  const ctx      = document.getElementById('edit-wk-ctx').value;
  const empId    = (document.getElementById('edit-wk-empid').value    || '').trim().toUpperCase();
  const name     = (document.getElementById('edit-wk-name').value     || '').trim();
  const jobTitle = (document.getElementById('edit-wk-jobtitle').value || '').trim();
  const phone    = (document.getElementById('edit-wk-phone').value    || '').trim();
  const email    = (document.getElementById('edit-wk-email').value    || '').trim();
  const pin      = (document.getElementById('edit-wk-pin').value      || '').trim();

  if (!empId || !name) { showMsg('edit-wk-msg', 'Employee ID and Name are required.', 'err'); return; }
  if (pin && pin.length < 4) { showMsg('edit-wk-msg', 'PIN must be at least 4 digits.', 'err'); return; }

  const updates = { employee_id: empId, name, job_title: jobTitle || null, phone: phone || null, email: email || null };
  if (pin) updates.pin = pin;

  const { error } = await db.from('workers').update(updates).eq('id', id);
  if (error) { showMsg('edit-wk-msg', error.code === '23505' ? 'Employee ID already in use.' : error.message, 'err'); return; }
  showMsg('edit-wk-msg', '✅ Worker updated!', 'ok');
  setTimeout(() => {
    closeEditWorker();
    if (ctx === 'dev') loadDevWorkers(); else loadWorkers();
  }, 1200);
}

// ── Developer: Workers tab ────────────────────────────
async function loadDevWorkers() {
  const el        = document.getElementById('dev-workers-list');
  const filterSel = document.getElementById('dev-filter-company-wk');

  if (filterSel.options.length <= 1) {
    const { data: cos } = await db.from('companies').select('id,name').eq('is_active', true).order('name');
    filterSel.innerHTML = '<option value="">Select a company…</option>' +
      (cos || []).map(c => `<option value="${c.id}">${c.name}</option>`).join('');
  }

  const cid = filterSel.value;
  if (!cid) { el.innerHTML = '<div class="empty">Select a company above to view its workers</div>'; return; }

  el.innerHTML = '<div class="empty">Loading…</div>';
  const { data, error } = await db.from('workers').select('*').eq('company_id', cid).order('name');
  if (error || !data) { el.innerHTML = '<div class="empty">Failed to load</div>'; return; }
  if (!data.length)   { el.innerHTML = '<div class="empty">No workers in this company</div>'; return; }

  data.forEach(w => { _wCache[w.id] = { ...w, _ctx: 'dev' }; });

  el.innerHTML = '<div class="workers-list">' + data.map(w => `
    <div class="wr-row">
      <div class="wr-info">
        <div class="avatar sm">${initials(w.name)}</div>
        <div>
          <div class="wr-name">${w.name}</div>
          <div class="wr-meta">${w.employee_id}${w.job_title?' · '+w.job_title:''}${w.biometric_enabled?' · 🔏':''}${w.face_descriptor?' · 🤳':''}${!w.is_active?' · <em>Inactive</em>':''}</div>
        </div>
      </div>
      <div class="wr-btns">
        <button class="icon-btn" title="Edit Worker" onclick="openEditWorkerById('${w.id}')">✏️</button>
        <button class="icon-btn" title="Enrol Face" onclick="adminEnrollFace('${w.id}','${w.name.replace(/'/g,"\\'")}','dev')">🤳</button>
        <button class="icon-btn" title="${w.is_active?'Deactivate':'Reactivate'}" onclick="devToggleWorker('${w.id}',${w.is_active})">${w.is_active?'🚫':'✅'}</button>
      </div>
    </div>`).join('') + '</div>';
}

async function devToggleWorker(id, cur) {
  const { error } = await db.from('workers').update({ is_active: !cur }).eq('id', id);
  if (!error) { toast(cur ? 'Worker deactivated' : 'Worker reactivated'); loadDevWorkers(); }
}

// ════════════════════════════════════════════════════
//  FACE RECOGNITION  (face-api.js)
// ════════════════════════════════════════════════════
const FACE_MODELS_URL = 'https://cdn.jsdelivr.net/gh/justadudewhohacks/face-api.js@0.22.2/weights';
let _faceModelsLoaded = false;
let _faceLoadPromise  = null;

async function loadFaceModels() {
  if (typeof faceapi === 'undefined') throw new Error('face-api.js not loaded yet — please wait a moment and try again');
  if (_faceModelsLoaded) return;
  if (_faceLoadPromise) return _faceLoadPromise;
  _faceLoadPromise = Promise.all([
    faceapi.nets.tinyFaceDetector.loadFromUri(FACE_MODELS_URL),
    faceapi.nets.faceLandmark68TinyNet.loadFromUri(FACE_MODELS_URL),
    faceapi.nets.faceRecognitionNet.loadFromUri(FACE_MODELS_URL),
  ]).then(() => {
    _faceModelsLoaded = true;
  }).catch(err => {
    _faceLoadPromise = null;
    throw err;
  });
  return _faceLoadPromise;
}

const faceOpts = () => new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 });

// ── Face recognition clock-in ─────────────────────────
let _faceStream    = null;
let _faceRunning   = false;
let _faceMatcher   = null;
let _faceWorkerMap = {};

async function openFaceRecognition() {
  showPage('face-scan');
  const statusEl = document.getElementById('face-status');
  const oval     = document.getElementById('face-oval');
  oval.classList.remove('face-found');

  if (!S.companyId) {
    statusEl.textContent = '⚠️ No company linked — open the employer's clock-in link first.';
    return;
  }

  statusEl.textContent = '⏳ Loading face models (first time may take a moment)…';
  try {
    await loadFaceModels();
  } catch {
    statusEl.textContent = '❌ Could not load face models — check your internet connection.';
    return;
  }

  statusEl.textContent = 'Loading enrolled faces…';
  const { data: workers } = await db.from('workers')
    .select('id, name, employee_id, face_descriptor')
    .eq('company_id', S.companyId)
    .eq('is_active', true)
    .not('face_descriptor', 'is', null);

  if (!workers?.length) {
    statusEl.textContent = '⚠️ No faces enrolled yet — ask your admin to enrol your face first.';
    return;
  }

  const labeled = [];
  _faceWorkerMap = {};
  for (const w of workers) {
    try {
      const arr = JSON.parse(w.face_descriptor);
      labeled.push(new faceapi.LabeledFaceDescriptors(w.id, [new Float32Array(arr)]));
      _faceWorkerMap[w.id] = w;
    } catch { /* skip corrupt entries */ }
  }

  if (!labeled.length) {
    statusEl.textContent = '⚠️ Face data invalid — ask admin to re-enrol your face.';
    return;
  }

  _faceMatcher = new faceapi.FaceMatcher(labeled, 0.50);

  statusEl.textContent = 'Position your face inside the oval…';
  try {
    _faceStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } }
    });
    const video = document.getElementById('face-video');
    video.srcObject = _faceStream;
    await video.play();
    _faceRunning = true;
    requestAnimationFrame(faceRecognitionFrame);
  } catch (err) {
    statusEl.textContent = err.name === 'NotAllowedError'
      ? '❌ Camera access denied — allow camera in your browser settings'
      : '❌ Camera error: ' + err.message;
  }
}

async function faceRecognitionFrame() {
  if (!_faceRunning) return;
  const video    = document.getElementById('face-video');
  const statusEl = document.getElementById('face-status');
  const oval     = document.getElementById('face-oval');

  if (video.readyState !== video.HAVE_ENOUGH_DATA) {
    requestAnimationFrame(faceRecognitionFrame);
    return;
  }

  try {
    const det = await faceapi
      .detectSingleFace(video, faceOpts())
      .withFaceLandmarks(true)
      .withFaceDescriptor();

    if (!det) {
      oval.classList.remove('face-found');
      requestAnimationFrame(faceRecognitionFrame);
      return;
    }

    const match = _faceMatcher.findBestMatch(det.descriptor);

    if (match.label === 'unknown') {
      oval.classList.remove('face-found');
      statusEl.textContent = '❓ Face not recognised — try again or use Employee ID';
      await new Promise(r => setTimeout(r, 1500));
      if (_faceRunning) statusEl.textContent = 'Position your face inside the oval…';
      requestAnimationFrame(faceRecognitionFrame);
      return;
    }

    // ── Match found ──────────────────────────────────
    _faceRunning = false;
    oval.classList.add('face-found');
    const matched = _faceWorkerMap[match.label];
    statusEl.textContent = `✅ Recognised: ${matched?.name || 'Unknown'}`;
    vibrate([50, 30, 100]);

    if (_faceStream) { _faceStream.getTracks().forEach(t => t.stop()); _faceStream = null; }

    const { data } = await db.from('workers')
      .select('*, workplace:workplaces(*)')
      .eq('id', match.label).eq('is_active', true).maybeSingle();

    if (!data) {
      statusEl.textContent = '❌ Account not found — contact your admin.';
      setTimeout(() => showPage('home'), 2500);
      return;
    }
    S.worker     = data;
    S.authMethod = 'biometric';
    S.authSource = 'face';
    setTimeout(() => enterClockScreen(), 900);

  } catch {
    requestAnimationFrame(faceRecognitionFrame);
  }
}

function stopFaceRecognition() {
  _faceRunning = false;
  if (_faceStream) { _faceStream.getTracks().forEach(t => t.stop()); _faceStream = null; }
  showPage('home');
}

// ── Face enrolment ────────────────────────────────────
let _enrollStream = null;
let _enrollTarget = null; // { id, name, ctx }

async function adminEnrollFace(workerId, workerName, ctx) {
  _enrollTarget = { id: workerId, name: workerName, ctx: ctx || 'admin' };
  document.getElementById('face-enroll-title').textContent  = `Enrol Face — ${workerName}`;
  document.getElementById('enroll-face-status').textContent = '⏳ Loading models…';
  document.getElementById('enroll-face-snap-btn').disabled  = true;
  document.getElementById('face-enroll-modal').classList.remove('hidden');

  try {
    await loadFaceModels();
  } catch {
    document.getElementById('enroll-face-status').textContent = '❌ Could not load models — check internet.';
    return;
  }

  document.getElementById('enroll-face-status').textContent = 'Opening camera…';
  try {
    _enrollStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } }
    });
    const video = document.getElementById('enroll-video');
    video.srcObject = _enrollStream;
    await video.play();
    document.getElementById('enroll-face-status').textContent =
      `Position ${workerName}'s face clearly in the frame, then tap Capture.`;
    document.getElementById('enroll-face-snap-btn').disabled = false;
  } catch (err) {
    document.getElementById('enroll-face-status').textContent = err.name === 'NotAllowedError'
      ? '❌ Camera access denied' : '❌ ' + err.message;
  }
}

function workerEnrollFace() {
  if (!S.worker) return;
  adminEnrollFace(S.worker.id, S.worker.name, 'worker');
}

async function captureFaceEnroll() {
  const statusEl = document.getElementById('enroll-face-status');
  const btn      = document.getElementById('enroll-face-snap-btn');
  btn.disabled   = true;
  statusEl.textContent = 'Detecting face…';

  const video = document.getElementById('enroll-video');
  try {
    const det = await faceapi
      .detectSingleFace(video, faceOpts())
      .withFaceLandmarks(true)
      .withFaceDescriptor();

    if (!det) {
      statusEl.textContent = '❌ No face detected — ensure good lighting and face is fully visible.';
      btn.disabled = false;
      return;
    }

    const descriptor = JSON.stringify(Array.from(det.descriptor));
    const { error } = await db.from('workers')
      .update({ face_descriptor: descriptor }).eq('id', _enrollTarget.id);

    if (error) {
      statusEl.textContent = '❌ Save failed: ' + error.message;
      btn.disabled = false;
      return;
    }

    vibrate([50, 30, 100]);
    statusEl.textContent = `✅ Face enrolled for ${_enrollTarget.name}!`;

    if (_enrollTarget.ctx === 'worker') {
      S.worker.face_descriptor = descriptor;
      document.getElementById('face-reg-card').style.display = 'none';
    }

    setTimeout(() => {
      closeFaceEnrollModal();
      if (_enrollTarget.ctx === 'dev')   loadDevWorkers();
      else if (_enrollTarget.ctx === 'admin') loadWorkers();
    }, 1400);

  } catch (err) {
    statusEl.textContent = '❌ Detection error: ' + err.message;
    btn.disabled = false;
  }
}

function closeFaceEnrollModal() {
  if (_enrollStream) { _enrollStream.getTracks().forEach(t => t.stop()); _enrollStream = null; }
  document.getElementById('face-enroll-modal').classList.add('hidden');
}

// ── PWA Install ──────────────────────────────────────
let _installPrompt = null;

window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  _installPrompt = e;
  // Show install banner once home page is visible
  setTimeout(() => {
    const banner = document.getElementById('install-banner');
    if (banner) banner.classList.remove('hidden');
  }, 2000);
});

window.addEventListener('appinstalled', () => {
  const banner = document.getElementById('install-banner');
  if (banner) banner.classList.add('hidden');
  _installPrompt = null;
  toast('✅ WorkClock installed! Find it on your home screen.');
});

async function installApp() {
  if (!_installPrompt) return;
  _installPrompt.prompt();
  const { outcome } = await _installPrompt.userChoice;
  if (outcome === 'accepted') {
    document.getElementById('install-banner').classList.add('hidden');
    _installPrompt = null;
  }
}

function checkIOSInstall() {
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const isStandalone = window.navigator.standalone === true;
  if (isIOS && !isStandalone) {
    setTimeout(() => {
      const b = document.getElementById('ios-install-banner');
      if (b) b.classList.remove('hidden');
    }, 2000);
  }
}

// ── Bootstrap ────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  checkIOSInstall();

  // Always show home within 1.5 s. DB queries run in background and
  // navigate to clock screen if a saved worker session is found.
  let pageShown = false;
  const splashTimer = setTimeout(() => {
    if (!pageShown) { pageShown = true; showPage('home'); }
  }, 1500);

  (async () => {
    await initCompany();

    const savedId = localStorage.getItem('wc_worker_id');
    if (!savedId) return;

    try {
      const { data } = await withTimeout(
        db.from('workers').select('*, workplace:workplaces(*)')
          .eq('id', savedId).eq('is_active', true).maybeSingle(),
        5000
      );
      if (data) {
        S.worker = data;
        if (!S.companyId) {
          try {
            const { data: co } = await withTimeout(
              db.from('companies').select('*').eq('id', data.company_id).maybeSingle(),
              5000
            );
            if (co) setCompany(co, false);
          } catch {}
        }
        clearTimeout(splashTimer);
        pageShown = true;
        enterClockScreen();
        return;
      }
    } catch {}
    localStorage.removeItem('wc_worker_id');
  })();
});
