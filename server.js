// server.js — HTTPS + Express + socket.io (roles correctos + rooms)
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
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
