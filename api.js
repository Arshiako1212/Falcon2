const router = require('express').Router();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { pool } = require('./db');
const { emitToUsers, notifyUser, validUsername, publicUser } = require('./lib');

const q = (t, p) => pool.query(t, p);
const wrap = (fn) => (req, res) =>
  fn(req, res).catch((e) => {
    console.error(e);
    res.status(500).json({ error: 'خطای سرور' });
  });
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });
const fa = (n) => Number(n).toLocaleString('fa-IR');
const intParam = (v) => (Number.isInteger(+v) && +v > 0 ? +v : null);

async function roleOf(gid, uid) {
  const { rows } = await q('SELECT role FROM group_members WHERE group_id=$1 AND user_id=$2', [gid, uid]);
  return rows[0]?.role || null;
}
async function memberIds(gid) {
  const { rows } = await q('SELECT user_id FROM group_members WHERE group_id=$1', [gid]);
  return rows.map((r) => r.user_id);
}

async function insertMessage({ gid = null, from, to = null, body, kind = 'text' }) {
  const { rows } = await q(
    `WITH m AS (INSERT INTO messages(group_id,from_user_id,to_user_id,body,kind) VALUES($1,$2,$3,$4,$5) RETURNING *)
     SELECT m.id,m.group_id,m.from_user_id,m.to_user_id,m.body,m.kind,m.created_at,u.username,u.display_name
     FROM m JOIN users u ON u.id=m.from_user_id`,
    [gid, from, to, body, kind]
  );
  const msg = rows[0];
  if (gid) emitToUsers(await memberIds(gid), 'message', { scope: 'group', group_id: gid, message: msg });
  else emitToUsers([from, to], 'message', { scope: 'dm', message: msg });
  return msg;
}
const systemMsg = (gid, from, body) => insertMessage({ gid, from, body, kind: 'system' });

/* ================= call config (STUN/TURN) ================= */
router.get('/rtc-config', (req, res) => {
  const stun = (process.env.STUN_URLS || 'stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302')
    .split(',').map((s) => s.trim()).filter(Boolean);
  const iceServers = [{ urls: stun }];
  const turn = (process.env.TURN_URLS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (turn.length && process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL) {
    iceServers.push({ urls: turn, username: process.env.TURN_USERNAME, credential: process.env.TURN_CREDENTIAL });
  }
  res.json({ iceServers });
});

/* ================= profile ================= */
router.get('/me', wrap(async (req, res) => res.json({ user: publicUser(req.user, true) })));

router.patch('/me', wrap(async (req, res) => {
  const me = req.user;
  const sets = [];
  const vals = [];
  if (req.body.display_name !== undefined) {
    const n = String(req.body.display_name).trim().slice(0, 40);
    if (!n) return bad(res, 'نام نمی‌تواند خالی باشد');
    vals.push(n); sets.push(`display_name=$${vals.length}`);
  }
  if (req.body.username !== undefined && String(req.body.username).trim().toLowerCase() !== me.username) {
    const u = validUsername(req.body.username);
    if (!u) return bad(res, 'آیدی باید با حرف انگلیسی شروع شود و ۳ تا ۲۰ کاراکتر (حرف، عدد یا _) باشد');
    const ex = await q('SELECT 1 FROM users WHERE username=$1 AND id<>$2', [u, me.id]);
    if (ex.rows[0]) return bad(res, 'این آیدی قبلاً گرفته شده است', 409);
    vals.push(u); sets.push(`username=$${vals.length}`);
  }
  if (req.body.password) {
    if (String(req.body.password).length < 6) return bad(res, 'رمز عبور حداقل ۶ کاراکتر باشد');
    vals.push(await bcrypt.hash(String(req.body.password), 10)); sets.push(`password_hash=$${vals.length}`);
  }
  if (me.needs_setup) sets.push('needs_setup=FALSE');
  if (!sets.length) return res.json({ user: publicUser(me, true) });
  vals.push(me.id);
  try {
    const { rows } = await q(`UPDATE users SET ${sets.join(',')} WHERE id=$${vals.length} RETURNING *`, vals);
    res.json({ user: publicUser(rows[0], true) });
  } catch (e) {
    if (e.code === '23505') return bad(res, 'این آیدی قبلاً گرفته شده است', 409);
    throw e;
  }
}));

router.get('/username/check', wrap(async (req, res) => {
  const u = validUsername(req.query.u);
  if (!u) return res.json({ ok: false, reason: 'فرمت آیدی درست نیست' });
  const ex = await q('SELECT 1 FROM users WHERE username=$1 AND id<>$2', [u, req.user.id]);
  res.json({ ok: !ex.rows[0], reason: ex.rows[0] ? 'قبلاً گرفته شده' : '' });
}));

router.get('/users/search', wrap(async (req, res) => {
  const s = String(req.query.q || '').trim().toLowerCase().replace(/^@/, '').replace(/[%_\\]/g, '');
  if (s.length < 2) return res.json({ users: [] });
  const { rows } = await q(
    `SELECT id,username,display_name FROM users
     WHERE username LIKE $1 AND id<>$2 AND needs_setup=FALSE AND is_blocked=FALSE
     ORDER BY username LIMIT 10`,
    [s + '%', req.user.id]
  );
  res.json({ users: rows });
}));

router.get('/users/:id', wrap(async (req, res) => {
  const id = intParam(req.params.id);
  if (!id) return bad(res, 'شناسه نامعتبر');
  const { rows } = await q('SELECT id,username,display_name FROM users WHERE id=$1 AND is_blocked=FALSE', [id]);
  if (!rows[0]) return bad(res, 'کاربر پیدا نشد', 404);
  res.json({ user: rows[0] });
}));

/* ================= chats list ================= */
router.get('/chats', wrap(async (req, res) => {
  const me = req.user.id;
  const groups = await q(
    `SELECT g.id,g.name,gm.role,
       (SELECT body FROM messages m WHERE m.group_id=g.id ORDER BY m.id DESC LIMIT 1) AS last_body,
       (SELECT created_at FROM messages m WHERE m.group_id=g.id ORDER BY m.id DESC LIMIT 1) AS last_at,
       (SELECT count(*) FROM group_members x WHERE x.group_id=g.id) AS members
     FROM groups g JOIN group_members gm ON gm.group_id=g.id AND gm.user_id=$1
     ORDER BY last_at DESC NULLS LAST, g.id DESC`,
    [me]
  );
  const dms = await q(
    `SELECT u.id,u.username,u.display_name,m.body AS last_body,m.created_at AS last_at
     FROM (
       SELECT DISTINCT ON (partner) partner,body,created_at FROM (
         SELECT CASE WHEN from_user_id=$1 THEN to_user_id ELSE from_user_id END AS partner,id,body,created_at
         FROM messages WHERE group_id IS NULL AND (from_user_id=$1 OR to_user_id=$1)
       ) x ORDER BY partner,id DESC
     ) m JOIN users u ON u.id=m.partner
     ORDER BY m.created_at DESC`,
    [me]
  );
  res.json({ groups: groups.rows, dms: dms.rows });
}));

/* ================= groups ================= */
router.post('/groups', wrap(async (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 50);
  if (!name) return bad(res, 'نام گروه را وارد کنید');
  const code = crypto.randomBytes(4).toString('hex').toUpperCase();
  const g = (await q('INSERT INTO groups(name,invite_code,created_by) VALUES($1,$2,$3) RETURNING *', [name, code, req.user.id])).rows[0];
  await q("INSERT INTO group_members(group_id,user_id,role) VALUES($1,$2,'treasurer')", [g.id, req.user.id]);
  await systemMsg(g.id, req.user.id, `🏠 گروه «${name}» ساخته شد. ${req.user.display_name} مادر خرج است.`);
  res.json({ group: { id: g.id, name: g.name } });
}));

router.post('/groups/join', wrap(async (req, res) => {
  const code = String(req.body.code || '').trim().toUpperCase();
  const g = (await q('SELECT id,name FROM groups WHERE invite_code=$1', [code])).rows[0];
  if (!g) return bad(res, 'کد دعوت معتبر نیست', 404);
  const r = await q(
    "INSERT INTO group_members(group_id,user_id,role) VALUES($1,$2,'member') ON CONFLICT DO NOTHING RETURNING 1",
    [g.id, req.user.id]
  );
  if (r.rows[0]) {
    await systemMsg(g.id, req.user.id, `👋 ${req.user.display_name} به گروه پیوست.`);
    emitToUsers(await memberIds(g.id), 'expense_update', { group_id: g.id });
  }
  res.json({ group: g });
}));

router.get('/groups/:id', wrap(async (req, res) => {
  const gid = intParam(req.params.id);
  const role = gid && (await roleOf(gid, req.user.id));
  if (!role) return bad(res, 'شما عضو این گروه نیستید', 403);
  const g = (await q('SELECT id,name,invite_code,created_by FROM groups WHERE id=$1', [gid])).rows[0];
  const members = (await q(
    `SELECT u.id,u.username,u.display_name,gm.role FROM group_members gm JOIN users u ON u.id=gm.user_id
     WHERE gm.group_id=$1 ORDER BY (gm.role='treasurer') DESC, u.display_name`,
    [gid]
  )).rows;
  res.json({ group: g, members, my_role: role });
}));

router.post('/groups/:id/members', wrap(async (req, res) => {
  const gid = intParam(req.params.id);
  if (!gid || (await roleOf(gid, req.user.id)) !== 'treasurer') return bad(res, 'فقط مادر خرج می‌تواند عضو اضافه کند', 403);
  const uname = String(req.body.username || '').trim().toLowerCase().replace(/^@/, '');
  const u = (await q('SELECT id,display_name FROM users WHERE username=$1 AND is_blocked=FALSE', [uname])).rows[0];
  if (!u) return bad(res, 'کاربری با این آیدی پیدا نشد', 404);
  const r = await q(
    "INSERT INTO group_members(group_id,user_id,role) VALUES($1,$2,'member') ON CONFLICT DO NOTHING RETURNING 1",
    [gid, u.id]
  );
  if (!r.rows[0]) return bad(res, 'این کاربر قبلاً عضو است', 409);
  const g = (await q('SELECT name FROM groups WHERE id=$1', [gid])).rows[0];
  await systemMsg(gid, req.user.id, `👋 ${u.display_name} به گروه اضافه شد.`);
  await notifyUser(u.id, `شما به گروه «${g.name}» اضافه شدید.`, { groupId: gid });
  emitToUsers(await memberIds(gid), 'expense_update', { group_id: gid });
  res.json({ ok: true });
}));

/* ================= messages ================= */
const MSG_SELECT = `SELECT m.id,m.group_id,m.from_user_id,m.to_user_id,m.body,m.kind,m.created_at,u.username,u.display_name
  FROM messages m JOIN users u ON u.id=m.from_user_id`;
const cleanBody = (b) => String(b || '').trim().slice(0, 2000);

router.get('/groups/:id/messages', wrap(async (req, res) => {
  const gid = intParam(req.params.id);
  if (!gid || !(await roleOf(gid, req.user.id))) return bad(res, 'شما عضو این گروه نیستید', 403);
  const before = intParam(req.query.before);
  const { rows } = await q(
    `${MSG_SELECT} WHERE m.group_id=$1 AND ($2::int IS NULL OR m.id<$2) ORDER BY m.id DESC LIMIT 60`,
    [gid, before]
  );
  res.json({ messages: rows.reverse() });
}));

router.post('/groups/:id/messages', wrap(async (req, res) => {
  const gid = intParam(req.params.id);
  if (!gid || !(await roleOf(gid, req.user.id))) return bad(res, 'شما عضو این گروه نیستید', 403);
  const body = cleanBody(req.body.body);
  if (!body) return bad(res, 'پیام خالی است');
  res.json({ message: await insertMessage({ gid, from: req.user.id, body }) });
}));

router.get('/dm/:uid/messages', wrap(async (req, res) => {
  const peer = intParam(req.params.uid);
  if (!peer) return bad(res, 'شناسه نامعتبر');
  const before = intParam(req.query.before);
  const { rows } = await q(
    `${MSG_SELECT} WHERE m.group_id IS NULL
       AND ((m.from_user_id=$1 AND m.to_user_id=$2) OR (m.from_user_id=$2 AND m.to_user_id=$1))
       AND ($3::int IS NULL OR m.id<$3) ORDER BY m.id DESC LIMIT 60`,
    [req.user.id, peer, before]
  );
  res.json({ messages: rows.reverse() });
}));

router.post('/dm/:uid/messages', wrap(async (req, res) => {
  const peer = intParam(req.params.uid);
  if (!peer || peer === req.user.id) return bad(res, 'گیرنده نامعتبر است');
  const u = (await q('SELECT id FROM users WHERE id=$1 AND is_blocked=FALSE', [peer])).rows[0];
  if (!u) return bad(res, 'کاربر پیدا نشد', 404);
  const body = cleanBody(req.body.body);
  if (!body) return bad(res, 'پیام خالی است');
  res.json({ message: await insertMessage({ from: req.user.id, to: peer, body }) });
}));

/* ================= expenses ================= */
router.get('/groups/:id/expenses', wrap(async (req, res) => {
  const gid = intParam(req.params.id);
  if (!gid || !(await roleOf(gid, req.user.id))) return bad(res, 'شما عضو این گروه نیستید', 403);
  const { rows } = await q(
    `SELECT e.id,e.title,e.note,e.total,e.created_by,e.created_at,
       (SELECT json_agg(json_build_object('id',s.id,'user_id',s.user_id,'amount',s.amount,'status',s.status,
          'pay_note',s.pay_note,'paid_at',s.paid_at,'username',u.username,'display_name',u.display_name) ORDER BY s.id)
        FROM expense_shares s JOIN users u ON u.id=s.user_id WHERE s.expense_id=e.id) AS shares
     FROM expenses e WHERE e.group_id=$1 ORDER BY e.id DESC LIMIT 100`,
    [gid]
  );
  res.json({ expenses: rows.map((e) => ({ ...e, shares: e.shares || [] })) });
}));

router.post('/groups/:id/expenses', wrap(async (req, res) => {
  const gid = intParam(req.params.id);
  if (!gid || (await roleOf(gid, req.user.id)) !== 'treasurer') return bad(res, 'فقط مادر خرج می‌تواند هزینه ثبت کند', 403);
  const title = String(req.body.title || '').trim().slice(0, 100);
  const note = String(req.body.note || '').trim().slice(0, 300) || null;
  const total = Math.round(Number(req.body.total));
  const parts = Array.isArray(req.body.participants) ? req.body.participants : [];
  if (!title || !(total > 0) || !parts.length) return bad(res, 'عنوان، مبلغ و شرکت‌کنندگان را وارد کنید');

  const ids = await memberIds(gid);
  const seen = new Set();
  let sum = 0;
  const clean = [];
  for (const p of parts) {
    const uid = +p.user_id;
    const amount = Math.round(Number(p.amount));
    if (!ids.includes(uid) || seen.has(uid) || !(amount > 0)) return bad(res, 'اطلاعات شرکت‌کنندگان نامعتبر است');
    seen.add(uid); sum += amount; clean.push({ uid, amount });
  }
  if (sum !== total) return bad(res, 'مجموع سهم‌ها با مبلغ کل برابر نیست');

  const client = await pool.connect();
  let expense;
  try {
    await client.query('BEGIN');
    expense = (await client.query(
      'INSERT INTO expenses(group_id,title,note,total,created_by) VALUES($1,$2,$3,$4,$5) RETURNING *',
      [gid, title, note, total, req.user.id]
    )).rows[0];
    for (const p of clean) {
      const self = p.uid === req.user.id;
      await client.query(
        'INSERT INTO expense_shares(expense_id,user_id,amount,status,paid_at) VALUES($1,$2,$3,$4,$5)',
        [expense.id, p.uid, p.amount, self ? 'paid' : 'unpaid', self ? new Date() : null]
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  const g = (await q('SELECT name FROM groups WHERE id=$1', [gid])).rows[0];
  for (const p of clean) {
    if (p.uid !== req.user.id) {
      await notifyUser(p.uid, `هزینه جدید «${title}» در گروه «${g.name}»: سهم شما ${fa(p.amount)} تومان`, { groupId: gid });
    }
  }
  await systemMsg(gid, req.user.id, `📌 هزینه جدید «${title}» به مبلغ ${fa(total)} تومان ثبت شد.`);
  emitToUsers(ids, 'expense_update', { group_id: gid });
  res.json({ expense });
}));

router.delete('/expenses/:id', wrap(async (req, res) => {
  const id = intParam(req.params.id);
  const e = id && (await q('SELECT group_id,title FROM expenses WHERE id=$1', [id])).rows[0];
  if (!e) return bad(res, 'هزینه پیدا نشد', 404);
  if ((await roleOf(e.group_id, req.user.id)) !== 'treasurer') return bad(res, 'فقط مادر خرج می‌تواند حذف کند', 403);
  await q('DELETE FROM expenses WHERE id=$1', [id]);
  await systemMsg(e.group_id, req.user.id, `🗑 هزینه «${e.title}» حذف شد.`);
  emitToUsers(await memberIds(e.group_id), 'expense_update', { group_id: e.group_id });
  res.json({ ok: true });
}));

async function loadShare(id) {
  if (!id) return null;
  return (await q(
    `SELECT s.*,e.title,e.group_id,e.created_by,g.name AS group_name
     FROM expense_shares s JOIN expenses e ON e.id=s.expense_id JOIN groups g ON g.id=e.group_id WHERE s.id=$1`,
    [id]
  )).rows[0];
}
const touch = async (gid) => emitToUsers(await memberIds(gid), 'expense_update', { group_id: gid });

// member says "I paid"
router.post('/shares/:id/pay', wrap(async (req, res) => {
  const s = await loadShare(intParam(req.params.id));
  if (!s || s.user_id !== req.user.id) return bad(res, 'سهم پیدا نشد', 404);
  if (s.status !== 'unpaid') return bad(res, 'این سهم قبلاً ثبت شده است');
  const note = String(req.body.note || '').trim().slice(0, 200) || null;
  await q("UPDATE expense_shares SET status='pending', pay_note=$2 WHERE id=$1", [s.id, note]);
  if (s.created_by) {
    await notifyUser(s.created_by, `${req.user.display_name} پرداخت ${fa(s.amount)} تومان برای «${s.title}» را اعلام کرد. لطفاً تأیید کنید.`, { groupId: s.group_id });
  }
  await touch(s.group_id);
  res.json({ ok: true });
}));

// treasurer confirms
router.post('/shares/:id/confirm', wrap(async (req, res) => {
  const s = await loadShare(intParam(req.params.id));
  if (!s) return bad(res, 'سهم پیدا نشد', 404);
  if ((await roleOf(s.group_id, req.user.id)) !== 'treasurer') return bad(res, 'فقط مادر خرج می‌تواند تأیید کند', 403);
  if (s.status === 'paid') return bad(res, 'قبلاً تأیید شده است');
  await q("UPDATE expense_shares SET status='paid', paid_at=now() WHERE id=$1", [s.id]);
  const u = (await q('SELECT display_name FROM users WHERE id=$1', [s.user_id])).rows[0];
  await notifyUser(s.user_id, `✅ پرداخت شما برای «${s.title}» تأیید شد.`, { groupId: s.group_id });
  await systemMsg(s.group_id, req.user.id, `✅ پرداخت ${u.display_name} برای «${s.title}» تأیید شد.`);
  await touch(s.group_id);
  res.json({ ok: true });
}));

// treasurer rejects
router.post('/shares/:id/reject', wrap(async (req, res) => {
  const s = await loadShare(intParam(req.params.id));
  if (!s) return bad(res, 'سهم پیدا نشد', 404);
  if ((await roleOf(s.group_id, req.user.id)) !== 'treasurer') return bad(res, 'فقط مادر خرج می‌تواند رد کند', 403);
  if (s.status !== 'pending') return bad(res, 'این مورد در انتظار تأیید نیست');
  await q("UPDATE expense_shares SET status='unpaid', pay_note=NULL WHERE id=$1", [s.id]);
  await notifyUser(s.user_id, `❌ پرداخت شما برای «${s.title}» تأیید نشد. لطفاً با مادر خرج هماهنگ کنید.`, { groupId: s.group_id, sms: true });
  await touch(s.group_id);
  res.json({ ok: true });
}));

// remind unpaid members (in-app + SMS)
router.post('/groups/:id/remind', wrap(async (req, res) => {
  const gid = intParam(req.params.id);
  if (!gid || (await roleOf(gid, req.user.id)) !== 'treasurer') return bad(res, 'فقط مادر خرج می‌تواند یادآوری بفرستد', 403);
  const only = intParam(req.body.user_id);
  const g = (await q('SELECT name FROM groups WHERE id=$1', [gid])).rows[0];
  const { rows } = await q(
    `SELECT s.id,s.user_id,s.amount FROM expense_shares s JOIN expenses e ON e.id=s.expense_id
     WHERE e.group_id=$1 AND s.status='unpaid' AND ($2::int IS NULL OR s.user_id=$2)
       AND (s.last_reminded_at IS NULL OR s.last_reminded_at < now()-interval '30 minutes')`,
    [gid, only]
  );
  const byUser = new Map();
  for (const r of rows) {
    const o = byUser.get(r.user_id) || { n: 0, sum: 0, ids: [] };
    o.n++; o.sum += r.amount; o.ids.push(r.id);
    byUser.set(r.user_id, o);
  }
  for (const [uid, o] of byUser) {
    await notifyUser(
      uid,
      `یادآوری: ${fa(o.n)} مورد پرداخت نشده در گروه «${g.name}» به مجموع ${fa(o.sum)} تومان. لطفاً به ${req.user.display_name} پرداخت کنید.`,
      { groupId: gid, sms: true }
    );
    await q('UPDATE expense_shares SET last_reminded_at=now() WHERE id=ANY($1::int[])', [o.ids]);
  }
  res.json({ reminded: byUser.size });
}));

router.get('/debts', wrap(async (req, res) => {
  const { rows } = await q(
    `SELECT s.id,s.amount,s.status,e.title,e.group_id,g.name AS group_name,e.created_at,u.display_name AS treasurer_name
     FROM expense_shares s JOIN expenses e ON e.id=s.expense_id JOIN groups g ON g.id=e.group_id
     LEFT JOIN users u ON u.id=e.created_by
     WHERE s.user_id=$1 AND s.status<>'paid' ORDER BY e.id DESC`,
    [req.user.id]
  );
  res.json({ debts: rows });
}));

/* ================= notifications ================= */
router.get('/notifications', wrap(async (req, res) => {
  const { rows } = await q(
    'SELECT id,text,group_id,is_read,created_at FROM notifications WHERE user_id=$1 ORDER BY id DESC LIMIT 50',
    [req.user.id]
  );
  res.json({ notifications: rows });
}));

router.post('/notifications/read', wrap(async (req, res) => {
  await q('UPDATE notifications SET is_read=TRUE WHERE user_id=$1 AND is_read=FALSE', [req.user.id]);
  res.json({ ok: true });
}));

module.exports = router;
