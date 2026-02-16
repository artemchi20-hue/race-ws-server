import http from "http";
import { WebSocketServer } from "ws";

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
    return;
  }
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("ws server");
});

const wss = new WebSocketServer({ server });

const rooms = new Map();
const ROOM_TTL_MS = 30 * 60 * 1000;

function nowMs() { return Date.now(); }
function safeSend(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}
function cleanupRooms() {
  const t = nowMs();
  for (const [roomId, r] of rooms.entries()) {
    const hostAlive  = r.host  && r.host.readyState  === 1;
    const guestAlive = r.guest && r.guest.readyState === 1;
    if (!hostAlive && !guestAlive && (t - r.createdAt > ROOM_TTL_MS)) rooms.delete(roomId);
  }
}
setInterval(cleanupRooms, 60_000);

function otherPeer(room, ws) {
  return ws === room.host ? room.guest : room.host;
}

wss.on("connection", (ws) => {
  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.t === "join") {
      const roomId = String(msg.room || "").slice(0, 64);
      if (!roomId) return;

      let room = rooms.get(roomId);
      if (!room) {
        room = { host: null, guest: null, createdAt: nowMs(), levelId: null };
        rooms.set(roomId, room);
      }

      if (!room.host || room.host.readyState !== 1) {
        room.host = ws; ws._role = "host";
      } else if (!room.guest || room.guest.readyState !== 1) {
        room.guest = ws; ws._role = "guest";
      } else {
        safeSend(ws, { t: "full" });
        ws.close();
        return;
      }

      ws._roomId = roomId;
      safeSend(ws, { t: "joined", role: ws._role });

      if (room.levelId) safeSend(ws, { t: "level", id: room.levelId });

      const ready = !!(room.host && room.host.readyState === 1) && !!(room.guest && room.guest.readyState === 1);
      if (ready) {
        safeSend(room.host,  { t: "ready" });
        safeSend(room.guest, { t: "ready" });
      }
      return;
    }

    const roomId = ws._roomId;
    const room = roomId ? rooms.get(roomId) : null;
    if (!room) return;

    if (msg.t === "state") {
      const peer = otherPeer(room, ws);
      safeSend(peer, { ...msg, serverTime: nowMs() });
      return;
    }

    if (msg.t === "start" && ws._role === "host") {
      const peer = otherPeer(room, ws);
      if (!peer) return;
      const startAt = nowMs() + 700;
      safeSend(room.host,  { t: "startAt", startAt });
      safeSend(room.guest, { t: "startAt", startAt });
      return;
    }

    if (msg.t === "setLevel" && ws._role === "host") {
      const id = String(msg.id || "").slice(0, 64);
      room.levelId = id;
      safeSend(room.host,  { t: "level", id });
      safeSend(room.guest, { t: "level", id });
      return;
    }
  });

  ws.on("close", () => {
    const roomId = ws._roomId;
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;

    if (room.host === ws) room.host = null;
    if (room.guest === ws) room.guest = null;

    const peer = room.host || room.guest;
    safeSend(peer, { t: "peerLeft" });
  });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log("listening on", PORT));
