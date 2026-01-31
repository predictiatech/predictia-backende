// FILE: index.js (COMPLETO E FUNCIONAL)

import "dotenv/config";
import express from "express";
import cors from "cors";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { LRUCache } from "lru-cache";

const app = express();
app.use(cors());
app.use(express.json());

const API_KEY = process.env.API_SPORTS_KEY;
const GENAI_KEY = process.env.GEMINI_API_KEY;
const GENAI_MODEL_RAW = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const FOOTBALL_BASE = "https://v3.football.api-sports.io";
const ODD_MIN = Number(process.env.ODD_MIN || 1.4);
const ODD_MAX = Number(process.env.ODD_MAX || 2.3);

// ---------------- CACHES PROFISSIONAIS ----------------
const snapshotCache = new LRUCache({ max: 500, ttl: 1000 * 60 });
const aiCache = new LRUCache({ max: 500, ttl: 1000 * 60 });

// Anti race condition
const snapshotInFlight = new Map();
const aiInFlight = new Map();

// ---------------- HELPERS ----------------
const safeNumber = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

// ---------------- API CLIENT ----------------
async function apiSports(path, params = {}) {
  try {
    const url = new URL(FOOTBALL_BASE + path);
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
    const r = await fetch(url, { headers: { "x-apisports-key": API_KEY } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } catch (e) {
    console.error("[API-SPORTS ERROR]", path, e.message);
    throw e;
  }
}

// ---------------- SNAPSHOT ENGINE ----------------
async function buildSnapshot(fixtureId) {
  console.log("[SNAPSHOT] building", fixtureId);

  const fx = await apiSports("/fixtures", { id: fixtureId });
  const item = fx?.response?.[0];
  if (!item) return null;

  const snapshot = {
    match: {
      fixtureId,
      teams: {
        home: item.teams.home.name,
        away: item.teams.away.name,
      },
      time: { elapsed: safeNumber(item.fixture.status.elapsed) },
      score: {
        home: safeNumber(item.goals.home),
        away: safeNumber(item.goals.away),
      },
    },
    events: {},
    odds: [],
    stats: { available: false, data: null },
  };

  // EVENTS
  const ev = await apiSports("/fixtures/events", { fixture: fixtureId });
  const events = ev.response || [];
  snapshot.events = {
    goals: events.filter((e) => e.type === "Goal").length,
    redcards: events.filter((e) =>
      String(e.detail).toLowerCase().includes("red")
    ).length,
  };

  // ODDS
  const odds = await apiSports("/odds/live", { fixture: fixtureId });
  for (const root of odds.response || []) {
    for (const bm of root.bookmakers || []) {
      for (const bet of bm.bets || []) {
        for (const v of bet.values || []) {
          const odd = safeNumber(v.odd);
          if (odd >= ODD_MIN && odd <= ODD_MAX) {
            snapshot.odds.push({
              id: snapshot.odds.length + 1,
              market: bet.name,
              selection: v.value,
              odd,
            });
          }
        }
      }
    }
  }

  // STATS só se existir odd válida
  if (snapshot.odds.length > 0) {
    const stats = await apiSports("/fixtures/statistics", {
      fixture: fixtureId,
    });
    if ((stats.response || []).length >= 2) {
      snapshot.stats = { available: true, data: stats.response };
    }
  }

  return snapshot;
}

// ---------------- SNAPSHOT WRAPPER (LRU + DEDUP) ----------------
async function getSnapshot(fixtureId) {
  if (snapshotCache.has(fixtureId))
    return snapshotCache.get(fixtureId);
  if (snapshotInFlight.has(fixtureId))
    return snapshotInFlight.get(fixtureId);

  const p = buildSnapshot(fixtureId)
    .then((snap) => {
      snapshotCache.set(fixtureId, snap);
      snapshotInFlight.delete(fixtureId);
      return snap;
    })
    .catch((e) => {
      snapshotInFlight.delete(fixtureId);
      throw e;
    });

  snapshotInFlight.set(fixtureId, p);
  return p;
}

// ---------------- IA ENGINE ----------------
const genAI = new GoogleGenerativeAI(GENAI_KEY);

async function getAI(snapshot, fixtureId) {
  if (aiCache.has(fixtureId)) return aiCache.get(fixtureId);
  if (aiInFlight.has(fixtureId)) return aiInFlight.get(fixtureId);

  const p = (async () => {
    try {
      const aiData = {
        match: snapshot.match,
        live: {
          odds: snapshot.odds,
          events: snapshot.events,
          statistics: snapshot.stats.data,
          top_evs: [],
          top_evs_available: false,
        },
      };

      const prompt = `Você é o "PredictIA Engine v2.1 Elite", um sistema de inteligência quantitativa para futebol ao vivo.

MISSÃO:
Sua tarefa é realizar a convergência entre a ARBITRAGEM MATEMÁTICA e o MOMENTUM DO JOGO.
Você deve escolher 1 (um) único palpite que represente o maior "Edge" (vantagem) real no momento.

════════════════════════════════════
PROTOCOLO DE DECISÃO (ORDEM DE PESO)
════════════════════════════════════

1. FILTRO DE EV:
- Use live.top_evs se existir, senão seja conservador.

2. MOMENTUM:
- DAPM, SOT e Game State.

3. REGRAS:
- match < 10 → sem análise
- odd entre ${ODD_MIN} e ${ODD_MAX}

FILTRO ANTI-UNDER:
- Sem under antes de 25 min.

SAÍDA:
Recomendação:
Odd:
Probabilidade de Green:
EV:
Risco:
Justificativa:

DADOS:
${JSON.stringify(aiData)}`;

      const model = genAI.getGenerativeModel({ model: GENAI_MODEL_RAW });
      const res = await model.generateContent(prompt);
      const text = res.response.text();

      aiCache.set(fixtureId, text);
      aiInFlight.delete(fixtureId);
      return text;
    } catch (e) {
      aiInFlight.delete(fixtureId);
      console.error("[IA ERROR]", e.message);
      throw e;
    }
  })();

  aiInFlight.set(fixtureId, p);
  return p;
}

// ---------------- ROUTE ----------------
app.get("/football/match/:fixtureId", async (req, res) => {
  const fixtureId = Number(req.params.fixtureId);

  try {
    const snap = await getSnapshot(fixtureId);
    if (!snap) return res.status(404).json({ error: "Jogo não encontrado" });

    const ai = await getAI(snap, fixtureId);
    res.json({ status: "ok", snapshot: snap, ai });
  } catch (e) {
    console.error("[ROUTE ERROR]", fixtureId, e.message);
    res.status(500).json({ error: "Erro interno do servidor" });
  }
});

// ---------------- SERVER ----------------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log("PredictIA Engine PRO rodando na porta", PORT);
});
