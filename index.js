// ======================================================
// PredictIA Engine – index.js (MODO ANTIGO / ESTÁVEL)
// - Mantém o filtro por leagueId no /football/live (como combinamos)
// - Mantém retorno do LIVE com league {id,name}
// - VOLTA a IA para o modo antigo: prompt curto + gemini-pro
// - Adiciona log do erro real (SEM mudar a resposta de erro)
// ======================================================

import "dotenv/config";
import express from "express";
import cors from "cors";
import { GoogleGenerativeAI } from "@google/generative-ai";

const app = express();
app.use(cors());
app.use(express.json());

// =====================
// ENV
// =====================
const API_KEY = process.env.API_SPORTS_KEY || process.env.FOOTBALL_API_KEY;
const GENAI_KEY = process.env.GEMINI_API_KEY;
const GENAI_MODEL = process.env.GEMINI_MODEL || "gemini-pro";

if (!API_KEY) {
  console.error("FALTA API_KEY: defina API_SPORTS_KEY ou FOOTBALL_API_KEY");
}

const FOOTBALL_BASE = "https://v3.football.api-sports.io";
const NBA_BASE = "https://v2.nba.api-sports.io";

// =====================
// GEMINI
// =====================
const genAI = GENAI_KEY ? new GoogleGenerativeAI(GENAI_KEY) : null;

// IA (MODO ANTIGO)
async function getAIAnalysis(gameInfo) {
  if (!genAI) return "IA não configurada.";
  try {
    const model = genAI.getGenerativeModel({ model: GENAI_MODEL });

    const prompt = `Aja como um analista esportivo profissional para o app PredictIA.
Responda em PT-BR.
Dê uma recomendação curta (máx 4 linhas), com risco (baixo/médio/alto) e 1 justificativa.
Dados: ${JSON.stringify(gameInfo)}`;

    const result = await model.generateContent(prompt);
    return result.response.text();
  } catch (err) {
    console.error("GEMINI ERROR:", err?.message || err);
    return "Erro na análise da IA.";
  }
}

// =====================
// UTILS
// =====================
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pick(obj, keys) {
  const out = {};
  keys.forEach((k) => {
    if (obj?.[k] !== undefined) out[k] = obj[k];
  });
  return out;
}

// =====================
// API-SPORTS CORE
// =====================
async function apiSports(base, path, params = {}) {
  const url = new URL(base + path);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== "") {
      url.searchParams.set(k, String(v));
    }
  });

  try {
    const response = await fetch(url.toString(), {
      headers: { "x-apisports-key": API_KEY },
    });

    const json = await response.json();
    if (!response.ok) {
      return { response: [], errors: { http: response.status }, raw: json };
    }
    return json;
  } catch (e) {
    return { response: [], errors: { internal: e.message } };
  }
}

async function apiSportsRetryNonEmpty(base, path, params, tries = 3, delayMs = 1200) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    last = await apiSports(base, path, params);
    if (Array.isArray(last.response) && last.response.length > 0) {
      return { ...last, _retry: { tries: i + 1, ok: true } };
    }
    if (i < tries - 1) await sleep(delayMs);
  }
  return { ...(last || { response: [] }), _retry: { tries, ok: false } };
}

// =====================
// ADAPTERS
// =====================
const ADAPTERS = {
  football: {
    // mantém o filtro leagueId (como combinamos)
    getGames: ({ date, live, leagueId }) => ({
      path: "/fixtures",
      params: live
        ? (leagueId ? { live: "all", league: leagueId } : { live: "all" })
        : (leagueId ? { date, league: leagueId } : { date }),
    }),

    // mantém league {id,name} no LIVE (para seu Android)
    extractLiveScore: (item) => ({
      fixtureId: item?.fixture?.id,
      league: item?.league ? { id: item.league.id, name: item.league.name } : null,
      teams: item?.teams,
      goals: item?.goals,
      score: item?.score,
      status: item?.fixture?.status,
      time: item?.fixture?.status?.elapsed,
    }),

    extractGoalsFromEvents: (events = []) =>
      events.filter((e) => e?.type === "Goal"),

    extractCardsFromEvents: (events = []) =>
      events.filter((e) => e?.type === "Card"),

    extractCornersFromStats: (stats = []) => {
      const perTeam = stats.map((row) => {
        const s = row.statistics || [];
        const c = s.find((x) => x.type === "Corner Kicks")?.value ?? 0;
        return { team: row.team, corners: c };
      });
      const total = perTeam.reduce((a, b) => a + Number(b.corners || 0), 0);
      return { total, perTeam };
    },
  },
};

// =====================
// ROUTES
// =====================
app.get("/", (_, res) => res.send("PredictIA Engine Online"));

// LIVE com filtro por liga (como combinamos)
// ex: /football/live?leagueId=475
app.get("/football/live", async (req, res) => {
  const leagueId = req.query.leagueId ? Number(req.query.leagueId) : undefined;

  const cfg = ADAPTERS.football.getGames({ live: true, leagueId });
  const data = await apiSports(FOOTBALL_BASE, cfg.path, cfg.params);

  res.json({
    status: "ok",
    data: (data.response || []).map(ADAPTERS.football.extractLiveScore),
    raw: data.errors ? { errors: data.errors } : undefined,
  });
});

app.get("/football/match/:fixtureId", async (req, res) => {
  const fixtureId = Number(req.params.fixtureId);
  const wantAnalysis = String(req.query.analysis || "").toLowerCase() === "true";

  const out = { fixtureId };

  // base fixture sempre
  const base = await apiSports(FOOTBALL_BASE, "/fixtures", { id: fixtureId });
  const item = base.response?.[0];
  if (!item) return res.status(404).json({ error: "Fixture não encontrado" });

  out.game = item;
  out.live_score = ADAPTERS.football.extractLiveScore(item);

  const statsTry = await apiSportsRetryNonEmpty(
    FOOTBALL_BASE,
    "/fixtures/statistics",
    { fixture: fixtureId }
  );
  out.live_stats = statsTry.response || [];
  out.corners = ADAPTERS.football.extractCornersFromStats(out.live_stats);

  const events = await apiSports(FOOTBALL_BASE, "/fixtures/events", { fixture: fixtureId });
  out.goals = ADAPTERS.football.extractGoalsFromEvents(events.response || []);
  out.cards = ADAPTERS.football.extractCardsFromEvents(events.response || []);

  const odds = await apiSports(FOOTBALL_BASE, "/odds/live", { fixture: fixtureId });
  out.live_odds = odds.response || [];

  if (wantAnalysis) {
    // MODO ANTIGO: manda dados “crus” (como antes) + prompt curto
    out.ai_prediction = await getAIAnalysis(
      pick(out, ["live_score", "live_stats", "goals", "cards", "corners", "live_odds"])
    );
  }

  res.json({ status: "ok", data: out });
});

// =====================
// SERVER
// =====================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("Servidor rodando na porta", PORT));
