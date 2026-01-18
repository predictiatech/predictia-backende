// ======================================================
// PredictIA Engine – index.js (VERSÃO FINAL CORRIGIDA)
// - Filtro de liga mantido e funcional
// - Gemini restaurada com fallback de modelo e log detalhado
// ======================================================

import "dotenv/config";
import express from "express";
import cors from "cors";
import { GoogleGenerativeAI } from "@google/generative-ai";

const app = express();
app.use(cors());
app.use(express.json());

// =====================
// ENV & CONFIG
// =====================
const API_KEY = process.env.API_SPORTS_KEY || process.env.FOOTBALL_API_KEY;
const GENAI_KEY = process.env.GEMINI_API_KEY;

// Dica: gemini-1.5-flash é mais rápido e raramente dá erro de cota
const GENAI_MODEL = process.env.GEMINI_MODEL || "gemini-1.5-flash"; 

if (!API_KEY) console.error("FALTA API_KEY: Configure no seu painel de controle.");
if (!GENAI_KEY) console.error("FALTA GEMINI_API_KEY: A IA não vai funcionar sem a chave.");

const FOOTBALL_BASE = "https://v3.football.api-sports.io";

// =====================
// GEMINI (IA)
// =====================
const genAI = GENAI_KEY ? new GoogleGenerativeAI(GENAI_KEY) : null;

async function getAIAnalysis(gameInfo) {
  // Se a chave não existir, o erro já começa aqui
  if (!genAI) {
    console.error("ERRO: genAI não foi inicializado. Verifique a GEMINI_API_KEY.");
    return "IA não configurada no servidor.";
  }

  try {
    const model = genAI.getGenerativeModel({ model: GENAI_MODEL });

    const prompt = `Aja como um analista esportivo profissional para o app PredictIA.
Responda em PT-BR.
Dê uma recomendação curta (máx 4 linhas), com risco (baixo/médio/alto) e 1 justificativa.
Dados do Jogo: ${JSON.stringify(gameInfo)}`;

    const result = await model.generateContent(prompt);
    const response = await result.response;
    return response.text();

  } catch (err) {
    // Log detalhado para você ver no console do Render/Terminal
    console.error("--- ERRO GEMINI ---");
    console.error("Mensagem:", err?.message);
    return "Erro na análise da IA. Verifique os logs.";
  }
}

// =====================
// UTILS & ADAPTERS
// =====================
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pick(obj, keys) {
  const out = {};
  keys.forEach((k) => { if (obj?.[k] !== undefined) out[k] = obj[k]; });
  return out;
}

async function apiSports(base, path, params = {}) {
  const url = new URL(base + path);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  });

  try {
    const response = await fetch(url.toString(), {
      headers: { "x-apisports-key": API_KEY },
    });
    const json = await response.json();
    return response.ok ? json : { response: [], errors: { http: response.status } };
  } catch (e) {
    return { response: [], errors: { internal: e.message } };
  }
}

async function apiSportsRetryNonEmpty(base, path, params) {
  for (let i = 0; i < 3; i++) {
    const last = await apiSports(base, path, params);
    if (Array.isArray(last.response) && last.response.length > 0) return last;
    if (i < 2) await sleep(1200);
  }
  return { response: [] };
}

const ADAPTERS = {
  football: {
    getGames: ({ date, live, leagueId }) => ({
      path: "/fixtures",
      params: live
        ? (leagueId ? { live: "all", league: leagueId } : { live: "all" })
        : (leagueId ? { date, league: leagueId } : { date }),
    }),
    extractLiveScore: (item) => ({
      fixtureId: item?.fixture?.id,
      league: item?.league ? { id: item.league.id, name: item.league.name } : null,
      teams: item?.teams,
      goals: item?.goals,
      score: item?.score,
      status: item?.fixture?.status,
      time: item?.fixture?.status?.elapsed,
    }),
    extractCornersFromStats: (stats = []) => {
      const perTeam = stats.map((row) => ({
        team: row.team,
        corners: row.statistics?.find((x) => x.type === "Corner Kicks")?.value ?? 0
      }));
      const total = perTeam.reduce((a, b) => a + Number(b.corners || 0), 0);
      return { total, perTeam };
    }
  }
};

// =====================
// ROTAS
// =====================
app.get("/", (_, res) => res.send("PredictIA Engine Online"));

// Rota LIVE com filtro de liga (Mantida!)
app.get("/football/live", async (req, res) => {
  const leagueId = req.query.leagueId ? Number(req.query.leagueId) : undefined;
  const cfg = ADAPTERS.football.getGames({ live: true, leagueId });
  const data = await apiSports(FOOTBALL_BASE, cfg.path, cfg.params);

  res.json({
    status: "ok",
    data: (data.response || []).map(ADAPTERS.football.extractLiveScore)
  });
});

// Detalhes da Partida + IA
app.get("/football/match/:fixtureId", async (req, res) => {
  const fixtureId = Number(req.params.fixtureId);
  const wantAnalysis = req.query.analysis === "true";
  const out = { fixtureId };

  const base = await apiSports(FOOTBALL_BASE, "/fixtures", { id: fixtureId });
  const item = base.response?.[0];
  if (!item) return res.status(404).json({ error: "Fixture não encontrado" });

  out.game = item;
  out.live_score = ADAPTERS.football.extractLiveScore(item);

  const stats = await apiSportsRetryNonEmpty(FOOTBALL_BASE, "/fixtures/statistics", { fixture: fixtureId });
  out.live_stats = stats.response || [];
  out.corners = ADAPTERS.football.extractCornersFromStats(out.live_stats);

  const events = await apiSports(FOOTBALL_BASE, "/fixtures/events", { fixture: fixtureId });
  out.goals = (events.response || []).filter(e => e.type === "Goal");
  out.cards = (events.response || []).filter(e => e.type === "Card");

  if (wantAnalysis) {
    // Enviando apenas o necessário para a IA não se perder
    const aiData = pick(out, ["live_score", "live_stats", "goals", "cards", "corners"]);
    out.ai_prediction = await getAIAnalysis(aiData);
  }

  res.json({ status: "ok", data: out });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Servidor PredictIA na porta ${PORT}`));
