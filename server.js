import express from "express";
import http from "http";
import { Server } from "socket.io";
import { getFreshDeck, loadDecks, watchDecks, listDecks } from "./deck.js";

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
app.use(express.static("public"));

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  loadDecks();
  watchDecks();
});

// -------------------- Game Logic --------------------

const MAX_HAND = 7;
const rooms = {}; // code -> room state

function generateRoomCode() {
  const chars = "ABCDEFGHJKMNPQRSTUWXYZ23456789";
  let code = "";
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return rooms[code] ? generateRoomCode() : code;
}

function shuffle(a){ for (let i=a.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; } return a; }
function freshRoomDeck(selectedDecks) {
  return getFreshDeck(selectedDecks && selectedDecks.length ? selectedDecks : ["default"]);
}

function createRoom(hostSocket, name, selectedDecks) {
  const code = generateRoomCode();
  const deck = freshRoomDeck(selectedDecks);
  rooms[code] = {
    code,
    hostId: hostSocket.id,
    phase: "lobby", // lobby|submit|reveal|vote|score
    round: 0,
    prompt: null,
    revealIndex: 0,
    revealShuffled: false,
    submissions: [], // {id, playerId, parts:[rawCard], votes}
    resultsSnapshot: null, // <-- NEW: stable snapshot for score phase
    players: {},     // socketId -> {id, name, score, hand:[], submittedParts:null, hasVoted:false, votedFor:null}
    deck,
    selectedDecks: (selectedDecks && selectedDecks.length) ? selectedDecks : ["default"],
  };
  rooms[code].players[hostSocket.id] = {
    id: hostSocket.id,
    name: name?.trim() || "Host",
    score: 0,
    hand: drawResponses(rooms[code], MAX_HAND),
    submittedParts: null,
    submittedCard: null, // legacy
    hasVoted: false,
    votedFor: null,
  };
  return rooms[code];
}

function joinRoom(code, socket, name) {
  const room = rooms[code];
  if (!room) return { error: "Room not found" };
  room.players[socket.id] = {
    id: socket.id,
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

function deepEqual(a, b) { try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; } }
function isImageLink(str){
  if (typeof str !== "string") return false;
  try {
    const u = new URL(str.trim());
    if (!/^https?:$/.test(u.protocol)) return false;
    return /\.(png|jpe?g|gif|webp|bmp|avif)$/i.test(u.pathname);
  } catch { return false; }
}
function hasSubmitted(p){
  return (Array.isArray(p.submittedParts) && p.submittedParts.length > 0) || p.submittedCard !== null;
}
function findAndRemoveFromHand(hand, card){
  const idx = hand.findIndex(c => (c === card) || deepEqual(c, card));
  if (idx === -1) return false;
  hand.splice(idx, 1);
  return true;
}

function ensureRevealShuffled(room){
  if (!room.revealShuffled) {
    shuffle(room.submissions);     // randomize reveal & voting order
    room.revealShuffled = true;
  }
}

// NEW: create a stable results array for score phase
function snapshotResults(room){
  room.resultsSnapshot = room.submissions.map(s => ({
    id: s.id, playerId: s.playerId, parts: s.parts, votes: s.votes
  }));
}

function proceedToVoteOrScore(room) {
  if (room.submissions.length <= 1) {
    // Directly to score, make sure snapshot exists
    snapshotResults(room);
    room.phase = "score";
    room.revealIndex = -1;
  } else {
    room.phase = "vote";
    resetVotes(room);
  }
}

function getPublicState(room, viewerId) {
  const you = room.players[viewerId];

  let submissionsPublic = [];
  if (room.phase === "reveal") {
    if (room.revealIndex >= 0 && room.revealIndex < room.submissions.length) {
      const s = room.submissions[room.revealIndex];
      submissionsPublic = [{ id: s.id, parts: s.parts, isYou: s.playerId === viewerId }];
    } else {
      submissionsPublic = [];
    }
  } else if (room.phase === "vote") {
    submissionsPublic = room.submissions.map(s => ({ id: s.id, parts: s.parts, isYou: s.playerId === viewerId }));
  } else if (room.phase === "score") {
    // Always use the snapshot to be safe
    const src = Array.isArray(room.resultsSnapshot) && room.resultsSnapshot.length
      ? room.resultsSnapshot
      : room.submissions;
    submissionsPublic = src.map(s => ({ id: s.id, parts: s.parts, playerId: s.playerId, votes: s.votes }));
  }

  return {
    code: room.code,
    phase: room.phase,
    isHost: room.hostId === viewerId,
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

// -------------------- Socket events --------------------

io.on("connection", (socket) => {
  let currentRoomCode = null;

  socket.emit("decks", listDecks());

  function emitRoom() {
    if (!currentRoomCode) return;
    const room = rooms[currentRoomCode];
    if (!room) return;
    for (const sid of Object.keys(room.players)) {
      io.to(sid).emit("state", getPublicState(room, sid));
    }
  }

  socket.on("createRoom", ({ name, decks }) => {
    const all = new Set(listDecks().map(d => d.id));
    const selected = (Array.isArray(decks) ? decks : []).filter(id => all.has(id));
    const room = createRoom(socket, name, selected.length ? selected : ["default"]);
    currentRoomCode = room.code;
    socket.join(room.code);
    emitRoom();
  });

  socket.on("joinRoom", ({ code, name }) => {
    const room = rooms[code];
    if (!room) { socket.emit("errorMsg", "Room not found."); return; }
    currentRoomCode = code;
    socket.join(code);
    const res = joinRoom(code, socket, name);
    if (res.error) { socket.emit("errorMsg", res.error); return; }
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
    room.revealIndex = 0;
    room.revealShuffled = false;
    room.resultsSnapshot = null;
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

  // Legacy one-card submit
  socket.on("submitCard", (card) => {
    if (!currentRoomCode) return;
    const room = rooms[currentRoomCode];
    if (room.phase !== "submit") return;
    const p = room.players[socket.id];
    if (!p || hasSubmitted(p)) return;
    if (!findAndRemoveFromHand(p.hand, card)) return;

    const kind = (typeof card === "string" && isImageLink(card)) ? "image" : "text";
    p.submittedParts = [{ kind, card }];
    p.submittedCard = card;

    room.submissions.push({ id: room.submissions.length + 1, playerId: p.id, parts: [card], votes: 0 });

    if (everyoneSubmitted(room)) {
      room.phase = "reveal";
      room.revealIndex = -1;   // paused
      ensureRevealShuffled(room);
    }
    emitRoom();
  });

  // New combo submit
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

    if (everyoneSubmitted(room)) {
      room.phase = "reveal";
      room.revealIndex = -1;   // paused
      ensureRevealShuffled(room);
    }
    emitRoom();
  });

  socket.on("forceStartReveal", () => {
    if (!currentRoomCode) return;
    const room = rooms[currentRoomCode];
    if (!room || room.hostId !== socket.id) return;
    if (room.phase !== "submit") return;
    if (room.submissions.length === 0) {
      socket.emit("errorMsg", "No submissions yet to reveal.");
      return;
    }
    room.phase = "reveal";
    room.revealIndex = -1; // paused; host must press Next
    ensureRevealShuffled(room);
    emitRoom();
  });

  socket.on("revealNext", () => {
    if (!currentRoomCode) return;
    const room = rooms[currentRoomCode];
    if (room.phase !== "reveal") return;
    if (room.hostId !== socket.id) return;

    if (room.revealIndex === -1 && room.submissions.length > 0) {
      room.revealIndex = 0; // show first
    } else if (room.revealIndex < room.submissions.length - 1) {
      room.revealIndex += 1;
    } else {
      proceedToVoteOrScore(room);
    }
    emitRoom();
  });

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
      // Tally -> score, keep everything visible
      for (const s of room.submissions) {
        const target = room.players[s.playerId];
        if (target) target.score += s.votes;
      }
      snapshotResults(room);  // <-- make sure score has stable data
      room.phase = "score";
      room.revealIndex = -1;
    }
    emitRoom();
  });

  socket.on("nextRound", () => {
    if (!currentRoomCode) return;
    const room = rooms[currentRoomCode];
    if (room.hostId !== socket.id) return;
    if (room.phase !== "score") return;

    room.phase = "submit";
    room.prompt = drawPrompt(room);
    room.revealIndex = 0;
    room.revealShuffled = false;
    room.resultsSnapshot = null;
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

  socket.on("disconnect", () => {
    if (!currentRoomCode) return;
    const room = rooms[currentRoomCode];
    if (!room) return;
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
  });
});
