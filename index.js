// FILE: index.js (COMPLETO E FUNCIONAL) — COM LIVE + FALLBACK DA CHAVE

import "dotenv/config";
import express from "express";
import cors from "cors";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { LRUCache } from "lru-cache";

const app = express();
app.use(cors());
app.use(express.json());

// ---------------- ENV ----------------
const API_KEY = process.env.API_SPORTS_KEY || process.env.FOOTBALL_API_KEY; // ✅ fallback corrigido
const GENAI_KEY = process.env.GEMINI_API_KEY;
const GENAI_MODEL_RAW = (process.env.GEMINI_MODEL || "gemini-2.5-flash").trim();

const FOOTBALL_BASE = "https://v3.football.api-sports.io";
const ODD_MIN = Number(process.env.ODD_MIN || 1.4);
const ODD_MAX = Number(process.env.ODD_MAX || 2.3);

if (!API_KEY) console.error("FALTA API_SPORTS_KEY ou FOOTBALL_API_KEY");
if (!GENAI_KEY) console.error("FALTA GEMINI_API_KEY");

// ---------------- CACHES ----------------
const snapshotCache = new LRUCache({ max: 500, ttl: 1000 * 60 });
const aiCache = new LRUCache({ max: 500, ttl: 1000 * 60 });

// Cache live list (curto, p/ não spammar live=all)
const liveCache = new LRUCache({ max: 50, ttl: 1000 * 10 }); // 10s
const liveInFlight = new Map();

// Anti race condition (dedup por fixtureId)
const snapshotInFlight = new Map();
const aiInFlight = new Map();

// ---------------- HELPERS ----------------
const safeNumber = (v, d = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

const isValidFixtureId = (n) =>
  Number.isFinite(n) && Number.isInteger(n) && n > 0;

// ---------------- API CLIENT ----------------
async function apiSports(path, params = {}) {
  try {
    if (!API_KEY) throw new Error("MISSING_API_SPORTS_KEY");

    const url = new URL(FOOTBALL_BASE + path);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }

    const r = await fetch(url, { headers: { "x-apisports-key": API_KEY } });
    if (!r.ok) throw new Error(`API_SPORTS_HTTP_${r.status}`);
    return await r.json();
  } catch (e) {
    console.error("[API-SPORTS ERROR]", path, e.message);
    throw e;
  }
}

// ---------------- LIVE (JOGOS AO VIVO) ----------------
async function fetchLiveFixtures() {
  const cacheKey = "live_all";
  if (liveCache.has(cacheKey)) return liveCache.get(cacheKey);
  if (liveInFlight.has(cacheKey)) return liveInFlight.get(cacheKey);

  const p = apiSports("/fixtures", { live: "all" })
    .then((data) => {
      const list = data?.response || [];
      liveCache.set(cacheKey, list);
      liveInFlight.delete(cacheKey);
      return list;
    })
    .catch((e) => {
      liveInFlight.delete(cacheKey);
      throw e;
    });

  liveInFlight.set(cacheKey, p);
  return p;
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
        home: item?.teams?.home?.name ?? "Home",
        away: item?.teams?.away?.name ?? "Away",
      },
      time: { elapsed: safeNumber(item?.fixture?.status?.elapsed) },
      score: {
        home: safeNumber(item?.goals?.home),
        away: safeNumber(item?.goals?.away),
      },
    },
    events: { goals: 0, redcards: 0 },
    odds: [],
    stats: { available: false, data: null },
  };

  // EVENTS
  const ev = await apiSports("/fixtures/events", { fixture: fixtureId });
  const events = ev?.response || [];
  snapshot.events = {
    goals: events.filter((e) => e?.type === "Goal").length,
    redcards: events.filter((e) =>
      String(e?.detail || "").toLowerCase().includes("red")
    ).length,
  };

  // ODDS (CATÁLOGO PARA ODD_ID)
  const odds = await apiSports("/odds/live", { fixture: fixtureId });
  for (const root of odds?.response || []) {
    for (const bm of root?.bookmakers || []) {
      for (const bet of bm?.bets || []) {
        for (const v of bet?.values || []) {
          const odd = safeNumber(v?.odd);
          if (odd >= ODD_MIN && odd <= ODD_MAX) {
            snapshot.odds.push({
              id: snapshot.odds.length + 1, // ODD_ID do seu catálogo (por snapshot)
              market: String(bet?.name || ""),
              selection: String(v?.value || ""),
              odd,
            });
          }
        }
      }
    }
  }

  // STATS só se existir odd válida
  if (snapshot.odds.length > 0) {
    const stats = await apiSports("/fixtures/statistics", { fixture: fixtureId });
    if ((stats?.response || []).length >= 2) {
      snapshot.stats = { available: true, data: stats.response };
    }
  }

  return snapshot;
}

// ---------------- SNAPSHOT WRAPPER (LRU + DEDUP) ----------------
async function getSnapshot(fixtureId) {
  if (snapshotCache.has(fixtureId)) return snapshotCache.get(fixtureId);
  if (snapshotInFlight.has(fixtureId)) return snapshotInFlight.get(fixtureId);

  const p = buildSnapshot(fixtureId)
    .then((snap) => {
      if (snap) snapshotCache.set(fixtureId, snap); // evita cachear null
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
const genAI = new GoogleGenerativeAI(GENAI_KEY || ""); // erro tratado em getAI

async function getAI(snapshot, fixtureId) {
  if (!GENAI_KEY) throw new Error("MISSING_GEMINI_API_KEY");

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

1. FILTRO DE EV (EXPECTED VALUE):
- Se live.top_evs_available = true:
  * O palpite DEVE ser extraído obrigatoriamente da lista live.top_evs (já ordenada por EV% desc).
  * Analise o item #1. Se o cenário de jogo (momentum) for contrário, descarte como "VALUE TRAP" e avalie o item #2, sucessivamente.
  * Se nenhum item da lista sobreviver ao filtro de momentum, RECUSE a análise.

- Se live.top_evs_available = false:
  * Não há consenso multi-book. Seja EXTREMAMENTE conservador.
  * Só recomende se houver distorção óbvia baseada em estatísticas fortes (ex: DAPM > 1.2).

2. VALIDAÇÃO DE MOMENTUM (FILTRO DE CAMPO):
- DAPM (Ataques Perigosos/Min):
  * Se o palpite é a favor de um time (Vitória, Handicap, Over Gols dele),
    o DAPM desse time nos últimos 10–15 min deve ser > 0.7.
- CONVERSÃO:
  * Use SOT (Chutes no Gol). Se volume alto e SOT baixo, reduza P.
- GAME STATE:
  * Favorito perdendo em casa = urgência alta.
  * Time vencendo por 2+ = tendência de desaceleração.
  * Nunca aplique urgência sem confirmar em DAPM/momentum.

3. REGRAS DE SEGURANÇA (HARD RULES):
- Se match.elapsed < 10:
  -> Responda APENAS:
  "INSUFFICIENT DATA — match too early for analysis."
- EXPULSÕES:
  * Se o time do palpite tiver vermelho:
    - Reduza P em no mínimo 30 pontos percentuais ou recuse.
    - Reavalie usando apenas dados pós-expulsão.
- ODDS:
  * Odd deve estar obrigatoriamente entre ${ODD_MIN.toFixed(2)} e ${ODD_MAX.toFixed(2)}.
- CONSISTÊNCIA:
  * Use ODD_ID real do catálogo live.odds. Proibido inventar IDs.

════════════════════════════════════
FILTRO ANTI-UNDER-CEDO (OBRIGATÓRIO)
════════════════════════════════════
- Proibido recomendar qualquer mercado de "Menos de X gols" se match.elapsed < 25.
- Exceção (raríssima): só permitir UNDER antes de 25 se TODAS as condições abaixo forem verdade:
  1) Placar 0-0
  2) SOT_total <= 1
  3) DAPM_total < 0.9
  4) Probabilidade de Green >= 70%
  5) EV >= +0.06
  6) redcards = 0
  7) Não é favorito perdendo em casa
- Se o filtro bloquear:
  -> Retorne SEM OPORTUNIDADE
  -> Justificativa obrigatória: "Minuto cedo para Under; risco alto de mudança de ritmo."

4. FILTRO DE EDGE FINAL:
- Só prossiga se:
  (P_decimal * odd) > 1.08
  e EV positivo.

════════════════════════════════════
REGRAS DE SAÍDA (FORMATO ESTRITO)
════════════════════════════════════
Recomendação: <palpite> [ODD_ID=<N>]
Odd:
Probabilidade de Green:
EV:
Risco:
Justificativa:

DADOS PARA PROCESSAMENTO
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

// ---------------- ROUTES ----------------

// ✅ LISTA DE JOGOS AO VIVO (para sua tela de seleção)
app.get("/football/live", async (req, res) => {
  try {
    const liveList = await fetchLiveFixtures();

    // resposta enxuta (mantém info essencial)
    const games = liveList.map((it) => ({
      fixtureId: safeNumber(it?.fixture?.id),
      league: it?.league?.name ?? "",
      country: it?.league?.country ?? "",
      teams: {
        home: it?.teams?.home?.name ?? "",
        away: it?.teams?.away?.name ?? "",
      },
      elapsed: safeNumber(it?.fixture?.status?.elapsed),
      status: it?.fixture?.status?.short ?? "",
      score: {
        home: safeNumber(it?.goals?.home),
        away: safeNumber(it?.goals?.away),
      },
    })).filter((g) => isValidFixtureId(g.fixtureId));

    res.json({ status: "ok", games });
  } catch (e) {
    console.error("[LIVE ERROR]", e.message);
    res.status(500).json({ error: "Erro ao buscar jogos ao vivo" });
  }
});

// ✅ SNAPSHOT + IA POR FIXTURE
app.get("/football/match/:fixtureId", async (req, res) => {
  const fixtureId = Number(req.params.fixtureId);

  if (!isValidFixtureId(fixtureId)) {
    return res.status(400).json({ error: "fixtureId inválido" });
  }

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
const PORT = Number(process.env.PORT || 10000);
app.listen(PORT, () => {
  console.log("PredictIA Engine PRO rodando na porta", PORT);
});
