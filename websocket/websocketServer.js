// serversocket.js
const { WebSocketServer } = require('ws');
const url = require('url');

const rooms = new Map(); // deviceId -> Set<ws>

function sendJSON(ws, obj) {
  try { ws.send(JSON.stringify(obj)); } catch {}
}

function sendToDevice(deviceId, payload) {
  const set = rooms.get(deviceId);
  if (!set || set.size === 0) {
    console.log(`[WS][TX] server -> ${deviceId} FAILED (offline)`);
    return false;
  }
  // Log nội dung gửi và nguồn (nếu có)
  const from = (payload && payload.from) ? ` (from ${payload.from})` : '';
  console.log(`[WS][TX] server -> ${deviceId}${from} | ${JSON.stringify(payload)}`);
  set.forEach(ws => sendJSON(ws, payload));
  return true;
}

function initServerSocket(httpServer) {
  const wss = new WebSocketServer({ noServer: true });

  wss.on('connection', (ws, req) => {
    const { pathname, query } = url.parse(req.url, true);
    const deviceId = (pathname || '').split('/').filter(Boolean)[1] || query.deviceId;
    if (!deviceId) {
      sendJSON(ws, { status: 'error', message: 'Missing deviceId' });
      return ws.close();
    }

    // Lưu IP cho log
    ws.ip = req.socket?.remoteAddress || 'unknown-ip';

    if (!rooms.has(deviceId)) rooms.set(deviceId, new Set());
    rooms.get(deviceId).add(ws);
    ws.deviceId = deviceId;

    console.log(`[WS] Device ${deviceId} connected from ${ws.ip}`);
    sendJSON(ws, { status: 'message', action: 'connected', deviceId });

    // Lắng nghe & LOG ai gửi + nội dung
    ws.on('message', (raw) => {
      const text = raw.toString();
      console.log(`[WS][RX] ${ws.deviceId}@${ws.ip} -> server | ${text}`);
      try {
        const obj = JSON.parse(text);
        const to = obj.to || obj.deviceId || '-';
        const action = obj.action || obj.cmd || obj.status || '-';
        console.log(`[WS][RX] meta from=${ws.deviceId} to=${to} action=${action}`);
      } catch {
        // không phải JSON thì bỏ qua meta
      }
    });

    ws.on('close', () => {
      const set = rooms.get(deviceId);
      if (set) {
        set.delete(ws);
        if (set.size === 0) rooms.delete(deviceId);
      }
      console.log(`[WS] Device ${deviceId} disconnected`);
    });
  });

  httpServer.on('upgrade', (req, socket, head) => {
    const { pathname } = url.parse(req.url);
    if (!pathname?.startsWith('/ws')) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  console.log(`[WS] WebSocket server ready`);
}

module.exports = {
  initServerSocket,
  sendToDevice
};
