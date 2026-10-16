const router = require('express').Router();
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { pool } = require('./db');
const { validUsername, publicUser, signToken } = require('./lib');

router.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 40,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'تعداد درخواست‌ها زیاد است، چند دقیقه دیگر تلاش کنید' },
  })
);

const wrap = (fn) => (req, res) =>
  fn(req, res).catch((e) => {
    console.error(e);
    res.status(500).json({ error: 'خطای سرور' });
  });
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });
const session = (u) => ({ token: signToken({ uid: u.id }), user: publicUser(u, true) });

/* ----- username / password ----- */
router.post('/register', wrap(async (req, res) => {
  const username = validUsername(req.body.username);
  const name = String(req.body.display_name || '').trim().slice(0, 40);
  const password = String(req.body.password || '');
  if (!username) return bad(res, 'آیدی باید با حرف انگلیسی شروع شود و ۳ تا ۲۰ کاراکتر (حرف، عدد یا _) باشد');
  if (!name) return bad(res, 'نام را وارد کنید');
  if (password.length < 6) return bad(res, 'رمز عبور حداقل ۶ کاراکتر باشد');

  const hash = await bcrypt.hash(password, 10);
  const r = await pool.query(
    `INSERT INTO users(username,display_name,password_hash) VALUES($1,$2,$3)
     ON CONFLICT (username) DO NOTHING RETURNING *`,
    [username, name, hash]
  );
  if (!r.rows[0]) return bad(res, 'این آیدی قبلاً گرفته شده است', 409);
  res.json(session(r.rows[0]));
}));

router.post('/login', wrap(async (req, res) => {
  const id = String(req.body.identifier || '').trim().toLowerCase().replace(/^@/, '');
  const password = String(req.body.password || '');
  if (!id || !password) return bad(res, 'آیدی و رمز عبور را وارد کنید');
  const { rows } = await pool.query('SELECT * FROM users WHERE username=$1', [id]);
  const u = rows[0];
  const ok = u && u.password_hash && (await bcrypt.compare(password, u.password_hash));
  if (!ok) return bad(res, 'آیدی یا رمز عبور اشتباه است', 401);
  if (u.is_blocked) return bad(res, 'حساب شما مسدود شده است', 403);
  res.json(session(u));
}));

module.exports = router;
