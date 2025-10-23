// public/webrtc.js
// Challenge 2.1 – WebRTC P2P (cliente) — HTTPS + socket.io (roles estables)

// ---------- Referencias UI ----------
const ui = {
  room: document.getElementById("room"),
  participants: document.getElementById("participants"),
  // botones
  btnJoin: document.getElementById("btnJoin"),
  btnLeave: document.getElementById("btnLeave"),
  btnStart: document.getElementById("btnStart"),
  btnCall: document.getElementById("btnCall"),
  btnAnswer: document.getElementById("btnAnswer"),
  btnHangup: document.getElementById("btnHangup"),
  btnToggleMic: document.getElementById("btnToggleMic"),
  btnToggleCam: document.getElementById("btnToggleCam"),
  btnShare: document.getElementById("btnShare"),
  // switches
  chkTrickle: document.getElementById("chkTrickle"),
  chkAudio: document.getElementById("chkAudio"),
  chkVideo: document.getElementById("chkVideo"),
  // vídeos
  localVideo: document.getElementById("local"),
  remoteVideo: document.getElementById("remote"),
  // badges/estado
  pcState: document.getElementById("pcState"),
  iceState: document.getElementById("iceState"),
  role: document.getElementById("role"),
  dtls: document.getElementById("dtls"),
  sctp: document.getElementById("sctp"),
  signaling: document.getElementById("signaling"),
  gather: document.getElementById("gather"),
  selectedPair: document.getElementById("selectedPair"),
  // depuración
  log: document.getElementById("log"),
  sdpLocal: document.getElementById("sdpLocal"),
  sdpRemote: document.getElementById("sdpRemote"),
};

// ---------- Estado ----------
const socket = io(); // inyectado por <script src="/socket.io/socket.io.js">
let room = null;
let isCaller = null; // <- AHORA se decide una sola vez cuando llega 'joined'

let pc = null;
let localStream = null;
let remoteStream = null;
let statsTimer = null;
let pendingRemoteOffer = null;
let screenTrack = null;

// Servidores ICE (configurable vía backend)
let rtcConfig = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};
let iceConfigPromise = null;

// ---------- Utilidades ----------
function log(...args) {
  console.log(...args);
  const line = args.map(a => (typeof a === "object" ? JSON.stringify(a, null, 2) : String(a))).join(" ");
  ui.log.textContent += line + "\n";
  ui.log.scrollTop = ui.log.scrollHeight;
}

async function ensureIceConfig() {
  if (!iceConfigPromise) {
    iceConfigPromise = (async () => {
      try {
        const res = await fetch("/ice-config", { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (data && Array.isArray(data.iceServers) && data.iceServers.length) {
          rtcConfig = { iceServers: data.iceServers };
          log("🔧 ICE servers actualizados", data.iceServers);
        } else {
          log("ℹ️ Config ICE vacía, se mantiene STUN público por defecto");
        }
      } catch (err) {
        log("⚠️ No se pudo obtener configuración ICE remota:", err.message || err);
      }
    })();
  }

  return iceConfigPromise;
}

// Solicita la configuración ICE en segundo plano al cargar la página
ensureIceConfig();

function setBadge(el, text, type = "warn") {
  el.textContent = text;
  const badge = el.closest(".badge") || el;
  badge.classList.remove("ok", "warn", "err");
  if (type === "ok") badge.classList.add("ok");
  else if (type === "err") badge.classList.add("err");
  else badge.classList.add("warn");
}

function updateParticipants(n) {
  ui.participants.textContent = `👥 ${n}`;
}

function setRoleLabelFromFlag() {
  const txt = isCaller === null ? "—" : (isCaller ? "caller" : "callee");
  ui.role.textContent = txt;
}

function updateSDPViews() {
  ui.sdpLocal.textContent = pc?.localDescription?.sdp || "";
  ui.sdpRemote.textContent = pc?.remoteDescription?.sdp || "";
}

function setControls(connected) {
  ui.btnCall.disabled = !localStream || connected;
  ui.btnAnswer.disabled = !pendingRemoteOffer;
  ui.btnHangup.disabled = !pc;
  ui.btnToggleMic.disabled = !localStream;
  ui.btnToggleCam.disabled = !localStream;
  ui.btnShare.disabled = !localStream || !pc;
}

// ---------- Socket.io (sala + señalización) ----------
ui.btnJoin.addEventListener("click", () => {
  room = (ui.room.value || "").trim() || "room-123";
  socket.emit("join", room);
  log("⤴️ join:", room);
});

ui.btnLeave.addEventListener("click", () => {
  if (!room) return;
  emitSignal({ type: "bye", data: null });
  socket.emit("leave");
  hangup();
  room = null;
  updateParticipants(0);
  isCaller = null;
  setRoleLabelFromFlag();
  log("🚪 leave");
});

socket.on("connect", () => log("✅ socket connected:", socket.id));
socket.on("disconnect", () => log("❌ socket disconnected"));

// Nueva semántica: rol solo en 'joined' (para quien entra)
socket.on("joined", ({ room: r, participants, role }) => {
  room = r;
  updateParticipants(participants);
  isCaller = role === "caller";
  setRoleLabelFromFlag();
  log("ℹ️ joined:", r, "participants:", participants, "role:", role);
  setControls(!!pc);
});

// Los demás reciben solo cambios de contador
socket.on("peer-joined", ({ room: r, participants }) => {
  updateParticipants(participants);
  log("👤 peer-joined:", r, "participants:", participants);
});
socket.on("peer-left", ({ room: r, participants }) => {
  updateParticipants(participants);
  log("👋 peer-left:", r, "participants:", participants);
  // si el peer remoto se va, cuelga la llamada
  hangup();
});

// Señalización genérica
socket.on("signal", async (payload) => {
  log("📩 signal:", payload.type);
  try {
    if (payload.type === "offer") {
      pendingRemoteOffer = payload.data;
      await onOffer(payload.data);
    } else if (payload.type === "answer") {
      await onAnswer(payload.data);
    } else if (payload.type === "candidate") {
      await onRemoteCandidate(payload.data);
    } else if (payload.type === "bye") {
      log("👋 bye (remote)");
      hangup();
    }
  } catch (e) {
    log("❌ signal handler error:", e.message || e);
  }
});

function emitSignal(payload) {
  if (!room) return log("⚠️ not in a room");
  socket.emit("signal", { room, payload });
  log("➡️ emit", payload.type);
}

// ---------- Captura local y toggles ----------
ui.btnStart.addEventListener("click", startLocal);
ui.chkAudio.addEventListener("change", () => {
  if (!localStream) return;
  localStream.getAudioTracks().forEach(t => (t.enabled = ui.chkAudio.checked));
});
ui.chkVideo.addEventListener("change", () => {
  if (!localStream) return;
  localStream.getVideoTracks().forEach(t => (t.enabled = ui.chkVideo.checked));
});

ui.btnToggleMic.addEventListener("click", () => {
  if (!localStream) return;
  localStream.getAudioTracks().forEach(t => (t.enabled = !t.enabled));
  const on = localStream.getAudioTracks().some(t => t.enabled);
  ui.btnToggleMic.textContent = on ? "Mic" : "Mic (muted)";
});

ui.btnToggleCam.addEventListener("click", () => {
  if (!localStream) return;
  localStream.getVideoTracks().forEach(t => (t.enabled = !t.enabled));
  const on = localStream.getVideoTracks().some(t => t.enabled);
  ui.btnToggleCam.textContent = on ? "Cam" : "Cam (off)";
});

ui.btnShare.addEventListener("click", async () => {
  if (!pc) return;
  try {
    const display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    const track = display.getVideoTracks()[0];
    screenTrack = track;
    const sender = pc.getSenders().find(s => s.track && s.track.kind === "video");
    if (sender) {
      await sender.replaceTrack(track);
      log("🖥️ screen share ON");
      track.onended = async () => {
        await restoreCameraTrack();
      };
    }
  } catch (e) {
    log("❌ getDisplayMedia:", e.message || e);
  }
});

async function restoreCameraTrack() {
  if (!localStream || !pc) return;
  const cam = localStream.getVideoTracks()[0];
  const sender = pc.getSenders().find(s => s.track && s.track.kind === "video");
  if (sender && cam) {
    await sender.replaceTrack(cam);
    log("🖥️ screen share OFF (restored camera)");
  }
}

async function startLocal() {
  if (localStream) return;
  const wantAudio = ui.chkAudio.checked;
  const wantVideo = ui.chkVideo.checked;
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: wantAudio, video: wantVideo });
    ui.localVideo.srcObject = localStream;
    log("🎙️ getUserMedia ok", { audio: wantAudio, video: wantVideo });
    setControls(!!pc);
  } catch (e) {
    log("❌ getUserMedia error:", e.message || e);
  }
}

// ---------- Llamada: Call / Answer / Hangup ----------
ui.btnCall.addEventListener("click", async () => {
  try {
    await ensureLocal();
    await ensurePC();
    addLocalTracksOnce();

    const trickle = ui.chkTrickle.checked;
    log(`📤 createOffer (trickle=${trickle})`);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    updateSDPViews();

    if (trickle) {
      emitSignal({ type: "offer", data: pc.localDescription });
    } else {
      await waitIceGatheringComplete();
      emitSignal({ type: "offer", data: pc.localDescription });
    }
  } catch (e) {
    log("❌ call error:", e.message || e);
  }
});

ui.btnAnswer.addEventListener("click", async () => {
  if (!pendingRemoteOffer) return;
  await onOffer(pendingRemoteOffer);
});

ui.btnHangup.addEventListener("click", () => {
  emitSignal({ type: "bye", data: null });
  hangup();
});

// ---------- Señalización: handlers ----------
async function onOffer(remoteOffer) {
  await ensureLocal();
  await ensurePC();
  addLocalTracksOnce();

  log("🔔 onOffer -> setRemoteDescription");
  await pc.setRemoteDescription(remoteOffer);
  updateSDPViews();

  const trickle = ui.chkTrickle.checked;
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  updateSDPViews();

  if (trickle) {
    emitSignal({ type: "answer", data: pc.localDescription });
  } else {
    await waitIceGatheringComplete();
    emitSignal({ type: "answer", data: pc.localDescription });
  }

  pendingRemoteOffer = null;
  setControls(!!pc);
}

async function onAnswer(remoteAnswer) {
  if (!pc) return;
  await pc.setRemoteDescription(remoteAnswer);
  updateSDPViews();
}

async function onRemoteCandidate(candidate) {
  if (!pc) return;
  try {
    await pc.addIceCandidate(candidate);
  } catch (e) {
    log("⚠️ addIceCandidate:", e.message || e);
  }
}

// ---------- RTCPeerConnection lifecycle ----------
async function ensureLocal() {
  if (!localStream) await startLocal();
}
async function ensurePC() {
  if (pc) return;

  await ensureIceConfig();
  pc = new RTCPeerConnection(rtcConfig);

  pc.addEventListener("connectionstatechange", () => {
    const st = pc.connectionState;
    setBadge(ui.pcState, st, st === "connected" ? "ok" : (st === "failed" || st === "closed") ? "err" : "warn");
    if (st === "connected") startStats();
    if (st === "failed" || st === "closed") stopStats();
    setControls(st === "connected");
  });

  pc.addEventListener("iceconnectionstatechange", () => {
    const st = pc.iceConnectionState;
    setBadge(
      ui.iceState,
      st,
      (st === "connected" || st === "completed") ? "ok" : st === "failed" ? "err" : "warn"
    );
  });

  pc.addEventListener("signalingstatechange", () => {
    setBadge(ui.signaling, `Signaling: ${pc.signalingState}`, "warn");
    updateSDPViews();
  });

  pc.addEventListener("icegatheringstatechange", () => {
    const done = pc.iceGatheringState === "complete";
    setBadge(ui.gather, `Gathering: ${pc.iceGatheringState}`, done ? "ok" : "warn");
  });

  pc.addEventListener("icecandidate", (e) => {
    // Trickle ICE: enviamos candidatos al vuelo
    if (e.candidate && ui.chkTrickle.checked) {
      emitSignal({ type: "candidate", data: e.candidate });
    }
  });

  pc.addEventListener("track", (e) => {
    if (!remoteStream) {
      remoteStream = new MediaStream();
      ui.remoteVideo.srcObject = remoteStream;
    }

    const track = e.track;
    const addTrackToRemote = () => {
      if (!remoteStream) return;
      if (!remoteStream.getTracks().includes(track)) {
        remoteStream.addTrack(track);
        ui.remoteVideo.play?.().catch(() => {});
      }
    };

    if (track.muted) {
      track.addEventListener("unmute", addTrackToRemote, { once: true });
    } else {
      addTrackToRemote();
    }

    track.addEventListener("ended", () => {
      if (!remoteStream) return;
      if (remoteStream.getTracks().includes(track)) {
        remoteStream.removeTrack(track);
        if (remoteStream.getTracks().length === 0) {
          ui.remoteVideo.srcObject = null;
          remoteStream = null;
        }
      }
    });
  });

  // DataChannel opcional
  try {
    const dc = pc.createDataChannel("chat");
    dc.onopen = () => setBadge(ui.sctp, "SCTP: open", "ok");
    dc.onclose = () => setBadge(ui.sctp, "SCTP: closed", "warn");
  } catch { /* callee lo gestionaría vía ondatachannel si hiciera falta */ }

  // Estado inicial
  setBadge(ui.pcState, "new", "warn");
  setBadge(ui.iceState, "new", "warn");
  setBadge(ui.signaling, `Signaling: ${pc.signalingState}`, "warn");
  setBadge(ui.gather, `Gathering: ${pc.iceGatheringState}`, "warn");
  setRoleLabelFromFlag();
  setControls(false);
}

function addLocalTracksOnce() {
  if (!pc || !localStream) return;
  const existingKinds = new Set(pc.getSenders().filter(s => s.track).map(s => s.track.kind));
  for (const track of localStream.getTracks()) {
    if (!existingKinds.has(track.kind)) pc.addTrack(track, localStream);
  }
}

function hangup() {
  stopStats();
  try { pc?.getSenders().forEach(s => s.track && s.track.stop()); } catch {}
  try { pc?.close(); } catch {}
  pc = null;
  pendingRemoteOffer = null;

  if (remoteStream) {
    remoteStream.getTracks().forEach(t => t.stop());
    remoteStream = null;
  }
  ui.remoteVideo.srcObject = null;

  setBadge(ui.pcState, "closed", "warn");
  setBadge(ui.iceState, "—", "warn");
  setBadge(ui.dtls, "DTLS: —", "warn");
  setBadge(ui.sctp, "SCTP: —", "warn");
  setBadge(ui.signaling, "Signaling: —", "warn");
  setBadge(ui.gather, "Gathering: —", "warn");
  ui.selectedPair.textContent = "Par ICE: —";
  updateSDPViews();
  setControls(false);
}

// Para versión "no-trickle": esperar a fin de recolección
function waitIceGatheringComplete() {
  return new Promise((resolve) => {
    if (!pc) return resolve();
    if (pc.iceGatheringState === "complete") return resolve();
    const onChange = () => {
      if (pc.iceGatheringState === "complete") {
        pc.removeEventListener("icegatheringstatechange", onChange);
        resolve();
      }
    };
    pc.addEventListener("icegatheringstatechange", onChange);
  });
}

// ---------- Stats: par ICE seleccionado / DTLS ----------
function startStats() {
  stopStats();
  statsTimer = setInterval(async () => {
    if (!pc) return;
    try {
      const stats = await pc.getStats();
      // localizar el candidate pair seleccionado
      let pair = null;
      stats.forEach(r => {
        if (r.type === "transport" && r.selectedCandidatePairId) {
          pair = stats.get(r.selectedCandidatePairId);
        }
      });
      if (!pair) {
        stats.forEach(r => {
          if (r.type === "candidate-pair" && r.nominated && r.state === "succeeded") pair = r;
        });
      }
      if (pair) {
        const local = stats.get(pair.localCandidateId);
        const remote = stats.get(pair.remoteCandidateId);
        const lp = local ? `${local.candidateType}/${local.protocol}/${local.ip || local.address}:${local.port}` : "?";
        const rp = remote ? `${remote.candidateType}/${remote.protocol}/${remote.ip || remote.address}:${remote.port}` : "?";
        ui.selectedPair.textContent = `Par ICE: [L] ${lp} ↔ [R] ${rp}`;
        setBadge(ui.dtls, "DTLS: connected", "ok");
      }
    } catch { /* ignorar errores intermitentes */ }
  }, 1000);
}
function stopStats() {
  if (statsTimer) clearInterval(statsTimer);
  statsTimer = null;
}

// ---------- Inicialización ----------
setBadge(ui.dtls, "DTLS: —", "warn");
setBadge(ui.sctp, "SCTP: —", "warn");
setBadge(ui.signaling, "Signaling: —", "warn");
setBadge(ui.gather, "Gathering: —", "warn");
ui.pcState.textContent = "new";
ui.iceState.textContent = "new";
setRoleLabelFromFlag();
setControls(false);
