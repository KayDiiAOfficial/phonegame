// deck.js
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DECK_DIR = path.join(__dirname, "data", "decks");

let decksMap = new Map(); // id -> { id, name, prompts:[], responses:[] }

function shuffle(a){
  for (let i = a.length - 1; i > 0; i--){
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function loadDecks(){
  decksMap.clear();
  if (!fs.existsSync(DECK_DIR)) fs.mkdirSync(DECK_DIR, { recursive: true });

  const files = fs.readdirSync(DECK_DIR).filter(f => f.endsWith(".json"));
  for (const f of files){
    const full = path.join(DECK_DIR, f);
    try {
      const raw = JSON.parse(fs.readFileSync(full, "utf8"));
      const id = (raw.id || path.basename(f, ".json")).trim();
      const name = raw.name || id;
      const prompts = Array.isArray(raw.prompts) ? raw.prompts.slice() : [];
      const responses = Array.isArray(raw.responses) ? raw.responses.slice() : [];
      if (!id) continue;
      decksMap.set(id, { id, name, prompts, responses });
    } catch (e){
      console.error("Failed to load deck:", f, e.message);
    }
  }

  if (!decksMap.has("default")){
    console.warn("No default deck found. Creating a tiny built-in default.");
    decksMap.set("default", {
      id: "default",
      name: "Default",
      prompts: [
        "Boss: Can you come in on Saturday?",
        { from: "Unknown", image: "https://picsum.photos/400/260", caption: "New phone, who dis?" }
      ],
      responses: [
        "My lawyer says no.",
        "I'll be there in 5–7 business days.",
        "https://media.giphy.com/media/3oEjI6SIIHBdRxXI40/giphy.gif"
      ]
    });
  }

  console.log(`Loaded decks: ${[...decksMap.keys()].join(", ")}`);
}

export function watchDecks(){
  if (!fs.existsSync(DECK_DIR)) return;
  try {
    fs.watch(DECK_DIR, { persistent: false }, (evt, file) => {
      if (file && file.endsWith(".json")) {
        console.log("Deck change detected:", file);
        loadDecks();
      }
    });
  } catch (e){
    console.warn("fs.watch not available:", e.message);
  }
}

export function listDecks(){
  return [...decksMap.values()].map(d => ({
    id: d.id,
    name: d.name,
    promptCount: d.prompts.length,
    responseCount: d.responses.length
  }));
}

export function getFreshDeck(selectedIds = ["default"]){
  const ids = (Array.isArray(selectedIds) && selectedIds.length) ? selectedIds : ["default"];
  const prompts = [];
  const responses = [];
  for (const id of ids){
    const d = decksMap.get(id);
    if (!d) continue;
    prompts.push(...d.prompts);
    responses.push(...d.responses);
  }
  return {
    prompts: shuffle(prompts.slice()),
    responses: shuffle(responses.slice())
  };
}
