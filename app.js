'use strict';

// ═══════════════════════════════════════════════
//  STATE
// ═══════════════════════════════════════════════
const S = {
  worker:       null,  // logged-in worker
  admin:        null,  // logged-in admin/developer
  workplace:    null,
  userLoc:      null,
  geoWatcher:   null,
  clockStatus:  'out',
  attendanceId: null,
  authMethod:   'pin',
  authSource:   'manual',
  scanStream:   null,
  scanRunning:  false,
  nfcReader:    null,
  npPin:        [],
  npTimer:      null,
  companyId:    null,
  companyName:  null,
  fromUrl:      false,
};

// caches for edit modals
const _wCache = {};
const _cCache = {};

// ═══════════════════════════════════════════════
//  NAVIGATION
// ═══════════════════════════════════════════════
function showPage(id) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  const el = document.getElementById('page-' + id);
  if (el) { el.classList.add('active'); window.scrollTo(0, 0); }
}

// ═══════════════════════════════════════════════
//  UTILITIES
// ═══════════════════════════════════════════════
const initials = n => (n || '??').split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms)),
  ]);
}

function haversineM(la1, lo1, la2, lo2) {
  const R = 6371000, r = d => d * Math.PI / 180;
  const a = Math.sin(r(la2-la1)/2)**2 + Math.cos(r(la1))*Math.cos(r(la2))*Math.sin(r(lo2-lo1)/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

const b64   = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = s   => { const b=atob(s),a=new Uint8Array(b.length); for(let i=0;i<b.length;i++)a[i]=b.charCodeAt(i); return a.buffer; };

let _toastTimer;
function toast(msg, dur = 3000) {
  const el = document.getElementById('toast');
  el.textContent = msg; el.classList.remove('hidden');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.add('hidden'), dur);
}

function showErr(id, msg) {
  const el = document.getElementById(id); if (!el) return;
  if (!msg) { el.classList.add('hidden'); return; }
  el.textContent = msg; el.classList.remove('hidden');
}

function showMsg(id, msg, type) {
  const el = document.getElementById(id); if (!el) return;
  el.textContent = msg; el.className = 'msg ' + (type || ''); el.classList.remove('hidden');
  if (type === 'ok') setTimeout(() => el.classList.add('hidden'), 3500);
}

function fmtTime(iso) {
  return iso ? new Date(iso).toLocaleTimeString('en-ZA', { hour:'2-digit', minute:'2-digit' }) : '--:--';
}

function fmtDate(iso) {
  return iso ? new Date(iso).toLocaleDateString('en-ZA') : '';
}

function vibrate(p = 50) { navigator.vibrate?.(p); }

// ═══════════════════════════════════════════════
//  COMPANY INIT
// ═══════════════════════════════════════════════
function setCompany(co, fromUrl) {
  S.companyId   = co.id;
  S.companyName = co.name;
  S.fromUrl     = !!fromUrl;
  localStorage.setItem('wc_company', JSON.stringify(co));
  updateHomeUI();
}

function updateHomeUI() {
  const nameEl  = document.getElementById('home-co-name');
  const noCard  = document.getElementById('no-co-card');
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
  const saved = localStorage.getItem('wc_company');
  if (saved) { try { setCompany(JSON.parse(saved), false); return; } catch {} }
  updateHomeUI();
}

// ═══════════════════════════════════════════════
//  LIVE CLOCK
// ═══════════════════════════════════════════════
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

// ═══════════════════════════════════════════════
//  QR SCANNER
// ═══════════════════════════════════════════════
async function openQR() {
  showPage('scan');
  document.getElementById('scan-status').textContent = 'Searching for QR code…';
  try {
    S.scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode:'environment', width:{ideal:1280}, height:{ideal:720} } });
    const video  = document.getElementById('qr-video');
    video.srcObject = S.scanStream; await video.play();
    S.scanRunning = true;
    requestAnimationFrame(qrFrame);
  } catch (err) {
    document.getElementById('scan-status').textContent =
      err.name === 'NotAllowedError' ? '❌ Camera access denied — allow camera in browser settings' : '❌ ' + err.message;
  }
}

function qrFrame() {
  if (!S.scanRunning) return;
  const video = document.getElementById('qr-video');
  const canvas = document.getElementById('qr-canvas');
  if (video.readyState === video.HAVE_ENOUGH_DATA) {
    canvas.width = video.videoWidth; canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d'); ctx.drawImage(video, 0, 0);
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const code = jsQR(img.data, img.width, img.height, { inversionAttempts:'dontInvert' });
    if (code) { vibrate(80); stopQR(); handleCardRead(code.data.trim().toUpperCase()); return; }
  }
  requestAnimationFrame(qrFrame);
}

function stopQR() {
  S.scanRunning = false;
  if (S.scanStream) { S.scanStream.getTracks().forEach(t => t.stop()); S.scanStream = null; }
}

// ═══════════════════════════════════════════════
//  NFC
// ═══════════════════════════════════════════════
async function openNFC() {
  showPage('nfc');
  if (!('NDEFReader' in window)) {
    document.getElementById('nfc-hint').textContent = '⚠️ NFC not supported (requires Android + Chrome)';
    showErr('nfc-err', 'Use QR scan or Enter Employee ID instead.'); return;
  }
  document.getElementById('nfc-hint').textContent = 'Ready — tap your NFC card to the back of the phone';
  try {
    S.nfcReader = new NDEFReader(); await S.nfcReader.scan();
    S.nfcReader.addEventListener('reading', ({ message }) => {
      const dec = new TextDecoder();
      for (const rec of message.records) {
        if (rec.recordType === 'text') {
          vibrate(80); stopNFC(); handleCardRead(dec.decode(rec.data).trim().toUpperCase()); return;
        }
      }
      showErr('nfc-err', 'Card read but no ID found.');
    });
    S.nfcReader.addEventListener('readingerror', () => showErr('nfc-err', 'Could not read card.'));
  } catch (err) {
    showErr('nfc-err', err.name === 'NotAllowedError' ? 'NFC permission denied.' : err.message);
  }
}

function stopNFC() { S.nfcReader = null; }

// ═══════════════════════════════════════════════
//  CARD READ (QR / NFC)
// ═══════════════════════════════════════════════
async function handleCardRead(empId) {
  toast('🔍 Looking up ' + empId + '…');
  S.authSource = 'card';
  document.getElementById('inp-empid').value = empId;
  await findWorker(empId);
}

// ═══════════════════════════════════════════════
//  HOME BIOMETRIC (discoverable credential)
// ═══════════════════════════════════════════════
async function homeBiometric() {
  if (!window.PublicKeyCredential) { toast('Biometric not supported on this browser'); return; }
  try {
    const cred = await navigator.credentials.get({ publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      allowCredentials: [],
      userVerification: 'required',
      timeout: 60000,
    }});
    if (!cred) return;
    const workerId = new TextDecoder().decode(cred.response.userHandle);
    if (!workerId) { toast('❌ Biometric not linked. Use Employee ID.'); return; }
    toast('Authenticated — loading your account…');
    S.authSource = 'biometric'; S.authMethod = 'biometric';
    let q = db.from('workers').select('*, workplace:workplaces(*)').eq('id', workerId).eq('is_active', true);
    if (S.companyId && S.fromUrl) q = q.eq('company_id', S.companyId);
    const { data } = await q.maybeSingle();
    if (!data) { toast('❌ Account not found.'); return; }
    S.worker = data; enterClockScreen();
  } catch (err) {
    if (err.name !== 'NotAllowedError') toast('Biometric error: ' + err.message);
  }
}

// ═══════════════════════════════════════════════
//  WORKER LOOKUP
// ═══════════════════════════════════════════════
async function findWorker(overrideId) {
  const id = overrideId || (document.getElementById('inp-empid').value || '').trim().toUpperCase();
  showErr('err-empid', '');
  if (!id) { showErr('err-empid', 'Please enter your Employee ID.'); return; }
  try {
    let q = db.from('workers').select('*, workplace:workplaces(*)')
      .eq('employee_id', id).eq('is_active', true);
    if (S.companyId && S.fromUrl) q = q.eq('company_id', S.companyId);
    const { data, error } = await q.maybeSingle();
    if (error?.code === 'PGRST116') {
      showErr('err-empid', 'Multiple accounts with this ID — open your employer's link (?c=CODE).');
      return;
    }
    if (!data) {
      if (S.authSource === 'card') { toast('❌ Card not recognised (' + id + ')'); showPage('home'); }
      else showErr('err-empid', 'Employee ID not found. Check with your manager.');
      return;
    }
    S.worker = data; goToAuth(data);
  } catch {
    if (S.authSource === 'card') { toast('❌ Connection error'); showPage('home'); }
    else showErr('err-empid', 'Connection error. Check internet and try again.');
  }
}

function goToAuth(w) {
  document.getElementById('auth-avatar').textContent = initials(w.name);
  document.getElementById('auth-name').textContent   = w.name;
  document.getElementById('auth-empid').textContent  = w.employee_id;
  document.getElementById('auth-job').textContent    = w.job_title || '';
  const bioWrap = document.getElementById('bio-auth-wrap');
  if (w.biometric_enabled && w.biometric_credential_id && window.PublicKeyCredential) {
    bioWrap.classList.remove('hidden');
    if (S.authSource === 'card') { showPage('auth'); npReset(); setTimeout(authBiometric, 400); return; }
  } else {
    bioWrap.classList.add('hidden');
  }
  showPage('auth'); npReset();
}

function backFromAuth() { S.worker = null; S.authSource = 'manual'; showPage('home'); }

// ═══════════════════════════════════════════════
//  PIN NUMPAD
// ═══════════════════════════════════════════════
function npReset() { S.npPin = []; clearTimeout(S.npTimer); renderDots(); showErr('err-pin', ''); }

function npKey(d) {
  if (S.npPin.length >= 6) return;
  S.npPin.push(d); renderDots(); vibrate(20); clearTimeout(S.npTimer);
  if (S.npPin.length >= 4) S.npTimer = setTimeout(verifyPin, 600);
}

function npBack()  { S.npPin.pop(); renderDots(); clearTimeout(S.npTimer); showErr('err-pin', ''); }
function npClear() { npReset(); }

function renderDots() {
  for (let i = 0; i < 6; i++) {
    const d = document.getElementById('pd' + i);
    if (d) d.classList.toggle('filled', i < S.npPin.length);
  }
}

function verifyPin() {
  if (!S.worker) return;
  if (S.npPin.join('') !== String(S.worker.pin)) {
    vibrate([50,30,50]); showErr('err-pin', 'Incorrect PIN — try again'); npReset(); return;
  }
  S.authMethod = 'pin'; enterClockScreen();
}

// ═══════════════════════════════════════════════
//  BIOMETRIC AUTH
// ═══════════════════════════════════════════════
async function authBiometric() {
  showErr('err-pin', '');
  if (!window.PublicKeyCredential) { showErr('err-pin', 'Biometric not supported.'); return; }
  try {
    const cred = await navigator.credentials.get({ publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      allowCredentials: [{ id: unb64(S.worker.biometric_credential_id), type:'public-key' }],
      userVerification: 'required', timeout: 60000,
    }});
    if (cred) { S.authMethod = 'biometric'; enterClockScreen(); }
  } catch (err) {
    if (err.name !== 'NotAllowedError') showErr('err-pin', 'Error: ' + err.message);
  }
}

// ═══════════════════════════════════════════════
//  CLOCK SCREEN
// ═══════════════════════════════════════════════
async function enterClockScreen() {
  const w = S.worker;
  localStorage.setItem('wc_worker_id', w.id);

  document.getElementById('clk-avatar').textContent = initials(w.name);
  document.getElementById('clk-name').textContent   = w.name;
  document.getElementById('clk-empid').textContent  = w.employee_id;
  document.getElementById('clk-job').textContent    = w.job_title || '';

  const hour = new Date().getHours();
  const greet = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  document.getElementById('clock-greeting').textContent = greet + ', ' + w.name.split(' ')[0] + '!';

  showPage('clock'); startClock();
  document.getElementById('bio-reg-card').style.display = (!w.biometric_enabled && window.PublicKeyCredential) ? '' : 'none';
  document.getElementById('face-reg-card').style.display = !w.face_descriptor ? '' : 'none';

  await loadTodayRecord();
  startLocationWatch();
}

async function loadTodayRecord() {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const { data } = await db.from('attendance')
    .select('*').eq('worker_id', S.worker.id)
    .gte('clock_in_time', today.toISOString())
    .order('clock_in_time', { ascending: false }).limit(1);

  const rec = data?.[0];
  const card = document.getElementById('today-card');
  const badge = document.getElementById('clk-badge');

  if (rec) {
    card.style.display = '';
    document.getElementById('rec-in').textContent  = fmtTime(rec.clock_in_time);
    document.getElementById('rec-out').textContent = rec.clock_out_time ? fmtTime(rec.clock_out_time) : 'Still In';
    if (rec.clock_in_time && rec.clock_out_time) {
      const hrs = ((new Date(rec.clock_out_time) - new Date(rec.clock_in_time)) / 3600000).toFixed(1);
      document.getElementById('rec-hrs').textContent = hrs + 'h';
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
}

function startLocationWatch() {
  const btn     = document.getElementById('clk-btn');
  const locCard = document.getElementById('loc-card');
  const locBlk  = document.getElementById('loc-blocked-card');
  locCard.style.display = ''; locBlk.classList.add('hidden');
  document.getElementById('loc-status').innerHTML = '<div class="checking"><div class="spin-sm"></div> Getting your location…</div>';

  if (!navigator.geolocation) {
    document.getElementById('loc-status').textContent = '⚠️ Location not available on this device';
    setClockBtn(true); return;
  }

  if (S.geoWatcher) navigator.geolocation.clearWatch(S.geoWatcher);

  S.geoWatcher = navigator.geolocation.watchPosition(
    pos => {
      S.userLoc = pos.coords;
      const wp  = S.worker?.workplace;
      if (!wp?.latitude || !wp?.longitude) {
        document.getElementById('loc-status').innerHTML = '⚠️ <span style="color:var(--amber)">Workplace not configured yet — ask your admin to set it up</span>';
        setClockBtn(true); return;
      }
      const dist = Math.round(haversineM(pos.coords.latitude, pos.coords.longitude, wp.latitude, wp.longitude));
      const radius = wp.radius_meters || 100;
      const inside = dist <= radius;
      document.getElementById('loc-status').innerHTML = inside
        ? '✅ <strong>' + (wp.name || 'Workplace') + '</strong> — ' + dist + 'm away'
        : '❌ Too far — ' + dist + 'm from <strong>' + (wp.name || 'workplace') + '</strong> (max ' + radius + 'm)';
      setClockBtn(inside);
    },
    err => {
      if (err.code === err.PERMISSION_DENIED) {
        locCard.style.display = 'none'; locBlk.classList.remove('hidden');
      } else {
        document.getElementById('loc-status').textContent = '⚠️ Location error: ' + err.message;
        setClockBtn(false);
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
  const btn = document.getElementById('clk-btn');
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

async function clockAction() {
  const btn = document.getElementById('clk-btn');
  btn.disabled = true;
  const action = S.clockStatus === 'in' ? 'out' : 'in';

  try {
    if (action === 'in') {
      const { data, error } = await db.from('attendance').insert({
        worker_id: S.worker.id,
        clock_in_time: new Date().toISOString(),
        auth_method: S.authMethod,
        status: 'active',
        location_lat: S.userLoc?.latitude  || null,
        location_lng: S.userLoc?.longitude || null,
      }).select().single();
      if (error) throw error;
      S.attendanceId = data.id; S.clockStatus = 'in';
    } else {
      const { error } = await db.from('attendance').update({
        clock_out_time: new Date().toISOString(),
        status: 'completed',
      }).eq('id', S.attendanceId);
      if (error) throw error;
      S.clockStatus = 'out';
    }

    vibrate([50, 30, 100]);
    showSuccess(action);
    await loadTodayRecord();
  } catch (err) {
    toast('❌ ' + err.message);
  }

  btn.disabled = false;
  setClockBtn(true);
}

function showSuccess(action) {
  const overlay = document.getElementById('success-overlay');
  const icon    = document.getElementById('succ-icon');
  icon.className = 'succ-icon' + (action === 'out' ? ' out' : '');
  icon.textContent = action === 'in' ? '✓' : '⏹';
  document.getElementById('succ-action').textContent = action === 'in' ? 'Clocked In!' : 'Clocked Out!';
  document.getElementById('succ-name').textContent   = S.worker.name;
  document.getElementById('succ-time').textContent   = new Date().toLocaleTimeString('en-ZA', { hour:'2-digit', minute:'2-digit' });
  document.getElementById('succ-wp').textContent     = S.worker?.workplace?.name || '';
  overlay.classList.remove('hidden');
  setTimeout(() => overlay.classList.add('hidden'), 2500);
}

function logoutWorker() {
  if (S.geoWatcher) { navigator.geolocation.clearWatch(S.geoWatcher); S.geoWatcher = null; }
  S.worker = null; S.userLoc = null; S.clockStatus = 'out'; S.attendanceId = null; S.authSource = 'manual';
  localStorage.removeItem('wc_worker_id');
  document.getElementById('inp-empid').value = '';
  showPage('home');
}

// ═══════════════════════════════════════════════
//  WORKER BIOMETRIC REGISTER
// ═══════════════════════════════════════════════
async function workerRegBio() {
  if (!window.PublicKeyCredential) { showMsg('bio-reg-msg', 'Biometric not supported on this browser.', 'err'); return; }
  try {
    const cred = await navigator.credentials.create({ publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rp:   { name:'WorkClock', id: window.location.hostname || 'localhost' },
      user: { id: new TextEncoder().encode(S.worker.id), name: S.worker.employee_id, displayName: S.worker.name },
      pubKeyCredParams: [{ alg:-7, type:'public-key' }, { alg:-257, type:'public-key' }],
      authenticatorSelection: { authenticatorAttachment:'platform', userVerification:'required', residentKey:'required', requireResidentKey:true },
      timeout: 60000,
    }});
    if (!cred) return;
    const { error } = await db.from('workers')
      .update({ biometric_credential_id: b64(cred.rawId), biometric_enabled: true }).eq('id', S.worker.id);
    if (error) throw error;
    S.worker.biometric_enabled = true;
    document.getElementById('bio-reg-card').style.display = 'none';
    showMsg('bio-reg-msg', '✅ Biometric registered! Use fingerprint to clock in next time.', 'ok');
  } catch (err) {
    if (err.name !== 'NotAllowedError') showMsg('bio-reg-msg', 'Error: ' + err.message, 'err');
  }
}

// ═══════════════════════════════════════════════
//  ADMIN LOGIN
// ═══════════════════════════════════════════════
async function adminLogin() {
  const user = (document.getElementById('inp-auser').value || '').trim().toLowerCase();
  const pass =  document.getElementById('inp-apass').value || '';
  showErr('err-admin', '');
  if (!user || !pass) { showErr('err-admin', 'Enter username and password.'); return; }
  if (typeof db === 'undefined') { showErr('err-admin', 'App not ready — refresh the page.'); return; }
  try {
    const { data, error } = await db.from('admin_users')
      .select('*, co:companies(name,code)')
      .eq('username', user).eq('password_hash', pass).eq('is_active', true).maybeSingle();
    if (error) { showErr('err-admin', 'Database error: ' + error.message); return; }
    if (!data)  { showErr('err-admin', 'Invalid username or password.'); return; }
    S.admin = data;
    document.getElementById('inp-auser').value = '';
    document.getElementById('inp-apass').value = '';
    if (data.role === 'developer') {
      showPage('developer'); loadDevCos();
    } else {
      document.getElementById('admin-co-label').textContent = data.co?.name || '';
      const isSA = data.role === 'super_admin';
      document.getElementById('tab-btn-admins').classList.toggle('hidden', !isSA);
      showPage('admin'); loadDashboard();
    }
  } catch (err) { showErr('err-admin', 'Error: ' + err.message); }
}

function adminLogout() { S.admin = null; showPage('home'); }

// ═══════════════════════════════════════════════
//  FORGOT PASSWORD (OTP via EmailJS)
// ═══════════════════════════════════════════════
const _otp = { code: null, expiry: null };

function toggleForgot() {
  const p = document.getElementById('forgot-panel');
  p.classList.toggle('hidden');
  if (!p.classList.contains('hidden')) {
    ['fp-step2','fp-step3'].forEach(id => document.getElementById(id).classList.add('hidden'));
    document.getElementById('fp-step1').classList.remove('hidden');
    document.getElementById('fp-msg').classList.add('hidden');
  }
}

async function sendOTP() {
  const btn = document.getElementById('send-otp-btn');
  if (typeof EMAILJS_PUBLIC_KEY === 'undefined' || EMAILJS_PUBLIC_KEY === 'YOUR_PUBLIC_KEY') {
    showMsg('fp-msg', '⚠️ Email reset not configured yet.', 'err'); return;
  }
  const user = (document.getElementById('inp-auser').value || '').trim().toLowerCase();
  if (!user) { showMsg('fp-msg', 'Enter your username first.', 'err'); return; }
  btn.disabled = true; btn.textContent = 'Sending…';
  _otp.code = String(Math.floor(100000 + Math.random() * 900000));
  _otp.expiry = Date.now() + 600000;
  try {
    const { data } = await db.from('admin_users').select('email').eq('username', user).maybeSingle();
    if (!data?.email) { showMsg('fp-msg', 'No email on file for that username.', 'err'); btn.disabled = false; btn.textContent = '📧 Send Reset Code'; return; }
    emailjs.init(EMAILJS_PUBLIC_KEY);
    await emailjs.send(EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, { to_email: data.email, otp: _otp.code, app_name: 'WorkClock' });
    document.getElementById('fp-step1').classList.add('hidden');
    document.getElementById('fp-step2').classList.remove('hidden');
    showMsg('fp-msg', '✅ Code sent to ' + data.email, 'ok');
  } catch (err) {
    showMsg('fp-msg', 'Failed: ' + (err?.text || err.message), 'err');
  }
  btn.disabled = false; btn.textContent = '📧 Send Reset Code';
}

function verifyOTP() {
  const entered = (document.getElementById('inp-otp').value || '').trim();
  if (!_otp.code)             { showMsg('fp-msg', 'Request a code first.', 'err'); return; }
  if (Date.now() > _otp.expiry) { showMsg('fp-msg', 'Code expired — request a new one.', 'err'); _otp.code = null; return; }
  if (entered !== _otp.code)  { showMsg('fp-msg', 'Incorrect code.', 'err'); return; }
  document.getElementById('fp-step2').classList.add('hidden');
  document.getElementById('fp-step3').classList.remove('hidden');
  showMsg('fp-msg', '✅ Verified — set your new password.', 'ok');
}

async function applyNewPw() {
  const pw   = (document.getElementById('inp-newpw').value || '').trim();
  const user = (document.getElementById('inp-auser').value || '').trim().toLowerCase();
  if (!pw || pw.length < 6) { showMsg('fp-msg', 'Password must be at least 6 characters.', 'err'); return; }
  const { error } = await db.from('admin_users').update({ password_hash: pw }).eq('username', user);
  if (error) { showMsg('fp-msg', 'Failed: ' + error.message, 'err'); return; }
  _otp.code = null;
  showMsg('fp-msg', '✅ Password updated! Log in now.', 'ok');
  document.getElementById('fp-step3').classList.add('hidden');
  setTimeout(() => { document.getElementById('forgot-panel').classList.add('hidden'); document.getElementById('inp-newpw').value = ''; }, 2500);
}

// ═══════════════════════════════════════════════
//  ADMIN TABS
// ═══════════════════════════════════════════════
function switchTab(name, btn) {
  document.querySelectorAll('#admin-tabs .tab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  document.querySelectorAll('#page-admin .tab-pane').forEach(p => p.classList.remove('active'));
  document.getElementById('tab-' + name).classList.add('active');
  if (name === 'dash')       loadDashboard();
  if (name === 'workers')    loadWorkers();
  if (name === 'co-admins')  loadCoAdmins();
  if (name === 'setup')      loadSetup();
  if (name === 'attendance') {
    const today = new Date().toISOString().slice(0, 10);
    const ago   = new Date(); ago.setMonth(ago.getMonth() - 1);
    document.getElementById('att-from').value = ago.toISOString().slice(0, 10);
    document.getElementById('att-to').value   = today;
    loadWorkerOptions();
  }
}

// ═══════════════════════════════════════════════
//  DASHBOARD
// ═══════════════════════════════════════════════
async function loadDashboard() {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const tmrw  = new Date(today); tmrw.setDate(tmrw.getDate() + 1);
  const cid   = S.admin?.company_id;

  const [{ count: total }, { data: wkrs }] = await Promise.all([
    db.from('workers').select('id', { count:'exact', head:true }).eq('is_active', true).eq('company_id', cid),
    db.from('workers').select('id').eq('company_id', cid),
  ]);
  const ids = (wkrs || []).map(w => w.id);
  const { data: recs } = ids.length
    ? await db.from('attendance').select('*, w:workers(name,employee_id)')
        .in('worker_id', ids)
        .gte('clock_in_time', today.toISOString())
        .lt('clock_in_time', tmrw.toISOString())
        .order('clock_in_time', { ascending: false })
    : { data: [] };

  const present = recs?.length ?? 0;
  const stillin = recs?.filter(r => r.status === 'active').length ?? 0;
  document.getElementById('s-present').textContent = present;
  document.getElementById('s-total').textContent   = total ?? '--';
  document.getElementById('s-absent').textContent  = Math.max(0, (total ?? 0) - present);
  document.getElementById('s-active').textContent  = stillin;

  const el = document.getElementById('activity-list');
  el.innerHTML = recs?.length
    ? '<div class="act-list">' + recs.slice(0, 15).map(r => `
        <div class="act-item">
          <div>
            <div class="act-name">${r.w?.name ?? 'Unknown'}</div>
            <div class="act-time">${fmtTime(r.clock_in_time)}${r.clock_out_time?' → '+fmtTime(r.clock_out_time):''} · ${r.auth_method??''}</div>
          </div>
          <span class="act-tag ${r.clock_out_time?'tag-out':'tag-in'}">${r.clock_out_time?'Done':'Active'}</span>
        </div>`).join('') + '</div>'
    : '<div class="empty">No clock-ins today</div>';
}

// ═══════════════════════════════════════════════
//  WORKERS (Admin)
// ═══════════════════════════════════════════════
async function loadWorkers() {
  const el = document.getElementById('workers-list');
  el.innerHTML = '<div class="empty">Loading…</div>';
  const { data, error } = await db.from('workers')
    .select('*').eq('company_id', S.admin?.company_id).order('name');
  if (error || !data) { el.innerHTML = '<div class="empty">Failed to load</div>'; return; }
  if (!data.length)   { el.innerHTML = '<div class="empty">No workers yet — add one above</div>'; return; }
  data.forEach(w => { _wCache[w.id] = { ...w, _ctx: 'admin' }; });
  el.innerHTML = '<div class="list-rows">' + data.map(w => `
    <div class="list-row">
      <div class="row-info">
        <div class="avatar av-sm">${initials(w.name)}</div>
        <div>
          <div class="row-name">${w.name}</div>
          <div class="row-meta">${w.employee_id}${w.job_title?' · '+w.job_title:''}${w.biometric_enabled?' · 🔏':''}${w.face_descriptor?' · 🤳':''}${!w.is_active?' · <em>Inactive</em>':''}</div>
        </div>
      </div>
      <div class="row-btns">
        <button class="icon-btn" title="Edit"             onclick="openEditWorker('${w.id}')">✏️</button>
        <button class="icon-btn" title="Enrol Face"       onclick="adminEnrollFace('${w.id}','${escQ(w.name)}','admin')">🤳</button>
        <button class="icon-btn" title="Register Bio"     onclick="adminRegBio('${w.id}','${escQ(w.name)}')">🔏</button>
        <button class="icon-btn" title="Print ID Card"    onclick="openCard('${w.id}','${w.employee_id}','${escQ(w.name)}','${escQ(w.job_title||'')}')">🪪</button>
        <button class="icon-btn" title="${w.is_active?'Deactivate':'Reactivate'}" onclick="toggleWorker('${w.id}',${w.is_active})">${w.is_active?'🚫':'✅'}</button>
      </div>
    </div>`).join('') + '</div>';
}

function escQ(s) { return (s || '').replace(/'/g, "\\'"); }

function toggleAddWorker() {
  const p = document.getElementById('add-worker-panel');
  p.classList.toggle('hidden');
  if (!p.classList.contains('hidden')) document.getElementById('nw-id').focus();
}

async function addWorker() {
  const empId = (document.getElementById('nw-id').value    || '').trim().toUpperCase();
  const name  = (document.getElementById('nw-name').value  || '').trim();
  const job   = (document.getElementById('nw-job').value   || '').trim();
  const phone = (document.getElementById('nw-phone').value || '').trim();
  const email = (document.getElementById('nw-email').value || '').trim();
  const pin   = (document.getElementById('nw-pin').value   || '').trim();
  if (!empId || !name || !pin) { showMsg('nw-msg', 'Employee ID, Name and PIN are required.', 'err'); return; }
  if (pin.length < 4)          { showMsg('nw-msg', 'PIN must be at least 4 digits.', 'err'); return; }
  const cid = S.admin?.company_id;
  const { data: wps } = await db.from('workplaces').select('id').eq('company_id', cid).limit(1);
  const { error } = await db.from('workers').insert({
    employee_id: empId, name, job_title: job||null, phone: phone||null, email: email||null,
    pin, workplace_id: wps?.[0]?.id ?? null, company_id: cid, is_active: true,
  });
  if (error) { showMsg('nw-msg', error.code === '23505' ? 'Employee ID already exists.' : error.message, 'err'); return; }
  showMsg('nw-msg', '✅ Worker added!', 'ok');
  setTimeout(() => { toggleAddWorker(); loadWorkers(); ['nw-id','nw-name','nw-job','nw-phone','nw-email','nw-pin'].forEach(id => document.getElementById(id).value=''); }, 1300);
}

async function toggleWorker(id, cur) {
  const { error } = await db.from('workers').update({ is_active: !cur }).eq('id', id);
  if (!error) { toast(cur ? 'Worker deactivated' : 'Worker reactivated'); loadWorkers(); }
}

async function adminRegBio(workerId, workerName) {
  if (!window.PublicKeyCredential) { toast('WebAuthn not supported here'); return; }
  if (!confirm('Register biometric for "' + workerName + '"?\n\nThe worker must be present on this device.')) return;
  try {
    const cred = await navigator.credentials.create({ publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rp:   { name:'WorkClock', id: window.location.hostname || 'localhost' },
      user: { id: new TextEncoder().encode(workerId), name: workerName, displayName: workerName },
      pubKeyCredParams: [{ alg:-7, type:'public-key' }, { alg:-257, type:'public-key' }],
      authenticatorSelection: { authenticatorAttachment:'platform', userVerification:'required', residentKey:'required', requireResidentKey:true },
      timeout: 60000,
    }});
    if (!cred) return;
    const { error } = await db.from('workers')
      .update({ biometric_credential_id: b64(cred.rawId), biometric_enabled: true }).eq('id', workerId);
    if (error) throw error;
    toast('✅ Biometric registered for ' + workerName); loadWorkers();
  } catch (err) { toast(err.name === 'NotAllowedError' ? 'Cancelled.' : '❌ ' + err.message); }
}

// ═══════════════════════════════════════════════
//  PRINT ID CARD
// ═══════════════════════════════════════════════
async function openCard(workerId, empId, name, job) {
  document.getElementById('pc-name').textContent = name;
  document.getElementById('pc-job').textContent  = job || '';
  document.getElementById('pc-id').textContent   = empId;
  document.getElementById('modal-card').classList.remove('hidden');
  const canvas = document.getElementById('qr-card-canvas');
  if (typeof QRCode === 'undefined') { toast('QR library loading — try again in a moment.'); return; }
  try { await QRCode.toCanvas(canvas, empId, { width:180, margin:2, color:{ dark:'#1E293B', light:'#FFFFFF' } }); }
  catch (err) { toast('QR error: ' + err.message); }
}
function closeCardModal() { document.getElementById('modal-card').classList.add('hidden'); }

// ═══════════════════════════════════════════════
//  ATTENDANCE
// ═══════════════════════════════════════════════
async function loadWorkerOptions() {
  const sel = document.getElementById('att-worker');
  const { data } = await db.from('workers').select('id,name,employee_id,job_title')
    .eq('company_id', S.admin?.company_id).order('name');
  sel.innerHTML = '<option value="">All Workers</option>' +
    (data || []).map(w => `<option value="${w.id}">${w.name}${w.job_title?' · '+w.job_title:''} (${w.employee_id})</option>`).join('');
}

async function loadAttendance() {
  const from   = document.getElementById('att-from').value;
  const to     = document.getElementById('att-to').value;
  const worker = document.getElementById('att-worker').value;
  const method = document.getElementById('att-method').value;
  const el     = document.getElementById('att-list');
  const sum    = document.getElementById('att-summary');
  if (!from || !to) { el.innerHTML = '<div class="empty">Select a date range</div>'; return; }
  el.innerHTML = '<div class="empty">Loading…</div>'; sum.classList.add('hidden');

  const start = new Date(from); start.setHours(0, 0, 0, 0);
  const end   = new Date(to);   end.setHours(23, 59, 59, 999);

  try {
    const { data: cWks } = await db.from('workers').select('id').eq('company_id', S.admin?.company_id);
    const allowed = worker ? [worker] : (cWks || []).map(w => w.id);
    if (!allowed.length) { el.innerHTML = '<div class="empty">No workers found</div>'; return; }
    let q = db.from('attendance')
      .select('*, w:workers(name,employee_id,job_title)')
      .in('worker_id', allowed)
      .gte('clock_in_time', start.toISOString())
      .lte('clock_in_time', end.toISOString())
      .order('clock_in_time', { ascending: false });
    if (method) q = q.eq('auth_method', method);
    const { data, error } = await q;
    if (error) { el.innerHTML = '<div class="empty">Failed to load</div>'; return; }
    if (!data?.length) { el.innerHTML = '<div class="empty">No records match filters</div>'; return; }
    const totalHrs = data.reduce((s, r) => s + (r.clock_in_time && r.clock_out_time ? (new Date(r.clock_out_time) - new Date(r.clock_in_time)) / 3600000 : 0), 0);
    const still = data.filter(r => r.status === 'active').length;
    sum.textContent = data.length + ' records · ' + totalHrs.toFixed(1) + 'h total · ' + still + ' still in';
    sum.classList.remove('hidden');
    el.innerHTML = '<div class="att-rows">' + data.map(r => {
      const hrs = (r.clock_in_time && r.clock_out_time) ? ((new Date(r.clock_out_time) - new Date(r.clock_in_time)) / 3600000).toFixed(1) + 'h' : '--';
      return `<div class="att-row">
        <div class="att-name">${r.w?.name ?? 'Unknown'} <small style="color:var(--muted)">${r.w?.employee_id ?? ''}</small>${r.w?.job_title ? ` <small style="color:var(--blue)">· ${r.w.job_title}</small>` : ''}</div>
        <div class="att-date">${fmtDate(r.clock_in_time)}</div>
        <div class="att-chips">
          <span class="chip chip-in">▶ ${fmtTime(r.clock_in_time)}</span>
          <span class="chip chip-out">⏹ ${r.clock_out_time ? fmtTime(r.clock_out_time) : 'Still in'}</span>
          <span class="chip chip-hrs">⏱ ${hrs}</span>
          <span class="chip chip-mth">${r.auth_method ?? ''}</span>
        </div>
      </div>`;
    }).join('') + '</div>';
  } catch (err) { el.innerHTML = '<div class="empty">Error: ' + err.message + '</div>'; }
}

async function downloadCSV() {
  const from   = document.getElementById('att-from').value;
  const to     = document.getElementById('att-to').value;
  const worker = document.getElementById('att-worker').value;
  const method = document.getElementById('att-method').value;
  if (!from || !to) { showMsg('csv-msg', 'Select a date range first.', 'err'); return; }
  showMsg('csv-msg', '⏳ Preparing CSV…', 'ok');
  const start = new Date(from); start.setHours(0,0,0,0);
  const end   = new Date(to);   end.setHours(23,59,59,999);
  try {
    const { data: cWks } = await db.from('workers').select('id').eq('company_id', S.admin?.company_id);
    const allowed = worker ? [worker] : (cWks || []).map(w => w.id);
    let q = db.from('attendance').select('*, w:workers(name,employee_id,job_title)')
      .in('worker_id', allowed)
      .gte('clock_in_time', start.toISOString()).lte('clock_in_time', end.toISOString())
      .order('clock_in_time');
    if (method) q = q.eq('auth_method', method);
    const { data } = await q;
    if (!data?.length) { showMsg('csv-msg', 'No records found.', 'err'); return; }
    const hdr  = ['Worker Name','Employee ID','Job Title','Date','Clock In','Clock Out','Hours','Auth Method','Status'];
    const rows = data.map(r => {
      const cin  = r.clock_in_time  ? new Date(r.clock_in_time)  : null;
      const cout = r.clock_out_time ? new Date(r.clock_out_time) : null;
      const hrs  = (cin && cout) ? ((cout - cin) / 3600000).toFixed(2) : '';
      return [r.w?.name||'',r.w?.employee_id||'',r.w?.job_title||'',cin?fmtDate(r.clock_in_time):'',cin?fmtTime(r.clock_in_time):'',cout?fmtTime(r.clock_out_time):'Still In',hrs?hrs+'h':'',r.auth_method||'',r.status||'']
        .map(v => '"' + String(v).replace(/"/g,'""') + '"').join(',');
    });
    const csv  = '﻿' + [hdr.join(','), ...rows].join('\r\n');
    const blob = new Blob([csv], { type:'text/csv;charset=utf-8;' });
    const url  = URL.createObjectURL(blob);
    const a    = Object.assign(document.createElement('a'), { href:url, download:`attendance_${from}_to_${to}.csv` });
    document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
    showMsg('csv-msg', '✅ Downloaded ' + data.length + ' records', 'ok');
  } catch (err) { showMsg('csv-msg', 'Export failed: ' + err.message, 'err'); }
}

// ═══════════════════════════════════════════════
//  COMPANY ADMINS (super_admin)
// ═══════════════════════════════════════════════
const ROLE_LABELS = { super_admin:'Super Admin', admin:'Admin', developer:'Developer' };
const ROLE_COLORS = { super_admin:'var(--green)', admin:'var(--blue)', developer:'var(--purple)' };

async function loadCoAdmins() {
  const el = document.getElementById('co-admins-list');
  el.innerHTML = '<div class="empty">Loading…</div>';
  const { data, error } = await db.from('admin_users')
    .select('*').eq('company_id', S.admin?.company_id).neq('role','developer').order('full_name');
  if (error || !data) { el.innerHTML = '<div class="empty">Failed to load</div>'; return; }
  if (!data.length)   { el.innerHTML = '<div class="empty">No admins yet — create one above</div>'; return; }
  el.innerHTML = '<div class="list-rows">' + data.map(a => `
    <div class="list-row">
      <div class="row-info">
        <div class="avatar av-sm" style="background:${ROLE_COLORS[a.role]||'var(--blue)'}">${initials(a.full_name||a.username)}</div>
        <div>
          <div class="row-name">${a.full_name||a.username} <small style="color:var(--muted)">@${a.username}</small></div>
          <div class="row-meta">
            <span class="role-pill" style="background:${ROLE_COLORS[a.role]||'var(--blue)'}22;color:${ROLE_COLORS[a.role]||'var(--blue)'};">${ROLE_LABELS[a.role]||a.role}</span>
            ${a.email?'· '+a.email:''}${!a.is_active?' · <em>Inactive</em>':''}
          </div>
        </div>
      </div>
      <div class="row-btns">
        <button class="icon-btn" title="Edit"  onclick="openEditAcct('${a.id}','${escQ(a.full_name||'')}','${escQ(a.email||'')}','${a.role}','sa')">✏️</button>
        <button class="icon-btn" title="Reset Password" onclick="resetPw('${a.id}','${a.username}')">🔑</button>
        <button class="icon-btn" title="${a.is_active?'Deactivate':'Reactivate'}" onclick="toggleAdmin('${a.id}',${a.is_active})">${a.is_active?'🚫':'✅'}</button>
      </div>
    </div>`).join('') + '</div>';
}

function toggleAddAdmin() {
  const p = document.getElementById('add-admin-panel');
  p.classList.toggle('hidden');
  if (!p.classList.contains('hidden')) document.getElementById('ca-name').focus();
}

async function addAdmin() {
  const name  = (document.getElementById('ca-name').value  || '').trim();
  const user  = (document.getElementById('ca-user').value  || '').trim().toLowerCase();
  const pass  = (document.getElementById('ca-pass').value  || '').trim();
  const email = (document.getElementById('ca-email').value || '').trim();
  const role  =  document.getElementById('ca-role').value  || 'admin';
  if (!name||!user||!pass) { showMsg('ca-msg','Name, username and password required.','err'); return; }
  if (pass.length < 6)     { showMsg('ca-msg','Password must be at least 6 characters.','err'); return; }
  if (!/^[a-z0-9_]+$/.test(user)) { showMsg('ca-msg','Username: letters, numbers and underscores only.','err'); return; }
  const { error } = await db.from('admin_users').insert({
    username:user, password_hash:pass, full_name:name, email:email||null,
    role, company_id:S.admin?.company_id, is_active:true,
  });
  if (error) { showMsg('ca-msg', error.code==='23505'?'Username already exists.':error.message,'err'); return; }
  showMsg('ca-msg','✅ ' + (ROLE_LABELS[role]||role) + ' "@' + user + '" created!','ok');
  ['ca-name','ca-user','ca-pass','ca-email'].forEach(id => document.getElementById(id).value='');
  setTimeout(() => { toggleAddAdmin(); loadCoAdmins(); }, 1400);
}

async function toggleAdmin(id, cur) {
  const { error } = await db.from('admin_users').update({ is_active: !cur }).eq('id', id);
  if (!error) { toast(cur?'Admin deactivated':'Admin reactivated'); loadCoAdmins(); }
}

// ═══════════════════════════════════════════════
//  SETUP TAB
// ═══════════════════════════════════════════════
async function loadSetup() {
  const cid = S.admin?.company_id;
  const { data: wps } = await db.from('workplaces').select('*').eq('company_id', cid).limit(1);
  if (wps?.[0]) {
    const w = wps[0];
    document.getElementById('wp-name').value   = w.name || '';
    document.getElementById('wp-addr').value   = w.address || '';
    document.getElementById('wp-lat').value    = w.latitude || '';
    document.getElementById('wp-lng').value    = w.longitude || '';
    document.getElementById('wp-radius').value = w.radius_meters || 100;
  }
  const code    = S.admin?.co?.code;
  const linkEl  = document.getElementById('clockin-link');
  if (linkEl) linkEl.textContent = code ? (window.location.origin + window.location.pathname + '?c=' + code) : 'Company code not found.';
  document.getElementById('my-name').value  = S.admin?.full_name || '';
  document.getElementById('my-email').value = S.admin?.email || '';
}

async function saveWorkplace() {
  const name   = (document.getElementById('wp-name').value   || '').trim();
  const addr   = (document.getElementById('wp-addr').value   || '').trim();
  const lat    = parseFloat(document.getElementById('wp-lat').value);
  const lng    = parseFloat(document.getElementById('wp-lng').value);
  const radius = parseInt(document.getElementById('wp-radius').value) || 100;
  if (!name || isNaN(lat) || isNaN(lng)) { showMsg('wp-msg','Name, Latitude and Longitude are required.','err'); return; }
  const cid     = S.admin?.company_id;
  const { data: ex } = await db.from('workplaces').select('id').eq('company_id', cid).limit(1);
  const payload = { name, address:addr, latitude:lat, longitude:lng, radius_meters:radius, company_id:cid };
  const { error } = ex?.length
    ? await db.from('workplaces').update(payload).eq('id', ex[0].id)
    : await db.from('workplaces').insert(payload);
  if (error) { showMsg('wp-msg','Save failed: '+error.message,'err'); return; }
  showMsg('wp-msg','✅ Workplace saved!','ok');
  const { data: wp } = await db.from('workplaces').select('id').eq('company_id', cid).limit(1);
  if (wp?.[0]?.id) await db.from('workers').update({ workplace_id:wp[0].id }).eq('company_id', cid).is('workplace_id', null);
}

function detectLocation() {
  if (!navigator.geolocation) { toast('Geolocation not available'); return; }
  toast('📍 Getting your location…');
  navigator.geolocation.getCurrentPosition(async pos => {
    const lat = pos.coords.latitude.toFixed(7);
    const lng = pos.coords.longitude.toFixed(7);
    document.getElementById('wp-lat').value = lat;
    document.getElementById('wp-lng').value = lng;
    toast('📍 Location captured (±' + Math.round(pos.coords.accuracy) + 'm)');
    try {
      const res = await fetch('https://nominatim.openstreetmap.org/reverse?format=json&lat=' + lat + '&lon=' + lng, { headers:{ 'Accept-Language':'en' } });
      const geo = await res.json();
      if (geo?.display_name) { document.getElementById('wp-addr').value = geo.display_name; }
    } catch {}
  }, () => toast('Could not get location — enter coordinates manually.'));
}

function copyClockInLink() {
  const code = S.admin?.co?.code;
  if (!code) { showMsg('link-msg','Company code not found.','err'); return; }
  const link = window.location.origin + window.location.pathname + '?c=' + code;
  navigator.clipboard.writeText(link).then(() => showMsg('link-msg','✅ Link copied!','ok'))
    .catch(() => { document.getElementById('clockin-link').textContent = link; showMsg('link-msg','Copy the link above manually.','ok'); });
}

async function saveProfile() {
  const name  = (document.getElementById('my-name').value  || '').trim();
  const email = (document.getElementById('my-email').value || '').trim();
  if (!name) { showMsg('profile-msg','Full name is required.','err'); return; }
  const { error } = await db.from('admin_users').update({ full_name:name, email:email||null }).eq('id', S.admin.id);
  if (error) { showMsg('profile-msg','Failed: '+error.message,'err'); return; }
  S.admin.full_name = name; S.admin.email = email;
  showMsg('profile-msg','✅ Profile updated!','ok');
}

async function changeAdminPw() {
  const pw = document.getElementById('new-pw').value;
  if (!pw || pw.length < 6) { showMsg('pw-msg','Password must be at least 6 characters.','err'); return; }
  const { error } = await db.from('admin_users').update({ password_hash:pw }).eq('id', S.admin.id);
  if (error) showMsg('pw-msg','Failed: '+error.message,'err');
  else { showMsg('pw-msg','✅ Password updated!','ok'); document.getElementById('new-pw').value=''; }
}

async function resetPw(id, username) {
  const pw = prompt('Set new password for @' + username + ':');
  if (!pw) return;
  if (pw.length < 6) { toast('Password must be at least 6 characters.'); return; }
  const { error } = await db.from('admin_users').update({ password_hash:pw }).eq('id', id);
  if (!error) toast('✅ Password updated for @' + username);
  else toast('Error: ' + error.message);
}

// ═══════════════════════════════════════════════
//  EDIT WORKER MODAL
// ═══════════════════════════════════════════════
function openEditWorker(id) {
  const w = _wCache[id]; if (!w) return;
  document.getElementById('ewk-id').value    = id;
  document.getElementById('ewk-ctx').value   = w._ctx || 'admin';
  document.getElementById('ewk-empid').value = w.employee_id || '';
  document.getElementById('ewk-name').value  = w.name || '';
  document.getElementById('ewk-job').value   = w.job_title || '';
  document.getElementById('ewk-phone').value = w.phone || '';
  document.getElementById('ewk-email').value = w.email || '';
  document.getElementById('ewk-pin').value   = '';
  document.getElementById('ewk-msg').classList.add('hidden');
  document.getElementById('modal-edit-worker').classList.remove('hidden');
}
function closeEditWorker() { document.getElementById('modal-edit-worker').classList.add('hidden'); }

async function saveEditWorker() {
  const id    = document.getElementById('ewk-id').value;
  const ctx   = document.getElementById('ewk-ctx').value;
  const empId = (document.getElementById('ewk-empid').value || '').trim().toUpperCase();
  const name  = (document.getElementById('ewk-name').value  || '').trim();
  const job   = (document.getElementById('ewk-job').value   || '').trim();
  const phone = (document.getElementById('ewk-phone').value || '').trim();
  const email = (document.getElementById('ewk-email').value || '').trim();
  const pin   = (document.getElementById('ewk-pin').value   || '').trim();
  if (!empId || !name) { showMsg('ewk-msg','Employee ID and Name required.','err'); return; }
  if (pin && pin.length < 4) { showMsg('ewk-msg','PIN must be at least 4 digits.','err'); return; }
  const updates = { employee_id:empId, name, job_title:job||null, phone:phone||null, email:email||null };
  if (pin) updates.pin = pin;
  const { error } = await db.from('workers').update(updates).eq('id', id);
  if (error) { showMsg('ewk-msg', error.code==='23505'?'Employee ID already in use.':error.message,'err'); return; }
  showMsg('ewk-msg','✅ Worker updated!','ok');
  setTimeout(() => { closeEditWorker(); if (ctx === 'dev') loadDevWorkers(); else loadWorkers(); }, 1200);
}

// ═══════════════════════════════════════════════
//  EDIT ACCOUNT MODAL
// ═══════════════════════════════════════════════
function openEditAcct(id, name, email, role, ctx) {
  document.getElementById('eac-id').value    = id;
  document.getElementById('eac-ctx').value   = ctx;
  document.getElementById('eac-name').value  = name;
  document.getElementById('eac-email').value = email;
  document.getElementById('eac-pw').value    = '';
  document.getElementById('eac-msg').classList.add('hidden');
  const roleWrap = document.getElementById('eac-role-wrap');
  if (ctx === 'dev' || ctx === 'sa') {
    roleWrap.classList.remove('hidden');
    document.getElementById('eac-role').value = role;
  } else {
    roleWrap.classList.add('hidden');
  }
  document.getElementById('modal-edit-acct').classList.remove('hidden');
}
function closeEditAcct() { document.getElementById('modal-edit-acct').classList.add('hidden'); }

async function saveEditAcct() {
  const id       = document.getElementById('eac-id').value;
  const ctx      = document.getElementById('eac-ctx').value;
  const name     = (document.getElementById('eac-name').value  || '').trim();
  const email    = (document.getElementById('eac-email').value || '').trim();
  const pw       = (document.getElementById('eac-pw').value    || '').trim();
  const roleWrap = document.getElementById('eac-role-wrap');
  if (!name) { showMsg('eac-msg','Full name required.','err'); return; }
  if (pw && pw.length < 6) { showMsg('eac-msg','Password must be at least 6 characters.','err'); return; }
  const updates = { full_name:name, email:email||null };
  if (pw) updates.password_hash = pw;
  if (!roleWrap.classList.contains('hidden')) updates.role = document.getElementById('eac-role').value;
  const { error } = await db.from('admin_users').update(updates).eq('id', id);
  if (error) { showMsg('eac-msg','Failed: '+error.message,'err'); return; }
  showMsg('eac-msg','✅ Account updated!','ok');
  setTimeout(() => { closeEditAcct(); if (ctx === 'dev') loadDevAccounts(); else loadCoAdmins(); }, 1200);
}

// ═══════════════════════════════════════════════
//  EDIT COMPANY MODAL
// ═══════════════════════════════════════════════
function openEditCo(id) {
  const c = _cCache[id]; if (!c) return;
  document.getElementById('eco-id').value   = id;
  document.getElementById('eco-name').value = c.name || '';
  document.getElementById('eco-code').value = c.code || '';
  document.getElementById('eco-msg').classList.add('hidden');
  document.getElementById('modal-edit-co').classList.remove('hidden');
}
function closeEditCo() { document.getElementById('modal-edit-co').classList.add('hidden'); }

async function saveEditCo() {
  const id   = document.getElementById('eco-id').value;
  const name = (document.getElementById('eco-name').value || '').trim();
  const code = (document.getElementById('eco-code').value || '').trim().toUpperCase().replace(/\s+/g,'');
  if (!name || !code) { showMsg('eco-msg','Name and Code required.','err'); return; }
  if (!/^[A-Z0-9_]+$/.test(code)) { showMsg('eco-msg','Code: letters, numbers, underscores only.','err'); return; }
  const { error } = await db.from('companies').update({ name, code }).eq('id', id);
  if (error) { showMsg('eco-msg', error.code==='23505'?'Code already exists.':error.message,'err'); return; }
  showMsg('eco-msg','✅ Company updated!','ok');
  setTimeout(() => { closeEditCo(); loadDevCos(); }, 1200);
}

// ═══════════════════════════════════════════════
//  DEVELOPER PANEL
// ═══════════════════════════════════════════════
function devLogout() { S.admin = null; showPage('home'); }

function switchDevTab(name, btn) {
  document.querySelectorAll('#dev-tabs .tab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  document.querySelectorAll('#page-developer .tab-pane').forEach(p => p.classList.remove('active'));
  document.getElementById('tab-' + name).classList.add('active');
  if (name === 'dev-cos')      loadDevCos();
  if (name === 'dev-accounts') loadDevAccounts();
  if (name === 'dev-workers')  loadDevWorkers();
  if (name === 'dev-system')   loadDevSystem();
}

// ── Dev: Companies ────────────────────────────
async function loadDevCos() {
  const el = document.getElementById('dev-cos-list');
  el.innerHTML = '<div class="empty">Loading…</div>';
  const { data, error } = await db.from('companies').select('*').order('name');
  if (error || !data) { el.innerHTML = '<div class="empty">Failed to load</div>'; return; }
  if (!data.length)   { el.innerHTML = '<div class="empty">No companies yet</div>'; return; }
  data.forEach(c => { _cCache[c.id] = c; });
  el.innerHTML = '<div class="list-rows">' + data.map(c => `
    <div class="list-row">
      <div class="row-info">
        <div class="avatar av-sm" style="background:var(--purple)">${c.code.slice(0,2)}</div>
        <div>
          <div class="row-name">${c.name}</div>
          <div class="row-meta">Code: ${c.code}${!c.is_active?' · <em>Inactive</em>':''}</div>
        </div>
      </div>
      <div class="row-btns">
        <button class="icon-btn" title="Edit"       onclick="openEditCo('${c.id}')">✏️</button>
        <button class="icon-btn" title="${c.is_active?'Deactivate':'Reactivate'}" onclick="devToggleCo('${c.id}',${c.is_active})">${c.is_active?'🚫':'✅'}</button>
      </div>
    </div>`).join('') + '</div>';
}

function toggleAddCo() {
  const p = document.getElementById('add-co-panel');
  p.classList.toggle('hidden');
  if (!p.classList.contains('hidden')) document.getElementById('nc-name').focus();
}

async function addCompany() {
  const name = (document.getElementById('nc-name').value || '').trim();
  const code = (document.getElementById('nc-code').value || '').trim().toUpperCase().replace(/\s+/g,'');
  if (!name || !code) { showMsg('nc-msg','Name and Code required.','err'); return; }
  if (!/^[A-Z0-9_]+$/.test(code)) { showMsg('nc-msg','Code: letters, numbers, underscores only.','err'); return; }
  const { error } = await db.from('companies').insert({ name, code, is_active:true });
  if (error) { showMsg('nc-msg', error.code==='23505'?'Code already exists.':error.message,'err'); return; }
  showMsg('nc-msg','✅ Company "'+name+'" created!','ok');
  document.getElementById('nc-name').value = ''; document.getElementById('nc-code').value = '';
  setTimeout(() => { toggleAddCo(); loadDevCos(); }, 1400);
}

async function devToggleCo(id, cur) {
  const { error } = await db.from('companies').update({ is_active: !cur }).eq('id', id);
  if (!error) { toast(cur?'Company deactivated':'Company reactivated'); loadDevCos(); }
}

// ── Dev: Accounts ─────────────────────────────
async function loadDevAccounts() {
  const el        = document.getElementById('dev-accounts-list');
  const filterSel = document.getElementById('dev-filter-co');
  el.innerHTML    = '<div class="empty">Loading…</div>';
  if (filterSel.options.length <= 1) {
    const { data: cos } = await db.from('companies').select('id,name').eq('is_active',true).order('name');
    filterSel.innerHTML = '<option value="">All Companies</option>' +
      (cos||[]).map(c => `<option value="${c.id}">${c.name}</option>`).join('');
  }
  let q = db.from('admin_users').select('*, co:companies(name,code)').neq('role','developer').order('full_name');
  const fco = filterSel.value;
  if (fco) q = q.eq('company_id', fco);
  const { data, error } = await q;
  if (error || !data) { el.innerHTML = '<div class="empty">Failed to load</div>'; return; }
  if (!data.length)   { el.innerHTML = '<div class="empty">No accounts yet</div>'; return; }
  el.innerHTML = '<div class="list-rows">' + data.map(a => `
    <div class="list-row">
      <div class="row-info">
        <div class="avatar av-sm" style="background:${ROLE_COLORS[a.role]||'var(--blue)'}">${initials(a.full_name||a.username)}</div>
        <div>
          <div class="row-name">${a.full_name||a.username} <small style="color:var(--muted)">@${a.username}</small></div>
          <div class="row-meta">
            <span class="role-pill" style="background:${ROLE_COLORS[a.role]||'var(--blue)'}22;color:${ROLE_COLORS[a.role]||'var(--blue)'};">${ROLE_LABELS[a.role]||a.role}</span>
            🏢 ${a.co?.name||'—'}${!a.is_active?' · <em>Inactive</em>':''}
          </div>
        </div>
      </div>
      <div class="row-btns">
        <button class="icon-btn" title="Edit"    onclick="openEditAcct('${a.id}','${escQ(a.full_name||'')}','${escQ(a.email||'')}','${a.role}','dev')">✏️</button>
        <button class="icon-btn" title="Reset PW" onclick="resetPw('${a.id}','${a.username}')">🔑</button>
        <button class="icon-btn" title="${a.is_active?'Deactivate':'Reactivate'}" onclick="devToggleAcct('${a.id}',${a.is_active})">${a.is_active?'🚫':'✅'}</button>
      </div>
    </div>`).join('') + '</div>';
}

function toggleAddDevAccount() {
  const p = document.getElementById('add-dev-acct-panel');
  p.classList.toggle('hidden');
  if (!p.classList.contains('hidden')) {
    db.from('companies').select('id,name').eq('is_active',true).order('name').then(({ data }) => {
      document.getElementById('da-company').innerHTML = '<option value="">Select Company…</option>' +
        (data||[]).map(c => `<option value="${c.id}">${c.name}</option>`).join('');
    });
    document.getElementById('da-name').focus();
  }
}

async function addDevAccount() {
  const cid   = document.getElementById('da-company').value;
  const role  = document.getElementById('da-role').value;
  const name  = (document.getElementById('da-name').value  || '').trim();
  const user  = (document.getElementById('da-user').value  || '').trim().toLowerCase();
  const pass  = (document.getElementById('da-pass').value  || '').trim();
  const email = (document.getElementById('da-email').value || '').trim();
  if (!cid)  { showMsg('da-msg','Select a company.','err'); return; }
  if (!name||!user||!pass) { showMsg('da-msg','Name, username and password required.','err'); return; }
  if (pass.length < 6)     { showMsg('da-msg','Password must be at least 6 characters.','err'); return; }
  if (!/^[a-z0-9_]+$/.test(user)) { showMsg('da-msg','Username: letters, numbers, underscores only.','err'); return; }
  const { error } = await db.from('admin_users').insert({
    username:user, password_hash:pass, full_name:name, email:email||null,
    role, company_id:cid, is_active:true,
  });
  if (error) { showMsg('da-msg', error.code==='23505'?'Username already exists.':error.message,'err'); return; }
  showMsg('da-msg','✅ ' + (ROLE_LABELS[role]||role) + ' "@' + user + '" created!','ok');
  ['da-name','da-user','da-pass','da-email'].forEach(id => document.getElementById(id).value='');
  setTimeout(() => { toggleAddDevAccount(); loadDevAccounts(); }, 1400);
}

async function devToggleAcct(id, cur) {
  const { error } = await db.from('admin_users').update({ is_active: !cur }).eq('id', id);
  if (!error) { toast(cur?'Account deactivated':'Account reactivated'); loadDevAccounts(); }
}

// ── Dev: Workers ──────────────────────────────
async function loadDevWorkers() {
  const el  = document.getElementById('dev-workers-list');
  const sel = document.getElementById('dev-filter-co-wk');
  if (sel.options.length <= 1) {
    const { data: cos } = await db.from('companies').select('id,name').eq('is_active',true).order('name');
    sel.innerHTML = '<option value="">Select a company…</option>' +
      (cos||[]).map(c => `<option value="${c.id}">${c.name}</option>`).join('');
  }
  const cid = sel.value;
  if (!cid) { el.innerHTML = '<div class="empty">Select a company above</div>'; return; }
  el.innerHTML = '<div class="empty">Loading…</div>';
  const { data, error } = await db.from('workers').select('*').eq('company_id', cid).order('name');
  if (error || !data) { el.innerHTML = '<div class="empty">Failed to load</div>'; return; }
  if (!data.length)   { el.innerHTML = '<div class="empty">No workers in this company</div>'; return; }
  data.forEach(w => { _wCache[w.id] = { ...w, _ctx:'dev' }; });
  el.innerHTML = '<div class="list-rows">' + data.map(w => `
    <div class="list-row">
      <div class="row-info">
        <div class="avatar av-sm">${initials(w.name)}</div>
        <div>
          <div class="row-name">${w.name}</div>
          <div class="row-meta">${w.employee_id}${w.job_title?' · '+w.job_title:''}${w.biometric_enabled?' · 🔏':''}${w.face_descriptor?' · 🤳':''}${!w.is_active?' · <em>Inactive</em>':''}</div>
        </div>
      </div>
      <div class="row-btns">
        <button class="icon-btn" title="Edit"      onclick="openEditWorker('${w.id}')">✏️</button>
        <button class="icon-btn" title="Enrol Face" onclick="adminEnrollFace('${w.id}','${escQ(w.name)}','dev')">🤳</button>
        <button class="icon-btn" title="${w.is_active?'Deactivate':'Reactivate'}" onclick="devToggleWorker('${w.id}',${w.is_active})">${w.is_active?'🚫':'✅'}</button>
      </div>
    </div>`).join('') + '</div>';
}

async function devToggleWorker(id, cur) {
  const { error } = await db.from('workers').update({ is_active: !cur }).eq('id', id);
  if (!error) { toast(cur?'Worker deactivated':'Worker reactivated'); loadDevWorkers(); }
}

// ── Dev: System ───────────────────────────────
function loadDevSystem() {
  const el = document.getElementById('dev-acct-info');
  if (!S.admin) return;
  el.innerHTML = `
    <div class="info-row"><span class="info-lbl">Username</span><span>@${S.admin.username}</span></div>
    <div class="info-row" style="margin-bottom:12px"><span class="info-lbl">Role</span><span style="color:var(--purple);font-weight:700">Developer</span></div>
    <div class="field"><label>Full Name</label>
      <input id="dev-profile-name" type="text" class="input" value="${(S.admin.full_name||'').replace(/"/g,'&quot;')}" placeholder="Full Name">
    </div>
    <div class="field"><label>Email</label>
      <input id="dev-profile-email" type="email" class="input" value="${(S.admin.email||'').replace(/"/g,'&quot;')}" placeholder="Email">
    </div>
    <button class="btn btn-outline btn-full" onclick="saveDevProfile()" style="margin-top:4px">Save Profile</button>
    <div id="dev-profile-msg" class="msg hidden"></div>`;
}

async function saveDevProfile() {
  const name  = (document.getElementById('dev-profile-name').value  || '').trim();
  const email = (document.getElementById('dev-profile-email').value || '').trim();
  if (!name) { showMsg('dev-profile-msg','Full name required.','err'); return; }
  const { error } = await db.from('admin_users').update({ full_name:name, email:email||null }).eq('id', S.admin.id);
  if (error) { showMsg('dev-profile-msg','Failed: '+error.message,'err'); return; }
  S.admin.full_name = name; S.admin.email = email;
  showMsg('dev-profile-msg','✅ Profile updated!','ok');
}

async function changeDevPw() {
  const pw = document.getElementById('dev-new-pw').value;
  if (!pw || pw.length < 6) { showMsg('dev-pw-msg','Password must be at least 6 characters.','err'); return; }
  const { error } = await db.from('admin_users').update({ password_hash:pw }).eq('id', S.admin.id);
  if (error) showMsg('dev-pw-msg','Failed: '+error.message,'err');
  else { showMsg('dev-pw-msg','✅ Password updated!','ok'); document.getElementById('dev-new-pw').value=''; }
}

// ═══════════════════════════════════════════════
//  FACE RECOGNITION
// ═══════════════════════════════════════════════
const FACE_MODELS = 'https://cdn.jsdelivr.net/gh/justadudewhohacks/face-api.js@0.22.2/weights';
let _faceModelsLoaded = false;
let _faceLoadPromise  = null;

async function loadFaceModels() {
  if (typeof faceapi === 'undefined') throw new Error('Face recognition library not loaded yet — please wait a moment');
  if (_faceModelsLoaded) return;
  if (_faceLoadPromise) return _faceLoadPromise;
  _faceLoadPromise = Promise.all([
    faceapi.nets.tinyFaceDetector.loadFromUri(FACE_MODELS),
    faceapi.nets.faceLandmark68TinyNet.loadFromUri(FACE_MODELS),
    faceapi.nets.faceRecognitionNet.loadFromUri(FACE_MODELS),
  ]).then(() => { _faceModelsLoaded = true; }).catch(err => { _faceLoadPromise = null; throw err; });
  return _faceLoadPromise;
}

const faceOpts = () => new faceapi.TinyFaceDetectorOptions({ inputSize:320, scoreThreshold:.5 });

let _faceStream    = null;
let _faceRunning   = false;
let _faceMatcher   = null;
let _faceWorkerMap = {};

async function openFaceRecog() {
  showPage('face-scan');
  const statusEl = document.getElementById('face-recog-status');
  const oval     = document.getElementById('face-oval');
  oval.classList.remove('found');

  if (!S.companyId) {
    statusEl.textContent = '⚠️ No company linked — open your employer's clock-in link first.'; return;
  }
  statusEl.textContent = '⏳ Loading face recognition (first time may take a moment)…';
  try { await loadFaceModels(); }
  catch { statusEl.textContent = '❌ Could not load models — check your internet connection.'; return; }

  statusEl.textContent = 'Loading enrolled faces…';
  const { data: workers } = await db.from('workers')
    .select('id,name,employee_id,face_descriptor')
    .eq('company_id', S.companyId).eq('is_active', true)
    .not('face_descriptor', 'is', null);

  if (!workers?.length) { statusEl.textContent = '⚠️ No faces enrolled — ask your admin to enrol faces first.'; return; }

  const labeled = []; _faceWorkerMap = {};
  for (const w of workers) {
    try {
      labeled.push(new faceapi.LabeledFaceDescriptors(w.id, [new Float32Array(JSON.parse(w.face_descriptor))]));
      _faceWorkerMap[w.id] = w;
    } catch {}
  }
  if (!labeled.length) { statusEl.textContent = '⚠️ Face data invalid — ask admin to re-enrol.'; return; }
  _faceMatcher = new faceapi.FaceMatcher(labeled, 0.50);

  statusEl.textContent = 'Position your face inside the oval…';
  try {
    _faceStream = await navigator.mediaDevices.getUserMedia({ video:{ facingMode:'user', width:{ideal:640}, height:{ideal:480} } });
    const video = document.getElementById('face-video');
    video.srcObject = _faceStream; await video.play();
    _faceRunning = true; requestAnimationFrame(faceFrame);
  } catch (err) {
    statusEl.textContent = err.name === 'NotAllowedError' ? '❌ Camera access denied' : '❌ ' + err.message;
  }
}

async function faceFrame() {
  if (!_faceRunning) return;
  const video    = document.getElementById('face-video');
  const statusEl = document.getElementById('face-recog-status');
  const oval     = document.getElementById('face-oval');
  if (video.readyState !== video.HAVE_ENOUGH_DATA) { requestAnimationFrame(faceFrame); return; }
  try {
    const det = await faceapi.detectSingleFace(video, faceOpts()).withFaceLandmarks(true).withFaceDescriptor();
    if (!det) { oval.classList.remove('found'); requestAnimationFrame(faceFrame); return; }
    const match = _faceMatcher.findBestMatch(det.descriptor);
    if (match.label === 'unknown') {
      oval.classList.remove('found'); statusEl.textContent = '❓ Face not recognised — try again or use Employee ID';
      await new Promise(r => setTimeout(r, 1500));
      if (_faceRunning) statusEl.textContent = 'Position your face inside the oval…';
      requestAnimationFrame(faceFrame); return;
    }
    _faceRunning = false; oval.classList.add('found');
    const matched = _faceWorkerMap[match.label];
    statusEl.textContent = '✅ Recognised: ' + (matched?.name || 'Unknown');
    vibrate([50,30,100]);
    if (_faceStream) { _faceStream.getTracks().forEach(t => t.stop()); _faceStream = null; }
    const { data } = await db.from('workers').select('*, workplace:workplaces(*)')
      .eq('id', match.label).eq('is_active', true).maybeSingle();
    if (!data) { statusEl.textContent = '❌ Account not found.'; setTimeout(() => showPage('home'), 2500); return; }
    S.worker = data; S.authMethod = 'face'; S.authSource = 'face';
    setTimeout(() => enterClockScreen(), 900);
  } catch { requestAnimationFrame(faceFrame); }
}

function stopFaceRecog() {
  _faceRunning = false;
  if (_faceStream) { _faceStream.getTracks().forEach(t => t.stop()); _faceStream = null; }
  showPage('home');
}

// ── Face Enrolment ──────────────────────────
let _enrollStream = null;
let _enrollTarget = null;

async function adminEnrollFace(workerId, workerName, ctx) {
  _enrollTarget = { id:workerId, name:workerName, ctx:ctx||'admin' };
  document.getElementById('face-enroll-title').textContent  = 'Enrol Face — ' + workerName;
  document.getElementById('enroll-status').textContent      = '⏳ Loading models…';
  document.getElementById('enroll-snap-btn').disabled       = true;
  document.getElementById('modal-face-enroll').classList.remove('hidden');
  try { await loadFaceModels(); }
  catch { document.getElementById('enroll-status').textContent = '❌ Could not load models.'; return; }
  document.getElementById('enroll-status').textContent = 'Opening camera…';
  try {
    _enrollStream = await navigator.mediaDevices.getUserMedia({ video:{ facingMode:'user', width:{ideal:640}, height:{ideal:480} } });
    const video   = document.getElementById('enroll-video');
    video.srcObject = _enrollStream; await video.play();
    document.getElementById('enroll-status').textContent = 'Position ' + workerName + "'s face clearly, then tap Capture.";
    document.getElementById('enroll-snap-btn').disabled  = false;
  } catch (err) {
    document.getElementById('enroll-status').textContent = err.name === 'NotAllowedError' ? '❌ Camera access denied' : '❌ ' + err.message;
  }
}

function workerEnrollFace() {
  if (!S.worker) return;
  adminEnrollFace(S.worker.id, S.worker.name, 'worker');
}

async function captureEnroll() {
  const statusEl = document.getElementById('enroll-status');
  const btn      = document.getElementById('enroll-snap-btn');
  btn.disabled   = true; statusEl.textContent = 'Detecting face…';
  const video    = document.getElementById('enroll-video');
  try {
    const det = await faceapi.detectSingleFace(video, faceOpts()).withFaceLandmarks(true).withFaceDescriptor();
    if (!det) { statusEl.textContent = '❌ No face detected — ensure good lighting and face fully visible.'; btn.disabled=false; return; }
    const descriptor = JSON.stringify(Array.from(det.descriptor));
    const { error }  = await db.from('workers').update({ face_descriptor:descriptor }).eq('id', _enrollTarget.id);
    if (error) { statusEl.textContent = '❌ Save failed: ' + error.message; btn.disabled=false; return; }
    vibrate([50,30,100]); statusEl.textContent = '✅ Face enrolled for ' + _enrollTarget.name + '!';
    if (_enrollTarget.ctx === 'worker') {
      S.worker.face_descriptor = descriptor;
      document.getElementById('face-reg-card').style.display = 'none';
    }
    setTimeout(() => {
      closeFaceEnroll();
      if (_enrollTarget.ctx === 'dev')        loadDevWorkers();
      else if (_enrollTarget.ctx === 'admin') loadWorkers();
    }, 1400);
  } catch (err) { statusEl.textContent = '❌ ' + err.message; btn.disabled=false; }
}

function closeFaceEnroll() {
  if (_enrollStream) { _enrollStream.getTracks().forEach(t => t.stop()); _enrollStream = null; }
  document.getElementById('modal-face-enroll').classList.add('hidden');
}

// ═══════════════════════════════════════════════
//  PWA INSTALL
// ═══════════════════════════════════════════════
let _installPrompt = null;

window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault(); _installPrompt = e;
  setTimeout(() => { const b = document.getElementById('install-banner'); if (b) b.classList.remove('hidden'); }, 3000);
});

window.addEventListener('appinstalled', () => {
  const b = document.getElementById('install-banner'); if (b) b.classList.add('hidden');
  _installPrompt = null; toast('✅ WorkClock installed!');
});

async function installPWA() {
  if (!_installPrompt) return;
  _installPrompt.prompt();
  const { outcome } = await _installPrompt.userChoice;
  if (outcome === 'accepted') { document.getElementById('install-banner').classList.add('hidden'); _installPrompt = null; }
}

function checkIOSInstall() {
  if (/iphone|ipad|ipod/i.test(navigator.userAgent) && !window.navigator.standalone) {
    setTimeout(() => { const b = document.getElementById('ios-banner'); if (b) b.classList.remove('hidden'); }, 3000);
  }
}

// ═══════════════════════════════════════════════
//  BOOTSTRAP
// ═══════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', () => {
  checkIOSInstall();

  let done = false;
  const finish = () => { if (done) return; done = true; showPage('home'); };

  // Hard 1-second deadline — home page always shows within 1s
  setTimeout(finish, 1000);

  // Background async init
  (async () => {
    try { await withTimeout(initCompany(), 3000); } catch {}

    const savedId = localStorage.getItem('wc_worker_id');
    if (!savedId) { finish(); return; }

    try {
      const { data } = await withTimeout(
        db.from('workers').select('*, workplace:workplaces(*)')
          .eq('id', savedId).eq('is_active', true).maybeSingle(),
        4000
      );
      if (data) {
        S.worker = data;
        if (!S.companyId) {
          try {
            const { data: co } = await withTimeout(
              db.from('companies').select('*').eq('id', data.company_id).maybeSingle(), 3000
            );
            if (co) setCompany(co, false);
          } catch {}
        }
        done = true;
        enterClockScreen();
        return;
      }
    } catch {}

    localStorage.removeItem('wc_worker_id');
    finish();
  })();
});
