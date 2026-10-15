// WebRTC signaling for voice / video / screen-share calls (mesh topology).
// One call room per group, and one per pair of users for private chats.
const { pool } = require('./db');
const { emitToUsers } = require('./lib');

const MAX = Math.max(2, +process.env.MAX_CALL_PARTICIPANTS || 8);
const rooms = new Map(); // key -> { key, scope, id, members:[userId], parts: Map(socketId -> info) }

async function resolve(userId, scope, rawId) {
  const id = +rawId;
  if (!Number.isInteger(id) || id <= 0) return null;
  if (scope === 'group') {
    const { rows } = await pool.query('SELECT user_id FROM group_members WHERE group_id=$1', [id]);
    const members = rows.map((r) => r.user_id);
    return members.includes(userId) ? { key: 'g:' + id, scope, id, members } : null;
  }
  if (scope === 'dm') {
    if (id === userId) return null;
    const { rows } = await pool.query('SELECT 1 FROM users WHERE id=$1 AND is_blocked=FALSE', [id]);
    if (!rows[0]) return null;
    return { key: `d:${Math.min(id, userId)}:${Math.max(id, userId)}`, scope, id, members: [id, userId] };
  }
  return null;
}

// the id a given user uses to refer to this chat
const idFor = (room, uid) => (room.scope === 'group' ? room.id : room.members.find((m) => m !== uid));

function summary(room) {
  const users = new Map();
  if (room) for (const v of room.parts.values()) users.set(v.userId, v.name);
  return { count: users.size, users: [...users].map(([id, name]) => ({ id, name })) };
}

function announce(room) {
  const s = summary(room);
  for (const uid of room.members) {
    emitToUsers([uid], 'call:active', { scope: room.scope, id: idFor(room, uid), ...s });
  }
}

function attach(io) {
  function leave(socket) {
    const key = socket.callKey;
    if (!key) return;
    socket.callKey = null;
    socket.leave('call:' + key);
    const room = rooms.get(key);
    if (!room) return;
    room.parts.delete(socket.id);
    io.to('call:' + key).emit('call:peer-left', { sid: socket.id });
    if (!room.parts.size) rooms.delete(key);
    announce(room);
  }

  io.on('connection', (socket) => {
    socket.callKey = null;

    socket.on('call:info', async (p, cb) => {
      cb = typeof cb === 'function' ? cb : () => {};
      try {
        const meta = await resolve(socket.userId, p?.scope, p?.id);
        cb(meta ? summary(rooms.get(meta.key)) : { count: 0, users: [] });
      } catch (e) {
        cb({ count: 0, users: [] });
      }
    });

    socket.on('call:join', async (p, cb) => {
      cb = typeof cb === 'function' ? cb : () => {};
      try {
        if (socket.callKey) leave(socket);
        const meta = await resolve(socket.userId, p?.scope, p?.id);
        if (!meta) return cb({ error: 'دسترسی به این تماس ندارید' });

        let room = rooms.get(meta.key);
        if (!room) { room = { ...meta, parts: new Map() }; rooms.set(meta.key, room); }
        room.members = meta.members;
        if (room.parts.size >= MAX) return cb({ error: `ظرفیت تماس (${MAX} نفر) پر است` });
        for (const v of room.parts.values()) {
          if (v.userId === socket.userId) return cb({ error: 'شما در این تماس هستید (شاید در تب یا دستگاه دیگری)' });
        }

        const u = await pool.query('SELECT display_name FROM users WHERE id=$1', [socket.userId]);
        const info = { userId: socket.userId, name: u.rows[0]?.display_name || 'کاربر', mic: p.mic !== false, cam: !!p.cam, screen: false };
        const peers = [...room.parts].map(([sid, v]) => ({ sid, ...v }));
        const first = room.parts.size === 0;

        room.parts.set(socket.id, info);
        socket.join('call:' + room.key);
        socket.callKey = room.key;
        socket.to('call:' + room.key).emit('call:peer-joined', { sid: socket.id, ...info });
        cb({ peers, max: MAX });

        if (first && p.ring !== false) {
          for (const uid of room.members) {
            if (uid === socket.userId) continue;
            emitToUsers([uid], 'call:ring', {
              scope: room.scope, id: idFor(room, uid), from: { id: socket.userId, name: info.name }, video: !!p.cam,
            });
          }
        }
        announce(room);
      } catch (e) {
        console.error('[call] join', e.message);
        cb({ error: 'خطا در اتصال به تماس' });
      }
    });

    socket.on('call:signal', (p) => {
      const room = rooms.get(socket.callKey);
      if (!room || !p || !room.parts.has(socket.id) || !room.parts.has(p.to)) return;
      io.to(p.to).emit('call:signal', { from: socket.id, data: p.data });
    });

    socket.on('call:state', (p) => {
      const room = rooms.get(socket.callKey);
      const me = room?.parts.get(socket.id);
      if (!me || !p) return;
      me.mic = !!p.mic; me.cam = !!p.cam; me.screen = !!p.screen;
      socket.to('call:' + room.key).emit('call:state', { sid: socket.id, mic: me.mic, cam: me.cam, screen: me.screen });
    });

    socket.on('call:leave', () => leave(socket));
    socket.on('disconnect', () => leave(socket));
  });
}

module.exports = { attach };
