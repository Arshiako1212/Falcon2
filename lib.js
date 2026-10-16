const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { pool } = require('./db');

const SECRET =
  process.env.JWT_SECRET ||
  (console.warn('[auth] JWT_SECRET not set; using a random one (sessions reset on restart)'),
  crypto.randomBytes(32).toString('hex'));

/* ---------- realtime ---------- */
let io = null;
const setIO = (i) => { io = i; };
function emitToUsers(ids, event, payload) {
  if (!io) return;
  for (const id of new Set(ids)) io.to('user:' + id).emit(event, payload);
}

/* ---------- helpers ---------- */
function toEn(s) {
  return String(s || '')
    .replace(/[۰-۹]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d))
    .replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d));
}

const RESERVED = new Set(['admin', 'root', 'support', 'system', 'telegram', 'api']);
function validUsername(u) {
  u = String(u || '').trim().toLowerCase();
  if (!/^[a-z][a-z0-9_]{2,19}$/.test(u)) return null;
  if (RESERVED.has(u)) return null;
  return u;
}

function publicUser(u, self = false) {
  const o = { id: u.id, username: u.username, display_name: u.display_name };
  if (self) o.needs_setup = !!u.needs_setup;
  return o;
}

/* ---------- notifications ---------- */
async function notifyUser(userId, text, { groupId = null } = {}) {
  const { rows } = await pool.query(
    'INSERT INTO notifications(user_id,text,group_id) VALUES($1,$2,$3) RETURNING id,text,group_id,is_read,created_at',
    [userId, text, groupId]
  );
  emitToUsers([userId], 'notification', rows[0]);
  return rows[0];
}

/* ---------- auth ---------- */
const signToken = (payload, exp = '30d') => jwt.sign(payload, SECRET, { expiresIn: exp });

async function authRequired(req, res, next) {
  const h = req.headers.authorization || '';
  const t = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!t) return res.status(401).json({ error: 'ابتدا وارد شوید' });
  try {
    const p = jwt.verify(t, SECRET);
    if (!p.uid) throw new Error('bad token');
    const { rows } = await pool.query(
      'SELECT id,username,display_name,needs_setup,is_blocked FROM users WHERE id=$1',
      [p.uid]
    );
    const u = rows[0];
    if (!u) throw new Error('no user');
    if (u.is_blocked) return res.status(403).json({ error: 'حساب شما مسدود شده است' });
    req.user = u;
    pool.query('UPDATE users SET last_seen=now() WHERE id=$1', [u.id]).catch(() => {});
    next();
  } catch (e) {
    res.status(401).json({ error: 'نشست نامعتبر است، دوباره وارد شوید' });
  }
}

function adminRequired(req, res, next) {
  const h = req.headers.authorization || '';
  const t = h.startsWith('Bearer ') ? h.slice(7) : null;
  try {
    const p = jwt.verify(t, SECRET);
    if (p.role !== 'admin') throw new Error('not admin');
    next();
  } catch (e) {
    res.status(401).json({ error: 'دسترسی ادمین لازم است' });
  }
}

function verifyToken(t) {
  return jwt.verify(t, SECRET);
}

module.exports = {
  SECRET, setIO, emitToUsers, toEn, validUsername, publicUser,
  notifyUser, signToken, verifyToken, authRequired, adminRequired,
};
