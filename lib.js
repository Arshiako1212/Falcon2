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

function normPhone(p) {
  let s = toEn(p).replace(/[\s\-()]/g, '');
  if (s.startsWith('+98')) s = '0' + s.slice(3);
  else if (s.startsWith('0098')) s = '0' + s.slice(4);
  else if (/^98\d{10}$/.test(s)) s = '0' + s.slice(2);
  else if (/^9\d{9}$/.test(s)) s = '0' + s;
  return /^09\d{9}$/.test(s) ? s : null;
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
  if (self) { o.phone = u.phone || null; o.needs_setup = !!u.needs_setup; }
  return o;
}

/* ---------- SMS (Kavenegar) ---------- */
async function kavenegar(path, params) {
  const key = process.env.KAVENEGAR_API_KEY;
  try {
    const r = await fetch(`https://api.kavenegar.com/v1/${key}/${path}.json`, {
      method: 'POST',
      body: new URLSearchParams(params),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) console.error('[sms] failed', r.status, d);
    return r.ok;
  } catch (e) {
    console.error('[sms] error', e.message);
    return false;
  }
}

async function sendSms(phone, text) {
  if (!process.env.KAVENEGAR_API_KEY) {
    console.log(`[SMS-DEV] to ${phone}: ${text}`);
    return false;
  }
  const p = { receptor: phone, message: text };
  if (process.env.KAVENEGAR_SENDER) p.sender = process.env.KAVENEGAR_SENDER;
  return kavenegar('sms/send', p);
}

async function sendOtp(phone, code) {
  if (!process.env.KAVENEGAR_API_KEY) {
    console.log(`[SMS-DEV] OTP for ${phone}: ${code}`);
    return false;
  }
  if (process.env.KAVENEGAR_OTP_TEMPLATE) {
    return kavenegar('verify/lookup', {
      receptor: phone,
      token: code,
      template: process.env.KAVENEGAR_OTP_TEMPLATE,
    });
  }
  return sendSms(phone, `کد ورود شما: ${code}`);
}

/* ---------- notifications ---------- */
async function notifyUser(userId, text, { groupId = null, sms = false } = {}) {
  const { rows } = await pool.query(
    'INSERT INTO notifications(user_id,text,group_id) VALUES($1,$2,$3) RETURNING id,text,group_id,is_read,created_at',
    [userId, text, groupId]
  );
  emitToUsers([userId], 'notification', rows[0]);
  if (sms) {
    const u = await pool.query('SELECT phone FROM users WHERE id=$1', [userId]);
    if (u.rows[0]?.phone) await sendSms(u.rows[0].phone, text);
  }
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
      'SELECT id,username,display_name,phone,needs_setup,is_blocked FROM users WHERE id=$1',
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
  SECRET, setIO, emitToUsers, toEn, normPhone, validUsername, publicUser,
  sendSms, sendOtp, notifyUser, signToken, verifyToken, authRequired, adminRequired,
};
