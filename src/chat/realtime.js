/**
 * Chat — WebSocket real-time layer.
 *
 * One WS endpoint: `/ws/chat`. Authentication reuses the existing signed
 * session cookie (the browser attaches it to the upgrade request
 * automatically), so there is no separate token flow to manage.
 *
 * Client → server:
 *   { type: 'subscribe',   channel: <id> }   watch a channel for new messages
 *   { type: 'unsubscribe', channel: <id> }
 *   { type: 'typing', channel, active? }     keystroke heartbeat (throttled by client)
 *   { type: 'read',   channel, ts? }         I read up to ts → persist + broadcast
 *   { type: 'ping' }                          keepalive
 *
 * Server → client:
 *   { type: 'ready', uid }                    handshake done
 *   { type: 'message', message }              new message in a watched channel
 *   { type: 'typing', channel, uid, name, active }   someone is/typing (sender excluded)
 *   { type: 'read',   channel, uid, name, ts }       someone read up to ts
 *   { type: 'error', error, code }            bad frame / not a member
 *
 * Membership is re-checked on every broadcast, so leaving a channel stops
 * delivery immediately even if the socket stays subscribed.
 */
const { WebSocketServer } = require('ws');
const { verifySession, SESSION_COOKIE } = require('../auth/session');
const { isMember, markRead, nameLookup } = require('./store');

function parseCookieHeader(header) {
  const out = {};
  const raw = String(header || '');
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/**
 * Attach the chat WS server to an existing HTTP server.
 * Returns { broadcast(channelId, payload), close() }.
 */
function attachChatRealtime(httpServer, { dataDir }) {
  const wss = new WebSocketServer({ server: httpServer, path: '/ws/chat', maxPayload: 64 * 1024 });

  /** channelId → Set<socket> of members currently watching it. */
  const rooms = new Map();

  wss.on('connection', (socket, req) => {
    // ---- authenticate from the upgrade request's cookies ----
    let uid = null;
    try {
      const cookies = parseCookieHeader(req.headers.cookie);
      uid = verifySession(dataDir, cookies[SESSION_COOKIE]);
    } catch { /* invalid cookie */ }
    if (!uid) {
      socket.send(JSON.stringify({ type: 'error', error: 'Please sign in to continue.', code: 'unauthenticated' }));
      socket.close(4401, 'unauthenticated');
      return;
    }

    /** Channels this socket has subscribed to. */
    const subs = new Set();
    socket.isAlive = true;
    socket.on('pong', () => { socket.isAlive = true; });
    const displayName = nameLookup(dataDir)(uid);

    const send = (payload) => {
      if (socket.readyState === 1) socket.send(JSON.stringify(payload));
    };
    const dropFromRooms = () => {
      for (const id of subs) {
        const room = rooms.get(id);
        if (room) {
          room.delete(socket);
          if (room.size === 0) rooms.delete(id);
        }
      }
      subs.clear();
    };

    send({ type: 'ready', uid });

    socket.on('message', (raw) => {
      let frame;
      try {
        frame = JSON.parse(String(raw));
      } catch {
        send({ type: 'error', error: 'Invalid frame.', code: 'validation' });
        return;
      }
      const type = String(frame && frame.type || '');
      const channelId = Number(frame && frame.channel);

      if (type === 'ping') {
        send({ type: 'pong', ts: Date.now() });
        return;
      }

      if (type === 'typing') {
        // Only while subscribed AND still a member; never echo to the sender.
        if (!subs.has(channelId) || !isMember(dataDir, channelId, uid)) return;
        broadcast(channelId, {
          type: 'typing',
          channel: channelId,
          uid,
          name: displayName,
          active: frame.active !== false,
        }, socket);
        return;
      }

      if (type === 'read') {
        if (!subs.has(channelId) || !isMember(dataDir, channelId, uid)) return;
        const ts = Number(frame.ts) || Date.now();
        try {
          markRead(dataDir, uid, channelId, ts);
        } catch { /* channel vanished mid-flight */ return; }
        // Everyone (including the reader) learns the new read watermark —
        // the sender turns it into a ✓ seen tick.
        broadcast(channelId, { type: 'read', channel: channelId, uid, name: displayName, ts });
        return;
      }

      if (type === 'subscribe' || type === 'unsubscribe') {
        if (!Number.isInteger(channelId) || channelId <= 0) {
          send({ type: 'error', error: 'Unknown channel.', code: 'validation' });
          return;
        }
        if (type === 'subscribe') {
          // Re-check membership at subscribe time AND on every broadcast.
          if (!isMember(dataDir, channelId, uid)) {
            send({ type: 'error', error: 'Join this channel to receive messages.', code: 'permission', channel: channelId });
            return;
          }
          if (!rooms.has(channelId)) rooms.set(channelId, new Set());
          rooms.get(channelId).add(socket);
          subs.add(channelId);
          send({ type: 'subscribed', channel: channelId });
        } else {
          const room = rooms.get(channelId);
          if (room) {
            room.delete(socket);
            if (room.size === 0) rooms.delete(channelId);
          }
          subs.delete(channelId);
          send({ type: 'unsubscribed', channel: channelId });
        }
        return;
      }

      send({ type: 'error', error: 'Unknown frame type.', code: 'validation' });
    });

    socket.on('close', dropFromRooms);
    socket.on('error', dropFromRooms);
  });

  // Drop dead sockets (Render's proxy can leave half-open connections).
  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      if (socket.isAlive === false) { socket.terminate(); continue; }
      socket.isAlive = false;
      try { socket.ping(); } catch { /* closing */ }
    }
  }, 30000);
  wss.on('close', () => clearInterval(heartbeat));

  /** Deliver a payload to every live subscriber of a channel (minus `exclude`). */
  function broadcast(channelId, payload, exclude = null) {
    const room = rooms.get(Number(channelId));
    if (!room || room.size === 0) return;
    const data = JSON.stringify(payload);
    for (const socket of room) {
      if (socket === exclude) continue;
      if (socket.readyState === 1) {
        try { socket.send(data); } catch { /* socket died mid-send */ }
      }
    }
  }

  function close() {
    clearInterval(heartbeat);
    for (const socket of wss.clients) socket.terminate();
    wss.close();
  }

  return { broadcast, close, wss };
}

module.exports = { attachChatRealtime };
