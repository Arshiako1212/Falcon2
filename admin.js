const router = require('express').Router();
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { pool } = require('./db');
const { signToken, adminRequired } = require('./lib');

const q = (t, p) => pool.query(t, p);
const wrap = (fn) => (req, res) =>
  fn(req, res).catch((e) => {
    console.error(e);
    res.status(500).json({ error: 'خطای سرور' });
  });
const safeEq = (a, b) => {
  const A = Buffer.from(String(a)), B = Buffer.from(String(b));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
};
const intParam = (v) => (Number.isInteger(+v) && +v > 0 ? +v : null);

router.post(
  '/login',
  rateLimit({ windowMs: 15 * 60 * 1000, max: 10, message: { error: 'تلاش بیش از حد، بعداً امتحان کنید' } }),
  (req, res) => {
    const U = process.env.ADMIN_USERNAME, P = process.env.ADMIN_PASSWORD;
    if (!U || !P) return res.status(503).json({ error: 'ADMIN_USERNAME و ADMIN_PASSWORD در تنظیمات سرور ست نشده‌اند' });
    if (!safeEq(req.body.username || '', U) || !safeEq(req.body.password || '', P)) {
      return res.status(401).json({ error: 'نام کاربری یا رمز اشتباه است' });
    }
    res.json({ token: signToken({ role: 'admin' }, '12h') });
  }
);

router.use(adminRequired);

router.get('/stats', wrap(async (req, res) => {
  const { rows } = await q(`SELECT
    (SELECT count(*) FROM users) AS users,
    (SELECT count(*) FROM users WHERE last_seen > now()-interval '24 hours') AS active_today,
    (SELECT count(*) FROM groups) AS groups,
    (SELECT count(*) FROM messages) AS messages,
    (SELECT count(*) FROM expenses) AS expenses,
    COALESCE((SELECT sum(amount) FROM expense_shares WHERE status='unpaid'),0)::bigint AS unpaid,
    COALESCE((SELECT sum(amount) FROM expense_shares WHERE status='pending'),0)::bigint AS pending,
    COALESCE((SELECT sum(amount) FROM expense_shares WHERE status='paid'),0)::bigint AS paid`);
  const r = rows[0];
  for (const k of ['users', 'active_today', 'groups', 'messages', 'expenses']) r[k] = +r[k];
  res.json(r);
}));

router.get('/users', wrap(async (req, res) => {
  const { rows } = await q(`
    SELECT u.id,u.username,u.display_name,u.phone,u.is_blocked,u.last_seen,u.created_at,
      (SELECT count(*) FROM group_members gm WHERE gm.user_id=u.id)::int AS groups,
      (SELECT count(*) FROM messages m WHERE m.from_user_id=u.id)::int AS messages,
      COALESCE((SELECT sum(amount) FROM expense_shares s WHERE s.user_id=u.id AND s.status<>'paid'),0)::bigint AS owed,
      COALESCE((SELECT sum(amount) FROM expense_shares s WHERE s.user_id=u.id AND s.status='paid'),0)::bigint AS paid
    FROM users u ORDER BY u.id DESC`);
  res.json({ users: rows });
}));

const MSG_SQL = `SELECT m.id,m.group_id,g.name AS group_name,m.from_user_id,fu.username AS from_username,fu.display_name AS from_name,
    m.to_user_id,tu.username AS to_username,tu.display_name AS to_name,m.body,m.kind,m.created_at
  FROM messages m JOIN users fu ON fu.id=m.from_user_id
  LEFT JOIN users tu ON tu.id=m.to_user_id LEFT JOIN groups g ON g.id=m.group_id`;

router.get('/users/:id', wrap(async (req, res) => {
  const id = intParam(req.params.id);
  const u = id && (await q('SELECT id,username,display_name,phone,is_blocked,last_seen,created_at FROM users WHERE id=$1', [id])).rows[0];
  if (!u) return res.status(404).json({ error: 'کاربر پیدا نشد' });
  const groups = (await q(
    `SELECT g.id,g.name,gm.role FROM group_members gm JOIN groups g ON g.id=gm.group_id WHERE gm.user_id=$1`, [id])).rows;
  const shares = (await q(
    `SELECT s.id,s.amount,s.status,s.pay_note,s.paid_at,e.title,e.created_at,g.name AS group_name
     FROM expense_shares s JOIN expenses e ON e.id=s.expense_id JOIN groups g ON g.id=e.group_id
     WHERE s.user_id=$1 ORDER BY s.id DESC LIMIT 100`, [id])).rows;
  const messages = (await q(
    `${MSG_SQL} WHERE (m.from_user_id=$1 OR m.to_user_id=$1) AND m.kind='text' ORDER BY m.id DESC LIMIT 200`, [id])).rows;
  res.json({ user: u, groups, shares, messages });
}));

router.post('/users/:id/block', wrap(async (req, res) => {
  const id = intParam(req.params.id);
  if (!id) return res.status(400).json({ error: 'شناسه نامعتبر' });
  const { rows } = await q('UPDATE users SET is_blocked=NOT is_blocked WHERE id=$1 RETURNING is_blocked', [id]);
  res.json({ is_blocked: rows[0]?.is_blocked });
}));

router.get('/groups', wrap(async (req, res) => {
  const { rows } = await q(`
    SELECT g.id,g.name,g.invite_code,g.created_at,
      (SELECT u.display_name FROM group_members gm JOIN users u ON u.id=gm.user_id WHERE gm.group_id=g.id AND gm.role='treasurer' LIMIT 1) AS treasurer,
      (SELECT count(*) FROM group_members gm WHERE gm.group_id=g.id)::int AS members,
      (SELECT count(*) FROM expenses e WHERE e.group_id=g.id)::int AS expenses,
      (SELECT count(*) FROM messages m WHERE m.group_id=g.id)::int AS messages,
      COALESCE((SELECT sum(s.amount) FROM expense_shares s JOIN expenses e ON e.id=s.expense_id WHERE e.group_id=g.id AND s.status<>'paid'),0)::bigint AS owed
    FROM groups g ORDER BY g.id DESC`);
  res.json({ groups: rows });
}));

router.get('/groups/:id', wrap(async (req, res) => {
  const id = intParam(req.params.id);
  const g = id && (await q('SELECT id,name,invite_code,created_at FROM groups WHERE id=$1', [id])).rows[0];
  if (!g) return res.status(404).json({ error: 'گروه پیدا نشد' });
  const members = (await q(
    `SELECT u.id,u.username,u.display_name,gm.role,
       COALESCE((SELECT sum(s.amount) FROM expense_shares s JOIN expenses e ON e.id=s.expense_id
         WHERE e.group_id=$1 AND s.user_id=u.id AND s.status<>'paid'),0)::bigint AS owed
     FROM group_members gm JOIN users u ON u.id=gm.user_id WHERE gm.group_id=$1`, [id])).rows;
  const expenses = (await q(
    `SELECT e.id,e.title,e.total,e.created_at,
       (SELECT json_agg(json_build_object('name',u.display_name,'amount',s.amount,'status',s.status) ORDER BY s.id)
        FROM expense_shares s JOIN users u ON u.id=s.user_id WHERE s.expense_id=e.id) AS shares
     FROM expenses e WHERE e.group_id=$1 ORDER BY e.id DESC`, [id])).rows;
  const messages = (await q(`${MSG_SQL} WHERE m.group_id=$1 ORDER BY m.id DESC LIMIT 200`, [id])).rows;
  res.json({ group: g, members, expenses, messages });
}));

router.get('/messages', wrap(async (req, res) => {
  const type = ['dm', 'group'].includes(req.query.type) ? req.query.type : 'all';
  const text = String(req.query.text || '').trim().replace(/[%_\\]/g, '');
  const where = ["m.kind='text'"];
  const vals = [];
  if (type === 'dm') where.push('m.group_id IS NULL');
  if (type === 'group') where.push('m.group_id IS NOT NULL');
  if (text) { vals.push('%' + text + '%'); where.push(`m.body ILIKE $${vals.length}`); }
  const { rows } = await q(`${MSG_SQL} WHERE ${where.join(' AND ')} ORDER BY m.id DESC LIMIT 300`, vals);
  res.json({ messages: rows });
}));

module.exports = router;
