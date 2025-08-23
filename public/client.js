// If opened as file://, connect to localhost server. Otherwise, same origin.
const inferServerURL = () => {
  const isHttp = location.protocol === "http:" || location.protocol === "https:";
  return isHttp ? undefined : (window.SOCKET_URL || "http://localhost:3000");
};
const socket = io(inferServerURL());

// Elements
const $auth = document.getElementById("auth");
const $lobby = document.getElementById("lobby");
const $game = document.getElementById("game");
const $players = document.getElementById("players");
const $roomInfo = document.getElementById("roomInfo");
const $roomCode = document.getElementById("roomCode");
const $btnCreate = document.getElementById("btnCreate");
const $btnJoin = document.getElementById("btnJoin");
const $joinCode = document.getElementById("joinCode");
const $nameInput = document.getElementById("nameInput");
const $btnStart = document.getElementById("btnStart");
const $btnStartFromGame = document.getElementById("btnStartFromGame");

const $prompt = document.getElementById("prompt");
const $responses = document.getElementById("responses");
const $phaseBadge = document.getElementById("phaseBadge");
const $btnReveal = document.getElementById("btnReveal");
const $voteHint = document.getElementById("voteHint");
const $leaderboard = document.getElementById("leaderboard");
const $toast = document.getElementById("toast");

// Split hand containers
const $handText = document.getElementById("handText");
const $handMediaWrap = document.getElementById("handMediaWrap");
const $handMedia = document.getElementById("handMedia");

// Deck UI (optional)
const $deckList = document.getElementById("deckList");
const $btnAllDecks = document.getElementById("btnAllDecks");
const $btnNoneDecks = document.getElementById("btnNoneDecks");

// Contact header name + chat scroller
const $contactName = document.getElementById("contactName");
const $chat = document.querySelector(".chat");

// NEW: Force start button (added in HTML actions bar)
const $btnForceStart = document.getElementById("btnForceStart");

// Keeps a fallback copy of all responses for the Score screen if needed
let cacheAllForScore = null;


// Mobile Drawer

const $sidePanel = document.getElementById("sidePanel");
const $btnToggleDrawer = document.getElementById("btnToggleDrawer");
const $btnCloseDrawer = document.getElementById("btnCloseDrawer");
const $drawerBackdrop = document.getElementById("drawerBackdrop");


// --- SFX ---
const $sfxPrompt = document.getElementById("sfxPrompt");
const $sfxReveal = document.getElementById("sfxReveal");
let audioUnlocked = false;

function unlockAudioOnce(){
  if (audioUnlocked) return;
  audioUnlocked = true;
  [$sfxPrompt, $sfxReveal].forEach(a => {
    if (!a) return;
    a.volume = 0.9;
    try { a.play().then(() => { a.pause(); a.currentTime = 0; }).catch(()=>{}); } catch {}
  });
}
["click","touchstart","keydown"].forEach(ev =>
  document.addEventListener(ev, unlockAudioOnce, { capture:true, passive:true })
);
function playSfx(el){
  if (!el || !audioUnlocked) return;
  try { el.currentTime = 0; el.play().catch(()=>{}); } catch {}
}

// --- Selection state (INDEX-BASED now) ---
let pick = { textIndex: null, imageIndex: null }; // indices in your hand

// --- Helpers ---
function toast(msg){
  $toast.textContent = msg;
  $toast.classList.remove("hidden");
  setTimeout(()=> $toast.classList.add("hidden"), 1800);
}
function upcaseCode(v){ return (v || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0,4); }

// Detect image/gif link
function isImageLink(str){
  if (!str || typeof str !== "string") return false;
  try {
    const u = new URL(str.trim());
    if (!/^https?:$/.test(u.protocol)) return false;
    return /\.(png|jpe?g|gif|webp|bmp|avif)$/i.test(u.pathname);
  } catch { return false; }
}

// Parse a response/prompt content (text | image | image+caption legacy)
function parseCardContent(content){
  if (content && typeof content === "object"){
    const url = content.image || content.img || content.url || content.src;
    const caption = content.caption ?? content.text ?? "";
    if (isImageLink(url)) return { kind:"image", url, caption: String(caption || "") };
    return { kind:"text", text: String(caption || "") };
  }
  const s = String(content || "").trim();

  const pipeIdx = s.indexOf("|");
  if (pipeIdx > 6) {
    const maybeUrl = s.slice(0, pipeIdx).trim();
    const cap = s.slice(pipeIdx + 1).trim();
    if (isImageLink(maybeUrl)) return { kind:"image", url: maybeUrl, caption: cap };
  }
  const nlIdx = s.indexOf("\n");
  if (nlIdx > 6) {
    const maybeUrl = s.slice(0, nlIdx).trim();
    const cap = s.slice(nlIdx + 1).trim();
    if (isImageLink(maybeUrl)) return { kind:"image", url: maybeUrl, caption: cap };
  }
  const m = s.match(/^(https?:\/\/\S+\.(?:png|jpe?g|gif|webp|bmp|avif))\s+[-–—]\s+(.+)$/i);
  if (m) return { kind:"image", url: m[1], caption: m[2] };

  if (isImageLink(s)) return { kind:"image", url: s, caption: "" };

  return { kind:"text", text: s };
}

// Parse "Name: message" OR object {from, text/image, caption}
function parsePrompt(p){
  if (!p) return { from:"—", kind:"text", text:"—" };

  if (typeof p === "object"){
    const from = p.from || "Unknown";
    const parsed = parseCardContent(p);   // keep caption
    return { from, ...parsed };
  }

  const s = String(p);
  const m = s.match(/^\s*([^:]{1,30}):\s*(.+)$/);
  let from = "Unknown", rest = s;
  if (m) { from = m[1]; rest = m[2]; }
  const parsed = parseCardContent(rest);
  return { from, ...parsed };
}

function createImageEl(src, className){
  const img = document.createElement("img");
  img.src = src;
  img.alt = "Image";
  img.loading = "lazy";
  img.decoding = "async";
  img.referrerPolicy = "no-referrer";
  img.className = className;
  img.addEventListener("error", () => { img.replaceWith(document.createTextNode("[image failed to load]")); });
  return img;
}

function openDrawer(){
  document.body.classList.add("drawerOpen");
  $btnToggleDrawer?.setAttribute("aria-expanded", "true");
  $drawerBackdrop?.classList.remove("hidden");
}
function closeDrawer(){
  document.body.classList.remove("drawerOpen");
  $btnToggleDrawer?.setAttribute("aria-expanded", "false");
  $drawerBackdrop?.classList.add("hidden");
}
function toggleDrawer(){
  if (document.body.classList.contains("drawerOpen")) closeDrawer();
  else openDrawer();
}


// Auto-scroll if near bottom
function autoScrollIfNearBottom(){
  if (!$chat) return;
  const tolerance = 40;
  const nearBottom = ($chat.scrollTop + $chat.clientHeight) >= ($chat.scrollHeight - tolerance);
  if (nearBottom) $chat.scrollTop = $chat.scrollHeight;
}

// Build ONE bubble (text OR image). No caption here.
function buildReplyBubble(rawContent, { voteable=false, selected=false } = {}){
  const { kind, text, url } = parseCardContent(rawContent);
  const div = document.createElement("div");
  div.className = "bubble reply";
  if (voteable) div.classList.add("voteable");
  if (selected) div.classList.add("selected");

  if (kind === "image") {
    div.classList.add("media");
    div.appendChild(createImageEl(url, "imgMessage"));
  } else {
    div.textContent = text;
  }
  return div;
}

// Append one response "message" which might be multiple parts now (image + text)
function appendReplyParts(container, parts, {
  voteable=false,
  selected=false,
  onVote=null
} = {}){
  const bubbles = [];
  const arr = Array.isArray(parts) ? parts : [parts];
  arr.forEach(part => {
    const bubble = buildReplyBubble(part, { voteable, selected });
    container.appendChild(bubble);
    bubbles.push(bubble);
  });

  if (voteable && onVote) {
    bubbles.forEach(b => {
      b.addEventListener("click", () => {
        document.querySelectorAll(".reply.voteable.selected").forEach(el => el.classList.remove("selected"));
        bubbles.forEach(el => el.classList.add("selected"));
        $voteHint.textContent = "Vote submitted.";
        onVote();
      }, { once: true });
    });
  }
}

// Tiny label above each response set
function addSenderTag(container, text, alignRight=true){
  const tag = document.createElement("div");
  tag.className = "senderTag";
  tag.textContent = text;
  if (alignRight) tag.style.textAlign = "right";
  container.appendChild(tag);
}

// Build a hand card button for either text or image (no caption logic)
function buildHandCard(rawContent, onToggle, disabled, selected){
  const { kind, text, url, caption } = parseCardContent(rawContent);

  const btn = document.createElement("button");
  btn.className = "cardBtn";
  if (selected) btn.classList.add("selected");
  btn.disabled = !!disabled;

  if (kind === "image") {
    btn.classList.add("mediaBtn");
    btn.appendChild(createImageEl(url, "imgThumb"));
    const cap = document.createElement("div");
    cap.className = "muted";
    cap.style.fontSize = "12px";
    cap.style.marginTop = "6px";
    cap.textContent = caption || "(image)";
    btn.appendChild(cap);
  } else {
    btn.textContent = text;
  }

  btn.addEventListener("click", onToggle);
  return btn;
}

// Ensure / update the floating hand controls (Play/Clear)
function ensureHandControls(){
  let bar = document.getElementById("handControls");
  if (!bar){
    bar = document.createElement("div");
    bar.id = "handControls";
    bar.className = "row";
    bar.style.marginTop = "12px";

    const play = document.createElement("button");
    play.id = "btnPlaySel";
    play.className = "primary";
    play.textContent = "Play selected";
    const clear = document.createElement("button");
    clear.id = "btnClearSel";
    clear.className = "secondary";
    clear.textContent = "Clear";

    bar.appendChild(play);
    bar.appendChild(clear);

    const parent = $handMediaWrap?.parentElement || $handText?.parentElement || document.body;
    parent.appendChild(bar);

    clear.addEventListener("click", () => {
      pick = { textIndex:null, imageIndex:null };
      renderHandControls("submit", false);
      renderHandCards(lastStateYou, lastPhase);
    });
    play.addEventListener("click", () => submitPicked());
  }
  return bar;
}

function renderHandControls(phase, submitted){
  const bar = ensureHandControls();
  const play = document.getElementById("btnPlaySel");
  const clear = document.getElementById("btnClearSel");

  const count = (pick.textIndex != null ? 1 : 0) + (pick.imageIndex != null ? 1 : 0);
  const label = count === 2 ? "Play image + text (2)" : count === 1 ? "Play selected (1)" : "Play selected";

  play.textContent = label;
  play.disabled = !(phase === "submit" && !submitted && count >= 1);
  clear.disabled = !(phase === "submit" && !submitted && count >= 1);

  bar.style.display = (phase === "submit" && !submitted) ? "flex" : "none";
}

function submitPicked(){
  if (!lastStateYou) return;
  const hand = lastStateYou.hand || [];
  const parts = [];
  if (pick.imageIndex != null && hand[pick.imageIndex] !== undefined) {
    parts.push({ kind:"image", card: hand[pick.imageIndex] });
  }
  if (pick.textIndex != null && hand[pick.textIndex] !== undefined) {
    parts.push({ kind:"text", card: hand[pick.textIndex] });
  }
  if (!parts.length) return;

  socket.emit("submitParts", { parts });
  closeDrawer();
  // lock UI
  pick = { textIndex:null, imageIndex:null };
  renderHandControls("locked", true);
}

// ======== DECK UI ========

let deckCatalog = []; // [{id,name,promptCount,responseCount}, ...]

socket.on("decks", (decks) => {
  deckCatalog = Array.isArray(decks) ? decks : [];
  renderDeckList(deckCatalog);
});

function renderDeckList(decks){
  if (!$deckList) return;
  $deckList.innerHTML = "";
  decks.forEach(d => {
    const id = `deck_${d.id}`;
    const label = document.createElement("label");
    label.className = "deckItem";
    label.innerHTML = `
      <input type="checkbox" id="${id}" data-id="${d.id}" ${d.id==="default" ? "checked" : ""}/>
      <span>${escapeHtml(d.name || d.id)}</span>
      <span class="muted" style="margin-left:auto;font-size:12px">${d.promptCount||0}P • ${d.responseCount||0}R</span>
    `;
    $deckList.appendChild(label);
  });
}

function selectedDeckIds(){
  if (!$deckList) return ["default"];
  const boxes = [...$deckList.querySelectorAll('input[type="checkbox"]')];
  const picked = boxes.filter(b => b.checked).map(b => b.dataset.id);
  return picked.length ? picked : ["default"];
}

$btnAllDecks?.addEventListener("click", () => {
  $deckList?.querySelectorAll('input[type="checkbox"]').forEach(b => b.checked = true);
});
$btnNoneDecks?.addEventListener("click", () => {
  $deckList?.querySelectorAll('input[type="checkbox"]').forEach(b => b.checked = false);
});

// --- UI events ---
$joinCode.addEventListener("input", e => { e.target.value = upcaseCode(e.target.value); });

$btnCreate.addEventListener("click", () => {
  const payload = {
    name: $nameInput.value.trim(),
    decks: selectedDeckIds()
  };
  socket.emit("createRoom", payload);
});

$btnJoin.addEventListener("click", () => {
  const code = upcaseCode($joinCode.value);
  if (!code) return toast("Enter room code");
  socket.emit("joinRoom", { code, name: $nameInput.value.trim() });
});
$btnStart.addEventListener("click", () => socket.emit("startRound"));
$btnStartFromGame.addEventListener("click", () => socket.emit("startRound"));
$btnReveal.addEventListener("click", () => socket.emit("revealNext"));
$btnForceStart?.addEventListener("click", () => socket.emit("forceStartReveal"));

$btnToggleDrawer?.addEventListener("click", toggleDrawer);
$btnCloseDrawer?.addEventListener("click", closeDrawer);
$drawerBackdrop?.addEventListener("click", closeDrawer);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeDrawer();
});


// --- Socket events ---
socket.on("connect_error", (err) => {
  console.error("Socket connect error:", err.message);
  toast("Can't reach game server. Is it running?");
});
socket.on("errorMsg", msg => toast(msg));

let lastStateYou = null;
let lastPhase = "lobby";
let lastPromptKey = null;
let lastRevealIdx = -1;

function serializePromptKey(p){
  try { return JSON.stringify(p); } catch { return String(p); }
}

socket.on("state", (state) => {
  const { code, phase, isHost, prompt, players, submissions, you, round, revealIndex } = state;
  lastStateYou = you;

  // Clear score cache when starting a fresh submit
  if (phase === "submit" && lastPhase !== "submit") {
    cacheAllForScore = null;
  }

  // Keep a fallback copy for SCORE:
  // - While in VOTE (authors hidden), keep parts so we can still render something
  if (phase === "vote" && Array.isArray(submissions) && submissions.length) {
    cacheAllForScore = submissions.map(s => ({ id: s.id, parts: s.parts, playerId: s.playerId, votes: s.votes }));
  }
  // - When SCORE arrives with proper authors, overwrite cache with authoritative version
  if (phase === "score" && Array.isArray(submissions) && submissions.length) {
    cacheAllForScore = submissions.map(s => ({ id: s.id, parts: s.parts, playerId: s.playerId, votes: s.votes }));
  }

  const nameById = {};
  (players || []).forEach(p => { nameById[p.id] = p.name; });

  // --- SFX triggers (compute before rendering) ---
  const promptKey = serializePromptKey(prompt);

  // New prompt sound: entering submit OR prompt value changed while in submit
  if (phase === "submit" && (lastPhase !== "submit" || promptKey !== lastPromptKey)) {
    playSfx($sfxPrompt);
  }

  // Reveal sound only when an item actually appears (revealIndex increases to >= 0)
  if (phase === "reveal" && typeof revealIndex === "number" && revealIndex >= 0 && revealIndex > lastRevealIdx) {
    playSfx($sfxReveal);
  }

  // Header info
  $roomInfo.textContent = code ? `Room ${code} — Round ${round || 0}` : "";
  $roomCode.textContent = code || "";

  // Show sections
  $auth.classList.toggle("hidden", !!code);
  $lobby.classList.toggle("hidden", !(code && phase === "lobby"));
  $game.classList.toggle("hidden", !(code && phase !== "lobby"));

  // Lobby
  $players.innerHTML = "";
  (players || []).forEach(p => {
    const span = document.createElement("span");
    span.className = "pill";
    span.textContent = `${p.name} • ${p.score}`;
    $players.appendChild(span);
  });
  $btnStart.disabled = !isHost;
  $btnStart.classList.toggle("hidden", phase !== "lobby");

  // Phase badge
  const phaseLabel = { lobby:"Lobby", submit:"Pick a response", reveal:"Revealing", vote:"Vote", score:"Scores" }[phase] || phase;
  $phaseBadge.textContent = phaseLabel;

  // ===== Phone prompt (image can create a second full prompt bubble for caption) =====
  const parsedPrompt = parsePrompt(prompt);
  if ($contactName) $contactName.textContent = parsedPrompt.from || "Unknown";

  // Ensure any extra prompt bubble from previous render is removed
  const oldExtra = document.getElementById("promptExtra");
  if (oldExtra && oldExtra.parentElement) oldExtra.parentElement.removeChild(oldExtra);

  $prompt.classList.toggle("media", parsedPrompt.kind === "image");
  $prompt.innerHTML = "";
  if (parsedPrompt.kind === "image") {
    $prompt.appendChild(createImageEl(parsedPrompt.url, "imgMessage"));
    if (parsedPrompt.caption) {
      const extra = document.createElement("div");
      extra.id = "promptExtra";
      extra.className = "bubble prompt";
      extra.textContent = parsedPrompt.caption;
      $prompt.after(extra);
    }
  } else {
    $prompt.textContent = parsedPrompt.text || "—";
  }

  // Responses area
  $responses.innerHTML = "";

  if (phase === "reveal") {
    // Server sends only the current one; render whatever comes
    (submissions || []).forEach(s => {
      addSenderTag($responses, s.isYou ? "You" : "Someone", true);
      const parts = (Array.isArray(s.parts) && s.parts.length) ? s.parts : s.text;
      appendReplyParts($responses, parts);
    });
  }

  if (phase === "vote") {
    $voteHint.classList.remove("hidden");
    $voteHint.textContent = you?.hasVoted ? "Vote submitted." : "Tap a response to vote.";
    (submissions || []).forEach(s => {
      addSenderTag($responses, s.isYou ? "You" : "Someone", true);
      const parts = (Array.isArray(s.parts) && s.parts.length) ? s.parts : s.text;
      appendReplyParts($responses, parts, {
        voteable: true,
        selected: you?.votedFor === s.id,
        onVote: () => socket.emit("castVote", s.id)
      });
    });
  } else if (phase === "reveal" && typeof revealIndex === "number" && revealIndex < 0) {
    // Everyone's in or host forced; waiting for host to start
    $voteHint.classList.remove("hidden");
    $voteHint.textContent = isHost
      ? "All responses are in. Press Start reveal."
      : "All responses are in. Waiting for host…";
  } else if (phase === "submit" && isHost) {
    $voteHint.classList.remove("hidden");
    $voteHint.textContent = "Waiting for players… You can Force start if needed.";
  } else {
    $voteHint.classList.add("hidden");
  }

  if (phase === "score") {
    // Prefer server-provided submissions; if empty for any reason, use our cache
    const scoreSubs = (Array.isArray(submissions) && submissions.length)
      ? submissions
      : (Array.isArray(cacheAllForScore) ? cacheAllForScore : []);

    scoreSubs.forEach(s => {
      const who = s.playerId ? (nameById[s.playerId] || "Unknown") : "Unknown";
      addSenderTag($responses, who, true);
      const parts = (Array.isArray(s.parts) && s.parts.length) ? s.parts : s.text;
      appendReplyParts($responses, parts);
    });
  }

  // Host reveal buttons
  const hostCanReveal = (phase === "reveal" && isHost);
  $btnReveal.classList.toggle("hidden", !hostCanReveal);
  if (hostCanReveal) {
    $btnReveal.textContent = (typeof revealIndex === "number" && revealIndex < 0)
      ? "Start reveal ▶"
      : "Next response ▶";
  }

  // Force start only during submit for host
  $btnForceStart?.classList.toggle("hidden", !(isHost && phase === "submit"));

  // --- Render hand (text grid + media strip) ---
  renderHandCards(you, phase);

  // Leaderboard
  $leaderboard.innerHTML = "";
  if (players?.length) {
    const title = document.createElement("h4");
    title.textContent = "Leaderboard";
    $leaderboard.appendChild(title);
    players.sort((a,b)=> b.score - a.score).forEach(p => {
      const row = document.createElement("div");
      row.className = "lbRow";
      row.innerHTML = `<div>${escapeHtml(p.name)}</div><div>${p.score}</div>`;
      $leaderboard.appendChild(row);
    });
  }

  $btnStartFromGame.classList.toggle("hidden", !(isHost && phase === "score"));
  autoScrollIfNearBottom();

  // --- update trackers last ---
  lastPromptKey = promptKey;
  lastRevealIdx = (phase === "reveal") ? (typeof revealIndex === "number" ? revealIndex : -1) : -1;
  lastPhase = phase;
  if (phase !== "submit") closeDrawer();
});

function renderHandCards(you, phase){
  const submitted = !!(you?.submittedParts || you?.submittedCard);
  $handText.innerHTML = "";
  $handMedia.innerHTML = "";
  let mediaCount = 0;

  const canPick = phase === "submit" && !submitted;

  (you?.hand || []).forEach((card, index) => {
    const info = parseCardContent(card);
    const isImg = info.kind === "image";
    const selected = isImg
      ? (pick.imageIndex === index)
      : (pick.textIndex === index);

    const btn = buildHandCard(
      card,
      () => {
        if (!canPick) return;
        if (isImg) {
          pick.imageIndex = selected ? null : index;
        } else {
          pick.textIndex = selected ? null : index;
        }
        renderHandControls(phase, submitted);
        renderHandCards(you, phase); // re-render for selected state
      },
      !canPick,
      selected
    );

    if (isImg) {
      mediaCount++;
      $handMedia.appendChild(btn);
    } else {
      $handText.appendChild(btn);
    }
  });

  $handMediaWrap.classList.toggle("hidden", mediaCount === 0);
  renderHandControls(phase, submitted);

  // Submitted summary
  if (submitted) {
    const div = document.createElement("div");
    div.className = "muted";
    div.style.marginTop = "8px";
    if (you?.submittedParts?.length) {
      const kinds = you.submittedParts.map(p => p.kind).join(" + ");
      div.textContent = `Submitted: ${kinds}`;
    } else if (you?.submittedCard) {
      div.textContent = `Submitted: “${you.submittedCard}”`;
    }
    $handText.appendChild(div);
  }
}

// --- tiny HTML escaper for innerHTML usage ---
function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[c]));
}
