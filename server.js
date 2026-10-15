const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const { init, pool } = require('./db');
const lib = require('./lib');

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '100kb' }));

app.get('/health', (req, res) => res.json({ ok: true }));
app.use('/api/auth', require('./auth'));
app.use('/api', lib.authRequired, require('./api'));

app.use('/admin/api', require('./admin'));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const io = new Server(server);
lib.setIO(io);

io.use(async (socket, next) => {
  try {
    const p = lib.verifyToken(socket.handshake.auth?.token);
    if (!p.uid) throw new Error('bad');
    const { rows } = await pool.query('SELECT id,is_blocked FROM users WHERE id=$1', [p.uid]);
    if (!rows[0] || rows[0].is_blocked) throw new Error('denied');
    socket.userId = rows[0].id;
    next();
  } catch (e) {
    next(new Error('unauthorized'));
  }
});
io.on('connection', (socket) => socket.join('user:' + socket.userId));
require('./calls').attach(io);

const PORT = process.env.PORT || 3000;
init()
  .then(() => {
    server.listen(PORT, '0.0.0.0', () => console.log('[server] listening on', PORT));
    require('./reminders').start();
  })
  .catch((e) => {
    console.error('[server] failed to start:', e.message);
    process.exit(1);
  });
