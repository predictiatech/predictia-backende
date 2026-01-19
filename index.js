// ======================================================
// PredictIA Engine – index.js (ESTÁVEL + GEMINI AUTO-LISTMODELS FIX)
// - Resolve 404 de modelos: busca modelos disponíveis via ListModels (v1beta)
// - Escolhe automaticamente um modelo que SUPORTA generateContent
// - Mantém: /football/live com leagueId, /football/match/:fixtureId com analysis=true
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

// Opcional: se você quiser fixar um modelo manualmente
// Ex: GEMINI_MODEL=gemini-1.5-flash
const GENAI_MODEL = process.env.GEMINI_MODEL || "";

if (!API_KEY) console.error("FALTA API_SPORTS_KEY ou FOOTBALL_API_KEY");
if (!GENAI_KEY) console.error("FALTA GEMINI_API_KEY");

const FOOTBALL_BASE = "https://v3.football.api-sports.io";

// =====================
// GEMINI
// =====================
const genAI = GENAI_KEY ? new GoogleGenerativeAI(GENAI_KEY) : null;

// cache do modelo escolhido automaticamente
let _cachedModelName = null;
let _cachedModelCheckedAt = 0;

async function listGeminiModels() {
  // ListModels v1beta (mesmo host do erro)
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(
    GENAI_KEY
  )}`;

  const r = await fetch(url);
  const j = await r.json();

  if (!r.ok) {
    const msg = j?.error?.message || `HTTP ${r.status}`;
    const e = new Error(msg);
    e.status = r.status;
    e.raw = j;
    throw e;
  }

  return Array.isArray(j?.models) ? j.models : [];
}

function pickBestModel(models) {
  // pega somente os que suportam generateContent
  const ok = models.filter((m) =>
    (m?.supportedGenerationMethods || []).includes("generateContent")
  );

  // prioridade por nomes comuns; mas sem depender disso (pega o primeiro se não achar)
  const preferredOrder = [
    "gemini-2.0-flash",
    "gemini-2.0-pro",
    "gemini-1.5-flash",
    "gemini-1.5-pro",
    "gemini-1.0-pro",
  ];

  for (const pref of preferredOrder) {
    const found = ok.find((m) => String(m?.name || "").endsWith(`/models/${pref}`) || String(m?.name || "") === `models/${pref}`);
    if (found?.name) return found.name.replace(/^models\//, "models/"); // normaliza
  }

  // fallback: primeiro que suportar generateContent
  if (ok[0]?.name) return ok[0].name;

  return null;
}

async function resolveModelName() {
  if (!genAI) return null;

  // se o usuário fixar um modelo via ENV, usa primeiro
  if (GENAI_MODEL && GENAI_MODEL.trim()) {
    return GENAI_MODEL.trim().startsWith("models/")
      ? GENAI_MODEL.trim().replace(/^models\//, "")
        ? GENAI_MODEL.trim().replace(/^models\//, "models/")
        : GENAI_MODEL.trim()
      : GENAI_MODEL.trim();
  }

  // cache por 10 minutos
  const now = Date.now();
  if (_cachedModelName && now - _cachedModelCheckedAt < 10 * 60 * 1000) {
    return _cachedModelName;
  }

  const models = await listGeminiModels();
  const best = pickBestModel(models);

  _cachedModelName = best; // pode ser "models/xxx"
  _cachedModelCheckedAt = now;

  return _cachedModelName;
}

async function generateWithResolvedModel(prompt) {
  const modelName = await resolveModelName();
  if (!modelName) throw new Error("Nenhum modelo Gemini disponível para generateContent.");

  // SDK aceita "gemini-..." (sem "models/") e também aceita "models/..."
  // Aqui normalizamos para aceitar ambos:
  const nameForSDK = modelName.startsWith("models/") ? modelName.replace("models/", "") : modelName;

  const model = genAI.getGenerativeModel({ model: nameForSDK });

  const result = await model.generateContent({
    contents: [{ role: "user", parts: [{ text: prompt }] }],
  });

  return result?.response?.text?.() || "";
}

async function getAIAnalysis(gameInfo) {
  if (!genAI) return "IA não configurada.";

  const prompt = `Aja como um analista esportivo profissional para o app PredictIA.
Responda em PT-BR.
Dê uma recomendação curta (máx 4 linhas), com risco (baixo/médio/alto) e 1 justificativa.
Dados: ${JSON.stringify(gameInfo)}`;

  try {
    const text = await generateWithResolvedModel(prompt);
    return text || "Erro na análise da IA.";
  } catch (err) {
    console.error("GEMINI ERROR (FULL):", err);
    console.error("GEMINI ERROR (MSG):", err?.message);
    console.error("GEMINI ERROR (STATUS):", err?.status);
    console.error("GEMINI ERROR (RAW):", err?.raw);
    return "Erro na análise da IA.";
  }
}

// (Opcional) rota de debug para ver modelos disponíveis
app.get("/gemini/models", async (_, res) => {
  try {
    if (!genAI) return res.status(500).json({ status: "error", error: "IA não configurada." });
    const models = await listGeminiModels();
    const supported = models
      .filter((m) => (m?.supportedGenerationMethods || []).includes("generateContent"))
      .map((m) => ({
        name: m?.name,
        supportedGenerationMethods: m?.supportedGenerationMethods,
      }));

    const chosen = await resolveModelName();

    res.json({ status: "ok", chosen, supported });
  } catch (e) {
    res.status(500).json({ status: "error", error: e?.message || String(e), raw: e?.raw });
  }
});

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
    return { response: [], errors: { internal: e?.message || String(e) } };
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
    getGames: ({ date, live, leagueId }) => ({
      path: "/fixtures",
      params: live
        ? leagueId
          ? { live: "all", league: leagueId }
          : { live: "all" }
        : leagueId
          ? { date, league: leagueId }
          : { date },
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

    extractGoalsFromEvents: (events = []) => events.filter((e) => e?.type === "Goal"),
    extractCardsFromEvents: (events = []) => events.filter((e) => e?.type === "Card"),

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
