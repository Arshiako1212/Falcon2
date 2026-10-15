const router = require('express').Router();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { pool } = require('./db');
const { SECRET, normPhone, validUsername, publicUser, sendOtp, signToken } = require('./lib');

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
const hashCode = (phone, code) => crypto.createHmac('sha256', SECRET).update(phone + ':' + code).digest('hex');
const session = (u) => ({ token: signToken({ uid: u.id }), user: publicUser(u, true) });

/* ----- OTP ----- */
router.post('/otp/request', wrap(async (req, res) => {
  const phone = normPhone(req.body.phone);
  if (!phone) return bad(res, 'شماره موبایل معتبر نیست (مثلاً 09123456789)');

  const old = await pool.query('SELECT created_at FROM otps WHERE phone=$1', [phone]);
  if (old.rows[0] && Date.now() - new Date(old.rows[0].created_at).getTime() < 60 * 1000) {
    return bad(res, 'لطفاً یک دقیقه صبر کنید و دوباره درخواست دهید', 429);
  }

  const blocked = await pool.query('SELECT is_blocked FROM users WHERE phone=$1', [phone]);
  if (blocked.rows[0]?.is_blocked) return bad(res, 'حساب شما مسدود شده است', 403);

  const code = String(crypto.randomInt(100000, 1000000));
  await pool.query(
    `INSERT INTO otps(phone,code_hash,expires_at,attempts,created_at)
     VALUES($1,$2,now()+interval '5 minutes',0,now())
     ON CONFLICT (phone) DO UPDATE SET code_hash=$2, expires_at=now()+interval '5 minutes', attempts=0, created_at=now()`,
    [phone, hashCode(phone, code)]
  );
  await sendOtp(phone, code);
  const out = { ok: true };
  if (process.env.ALLOW_DEV_OTP === 'true') out.devCode = code;
  res.json(out);
}));

router.post('/otp/verify', wrap(async (req, res) => {
  const phone = normPhone(req.body.phone);
  const code = String(req.body.code || '').replace(/\D/g, '').slice(0, 6);
  if (!phone || code.length !== 6) return bad(res, 'کد ۶ رقمی را وارد کنید');

  const { rows } = await pool.query('SELECT * FROM otps WHERE phone=$1', [phone]);
  const o = rows[0];
  if (!o || new Date(o.expires_at) < new Date()) return bad(res, 'کد منقضی شده است، دوباره درخواست دهید');
  if (o.attempts >= 5) return bad(res, 'تعداد تلاش بیش از حد مجاز است، کد جدید بگیرید', 429);

  const a = Buffer.from(hashCode(phone, code));
  const b = Buffer.from(o.code_hash);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    await pool.query('UPDATE otps SET attempts=attempts+1 WHERE phone=$1', [phone]);
    return bad(res, 'کد اشتباه است');
  }
  await pool.query('DELETE FROM otps WHERE phone=$1', [phone]);

  let u = (await pool.query('SELECT * FROM users WHERE phone=$1', [phone])).rows[0];
  if (u?.is_blocked) return bad(res, 'حساب شما مسدود شده است', 403);
  if (!u) {
    for (let i = 0; i < 8 && !u; i++) {
      const uname = 'user' + crypto.randomInt(100000, 1000000);
      const r = await pool.query(
        `INSERT INTO users(username,display_name,phone,needs_setup) VALUES($1,$2,$3,TRUE)
         ON CONFLICT DO NOTHING RETURNING *`,
        [uname, 'کاربر جدید', phone]
      );
      u = r.rows[0];
    }
    if (!u) return bad(res, 'ساخت حساب ناموفق بود، دوباره تلاش کنید', 500);
  }
  res.json(session(u));
}));

/* ----- username / password (no phone needed) ----- */
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
  const phone = normPhone(id);
  const { rows } = await pool.query(
    'SELECT * FROM users WHERE username=$1 OR ($2::text IS NOT NULL AND phone=$2)',
    [id, phone]
  );
  const u = rows[0];
  const ok = u && u.password_hash && (await bcrypt.compare(password, u.password_hash));
  if (!ok) return bad(res, 'آیدی یا رمز عبور اشتباه است', 401);
  if (u.is_blocked) return bad(res, 'حساب شما مسدود شده است', 403);
  res.json(session(u));
}));

module.exports = router;
