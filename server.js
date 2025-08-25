import express from "express";
import http from "http";
import { Server } from "socket.io";
import { getFreshDeck, loadDecks, watchDecks, listDecks } from "./deck.js";

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  // slightly more tolerant mobile keepalive
  pingInterval: 25000,
  pingTimeout: 30000
});

const PORT = process.env.PORT || 3000;
app.use(express.static("public"));

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  loadDecks();
  watchDecks();
});

// -------------------- Game Logic --------------------

const MAX_HAND = 7;
const DISCONNECT_GRACE_MS = 45000; // wait before removing a player (mobile resume window)
const rooms = {}; // code -> room state

function shuffle(arr){
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i+1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function prepareReveal(room){
  // randomize reveal order by shuffling submissions array
  room.submissions = shuffle(room.submissions);
  room.phase = "reveal";
  room.revealIndex = -1; // host sees "Start reveal ▶"
}

function generateRoomCode() {
  const chars = "ABCDEFGHJKMNPQRSTUWXYZ23456789";
  let code = "";
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return rooms[code] ? generateRoomCode() : code;
}

function freshRoomDeck(selectedDecks) {
  return getFreshDeck(selectedDecks && selectedDecks.length ? selectedDecks : ["default"]);
}

function drawResponses(room, count) {
  const out = [];
  while (out.length < count) {
    if (room.deck.responses.length === 0) {
      room.deck.responses = freshRoomDeck(room.selectedDecks).responses;
    }
    out.push(room.deck.responses.pop());
  }
  return out;
}
function drawPrompt(room) {
  if (room.deck.prompts.length === 0) {
    room.deck.prompts = freshRoomDeck(room.selectedDecks).prompts;
  }
  return room.deck.prompts.pop();
}

function getPlayerList(room) {
  return Object.values(room.players).map(p => ({
    id: p.id, name: p.name, score: p.score
  }));
}

function hasSubmitted(p){
  return (Array.isArray(p.submittedParts) && p.submittedParts.length > 0) || p.submittedCard !== null;
}
function deepEqual(a, b) { try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; } }
function findAndRemoveFromHand(hand, card){
  const idx = hand.findIndex(c => (c === card) || deepEqual(c, card));
  if (idx === -1) return false;
  hand.splice(idx, 1);
  return true;
}

function getPublicState(room, viewerId) {
  const you = room.players[viewerId];
  const isHost = room.hostId === viewerId;

  let submissionsPublic = [];
  if (room.phase === "reveal") {
    // Show only the CURRENT item while revealing
    if (room.revealIndex >= 0) {
      const s = room.submissions[room.revealIndex];
      if (s) submissionsPublic = [{ id: s.id, parts: s.parts, isYou: s.playerId === viewerId }];
    } else {
      submissionsPublic = []; // waiting for host to press Start reveal
    }
  } else if (room.phase === "vote") {
    // All visible, anonymous; include isYou for client labeling only
    submissionsPublic = room.submissions.map(s => ({ id: s.id, parts: s.parts, isYou: s.playerId === viewerId }));
  } else if (room.phase === "score") {
    // Reveal authors and votes
    submissionsPublic = room.submissions.map(s => ({ id: s.id, parts: s.parts, playerId: s.playerId, votes: s.votes }));
  }

  return {
    code: room.code,
    phase: room.phase,
    isHost,
    round: room.round,
    prompt: room.prompt,
    revealIndex: room.revealIndex,
    players: getPlayerList(room),
    submissions: submissionsPublic,
    you: you ? {
      id: you.id,
      name: you.name,
      score: you.score,
      hand: you.hand,
      submittedParts: you.submittedParts,
      submittedCard: you.submittedCard,
      hasVoted: you.hasVoted,
      votedFor: you.votedFor,
    } : null,
  };
}

function everyoneSubmitted(room) {
  return Object.values(room.players).every(p => hasSubmitted(p));
}
function everyoneVoted(room) {
  return Object.values(room.players).every(p => p.hasVoted);
}
function resetVotes(room) {
  for (const p of Object.values(room.players)) { p.hasVoted = false; p.votedFor = null; }
  for (const s of room.submissions) s.votes = 0;
}

function createRoom(hostSocket, name, selectedDecks, sessionId) {
  const code = generateRoomCode();
  const deck = freshRoomDeck(selectedDecks);
  rooms[code] = {
    code,
    hostId: hostSocket.id,
    phase: "lobby", // lobby|submit|reveal|vote|score
    round: 0,
    prompt: null,
    revealIndex: -1, // -1 = staging before first reveal
    submissions: [], // {id, playerId, parts:[rawCard], votes}
    players: {},     // socketId -> player
    deck,
    selectedDecks: (selectedDecks && selectedDecks.length) ? selectedDecks : ["default"],
    disconnectTimers: {} // socketId -> timeout
  };
  rooms[code].players[hostSocket.id] = {
    id: hostSocket.id,
    sessionId: sessionId || null,
    name: name?.trim() || "Host",
    score: 0,
    hand: drawResponses(rooms[code], MAX_HAND),
    submittedParts: null,
    submittedCard: null,
    hasVoted: false,
    votedFor: null,
  };
  return rooms[code];
}

function joinRoom(code, socket, name, sessionId) {
  const room = rooms[code];
  if (!room) return { error: "Room not found" };
  room.players[socket.id] = {
    id: socket.id,
    sessionId: sessionId || null,
    name: name?.trim() || `Player ${Object.keys(room.players).length + 1}`,
    score: 0,
    hand: drawResponses(room, MAX_HAND),
    submittedParts: null,
    submittedCard: null,
    hasVoted: false,
    votedFor: null,
  };
  return { room };
}

// Find an existing player by sessionId (returns [socketId, player] or [null,null])
function findPlayerBySession(room, sessionId){
  if (!sessionId) return [null, null];
  for (const [sid, p] of Object.entries(room.players)) {
    if (p.sessionId && p.sessionId === sessionId) return [sid, p];
  }
  return [null, null];
}

// Move a player from old socketId -> new socket.id (preserve scores/submissions/etc)
function rebindPlayer(room, oldSid, socket, newName) {
  const old = room.players[oldSid];
  if (!old) return;

  const updated = {
    ...old,
    id: socket.id,
    name: newName?.trim() || old.name
  };
  delete room.players[oldSid];
  room.players[socket.id] = updated;

  if (room.hostId === oldSid) room.hostId = socket.id;

  room.submissions.forEach(s => {
    if (s.playerId === oldSid) s.playerId = socket.id;
  });

  const t = room.disconnectTimers[oldSid];
  if (t) { clearTimeout(t); delete room.disconnectTimers[oldSid]; }
}

// -------------------- Socket events --------------------

io.on("connection", (socket) => {
  let currentRoomCode = null;

  // Send available decks to new clients (for lobby checkbox UI)
  socket.emit("decks", listDecks());

  function emitRoom() {
    if (!currentRoomCode) return;
    const room = rooms[currentRoomCode];
    if (!room) return;
    for (const sid of Object.keys(room.players)) {
      io.to(sid).emit("state", getPublicState(room, sid));
    }
  }

  // Resume flow: called on fresh connection to reclaim previous identity
  socket.on("resume", ({ code, name, sessionId }) => {
    const room = rooms[code];
    if (!room) { socket.emit("errorMsg", "Room not found."); return; }

    const [oldSid, player] = findPlayerBySession(room, sessionId);
    currentRoomCode = code;
    socket.join(code);

    if (player && oldSid && oldSid !== socket.id) {
      rebindPlayer(room, oldSid, socket, name);
    } else if (!player) {
      const res = joinRoom(code, socket, name, sessionId);
      if (res.error) { socket.emit("errorMsg", res.error); return; }
    }
    emitRoom();
  });

  socket.on("createRoom", ({ name, decks, sessionId }) => {
    const all = new Set(listDecks().map(d => d.id));
    const selected = (Array.isArray(decks) ? decks : []).filter(id => all.has(id));
    const room = createRoom(socket, name, selected.length ? selected : ["default"], sessionId);
    currentRoomCode = room.code;
    socket.join(room.code);
    emitRoom();
  });

  socket.on("joinRoom", ({ code, name, sessionId }) => {
    const room = rooms[code];
    if (!room) { socket.emit("errorMsg", "Room not found."); return; }
    currentRoomCode = code;
    socket.join(code);

    const [oldSid, player] = findPlayerBySession(room, sessionId);
    if (player && oldSid) {
      rebindPlayer(room, oldSid, socket, name);
    } else {
      const res = joinRoom(code, socket, name, sessionId);
      if (res.error) { socket.emit("errorMsg", res.error); return; }
    }
    emitRoom();
  });

  socket.on("rename", (newName) => {
    if (!currentRoomCode) return;
    const room = rooms[currentRoomCode];
    const p = room.players[socket.id];
    if (p) p.name = String(newName || "").slice(0, 24) || p.name;
    emitRoom();
  });

  socket.on("startRound", () => {
    if (!currentRoomCode) return;
    const room = rooms[currentRoomCode];
    if (room.hostId !== socket.id) return;
    room.round += 1;
    room.phase = "submit";
    room.prompt = drawPrompt(room);
    room.revealIndex = -1; // wait for host to begin reveal
    room.submissions = [];
    for (const p of Object.values(room.players)) {
      while (p.hand.length < MAX_HAND) p.hand.push(...drawResponses(room, 1));
      p.submittedParts = null;
      p.submittedCard = null;
      p.hasVoted = false;
      p.votedFor = null;
    }
    emitRoom();
  });

  // Legacy one-card submit (still supported)
  socket.on("submitCard", (card) => {
    if (!currentRoomCode) return;
    const room = rooms[currentRoomCode];
    if (room.phase !== "submit") return;
    const p = room.players[socket.id];
    if (!p || hasSubmitted(p)) return;
    if (!findAndRemoveFromHand(p.hand, card)) return;

    const kind = (typeof card === "string" && /^https?:\/\//.test(card)) ? "image" : "text";
    p.submittedParts = [{ kind, card }];
    p.submittedCard = card;

    room.submissions.push({ id: room.submissions.length + 1, playerId: p.id, parts: [card], votes: 0 });

    // If everyone is in, stage reveal for host (shuffled)
    if (everyoneSubmitted(room)) prepareReveal(room);

    emitRoom();
  });

  // New: combo submit (1–2 parts)
  socket.on("submitParts", ({ parts }) => {
    if (!currentRoomCode) return;
    const room = rooms[currentRoomCode];
    if (room.phase !== "submit") return;
    const p = room.players[socket.id];
    if (!p || hasSubmitted(p)) return;

    if (!Array.isArray(parts) || parts.length < 1 || parts.length > 2) {
      socket.emit("errorMsg", "Pick 1 or 2 cards."); return;
    }
    const kinds = parts.map(x => x?.kind);
    const validKinds = kinds.every(k => k === "image" || k === "text");
    if (!validKinds) { socket.emit("errorMsg", "Invalid selection."); return; }
    if (kinds.filter(k => k === "image").length > 1 || kinds.filter(k => k === "text").length > 1) {
      socket.emit("errorMsg", "Choose at most one image and one text."); return;
    }

    for (const part of parts) {
      if (!findAndRemoveFromHand(p.hand, part.card)) {
        socket.emit("errorMsg", "Selected card not in your hand."); return;
      }
    }

    p.submittedParts = parts.map(pp => ({ kind: pp.kind, card: pp.card }));
    p.submittedCard = null;

    room.submissions.push({
      id: room.submissions.length + 1,
      playerId: p.id,
      parts: parts.map(pp => pp.card),
      votes: 0
    });

    // If everyone is in, stage reveal for host (shuffled)
    if (everyoneSubmitted(room)) prepareReveal(room);

    emitRoom();
  });

  // Host: begin/continue reveal
  socket.on("revealNext", () => {
    if (!currentRoomCode) return;
    const room = rooms[currentRoomCode];
    if (room.phase !== "reveal" && room.phase !== "submit") return;
    if (room.hostId !== socket.id) return;

    // If still in submit, start reveal now (shuffled, staged)
    if (room.phase === "submit") {
      if (room.submissions.length === 0) return; // nothing to reveal
      prepareReveal(room); // sets phase="reveal" and revealIndex=-1
    }

    if (room.revealIndex < room.submissions.length - 1) {
      room.revealIndex += 1; // -1→0 (first), 0→1, ...
    } else {
      // if only one submission, skip vote -> score
      if (room.submissions.length <= 1) {
        for (const s of room.submissions) {
          const target = room.players[s.playerId];
          if (target) target.score += s.votes;
        }
        room.phase = "score";
      } else {
        room.phase = "vote";
        resetVotes(room);
      }
    }
    emitRoom();
  });

  // Host: force start reveal (even if not everyone submitted)
  socket.on("forceStartReveal", () => {
    if (!currentRoomCode) return;
    const room = rooms[currentRoomCode];
    if (room.hostId !== socket.id) return;
    if (room.phase !== "submit") return;
    if (room.submissions.length === 0) { socket.emit("errorMsg","No submissions yet."); return; }
    prepareReveal(room); // shuffle + stage at -1
    emitRoom();
  });

  // Voting
  socket.on("castVote", (submissionId) => {
    if (!currentRoomCode) return;
    const room = rooms[currentRoomCode];
    if (room.phase !== "vote") return;
    const voter = room.players[socket.id];
    if (!voter || voter.hasVoted) return;
    const choice = room.submissions.find(s => s.id === submissionId);
    if (!choice) return;
    if (choice.playerId === voter.id) {
      socket.emit("errorMsg", "You can't vote for your own response."); return;
    }
    choice.votes += 1;
    voter.hasVoted = true;
    voter.votedFor = submissionId;

    if (everyoneVoted(room)) {
      for (const s of room.submissions) {
        const target = room.players[s.playerId];
        if (target) target.score += s.votes;
      }
      room.phase = "score";
    }
    emitRoom();
  });

  // Next round
  socket.on("nextRound", () => {
    if (!currentRoomCode) return;
    const room = rooms[currentRoomCode];
    if (room.hostId !== socket.id) return;
    if (room.phase !== "score") return;

    room.phase = "submit";
    room.prompt = drawPrompt(room);
    room.revealIndex = -1;
    room.submissions = [];
    for (const p of Object.values(room.players)) {
      while (p.hand.length < MAX_HAND) p.hand.push(...drawResponses(room, 1));
      p.submittedParts = null;
      p.submittedCard = null;
      p.hasVoted = false;
      p.votedFor = null;
    }
    emitRoom();
  });

  // Leave room (explicit)
  socket.on("leaveRoom", () => {
    if (!currentRoomCode) { socket.emit("leftRoom"); return; }
    const room = rooms[currentRoomCode];
    if (room) {
      delete room.players[socket.id];
      if (room.hostId === socket.id) {
        const ids = Object.keys(room.players);
        room.hostId = ids[0] || null;
      }
      if (Object.keys(room.players).length === 0) {
        delete rooms[currentRoomCode];
      } else {
        emitRoom();
      }
    }
    currentRoomCode = null;
    socket.emit("leftRoom");
  });

  // Disconnect with grace period
  socket.on("disconnect", () => {
    if (!currentRoomCode) return;
    const room = rooms[currentRoomCode];
    if (!room) return;

    room.disconnectTimers[socket.id] = setTimeout(() => {
      const p = room.players[socket.id];
      if (!p) return;
      delete room.players[socket.id];

      if (room.hostId === socket.id) {
        const ids = Object.keys(room.players);
        room.hostId = ids[0] || null;
      }

      if (Object.keys(room.players).length === 0) {
        delete rooms[currentRoomCode];
      } else {
        emitRoom();
      }
      delete room.disconnectTimers[socket.id];
    }, DISCONNECT_GRACE_MS);
  });
});
