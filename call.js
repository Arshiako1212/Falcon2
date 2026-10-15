// Voice / video / screen-share calls (WebRTC mesh, signaling over Socket.IO)
(() => {
'use strict';
const A = () => window.App;
const $ = (s, r = document) => r.querySelector(s);
const ckey = (scope, id) => scope + ':' + id;

let socket = null;
const active = {};   // "group:5" -> { count, users }
let call = null;
let ring = null;
let iceCache = null;
let audioCtx = null;

/* ---------- small helpers ---------- */
function beep(freq = 520, dur = 0.2) {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.frequency.value = freq; g.gain.value = 0.05;
    o.connect(g); g.connect(audioCtx.destination);
    o.start(); o.stop(audioCtx.currentTime + dur);
  } catch (_) {}
}
async function getIce() {
  if (!iceCache) {
    try { iceCache = (await A().api('/rtc-config')).iceServers; }
    catch (_) { iceCache = [{ urls: 'stun:stun.l.google.com:19302' }]; }
  }
  return iceCache;
}

/* ---------- socket wiring ---------- */
function bind(s) {
  socket = s;
  s.on('call:active', (p) => {
    active[ckey(p.scope, p.id)] = p;
    if (!p.count && ring && ring.scope === p.scope && ring.id === p.id) endRing();
    renderBar();
  });
  s.on('call:ring', showRing);
  s.on('call:peer-joined', (p) => { if (!call) return; ensurePeer(p.sid, p); syncTiles(); beep(660, 0.12); });
  s.on('call:peer-left', (p) => { if (call) removePeer(p.sid); });
  s.on('call:signal', onSignal);
  s.on('call:state', (p) => {
    const peer = call && call.peers.get(p.sid);
    if (!peer) return;
    peer.state = { mic: p.mic, cam: p.cam, screen: p.screen };
    syncTiles();
  });
  s.on('disconnect', () => { if (call) { cleanup(false); A().toast('ارتباط با سرور قطع شد؛ تماس پایان یافت', 'err'); } });
}

/* ---------- chat banner ---------- */
function onChatOpen() {
  const a = A().state.active;
  if (!a || !socket || !socket.connected) return;
  socket.emit('call:info', { scope: a.type, id: a.id }, (r) => {
    active[ckey(a.type, a.id)] = { scope: a.type, id: a.id, ...r };
    renderBar();
  });
}
function chatTitle() {
  const st = A().state;
  return st.active.type === 'group' ? (st.group ? st.group.group.name : 'گروه') : (st.peer ? st.peer.display_name : 'تماس');
}
function renderBar() {
  const el = $('#callbar'), st = A().state;
  if (!el || !st.active) return;
  const k = ckey(st.active.type, st.active.id);
  const a = active[k];
  if (call && ckey(call.scope, call.id) === k) {
    el.innerHTML = `<div class="callbanner in"><span class="dot"></span><span>شما در تماس هستید</span><span class="grow"></span><button class="btn sm" id="cb-show">نمایش تماس</button></div>`;
    $('#cb-show').onclick = () => { const u = $('#callui'); if (u) u.classList.remove('mini'); };
    return;
  }
  if (a && a.count > 0) {
    const av = (a.users || []).slice(0, 5).map((u) => A().avatar({ id: u.id, display_name: u.name }, 'sm')).join('');
    el.innerHTML = `<div class="callbanner"><span class="dot"></span><span>تماس در جریان است (${Number(a.count).toLocaleString('fa-IR')} نفر)</span><span class="cav">${av}</span><span class="grow"></span>
      <button class="btn sm" id="cb-v">🎙 صوتی</button><button class="btn sm primary" id="cb-vid">🎥 تصویری</button></div>`;
    $('#cb-v').onclick = () => join(st.active.type, st.active.id, false, false, chatTitle());
    $('#cb-vid').onclick = () => join(st.active.type, st.active.id, true, false, chatTitle());
  } else el.innerHTML = '';
}
function start(chat, video) {
  if (!chat) return;
  join(chat.type, chat.id, video, true, chatTitle());
}

/* ---------- incoming ring ---------- */
function showRing(p) {
  if (call || ring) return;
  ring = p;
  const st = A().state, esc = A().esc;
  let where = '';
  let title = p.from.name;
  if (p.scope === 'group') {
    const g = st.groups.find((x) => x.id === p.id);
    where = g ? ` · گروه «${g.name}»` : ' · گروه';
    if (g) title = g.name;
  }
  const el = document.createElement('div');
  el.id = 'ringui'; el.className = 'ringui';
  el.innerHTML = `${A().avatar({ id: p.from.id, display_name: p.from.name }, 'md')}<div class="rt"><b>${esc(p.from.name)}</b><small>تماس ${p.video ? 'تصویری' : 'صوتی'}${esc(where)}</small></div>
    <button class="cbtn sm ok" id="r-a" title="پیوستن صوتی">🎙</button><button class="cbtn sm ok" id="r-v" title="پیوستن تصویری">🎥</button><button class="cbtn sm end" id="r-d" title="رد">✕</button>`;
  document.body.appendChild(el);
  $('#r-a').onclick = () => { endRing(); join(p.scope, p.id, false, false, title); };
  $('#r-v').onclick = () => { endRing(); join(p.scope, p.id, true, false, title); };
  $('#r-d').onclick = endRing;
  beep(520, 0.25); setTimeout(() => beep(620, 0.25), 300);
  ring.timer = setInterval(() => { beep(520, 0.25); setTimeout(() => beep(620, 0.25), 300); }, 2200);
  ring.kill = setTimeout(endRing, 40000);
}
function endRing() {
  if (!ring) return;
  clearInterval(ring.timer); clearTimeout(ring.kill);
  const el = $('#ringui'); if (el) el.remove();
  ring = null;
}

/* ---------- joining ---------- */
async function join(scope, id, video, doRing, title) {
  const toast = A().toast;
  if (call) return toast('شما همین حالا در یک تماس هستید', 'err');
  if (!socket || !socket.connected) return toast('ارتباط با سرور برقرار نیست', 'err');
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.RTCPeerConnection) {
    return toast('این مرورگر از تماس پشتیبانی نمی‌کند (یا آدرس سایت HTTPS نیست)', 'err');
  }
  const audioC = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: audioC, video: video ? { width: { ideal: 1280 }, height: { ideal: 720 } } : false });
  } catch (e) {
    if (video) {
      try { stream = await navigator.mediaDevices.getUserMedia({ audio: audioC }); video = false; toast('دوربین در دسترس نیست؛ فقط صدا وصل شد'); }
      catch (_) { return toast('دسترسی به میکروفون ممکن نشد. اجازه‌ی مرورگر را بررسی کنید.', 'err'); }
    } else return toast('دسترسی به میکروفون ممکن نشد. اجازه‌ی مرورگر را بررسی کنید.', 'err');
  }
  const mic = stream.getAudioTracks()[0];
  const cam = video ? (stream.getVideoTracks()[0] || null) : null;
  const ice = await getIce();
  call = {
    scope, id, title, ice, mic, micOn: true, cam, screen: null,
    camStream: new MediaStream(cam ? [cam] : []), screenStream: new MediaStream(),
    peers: new Map(), analysers: new Map(), started: Date.now(), timer: null,
  };
  openUI();
  watch('me', new MediaStream([mic]));
  call.timer = setInterval(tick, 250);
  endRing();
  socket.emit('call:join', { scope, id, mic: true, cam: !!cam, ring: doRing }, async (res) => {
    if (!call) return;
    if (!res || res.error) { toast((res && res.error) || 'اتصال به تماس ناموفق بود', 'err'); cleanup(false); return; }
    for (const p of res.peers) { const peer = ensurePeer(p.sid, p); await connectTo(peer).catch((e) => console.error(e)); }
    syncTiles(); renderBar();
  });
  syncTiles(); renderBar();
}

/* ---------- peers ---------- */
function ensurePeer(sid, info) {
  let peer = call.peers.get(sid);
  if (!peer) {
    peer = {
      sid, userId: info.userId, name: info.name || 'کاربر',
      state: { mic: info.mic !== false, cam: !!info.cam, screen: !!info.screen },
      pc: null, camStream: new MediaStream(), screenStream: new MediaStream(), audio: null, pending: [], conn: 'new',
    };
    call.peers.set(sid, peer);
  }
  return peer;
}
function newPC(peer, initiator) {
  const pc = new RTCPeerConnection({ iceServers: call.ice });
  peer.pc = pc;
  pc.onicecandidate = (e) => { if (e.candidate) socket.emit('call:signal', { to: peer.sid, data: { candidate: e.candidate.toJSON() } }); };
  // transceiver order is fixed: 0 = audio, 1 = camera, 2 = screen
  pc.ontrack = (e) => {
    const idx = pc.getTransceivers().indexOf(e.transceiver);
    if (idx === 0) attachAudio(peer, e.track);
    else if (idx === 1) peer.camStream.addTrack(e.track);
    else if (idx === 2) peer.screenStream.addTrack(e.track);
    syncTiles();
  };
  pc.onconnectionstatechange = () => {
    peer.conn = pc.connectionState;
    if (pc.connectionState === 'failed') A().toast(`اتصال با ${peer.name} برقرار نشد (شاید سرور TURN لازم باشد)`, 'err');
    syncTiles();
  };
  if (initiator) {
    pc.addTransceiver(call.mic, { direction: 'sendrecv' });
    pc.addTransceiver(call.cam || 'video', { direction: 'sendrecv' });
    pc.addTransceiver(call.screen || 'video', { direction: 'sendrecv' });
  }
  return pc;
}
async function connectTo(peer) {
  const pc = newPC(peer, true);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.emit('call:signal', { to: peer.sid, data: { sdp: { type: offer.type, sdp: offer.sdp } } });
}
async function flush(peer) {
  const list = peer.pending; peer.pending = [];
  for (const c of list) { try { await peer.pc.addIceCandidate(c); } catch (_) {} }
}
async function onSignal({ from, data }) {
  if (!call || !data) return;
  const peer = ensurePeer(from, { name: 'کاربر' });
  try {
    if (data.sdp) {
      if (data.sdp.type === 'offer') {
        const pc = peer.pc || newPC(peer, false);
        await pc.setRemoteDescription(data.sdp);
        const ts = pc.getTransceivers();
        const tracks = [call.mic, call.cam, call.screen];
        for (let i = 0; i < Math.min(3, ts.length); i++) {
          ts[i].direction = 'sendrecv';
          if (tracks[i]) await ts[i].sender.replaceTrack(tracks[i]);
        }
        const ans = await pc.createAnswer();
        await pc.setLocalDescription(ans);
        socket.emit('call:signal', { to: from, data: { sdp: { type: ans.type, sdp: ans.sdp } } });
        await flush(peer);
      } else if (peer.pc) {
        await peer.pc.setRemoteDescription(data.sdp);
        await flush(peer);
      }
    } else if (data.candidate) {
      if (peer.pc && peer.pc.remoteDescription) { try { await peer.pc.addIceCandidate(data.candidate); } catch (_) {} }
      else peer.pending.push(data.candidate);
    }
  } catch (e) { console.error('[call] signal', e); }
}
function attachAudio(peer, track) {
  const stream = new MediaStream([track]);
  const el = document.createElement('audio');
  el.autoplay = true; el.playsInline = true; el.srcObject = stream;
  document.body.appendChild(el);
  const p = el.play(); if (p && p.catch) p.catch(() => {});
  peer.audio = el;
  watch(peer.sid, stream);
}
function removePeer(sid) {
  const peer = call.peers.get(sid);
  if (!peer) return;
  try { if (peer.pc) peer.pc.close(); } catch (_) {}
  if (peer.audio) peer.audio.remove();
  call.analysers.delete(sid);
  call.peers.delete(sid);
  syncTiles();
}

/* ---------- speaking indicator ---------- */
function watch(id, stream) {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const src = audioCtx.createMediaStreamSource(stream);
    const an = audioCtx.createAnalyser(); an.fftSize = 512;
    src.connect(an);
    call.analysers.set(id, { an, buf: new Uint8Array(an.frequencyBinCount) });
  } catch (_) {}
}
const tileEl = (id) => { const g = $('#cgrid'); return g ? [...g.children].find((t) => t.dataset.id === id) : null; };
function tick() {
  if (!call) return;
  const s = Math.floor((Date.now() - call.started) / 1000);
  const t = $('#ctimer');
  if (t) t.textContent = String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  for (const [id, a] of call.analysers) {
    a.an.getByteFrequencyData(a.buf);
    let sum = 0; for (let i = 0; i < a.buf.length; i++) sum += a.buf[i];
    const tile = tileEl(id + ':cam');
    if (tile) tile.classList.toggle('speaking', sum / a.buf.length > 18 && (id !== 'me' || call.micOn));
  }
}

/* ---------- UI ---------- */
function openUI() {
  const canShare = !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
  const el = document.createElement('div');
  el.id = 'callui'; el.className = 'callui';
  el.innerHTML = `<div class="ctop"><div><b id="ctitle"></b><small id="ctimer">00:00</small></div><button class="cbtn sm" id="cmin" title="کوچک‌کردن">▾</button></div>
    <div class="cgrid" id="cgrid"></div>
    <div class="cbar"><button class="cbtn" id="cmic" title="میکروفون">🎙</button><button class="cbtn" id="ccam" title="دوربین">🎥</button>
    ${canShare ? '<button class="cbtn" id="cscr" title="اشتراک صفحه">🖥</button>' : ''}<button class="cbtn end" id="cend" title="پایان تماس">📞</button></div>`;
  document.body.appendChild(el);
  $('#ctitle').textContent = call.title || 'تماس';
  $('#cmic').onclick = toggleMic;
  $('#ccam').onclick = toggleCam;
  if (canShare) $('#cscr').onclick = toggleScreen;
  $('#cend').onclick = () => cleanup(true);
  $('#cmin').onclick = () => { el.classList.toggle('mini'); $('#cmin').textContent = el.classList.contains('mini') ? '▴' : '▾'; };
  updateBar();
}
function updateBar() {
  if (!call) return;
  const set = (id, on, label) => { const b = $(id); if (b) { b.classList.toggle('off', !on); if (label) b.textContent = label; } };
  set('#cmic', call.micOn, call.micOn ? '🎙' : '🔇');
  set('#ccam', !!call.cam, call.cam ? '🎥' : '📷');
  const s = $('#cscr'); if (s) s.classList.toggle('on', !!call.screen);
}
function setPin(id) {
  const grid = $('#cgrid'); if (!grid) return;
  grid.dataset.pin = id || '';
  grid.classList.toggle('has-pin', !!id);
  [...grid.children].forEach((t) => t.classList.toggle('pinned', t.dataset.id === id));
}
function syncTiles() {
  const grid = $('#cgrid');
  if (!grid || !call) return;
  const me = A().state.me;
  const want = [{ id: 'me:cam', name: me.display_name + ' (شما)', uid: me.id, stream: call.camStream, on: !!call.cam, mic: call.micOn, mine: true }];
  if (call.screen) want.push({ id: 'me:screen', name: 'صفحه‌ی شما', uid: me.id, stream: call.screenStream, on: true, mic: true, screen: true, mine: true });
  for (const p of call.peers.values()) {
    want.push({ id: p.sid + ':cam', name: p.name, uid: p.userId, stream: p.camStream, on: p.state.cam, mic: p.state.mic, conn: p.conn });
    if (p.state.screen) want.push({ id: p.sid + ':screen', name: 'صفحه‌ی ' + p.name, uid: p.userId, stream: p.screenStream, on: true, mic: true, screen: true });
  }
  const ids = new Set(want.map((w) => w.id));
  [...grid.children].forEach((t) => { if (!ids.has(t.dataset.id)) { if (grid.dataset.pin === t.dataset.id) setPin(null); t.remove(); } });
  for (const w of want) {
    let t = tileEl(w.id);
    if (!t) {
      t = document.createElement('div');
      t.className = 'tile' + (w.screen ? ' screen' : '') + (w.mine ? ' mine' : '');
      t.dataset.id = w.id;
      t.innerHTML = `<video autoplay playsinline muted></video><div class="ph">${A().avatar({ id: w.uid, display_name: w.name }, 'lg')}</div><div class="nm"><span class="mi"></span><span class="tn"></span></div>`;
      t.querySelector('video').srcObject = w.stream;
      t.querySelector('.tn').textContent = w.name;
      t.onclick = () => setPin(grid.dataset.pin === w.id ? null : w.id);
      grid.appendChild(t);
      if (w.screen && !grid.dataset.pin) setPin(w.id);
    }
    t.classList.toggle('vid', !!w.on);
    t.classList.toggle('bad', w.conn === 'failed');
    t.querySelector('.mi').textContent = w.mic ? '🎙' : '🔇';
    const v = t.querySelector('video');
    if (w.on && v.paused) { const pr = v.play(); if (pr && pr.catch) pr.catch(() => {}); }
  }
  grid.dataset.n = String(grid.children.length);
}

/* ---------- controls ---------- */
function pushState() { socket.emit('call:state', { mic: call.micOn, cam: !!call.cam, screen: !!call.screen }); }
function setSender(i, track) {
  for (const p of call.peers.values()) {
    const t = p.pc && p.pc.getTransceivers()[i];
    if (t) t.sender.replaceTrack(track).catch(() => {});
  }
}
function toggleMic() {
  call.micOn = !call.micOn;
  call.mic.enabled = call.micOn;
  pushState(); syncTiles(); updateBar();
}
async function toggleCam() {
  if (call.cam) {
    const t = call.cam; t.stop(); call.camStream.removeTrack(t); call.cam = null; setSender(1, null);
  } else {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } } });
      const t = s.getVideoTracks()[0];
      call.cam = t; call.camStream.addTrack(t); setSender(1, t);
    } catch (_) { return A().toast('دسترسی به دوربین ممکن نشد', 'err'); }
  }
  pushState(); syncTiles(); updateBar();
}
async function toggleScreen() {
  if (call.screen) return stopScreen();
  try {
    const s = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: false });
    const t = s.getVideoTracks()[0];
    call.screen = t; call.screenStream.addTrack(t); t.onended = stopScreen; setSender(2, t);
  } catch (e) {
    if (e && e.name !== 'NotAllowedError') A().toast('اشتراک صفحه ممکن نشد', 'err');
    return;
  }
  pushState(); syncTiles(); updateBar();
}
function stopScreen() {
  if (!call || !call.screen) return;
  const t = call.screen;
  t.onended = null; t.stop(); call.screenStream.removeTrack(t); call.screen = null;
  setSender(2, null); pushState(); syncTiles(); updateBar();
}

/* ---------- leaving ---------- */
function cleanup(emit) {
  if (!call) return;
  const c = call;
  call = null;
  clearInterval(c.timer);
  if (emit && socket && socket.connected) socket.emit('call:leave');
  [c.mic, c.cam, c.screen].forEach((t) => { try { if (t) t.stop(); } catch (_) {} });
  for (const p of c.peers.values()) { try { if (p.pc) p.pc.close(); } catch (_) {} if (p.audio) p.audio.remove(); }
  const u = $('#callui'); if (u) u.remove();
  renderBar();
}

window.Calls = { bind, start, onChatOpen, renderBar, end: () => cleanup(true) };
})();
