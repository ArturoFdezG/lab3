// server.js — HTTPS + Express + socket.io (roles correctos + rooms)
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";
import express from "express";
import https from "https";
import { Server as IOServer } from "socket.io";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Credenciales HTTPS (autofirmado) ---
const key = fs.readFileSync(path.join(__dirname, "server.key"));
const cert = fs.readFileSync(path.join(__dirname, "server.cert"));

// --- App / estáticos ---
const app = express();
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "webrtc.html"));
});

app.get("/healthz", (_req, res) => res.status(200).send("ok"));

// --- HTTPS + socket.io ---
const PORT = process.env.PORT || 3000;
const server = https.createServer({ key, cert }, app);
const io = new IOServer(server);

const allowStunFallback = process.env.ALLOW_STUN_FALLBACK === "1";
const defaultStunUrls = allowStunFallback
  ? (process.env.STUN_URLS || "")
      .split(",")
      .map(url => url.trim())
      .filter(Boolean)
  : [];

const baseIceServers = defaultStunUrls.map(url => ({ urls: url }));

const turnUrls = (() => {
  const urlsFromEnv = (process.env.TURN_URLS || "")
    .split(",")
    .map(url => url.trim())
    .filter(Boolean);

  if (urlsFromEnv.length) return urlsFromEnv;

  const host = process.env.TURN_HOST?.trim();
  if (!host) return urlsFromEnv;

  const udpPort = process.env.TURN_PORT || "3478";
  const tlsPort = process.env.TURN_TLS_PORT || "5349";
  const transports = (process.env.TURN_TRANSPORTS || "udp,tcp")
    .split(",")
    .map(t => t.trim())
    .filter(Boolean);

  const computed = [];
  transports.forEach(transport => {
    computed.push(`turn:${host}:${udpPort}?transport=${transport}`);
  });

  if (process.env.TURN_DISABLE_TLS !== "1") {
    computed.push(`turns:${host}:${tlsPort}?transport=udp`);
  }

  if (process.env.TURN_INCLUDE_STUN === "1") {
    baseIceServers.push({ urls: `stun:${host}:${udpPort}` });
  }

  return computed;
})();

const turnSecret = process.env.TURN_STATIC_SECRET;
const turnUsername = process.env.TURN_USERNAME;
const turnPassword = process.env.TURN_PASSWORD;
const turnTtlSeconds = Number.parseInt(process.env.TURN_TTL || "3600", 10);
const turnUserPrefix = process.env.TURN_USER_PREFIX || "webrtc";

function normalizeTurnOnly(servers) {
  return servers
    .map(server => {
      const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
      const turnUrls = urls.filter(url => /^turns?:/i.test(url));
      if (turnUrls.length === 0) {
        return null;
      }

      return {
        ...server,
        urls: turnUrls.length === 1 ? turnUrls[0] : turnUrls,
      };
    })
    .filter(Boolean);
}

function buildIceServers() {
  const iceServers = [...baseIceServers];

  if (turnUrls.length === 0) {
    const normalizedEmpty = normalizeTurnOnly(iceServers);
    if (normalizedEmpty.length === 0) {
      console.warn("[ICE] No TURN servers configured; clients will fail to connect");
    }
    return normalizedEmpty;
  }

  if (turnSecret) {
    const timestamp = Math.floor(Date.now() / 1000) + Math.max(turnTtlSeconds, 1);
    const username = `${timestamp}:${turnUserPrefix}`;
    const credential = crypto.createHmac("sha1", turnSecret).update(username).digest("base64");
    iceServers.push({
      urls: turnUrls,
      username,
      credential,
    });
  } else if (turnUsername && turnPassword) {
    iceServers.push({
      urls: turnUrls,
      username: turnUsername,
      credential: turnPassword,
    });
  }

  const normalized = normalizeTurnOnly(iceServers);
  if (normalized.length === 0) {
    console.warn("[ICE] TURN credentials missing; filtered configuration is empty");
  }
  return normalized;
}

app.get("/ice-config", (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({ iceServers: buildIceServers() });
});

// Helpers
function getRoomSize(room) {
  return io.sockets.adapter.rooms.get(room)?.size || 0;
}

// Señalización mínima con asignación de rol estable
io.on("connection", (socket) => {
  let joinedRoom = null;

  socket.on("join", (room) => {
    const r = String(room || "room-123");
    if (joinedRoom && joinedRoom !== r) {
      socket.leave(joinedRoom);
    }

    // Tamaño ANTES de unir para decidir rol
    const sizeBefore = getRoomSize(r);
    const role = sizeBefore === 0 ? "caller" : "callee";

    socket.join(r);
    joinedRoom = r;

    const sizeAfter = getRoomSize(r);

    // Solo al que entra → rol + participantes
    socket.emit("joined", { room: r, participants: sizeAfter, role });

    // A los demás → solo contador actualizado
    socket.to(r).emit("peer-joined", { room: r, participants: sizeAfter });
  });

  // Reenvío transparente de señalización (offer/answer/candidate/bye)
  socket.on("signal", ({ room, payload }) => {
    const r = String(room || joinedRoom || "");
    if (!r) return;
    socket.to(r).emit("signal", payload);
  });

  // Dejar sala explícitamente (opcional)
  socket.on("leave", () => {
    if (!joinedRoom) return;
    const r = joinedRoom;
    socket.leave(r);
    joinedRoom = null;
    const size = getRoomSize(r);
    socket.to(r).emit("peer-left", { room: r, participants: size });
  });

  socket.on("disconnect", () => {
    if (!joinedRoom) return;
    const r = joinedRoom;
    joinedRoom = null;
    const size = getRoomSize(r);
    socket.to(r).emit("peer-left", { room: r, participants: size });
  });
});

server.listen(PORT, () => {
  console.log(`HTTPS WebRTC server on https://0.0.0.0:${PORT}`);
  console.log(`Sirviendo /public y socket.io en el mismo origen`);
});
