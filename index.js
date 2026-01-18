// ======================================================
// PredictIA Engine – index.js (COM GEMINI)
// Lógica original PRESERVADA
// Apenas: compactação + envio correto para IA
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
const GENAI_MODEL = process.env.GEMINI_MODEL || "gemini-1.5-flash";

if (!API_KEY) {
  console.error("FALTA API_KEY: defina API_SPORTS_KEY ou FOOTBALL_API_KEY");
}

const FOOTBALL_BASE = "https://v3.football.api-sports.io";
const NBA_BASE = "https://v2.nba.api-sports.io";

// =====================
// GEMINI
// =====================
const genAI = GENAI_KEY ? new GoogleGenerativeAI(GENAI_KEY) : null;

// =====================
// UTILS
// =====================
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function todayISO() {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

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
    getGames: ({ date, live }) => ({
      path: "/fixtures",
      params: live ? { live: "all" } : { date },
    }),

    extractLiveScore: (item) => ({
      fixtureId: item?.fixture?.id,
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

    extractCornerLineFromOdds: (odds = []) => {
      const markets = odds?.[0]?.odds || [];
      const m =
        markets.find((x) => /match corners/i.test(x.name)) ||
        markets.find((x) => /total corners/i.test(x.name));
      if (!m) return null;
      const v = m.values.find((x) => x.handicap);
      return { market: m.name, handicap: v?.handicap, odd: v?.odd };
    },
  },
};

// =====================
// COMPACTADORES (IA)
// =====================
function compactStats(live_stats = []) {
  return live_stats.map((row) => {
    const s = row.statistics || [];
    const get = (t) => s.find((x) => x.type === t)?.value ?? null;
    return {
      team: row.team.name,
      possession: get("Ball Possession"),
      shots: get("Total Shots"),
      shots_on_goal: get("Shots on Goal"),
      corners: get("Corner Kicks"),
      fouls: get("Fouls"),
      xg: get("expected_goals"),
    };
  });
}

function compactOdds(live_odds = []) {
  const odds = live_odds?.[0]?.odds || [];
  const pick = (regex) =>
    odds.find((o) => regex.test(o.name.toLowerCase()));
  return {
    match_corners: pick(/match corners|total corners/),
    goals_ou: pick(/over\/under|total goals/),
    btts: pick(/both teams to score|btts/),
  };
}

function buildGeminiPayload(out) {
  return {
    fixtureId: out.fixtureId,
    status: out.live_score?.status,
    elapsed: out.live_score?.time,
    teams: out.live_score?.teams,
    goals: out.live_score?.goals,
    stats: compactStats(out.live_stats),
    corners: out.corners,
    cards: out.cards,
    goals_events: out.goals,
    odds: compactOdds(out.live_odds),
  };
}

// =====================
// GEMINI ANALYSIS
// =====================
async function getAIAnalysis(payload) {
  if (!genAI) return "IA não configurada.";

  try {
    const model = genAI.getGenerativeModel({ model: GENAI_MODEL });

    const prompt = `
Você é a PREDICT IA, um tipster profissional consolidado no mercado de apostas esportivas,
com abordagem analítica, conservadora e orientada a valor esperado (EV).

Você entende profundamente FUTEBOL e NBA e atua como um analista profissional,
não como um apostador recreativo.

════════════════════════════════════
CONTEXTO DE ENTRADA
════════════════════════════════════
Você receberá EXCLUSIVAMENTE DADOS ESTRUTURADOS (JSON) de um jogo ao vivo,
contendo informações como:
placar, tempo, estatísticas, escanteios, cartões, eventos e odds.

NÃO há imagem.
NÃO há opinião do usuário.
NÃO há dados externos além do JSON fornecido.

════════════════════════════════════
IDENTIFICAÇÃO DA MODALIDADE
════════════════════════════════════
Identifique a modalidade com base nos dados:

• FUTEBOL
• NBA

Se não for possível identificar, responda apenas:
INVALIDO

════════════════════════════════════
REGRAS GERAIS (INEGOCIÁVEIS)
════════════════════════════════════
• Nunca mencione IA, modelos, tecnologia ou fontes
• Nunca prometa lucro garantido
• Linguagem: português do Brasil
• Seja técnico, objetivo e profissional
• Baseie TODAS as decisões exclusivamente nos dados do JSON
• NÃO invente gols, cartões, escanteios, tempo ou estatísticas
• Se algum dado não existir, escreva: "não informado"
• NÃO adapte respostas para agradar o usuário
• NÃO valide apostas fora do critério mínimo

════════════════════════════════════
CRITÉRIO DE CONFIANÇA (REGRA CENTRAL)
════════════════════════════════════
• Apenas valide palpites com confiança estimada ≥ 65%
• Qualquer mercado abaixo de 65% deve ser RECUSADO e NÃO listado

════════════════════════════════════
ANÁLISE – JOGO AO VIVO
════════════════════════════════════
Considere APENAS o que estiver disponível no JSON:
• Placar atual e tempo
• Posse de bola
• Finalizações
• xG
• Escanteios
• Cartões
• Tendência do jogo
• Odds e linhas disponíveis (se existirem)

════════════════════════════════════
ENTREGA DE PALPITES RECOMENDADOS
════════════════════════════════════
Entregue EXATAMENTE 3 palpites,
ordenados do MAIS SEGURO para o MAIS ARRISCADO,
TODOS com confiança estimada ≥ 65%.

Para cada palpite, informe:
• Mercado
• Justificativa técnica (NO MÁXIMO 1 FRASE)
• Confiança estimada (%)

════════════════════════════════════
DADOS DO JOGO (JSON)
════════════════════════════════════
${JSON.stringify(payload)}
`.trim();

    const r = await model.generateContent(prompt);
    return r.response.text();
  } catch {
    return "Erro na análise da IA.";
  }
}


// =====================
// ROUTES
// =====================
app.get("/", (_, res) => res.send("PredictIA Engine Online"));

app.get("/football/live", async (_, res) => {
  const cfg = ADAPTERS.football.getGames({ live: true });
  const data = await apiSports(FOOTBALL_BASE, cfg.path, cfg.params);
  res.json({
    status: "ok",
    data: data.response.map(ADAPTERS.football.extractLiveScore),
  });
});

app.get("/football/match/:fixtureId", async (req, res) => {
  const fixtureId = Number(req.params.fixtureId);
  const wantAnalysis = req.query.analysis === "true";

  const out = { fixtureId };

  const base = await apiSports(FOOTBALL_BASE, "/fixtures", { id: fixtureId });
  const item = base.response?.[0];
  if (!item) return res.status(404).json({ error: "Fixture não encontrado" });

  out.live_score = ADAPTERS.football.extractLiveScore(item);

  const statsTry = await apiSportsRetryNonEmpty(
    FOOTBALL_BASE,
    "/fixtures/statistics",
    { fixture: fixtureId }
  );
  out.live_stats = statsTry.response;
  out.corners = ADAPTERS.football.extractCornersFromStats(statsTry.response);

  const events = await apiSports(FOOTBALL_BASE, "/fixtures/events", {
    fixture: fixtureId,
  });
  out.goals = ADAPTERS.football.extractGoalsFromEvents(events.response);
  out.cards = ADAPTERS.football.extractCardsFromEvents(events.response);

  const odds = await apiSports(FOOTBALL_BASE, "/odds/live", {
    fixture: fixtureId,
  });
  out.live_odds = odds.response;

  if (wantAnalysis) {
    const payload = buildGeminiPayload(out);
    out.ai_prediction = await getAIAnalysis(payload);
  }

  res.json({ status: "ok", data: out });
});

// =====================
// SERVER
// =====================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("Servidor rodando na porta", PORT));
