// Automatic daily reminders: unpaid shares older than 24h -> in-app + SMS (once per user per run)
const { pool } = require('./db');
const { notifyUser } = require('./lib');

const fa = (n) => Number(n).toLocaleString('fa-IR');

function tehranHour() {
  return +new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Tehran', hour: 'numeric', hour12: false }).format(new Date()) % 24;
}

async function run() {
  const h = tehranHour();
  if (h < 9 || h >= 21) return; // no SMS at night
  const { rows } = await pool.query(
    `SELECT s.id,s.user_id,s.amount,g.name AS group_name
     FROM expense_shares s JOIN expenses e ON e.id=s.expense_id JOIN groups g ON g.id=e.group_id
     WHERE s.status='unpaid' AND e.created_at < now()-interval '24 hours'
       AND (s.last_reminded_at IS NULL OR s.last_reminded_at < now()-interval '24 hours')`
  );
  const byUser = new Map();
  for (const r of rows) {
    const o = byUser.get(r.user_id) || { n: 0, sum: 0, ids: [], groups: new Set() };
    o.n++; o.sum += r.amount; o.ids.push(r.id); o.groups.add(r.group_name);
    byUser.set(r.user_id, o);
  }
  for (const [uid, o] of byUser) {
    try {
      await notifyUser(
        uid,
        `یادآوری: ${fa(o.n)} پرداخت معوق به مجموع ${fa(o.sum)} تومان در گروه «${[...o.groups].join('، ')}» دارید.`,
        { sms: true }
      );
      await pool.query('UPDATE expense_shares SET last_reminded_at=now() WHERE id=ANY($1::int[])', [o.ids]);
    } catch (e) {
      console.error('[reminders]', e.message);
    }
  }
  if (byUser.size) console.log(`[reminders] sent ${byUser.size}`);
}

function start() {
  setInterval(() => run().catch((e) => console.error('[reminders]', e.message)), 60 * 60 * 1000);
  setTimeout(() => run().catch(() => {}), 30 * 1000);
}

module.exports = { start };
