(() => {
'use strict';
/* ---------- helpers ---------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const toEn = (s) => String(s || '').replace(/[۰-۹]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d)).replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d));
const fa = (n) => Number(n || 0).toLocaleString('fa-IR');
const money = (n) => fa(n) + ' تومان';
const fmtTime = (d) => new Date(d).toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' });
const fmtDay = (d) => new Date(d).toLocaleDateString('fa-IR', { weekday: 'long', month: 'long', day: 'numeric' });
const dayKey = (d) => new Date(d).toDateString();
const COLORS = ['#7c5cff', '#00a8e8', '#ff5c9a', '#e89b00', '#1fb384', '#ff7a45', '#a46bff'];
const avatar = (u, cls = '') =>
  `<span class="av ${cls}" style="background:${COLORS[(u.id || 0) % COLORS.length]}">${esc((u.display_name || u.name || '?').trim().charAt(0))}</span>`;
const STATUS = { unpaid: 'پرداخت نشده', pending: 'منتظر تأیید', paid: 'پرداخت شد' };
const NOTICE = 'برای امنیت گروه‌ها، مدیر سایت می‌تواند فعالیت و پیام‌ها را مشاهده کند.';

const state = {
  token: localStorage.getItem('token'), me: null, view: 'chats',
  groups: [], dms: [], debts: [], notifs: [], search: null,
  active: null, tab: 'chat', messages: [], group: null, peer: null, expenses: [], socket: null,
};
const auth = { mode: 'login' };

async function api(path, opts = {}) {
  const r = await fetch('/api' + path, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json', ...(state.token ? { Authorization: 'Bearer ' + state.token } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && state.token && !path.startsWith('/auth')) { logout(); throw new Error(data.error || 'نشست منقضی شد'); }
  if (!r.ok) throw new Error(data.error || 'خطا در ارتباط با سرور');
  return data;
}

function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => { el.style.transition = '.3s'; el.style.opacity = 0; setTimeout(() => el.remove(), 300); }, 3500);
}
function openModal(html) { const m = $('#modal'); m.innerHTML = `<div class="modal">${html}</div>`; m.hidden = false; }
function closeModal() { $('#modal').hidden = true; $('#modal').innerHTML = ''; }
$('#modal').addEventListener('mousedown', (e) => { if (e.target.id === 'modal') closeModal(); });

/* ---------- auth screens ---------- */
function renderAuth() {
  const m = auth.mode;
  let inner = '';
  if (m === 'login') inner = `<form data-form="login" style="display:grid;gap:12px">
    <label>آیدی<input name="identifier" class="ltr" autocomplete="username" required autofocus></label>
    <label>رمز عبور<input name="password" type="password" autocomplete="current-password" required></label>
    <button class="btn primary">ورود</button></form>
    <button class="link" data-act="auth-mode" data-m="register">حساب ندارید؟ ثبت‌نام</button>`;
  else if (m === 'register') inner = `<form data-form="register" style="display:grid;gap:12px">
    <label>نام<input name="display_name" maxlength="40" required autofocus></label>
    <label>آیدی (انگلیسی)<input name="username" class="ltr" id="reg-un" maxlength="20" placeholder="ali_123" required autocomplete="username"><span class="hint" id="un-hint"></span></label>
    <label>رمز عبور (حداقل ۶ کاراکتر)<input name="password" type="password" minlength="6" required autocomplete="new-password"></label>
    <button class="btn primary">ساخت حساب</button></form>
    <button class="link" data-act="auth-mode" data-m="login">حساب دارید؟ ورود</button>`;
  else if (m === 'setup') inner = `<p>خوش آمدید! نام و آیدی خودتان را انتخاب کنید.<br>دیگران با همین آیدی می‌توانند شما را پیدا کنند.</p>
    <form data-form="setup" style="display:grid;gap:12px">
    <label>نام<input name="display_name" maxlength="40" required autofocus value="${esc(state.me?.display_name === 'کاربر جدید' ? '' : state.me?.display_name || '')}"></label>
    <label>آیدی یکتا<input name="username" class="ltr" id="reg-un" maxlength="20" placeholder="ali_123" required><span class="hint" id="un-hint"></span></label>
    <label>رمز عبور (حداقل ۶ کاراکتر)<input name="password" type="password" minlength="6" required autocomplete="new-password"></label>
    <button class="btn primary">شروع</button></form>`;
  $('#app').innerHTML = `<div class="auth"><div class="auth-card"><div class="logo">🏠</div><h1>خوابگاه‌یار</h1>
    <p>هزینه‌های مشترک، گروه و چت؛ همه در یک‌جا</p>${inner}<div class="notice">${NOTICE}</div></div></div>`;
}

let unTimer;
document.addEventListener('input', (e) => {
  if (e.target.id === 'reg-un') {
    clearTimeout(unTimer);
    const v = e.target.value.trim().toLowerCase(); const h = $('#un-hint');
    if (!v) { h.textContent = ''; return; }
    unTimer = setTimeout(async () => {
      try {
        if (auth.mode === 'register') {
          if (!/^[a-z][a-z0-9_]{2,19}$/.test(v)) { h.className = 'hint bad'; h.textContent = 'با حرف انگلیسی شروع شود، ۳ تا ۲۰ کاراکتر (حرف، عدد، _)'; return; }
          h.className = 'hint'; h.textContent = 'فرمت درست است؛ در زمان ثبت بررسی می‌شود';
        } else {
          const r = await api('/username/check?u=' + encodeURIComponent(v));
          h.className = 'hint ' + (r.ok ? 'ok' : 'bad'); h.textContent = r.ok ? '✓ آزاد است' : '✗ ' + r.reason;
        }
      } catch (_) {}
    }, 350);
  }
  if (e.target.id === 'ex-total') equalSplit();
  if (e.target.dataset && e.target.dataset.amt) updateSum();
  if (e.target.id === 'search-in') doSearch(e.target.value);
});
document.addEventListener('change', (e) => {
  if (e.target.dataset && e.target.dataset.uid) {
    const amt = $(`[data-amt="${e.target.dataset.uid}"]`);
    amt.disabled = !e.target.checked; if (!e.target.checked) amt.value = '';
    equalSplit();
  }
});

function setSession(r) {
  state.token = r.token; localStorage.setItem('token', r.token); state.me = r.user;
  if (r.user.needs_setup) { auth.mode = 'setup'; renderAuth(); } else enterApp();
}
function logout() {
  if (window.Calls) window.Calls.end();
  localStorage.removeItem('token');
  if (state.socket) state.socket.disconnect();
  Object.assign(state, { token: null, me: null, active: null, groups: [], dms: [], debts: [], notifs: [], search: null, view: 'chats' });
  auth.mode = 'login'; closeModal(); renderAuth();
}

/* ---------- forms ---------- */
const forms = {
  async login(f) { setSession(await api('/auth/login', { method: 'POST', body: { identifier: toEn(f.identifier.value), password: f.password.value } })); },
  async register(f) { setSession(await api('/auth/register', { method: 'POST', body: { display_name: f.display_name.value, username: f.username.value, password: f.password.value } })); },
  async setup(f) {
    const body = { display_name: f.display_name.value, username: f.username.value };
    if (f.password.value) body.password = f.password.value;
    const r = await api('/me', { method: 'PATCH', body }); state.me = r.user; enterApp();
  },
  async profile(f) {
    const body = { display_name: f.display_name.value, username: f.username.value };
    if (f.password.value) body.password = f.password.value;
    const r = await api('/me', { method: 'PATCH', body }); state.me = r.user; closeModal(); renderSide(); toast('ذخیره شد', 'ok');
  },
  async 'group-new'(f) {
    const r = await api('/groups', { method: 'POST', body: { name: f.name.value } });
    closeModal(); await loadChats(); openChat('group', r.group.id);
  },
  async 'group-join'(f) {
    const r = await api('/groups/join', { method: 'POST', body: { code: f.code.value } });
    closeModal(); await loadChats(); openChat('group', r.group.id); toast('به گروه پیوستید', 'ok');
  },
  async 'add-member'(f) {
    await api(`/groups/${state.active.id}/members`, { method: 'POST', body: { username: f.username.value } });
    f.reset(); toast('عضو اضافه شد', 'ok'); await refreshGroup();
  },
  async send(f) {
    const body = f.body.value.trim(); if (!body) return;
    f.body.value = ''; const a = state.active;
    try {
      const r = await api(a.type === 'group' ? `/groups/${a.id}/messages` : `/dm/${a.id}/messages`, { method: 'POST', body: { body } });
      addMessage(r.message, a);
    } catch (e) { f.body.value = body; throw e; }
  },
  async pay(f) {
    await api(`/shares/${f.dataset.id}/pay`, { method: 'POST', body: { note: f.note.value } });
    closeModal(); toast('منتظر تأیید مادر خرج', 'ok'); await refreshAfterExpense();
  },
  async 'expense-new'(f) {
    const participants = $$('[data-uid]').filter((c) => c.checked).map((c) => ({ user_id: +c.dataset.uid, amount: +toEn($(`[data-amt="${c.dataset.uid}"]`).value) || 0 }));
    await api(`/groups/${state.active.id}/expenses`, { method: 'POST', body: { title: f.title.value, note: f.note.value, total: +toEn(f.total.value), participants } });
    closeModal(); toast('هزینه ثبت شد', 'ok'); await refreshAfterExpense();
  },
};
document.addEventListener('submit', async (e) => {
  const f = e.target; const h = forms[f.dataset.form];
  if (!h) return;
  e.preventDefault();
  const btn = $('button:not([type=button])', f);
  if (btn) btn.disabled = true;
  try { await h(f); } catch (err) { toast(err.message, 'err'); }
  if (btn && document.body.contains(btn)) btn.disabled = false;
});

/* ---------- actions ---------- */
const acts = {
  'auth-mode': (el) => { auth.mode = el.dataset.m; renderAuth(); },
  view(el) { state.view = el.dataset.v; state.search = null; const s = $('#search-in'); if (s) s.value = ''; renderSide(); if (state.view === 'notifs') markNotifsRead(); },
  'open-chat': (el) => openChat(el.dataset.type, +el.dataset.id),
  'open-debt': async (el) => { await openChat('group', +el.dataset.id); setTab('expenses'); },
  'start-dm': (el) => { state.search = null; $('#search-in').value = ''; openChat('dm', +el.dataset.id); },
  back() { $('#shell').classList.remove('show-main'); state.active = null; renderSide(); },
  tab: (el) => setTab(el.dataset.t),
  menu() {
    openModal(`<h3>پروفایل من</h3><form data-form="profile">
      <label>نام<input name="display_name" value="${esc(state.me.display_name)}" maxlength="40" required></label>
      <label>آیدی<input name="username" class="ltr" value="${esc(state.me.username)}" maxlength="20" required></label>
      <label>رمز جدید (اختیاری)<input name="password" type="password" autocomplete="new-password"></label>
      <button class="btn primary">ذخیره</button></form>
      <div class="notice">${NOTICE}</div>
      <button class="btn bad" data-act="logout">خروج از حساب</button>`);
  },
  logout,
  'new-group'() { openModal(`<h3>گروه جدید</h3><form data-form="group-new"><label>نام گروه<input name="name" maxlength="50" placeholder="مثلاً اتاق ۲۱۴" required autofocus></label><p class="hint">سازنده گروه «مادر خرج» می‌شود.</p><button class="btn primary">ساخت</button></form>`); },
  'join-group'() { openModal(`<h3>پیوستن با کد دعوت</h3><form data-form="group-join"><label>کد دعوت<input name="code" class="ltr" maxlength="8" required autofocus></label><button class="btn primary">پیوستن</button></form>`); },
  'close-modal': closeModal,
  async copy(el) { try { await navigator.clipboard.writeText(el.dataset.v); toast('کپی شد', 'ok'); } catch (_) { toast(el.dataset.v); } },
  'pay-modal'(el) { openModal(`<h3>اعلام پرداخت</h3><form data-form="pay" data-id="${+el.dataset.id}"><label>توضیح یا ۴ رقم آخر کارت (اختیاری)<input name="note" maxlength="200"></label><button class="btn primary">پرداخت کردم</button></form>`); },
  async confirm(el) { await call(() => api(`/shares/${el.dataset.id}/confirm`, { method: 'POST' }), 'تأیید شد'); },
  async reject(el) { await call(() => api(`/shares/${el.dataset.id}/reject`, { method: 'POST' }), 'رد شد'); },
  async remind(el) { await remind(+el.dataset.uid || null); },
  async 'del-expense'(el) { if (confirm('این هزینه حذف شود؟')) await call(() => api(`/expenses/${el.dataset.id}`, { method: 'DELETE' }), 'حذف شد'); },
  call(el) { if (window.Calls) window.Calls.start(state.active, el.dataset.v === '1'); },
  'new-expense': expenseModal,
  equal: equalSplit,
  async 'open-notif'(el) { const g = +el.dataset.g; if (g) { await openChat('group', g); setTab('expenses'); } },
};
async function call(fn, okMsg) { try { await fn(); toast(okMsg, 'ok'); await refreshAfterExpense(); } catch (e) { toast(e.message, 'err'); } }
async function remind(uid) {
  try {
    const r = await api(`/groups/${state.active.id}/remind`, { method: 'POST', body: uid ? { user_id: uid } : {} });
    toast(r.reminded ? `یادآوری برای ${fa(r.reminded)} نفر ارسال شد (اعلان داخل برنامه)` : 'موردی برای یادآوری نبود (یا به‌تازگی یادآوری شده)', r.reminded ? 'ok' : '');
  } catch (e) { toast(e.message, 'err'); }
}
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const fn = acts[el.dataset.act];
  if (fn) { e.stopPropagation(); Promise.resolve(fn(el)).catch((err) => toast(err.message, 'err')); }
});

/* ---------- data loading ---------- */
async function loadChats() { const r = await api('/chats'); state.groups = r.groups; state.dms = r.dms; renderSide(); }
async function loadDebts() { state.debts = (await api('/debts')).debts; renderSide(); }
async function loadNotifs() { state.notifs = (await api('/notifications')).notifications; renderSide(); }
let chatsTimer;
const loadChatsSoon = () => { clearTimeout(chatsTimer); chatsTimer = setTimeout(() => loadChats().catch(() => {}), 300); };
async function markNotifsRead() {
  if (!state.notifs.some((n) => !n.is_read)) return;
  try { await api('/notifications/read', { method: 'POST' }); } catch (_) {}
  setTimeout(() => { state.notifs.forEach((n) => (n.is_read = true)); renderSide(); }, 1500);
}
async function refreshGroup() {
  const id = state.active?.id; if (!id || state.active.type !== 'group') return;
  const [g, e] = await Promise.all([api('/groups/' + id), api(`/groups/${id}/expenses`)]);
  if (state.active?.id !== id) return;
  state.group = g; state.expenses = e.expenses; renderBody();
}
async function refreshAfterExpense() { await Promise.all([loadDebts(), state.active?.type === 'group' ? refreshGroup() : null]); }

async function enterApp() {
  $('#app').innerHTML = `<div class="shell" id="shell">
    <aside class="side">
      <div class="side-head"><button class="me" data-act="menu" id="me-box"></button>
        <button class="icon-btn" data-act="join-group" title="پیوستن با کد">🔗</button>
        <button class="icon-btn" data-act="new-group" title="گروه جدید">＋</button></div>
      <div class="search"><input id="search-in" placeholder="جستجوی آیدی کاربر (مثلاً ali)" autocomplete="off"></div>
      <div class="tabs" id="tabs"></div><div class="list" id="list"></div>
    </aside><main class="main" id="main"></main></div>`;
  renderSide(); renderMain();
  await Promise.all([loadChats(), loadDebts(), loadNotifs()]).catch((e) => toast(e.message, 'err'));
  connectSocket();
}

/* ---------- sidebar ---------- */
function renderSide() {
  if (!$('#list')) return;
  $('#me-box').innerHTML = `${avatar(state.me)}<div><b>${esc(state.me.display_name)}</b><small class="ltr" style="direction:ltr;text-align:start">@${esc(state.me.username)}</small></div>`;
  const unread = state.notifs.filter((n) => !n.is_read).length;
  $('#tabs').innerHTML = [['chats', 'چت‌ها', 0], ['debts', 'بدهی‌ها', state.debts.length], ['notifs', 'اعلان‌ها', unread]]
    .map(([v, t, n]) => `<button data-act="view" data-v="${v}" class="${state.view === v ? 'on' : ''}">${t}${n ? `<span class="badge">${fa(n)}</span>` : ''}</button>`).join('');
  const list = $('#list'); let html = '';
  const act = state.active;
  if (state.search) {
    html = state.search.length
      ? `<div class="sec">نتیجه جستجو</div>` + state.search.map((u, i) => `<div class="item" style="animation-delay:${i * 30}ms" data-act="start-dm" data-id="${u.id}">${avatar(u)}<div class="tx"><b>${esc(u.display_name)}</b><small style="direction:ltr;text-align:start">@${esc(u.username)}</small></div></div>`).join('')
      : `<div class="empty"><div>کاربری با این آیدی پیدا نشد</div></div>`;
  } else if (state.view === 'chats') {
    html += state.groups.length ? `<div class="sec">گروه‌ها</div>` : '';
    html += state.groups.map((g, i) => `<div class="item ${act && act.type === 'group' && act.id === g.id ? 'on' : ''}" style="animation-delay:${i * 30}ms" data-act="open-chat" data-type="group" data-id="${g.id}">${avatar({ id: g.id, name: g.name })}<div class="tx"><b>${esc(g.name)} ${g.role === 'treasurer' ? '👑' : ''}</b><small>${esc(g.last_body || fa(g.members) + ' عضو')}</small></div><span class="meta">${g.last_at ? fmtTime(g.last_at) : ''}</span></div>`).join('');
    html += state.dms.length ? `<div class="sec">پیام‌های خصوصی</div>` : '';
    html += state.dms.map((u, i) => `<div class="item ${act && act.type === 'dm' && act.id === u.id ? 'on' : ''}" style="animation-delay:${i * 30}ms" data-act="open-chat" data-type="dm" data-id="${u.id}">${avatar(u)}<div class="tx"><b>${esc(u.display_name)}</b><small>${esc(u.last_body)}</small></div><span class="meta">${fmtTime(u.last_at)}</span></div>`).join('');
    if (!state.groups.length && !state.dms.length) html = `<div class="empty"><div class="big">💬</div><b>هنوز چتی ندارید</b><small>یک گروه بسازید، با کد دعوت به گروه بپیوندید، یا آیدی یک نفر را جستجو کنید.</small></div>`;
  } else if (state.view === 'debts') {
    html = state.debts.length ? `<div class="sec">مجموع: ${money(state.debts.reduce((a, d) => a + d.amount, 0))}</div>` + state.debts.map((d, i) => `<div class="item" style="animation-delay:${i * 30}ms" data-act="open-debt" data-id="${d.group_id}"><div class="tx"><b>${esc(d.title)}</b><small>${esc(d.group_name)} · ${money(d.amount)}</small></div><span class="chip ${d.status}">${STATUS[d.status]}</span></div>`).join('')
      : `<div class="empty"><div class="big">🎉</div><b>بدهی ندارید</b></div>`;
  } else {
    html = state.notifs.length ? state.notifs.map((n, i) => `<div class="item" style="animation-delay:${i * 25}ms;${n.is_read ? 'opacity:.7' : ''}" data-act="open-notif" data-g="${n.group_id || 0}"><div class="tx"><b style="white-space:normal;font-weight:${n.is_read ? 400 : 700}">${esc(n.text)}</b><small>${new Date(n.created_at).toLocaleString('fa-IR', { dateStyle: 'short', timeStyle: 'short' })}</small></div></div>`).join('')
      : `<div class="empty"><div class="big">🔔</div><b>اعلانی نیست</b></div>`;
  }
  list.innerHTML = html;
}
let searchTimer;
function doSearch(v) {
  clearTimeout(searchTimer);
  if (v.trim().length < 2) { state.search = null; renderSide(); return; }
  searchTimer = setTimeout(async () => {
    try { const r = await api('/users/search?q=' + encodeURIComponent(v)); if ($('#search-in').value === v) { state.search = r.users; renderSide(); } } catch (_) {}
  }, 300);
}

/* ---------- main panel ---------- */
async function openChat(type, id) {
  state.active = { type, id }; state.tab = 'chat'; state.messages = []; state.group = null; state.peer = null; state.expenses = [];
  $('#shell').classList.add('show-main'); renderMain(); renderSide();
  try {
    if (type === 'group') {
      const [g, m, e] = await Promise.all([api('/groups/' + id), api(`/groups/${id}/messages`), api(`/groups/${id}/expenses`)]);
      if (state.active?.id !== id) return;
      Object.assign(state, { group: g, messages: m.messages, expenses: e.expenses });
    } else {
      const [p, m] = await Promise.all([api('/users/' + id), api(`/dm/${id}/messages`)]);
      if (state.active?.id !== id) return;
      Object.assign(state, { peer: p.user, messages: m.messages });
    }
  } catch (e) { toast(e.message, 'err'); state.active = null; $('#shell').classList.remove('show-main'); renderMain(); return; }
  renderMain(); scrollMsgs();
  if (window.Calls) window.Calls.onChatOpen();
}
function setTab(t) { state.tab = t; renderMain(); if (t === 'chat') scrollMsgs(); }

function renderMain() {
  const el = $('#main'); if (!el) return;
  const a = state.active;
  if (!a) { el.innerHTML = `<div class="welcome"><div class="logo">🏠</div><h2>خوش آمدید، ${esc(state.me.display_name)}</h2><small>یک گفتگو را از لیست انتخاب کنید یا گروه جدیدی بسازید.</small></div>`; return; }
  const loaded = a.type === 'group' ? state.group : state.peer;
  const title = a.type === 'group' ? (state.group ? state.group.group.name : '...') : (state.peer ? state.peer.display_name : '...');
  const sub = a.type === 'group' ? (state.group ? `${fa(state.group.members.length)} عضو · مادر خرج: ${esc((state.group.members.find((m) => m.role === 'treasurer') || {}).display_name || '—')}` : '') : (state.peer ? '@' + esc(state.peer.username) : '');
  const av = a.type === 'group' ? avatar({ id: a.id, name: title }) : avatar(state.peer || { id: a.id, display_name: '?' });
  el.innerHTML = `<div class="head"><button class="icon-btn back" data-act="back">→</button>${av}<div class="t"><b>${esc(title)}</b><small style="direction:ltr;text-align:start">${sub}</small></div>
    ${loaded ? '<button class="icon-btn" data-act="call" data-v="0" title="تماس صوتی">📞</button><button class="icon-btn" data-act="call" data-v="1" title="تماس تصویری">🎥</button>' : ''}</div>
    ${a.type === 'group' ? `<div class="gtabs">${[['chat', '💬 گفتگو'], ['expenses', '💰 هزینه‌ها'], ['members', '👥 اعضا']].map(([t, n]) => `<button data-act="tab" data-t="${t}" class="${state.tab === t ? 'on' : ''}">${n}</button>`).join('')}</div>` : ''}
    <div id="callbar"></div><div class="body" id="body">${loaded ? '' : '<div class="spinner"></div>'}</div>`;
  if (loaded) renderBody();
  if (window.Calls) window.Calls.renderBar();
}

function renderBody() {
  const b = $('#body'); if (!b || !state.active) return;
  if (state.tab === 'chat') {
    b.innerHTML = `<div class="msgs" id="msgs"></div><form class="composer" data-form="send"><input name="body" placeholder="پیام بنویسید..." autocomplete="off" maxlength="2000"><button class="send" aria-label="ارسال"><svg viewBox="0 0 24 24"><path d="M2 21l21-9L2 3v7l15 2-15 2z"/></svg></button></form>`;
    const box = $('#msgs'); let last = '';
    for (const m of state.messages) { const k = dayKey(m.created_at); if (k !== last) { box.insertAdjacentHTML('beforeend', `<div class="day">${fmtDay(m.created_at)}</div>`); last = k; } box.insertAdjacentHTML('beforeend', msgHTML(m)); }
    if (!state.messages.length) box.innerHTML = `<div class="empty" style="margin:auto"><div class="big">👋</div><small>اولین پیام را بفرستید</small></div>`;
    scrollMsgs();
  } else if (state.tab === 'expenses') b.innerHTML = `<div class="scroll">${expensesHTML()}</div>`;
  else b.innerHTML = `<div class="scroll">${membersHTML()}</div>`;
}

function msgHTML(m) {
  if (m.kind === 'system') return `<div class="sysmsg" data-mid="${m.id}">${esc(m.body)}</div>`;
  const mine = m.from_user_id === state.me.id;
  const who = !mine && state.active.type === 'group' ? `<span class="who">${esc(m.display_name)}</span>` : '';
  return `<div class="bub ${mine ? 'me' : 'them'}" data-mid="${m.id}">${who}${esc(m.body)}<time>${fmtTime(m.created_at)}</time></div>`;
}
function scrollMsgs() { const m = $('#msgs'); if (m) requestAnimationFrame(() => (m.scrollTop = m.scrollHeight)); }
function addMessage(m, a = state.active) {
  if (!a || !state.active || state.active.type !== a.type || state.active.id !== a.id) return;
  if (state.messages.some((x) => x.id === m.id)) return;
  state.messages.push(m);
  const box = $('#msgs'); if (!box || state.tab !== 'chat') return;
  const prev = state.messages[state.messages.length - 2];
  if (!prev) box.innerHTML = '';
  if (!prev || dayKey(prev.created_at) !== dayKey(m.created_at)) box.insertAdjacentHTML('beforeend', `<div class="day">${fmtDay(m.created_at)}</div>`);
  const near = box.scrollHeight - box.scrollTop - box.clientHeight < 200 || m.from_user_id === state.me.id;
  box.insertAdjacentHTML('beforeend', msgHTML(m));
  if (near) scrollMsgs();
}

/* ---------- expenses ---------- */
function expensesHTML() {
  const g = state.group, isT = g.my_role === 'treasurer';
  let open = 0, pend = 0;
  state.expenses.forEach((e) => e.shares.forEach((s) => { if (s.status === 'unpaid') open += s.amount; if (s.status === 'pending') pend += s.amount; }));
  const myOpen = state.expenses.flatMap((e) => e.shares).filter((s) => s.user_id === state.me.id && s.status !== 'paid').reduce((a, s) => a + s.amount, 0);
  let h = `<div class="sumbar"><div class="pill"><small>بدهی باز گروه</small><b>${money(open)}</b></div><div class="pill"><small>منتظر تأیید</small><b>${money(pend)}</b></div>
    ${myOpen ? `<div class="pill"><small>بدهی من</small><b style="color:var(--bad)">${money(myOpen)}</b></div>` : ''}<span class="grow"></span>
    ${isT ? `<button class="btn" data-act="remind">🔔 یادآوری همه</button><button class="btn primary" data-act="new-expense">＋ هزینه جدید</button>` : ''}</div>`;
  if (!state.expenses.length) return h + `<div class="empty"><div class="big">🧾</div><b>هنوز هزینه‌ای ثبت نشده</b><small>${isT ? 'با دکمه «هزینه جدید» شروع کنید.' : 'مادر خرج هزینه‌ها را ثبت می‌کند.'}</small></div>`;
  h += state.expenses.map((e, i) => {
    const paid = e.shares.filter((s) => s.status === 'paid').reduce((a, s) => a + s.amount, 0);
    const pct = e.total ? Math.round((paid / e.total) * 100) : 0;
    return `<div class="ex" style="animation-delay:${i * 50}ms"><div class="ex-h"><div><b>${esc(e.title)}</b><br><small>${money(e.total)} · ${new Date(e.created_at).toLocaleDateString('fa-IR')}${e.note ? ' · ' + esc(e.note) : ''}</small></div>
      ${isT ? `<button class="btn sm" data-act="del-expense" data-id="${e.id}">🗑</button>` : ''}</div>
      <div class="bar"><i style="width:${pct}%"></i></div><small>${fa(pct)}٪ پرداخت شده</small>
      ${e.shares.map((s) => `<div class="share">${avatar({ id: s.user_id, display_name: s.display_name }, 'sm')}<div class="nm"><b>${esc(s.display_name)}</b><small>${money(s.amount)}${s.pay_note ? ' · ' + esc(s.pay_note) : ''}</small></div>
        <span class="chip ${s.status}">${STATUS[s.status]}</span><div class="acts">
        ${s.user_id === state.me.id && s.status === 'unpaid' ? `<button class="btn primary sm" data-act="pay-modal" data-id="${s.id}">پرداخت کردم</button>` : ''}
        ${isT && s.status === 'pending' ? `<button class="btn ok sm" data-act="confirm" data-id="${s.id}">تأیید</button><button class="btn bad sm" data-act="reject" data-id="${s.id}">رد</button>` : ''}
        ${isT && s.status === 'unpaid' ? `<button class="btn ok sm" data-act="confirm" data-id="${s.id}" title="پرداخت نقدی">نقدی ✓</button><button class="btn sm" data-act="remind" data-uid="${s.user_id}">🔔</button>` : ''}
        </div></div>`).join('')}</div>`;
  }).join('');
  return h;
}

function membersHTML() {
  const g = state.group, isT = g.my_role === 'treasurer';
  const owed = {}; state.expenses.forEach((e) => e.shares.forEach((s) => { if (s.status !== 'paid') owed[s.user_id] = (owed[s.user_id] || 0) + s.amount; }));
  return `<div class="invite"><div><small>کد دعوت گروه</small><br><code>${esc(g.group.invite_code)}</code></div><button class="btn" data-act="copy" data-v="${esc(g.group.invite_code)}">کپی</button></div>
    ${isT ? `<form data-form="add-member" style="display:flex;gap:8px;margin-bottom:14px"><input name="username" class="ltr" placeholder="افزودن با آیدی، مثلاً ali_123" required><button class="btn primary">افزودن</button></form>` : ''}
    ${g.members.map((m, i) => `<div class="mem" style="animation-delay:${i * 40}ms">${avatar(m)}<div class="tx"><b>${esc(m.display_name)} ${m.role === 'treasurer' ? '<span class="chip role">مادر خرج 👑</span>' : ''}</b><small style="direction:ltr;text-align:start">@${esc(m.username)}</small></div>
      ${owed[m.id] ? `<span class="chip unpaid">${money(owed[m.id])}</span>` : '<span class="chip paid">تسویه</span>'}
      ${m.id !== state.me.id ? `<button class="btn sm" data-act="start-dm" data-id="${m.id}">پیام</button>` : ''}</div>`).join('')}`;
}

function expenseModal() {
  const members = state.group.members;
  openModal(`<h3>هزینه جدید</h3><form data-form="expense-new">
    <label>عنوان<input name="title" maxlength="100" placeholder="مثلاً خرید مواد غذایی" required autofocus></label>
    <label>مبلغ کل (تومان)<input name="total" id="ex-total" class="ltr" inputmode="numeric" placeholder="0" required></label>
    <label>توضیح (اختیاری)<input name="note" maxlength="300"></label>
    <div class="parts-head"><b>سهم هر نفر</b><button type="button" class="link" data-act="equal">تقسیم مساوی</button></div>
    <div id="parts">${members.map((m) => `<div class="part"><label class="chk"><input type="checkbox" data-uid="${m.id}" checked>${avatar(m, 'sm')}${esc(m.display_name)}</label><input class="amt" data-amt="${m.id}" inputmode="numeric" placeholder="0"></div>`).join('')}</div>
    <div class="sumline" id="sumline"></div><button class="btn primary">ثبت هزینه</button></form>`);
}
function equalSplit() {
  const total = Math.round(+toEn($('#ex-total')?.value) || 0);
  const ids = $$('[data-uid]').filter((c) => c.checked).map((c) => c.dataset.uid);
  const n = ids.length;
  if (n && total > 0) { const base = Math.floor(total / n); let rem = total - base * n; ids.forEach((id) => { $(`[data-amt="${id}"]`).value = base + (rem-- > 0 ? 1 : 0); }); }
  updateSum();
}
function updateSum() {
  const el = $('#sumline'); if (!el) return;
  const total = Math.round(+toEn($('#ex-total').value) || 0);
  const sum = $$('[data-uid]').filter((c) => c.checked).reduce((a, c) => a + (+toEn($(`[data-amt="${c.dataset.uid}"]`).value) || 0), 0);
  const diff = total - sum;
  el.className = 'sumline hint ' + (diff === 0 && total ? 'ok' : 'bad');
  el.textContent = !total ? '' : diff === 0 ? `✓ مجموع سهم‌ها ${money(sum)} است` : `مجموع سهم‌ها ${money(sum)} است؛ ${money(Math.abs(diff))} ${diff > 0 ? 'کم' : 'اضافه'}`;
}

/* ---------- realtime ---------- */
function connectSocket() {
  if (state.socket) state.socket.disconnect();
  const s = io({ auth: { token: state.token } });
  state.socket = s;
  if (window.Calls) window.Calls.bind(s);
  s.on('connect_error', (e) => { if (e.message === 'unauthorized') logout(); });
  s.on('message', (p) => {
    const m = p.message, a = state.active;
    const inActive = a && ((p.scope === 'group' && a.type === 'group' && a.id === p.group_id) || (p.scope === 'dm' && a.type === 'dm' && (m.from_user_id === a.id || m.to_user_id === a.id)));
    if (inActive) addMessage(m, a);
    else if (m.from_user_id !== state.me.id && m.kind !== 'system') toast(`${m.display_name}: ${m.body.slice(0, 60)}`);
    loadChatsSoon();
  });
  s.on('notification', (n) => { state.notifs.unshift(n); renderSide(); toast(n.text); });
  s.on('expense_update', (p) => { loadDebts().catch(() => {}); if (state.active?.type === 'group' && state.active.id === p.group_id) refreshGroup().catch(() => {}); });
}

window.App = { state, api, toast, avatar, esc };

/* ---------- boot ---------- */
(async function boot() {
  if (!state.token) { renderAuth(); return; }
  try {
    state.me = (await api('/me')).user;
    if (state.me.needs_setup) { auth.mode = 'setup'; renderAuth(); } else enterApp();
  } catch (_) { if (!state.token) return; localStorage.removeItem('token'); state.token = null; renderAuth(); }
})();
})();
