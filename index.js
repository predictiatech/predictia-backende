// ======================================================
// OBJETIVO (IMPLEMENTADO):
// - Manter futebol como está (NÃO ALTERADO)
// - NBA AO VIVO + stats + players + odds usando API-BASKETBALL (assinatura "basketball")
// - Sem quebrar provider antigo (API-NBA v2): escolhe via ENV NBA_PROVIDER
//
// FIX CRÍTICO:
// - API-BASKETBALL NÃO aceita ?live=all  -> retorna "The Live field do not exist."
// - Portanto: /nba/live (basketball) busca jogos DO DIA (date) e filtra AO VIVO localmente
//
// ENV:
//   NBA_PROVIDER=basketball (default)  -> https://v1.basketball.api-sports.io
//   NBA_PROVIDER=nba                  -> https://v2.nba.api-sports.io
//   BASKETBALL_NBA_LEAGUE_ID=??       -> (opcional mas recomendado) filtra só NBA
//
// ROTAS:
//   GET /nba/live
//   GET /nba/game/:gameId
//   GET /nba/game/:gameId?analysis=true
// ======================================================

import "dotenv/config";
import express from "express";
import cors from "cors";
import { GoogleGenerativeAI } from "@google/generative-ai";

// ---------- BOOT SAFETY ----------
process.on("uncaughtException", (err) => console.error("UNCAUGHT_EXCEPTION:", err));
process.on("unhandledRejection", (reason) => console.error("UNHANDLED_REJECTION:", reason));

// ---------- APP ----------
const app = express();
app.use(cors());
app.use(express.json());

// =====================
// ENV
// =====================
const API_KEY = process.env.API_SPORTS_KEY || process.env.FOOTBALL_API_KEY;
const GENAI_KEY = process.env.GEMINI_API_KEY;
const GENAI_MODEL_RAW = (process.env.GEMINI_MODEL || "gemini-2.5-flash").trim();

const NBA_PROVIDER = (process.env.NBA_PROVIDER || "basketball").toLowerCase(); // "basketball" | "nba"

// NBA League ID (API-BASKETBALL). Recomendado para evitar pegar outras ligas do dia.
const BASKETBALL_NBA_LEAGUE_ID = process.env.BASKETBALL_NBA_LEAGUE_ID
  ? Number(process.env.BASKETBALL_NBA_LEAGUE_ID)
  : undefined;

if (!API_KEY) console.error("FALTA API_SPORTS_KEY ou FOOTBALL_API_KEY");
if (!GENAI_KEY) console.error("FALTA GEMINI_API_KEY");

const FOOTBALL_BASE = "https://v3.football.api-sports.io";
const NBA_BASE = "https://v2.nba.api-sports.io";
const BASKETBALL_BASE = "https://v1.basketball.api-sports.io";

// =====================
// GEMINI (AUTO-LISTMODELS)
// =====================
const genAI = GENAI_KEY ? new GoogleGenerativeAI(GENAI_KEY) : null;

let _cachedResolvedModel = null;
let _cachedAt = 0;

function normalizeModelName(x) {
  return String(x || "").replace(/^models\//, "").trim();
}

async function listGeminiModels() {
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(
    GENAI_KEY
  )}`;

  const r = await fetch(url);
  const j = await r.json();

  if (!r.ok) {
    const e = new Error(j?.error?.message || `HTTP ${r.status}`);
    e.status = r.status;
    e.raw = j;
    throw e;
  }
  return Array.isArray(j?.models) ? j.models : [];
}

function pickSupportedGenerateContent(models) {
  return models.filter((m) =>
    (m?.supportedGenerationMethods || []).includes("generateContent")
  );
}

function resolveByHint(models, hintRaw) {
  const hint = normalizeModelName(hintRaw).toLowerCase();
  const supported = pickSupportedGenerateContent(models);
  const names = supported.map((m) => normalizeModelName(m?.name));

  const exact = names.find((n) => n.toLowerCase() === hint);
  if (exact) return exact;

  const prefix = names.find((n) => n.toLowerCase().startsWith(hint));
  if (prefix) return prefix;

  if (hint.includes("2.5") && hint.includes("flash")) {
    const flash25 = names.find(
      (n) => n.toLowerCase().includes("2.5") && n.toLowerCase().includes("flash")
    );
    if (flash25) return flash25;
  }

  return names[0] || null;
}

async function getResolvedModelName() {
  if (!genAI) return null;

  const now = Date.now();
  if (_cachedResolvedModel && now - _cachedAt < 10 * 60 * 1000) return _cachedResolvedModel;

  const models = await listGeminiModels();
  const resolved = resolveByHint(models, GENAI_MODEL_RAW);

  _cachedResolvedModel = resolved;
  _cachedAt = now;

  return _cachedResolvedModel;
}

async function generateGemini(prompt) {
  const resolved = await getResolvedModelName();
  if (!resolved) throw new Error("Nenhum modelo Gemini disponível para generateContent.");

  const model = genAI.getGenerativeModel({ model: resolved });

  const result = await model.generateContent({
    contents: [{ role: "user", parts: [{ text: prompt }] }],
  });

  return result?.response?.text?.() || "";
}

// =====================
// IA RESPONSE NORMALIZATION
// =====================
function ensureSingleGreenPercent(text) {
  const t = String(text || "").trim();
  const matches = [...t.matchAll(/(\d{2,3})%/g)];

  if (matches.length === 0) {
    return `${t}\nProbabilidade de GREEN: 65%\nRisco: médio\nJustificativa: Estimativa padrão.`;
  }

  const first = matches[0][1];

  let cleaned = t
    .replace(/probabilidade\s+de\s+green\s*:\s*\d{2,3}%/gi, "")
    .replace(/(\d{2,3})%/g, "")
    .replace(/\n{2,}/g, "\n")
    .trim();

  const lines = cleaned
    .split("\n")
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, 3);

  cleaned = lines.join("\n");

  return `${cleaned}\nProbabilidade de GREEN: ${first}%`;
}

// =====================
// IA QUOTA PROTECTION (CACHE + RETRY 429)
// =====================
const AI_CACHE_TTL_MS = Number(process.env.AI_CACHE_TTL_MS || 60_000);
const _aiCache = new Map();

function aiCacheGet(key) {
  const row = _aiCache.get(key);
  if (!row) return null;
  if (Date.now() > row.exp) {
    _aiCache.delete(key);
    return null;
  }
  return row.value;
}

function aiCacheSet(key, value) {
  _aiCache.set(key, { value, exp: Date.now() + AI_CACHE_TTL_MS });
}

function parseRetryDelaySeconds(err) {
  const details = err?.errorDetails;
  if (!Array.isArray(details)) return null;

  const retryInfo = details.find((d) => d?.["@type"] === "type.googleapis.com/google.rpc.RetryInfo");
  const raw = retryInfo?.retryDelay;
  if (!raw) return null;

  const m = String(raw).match(/(\d+)\s*s/i);
  if (!m) return null;

  const sec = Number(m[1]);
  if (!Number.isFinite(sec) || sec <= 0) return null;

  return sec;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pick(obj, keys) {
  const out = {};
  keys.forEach((k) => {
    if (obj?.[k] !== undefined) out[k] = obj[k];
  });
  return out;
}

async function getAIAnalysis(gameInfo, sportLabel = "Esporte", cacheKey = "") {
  if (!genAI) return "IA não configurada.";

  if (cacheKey) {
    const cached = aiCacheGet(cacheKey);
    if (cached) return cached;
  }

  const prompt = `Aja como um analista esportivo profissional para o app PredictIA.
Esporte: ${sportLabel}
Responda em PT-BR.
Retorne APENAS texto simples (sem Markdown).
Máximo 4 linhas.
Formato EXATO:
Recomendação: <aposta>
Probabilidade de GREEN: <XX%>
Risco: baixo|médio|alto
Justificativa: <1 frase>
Dados: ${JSON.stringify(gameInfo)}`;

  try {
    const text = await generateGemini(prompt);
    const finalText = ensureSingleGreenPercent(text || "Erro na análise da IA.");
    if (cacheKey) aiCacheSet(cacheKey, finalText);
    return finalText;
  } catch (err) {
    const status = err?.status;

    if (status === 429) {
      const sec = parseRetryDelaySeconds(err);
      const msg = sec
        ? `IA em limite de uso. Tente novamente em ~${sec}s.\nProbabilidade de GREEN: 65%\nRisco: médio\nJustificativa: Limite de cota/velocidade da IA.`
        : `IA em limite de uso. Tente novamente mais tarde.\nProbabilidade de GREEN: 65%\nRisco: médio\nJustificativa: Limite de cota/velocidade da IA.`;

      if (sec && sec <= 60) {
        try {
          await sleep((sec + 1) * 1000);
          const text2 = await generateGemini(prompt);
          const finalText2 = ensureSingleGreenPercent(text2 || msg);
          if (cacheKey) aiCacheSet(cacheKey, finalText2);
          return finalText2;
        } catch (err2) {
          console.error("GEMINI RETRY FAILED:", err2);
        }
      }

      if (cacheKey) aiCacheSet(cacheKey, msg);
      return msg;
    }

    console.error("GEMINI_MODEL_RAW:", GENAI_MODEL_RAW);
    console.error("GEMINI_RESOLVED_MODEL:", _cachedResolvedModel);
    console.error("GEMINI ERROR (FULL):", err);
    console.error("GEMINI ERROR (STATUS):", status);
    console.error("GEMINI ERROR (RAW):", err?.raw);

    const fallback = "Erro na análise da IA.\nProbabilidade de GREEN: 65%\nRisco: médio\nJustificativa: Falha ao consultar a IA.";
    if (cacheKey) aiCacheSet(cacheKey, fallback);
    return fallback;
  }
}

// =====================
// LIVE CHECKS
// =====================

// Provider API-NBA v2 (seu atual)
function isNbaLiveGame_v2(game) {
  const short = Number(game?.status?.short);
  const clock = game?.status?.clock;

  if (clock !== null && clock !== undefined && String(clock).trim() !== "") return true;

  const periodsCurrent = Number(game?.periods?.current || 0);
  if (short && short !== 3 && periodsCurrent > 0) return true;

  const long = String(game?.status?.long || "").toLowerCase();
  if (long.includes("live") || long.includes("in play") || long.includes("in progress")) return true;

  return false;
}

function isNbaFinishedGame_v2(game) {
  const short = Number(game?.status?.short);
  const long = String(game?.status?.long || "").toLowerCase();
  return short === 3 || long.includes("finished") || long.includes("final");
}

// Provider API-BASKETBALL v1 (assinatura "basketball")
function isBasketballLiveGame_v1(game) {
  const stShort = String(game?.status?.short || "").toUpperCase();
  const stLong = String(game?.status?.long || "").toLowerCase();
  const timer = game?.timer;

  if (timer !== null && timer !== undefined && String(timer).trim() !== "") return true;

  if (stLong.includes("live") || stLong.includes("in play") || stLong.includes("inplay")) return true;

  if (["Q1", "Q2", "Q3", "Q4", "OT", "HT"].includes(stShort)) return true;

  return false;
}

function isBasketballFinishedGame_v1(game) {
  const stShort = String(game?.status?.short || "").toLowerCase();
  const stLong = String(game?.status?.long || "").toLowerCase();
  return stShort === "ft" || stShort === "end" || stLong.includes("finished") || stLong.includes("final");
}

// =====================
// API-SPORTS CORE
// =====================
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
    if (!response.ok) return { response: [], errors: { http: response.status }, raw: json };
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

  // SEU PROVIDER ATUAL (API-NBA v2)
  nba_v2: {
    getGames: ({ id, live, date, season, league }) => ({
      path: "/games",
      params: id ? { id } : live ? { live: "all" } : { date, season, league },
    }),

    getGameStats: ({ game }) => ({ path: "/games/statistics", params: { game } }),
    getPlayersStats: ({ game, season }) => ({ path: "/players/statistics", params: { game, season } }),
    getOdds: ({ game }) => ({ path: "/odds", params: { game } }),

    extractLiveGame: (item) => ({
      gameId: item?.id,
      league: item?.league
        ? { id: item.league.id, name: item.league.name, season: item.league.season }
        : null,
      teams: item?.teams,
      scores: item?.scores,
      status: item?.status,
      periods: item?.periods,
    }),
  },

  // API-BASKETBALL v1 (assinatura "basketball")
  basketball_v1: {
    // FIX: NÃO EXISTE live=all -> sempre busca por date e filtra live localmente
    getGames: ({ id, date, league }) => ({
      path: "/games",
      params: id ? { id } : league ? { date, league } : { date },
    }),

    getTeamStats: ({ game }) => ({ path: "/games/statistics/teams", params: { game } }),
    getPlayersStats: ({ game }) => ({ path: "/games/statistics/players", params: { game } }),
    getOdds: ({ game }) => ({ path: "/odds", params: { game } }),

    extractLiveGame: (item) => ({
      gameId: item?.id,
      league: item?.league ? { id: item.league.id, name: item.league.name, season: item.league.season } : null,
      country: item?.country ? { id: item.country.id, name: item.country.name } : null,
      teams: item?.teams,
      scores: item?.scores,
      status: item?.status,
      timer: item?.timer,
      date: item?.date,
      time: item?.time,
    }),
  },
};

// =====================
// ROUTES
// =====================
app.get("/", (_, res) => res.send("PredictIA Engine Online"));

// ---------------------
// FOOTBALL (mantido)
// ---------------------
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
      pick(out, ["live_score", "live_stats", "goals", "cards", "corners", "live_odds"]),
      "Futebol",
      `football:${fixtureId}`
    );
  }

  res.json({ status: "ok", data: out });
});

// ---------------------
// NBA (LIVE ONLY) - PROVIDER SWITCH
// ---------------------

function getNbaProvider() {
  if (NBA_PROVIDER === "nba") {
    return {
      base: NBA_BASE,
      adapter: ADAPTERS.nba_v2,
      isLive: isNbaLiveGame_v2,
      isFinished: isNbaFinishedGame_v2,
      leagueParam: undefined,
      label: "NBA (Basquete) - API-NBA v2",
    };
  }

  return {
    base: BASKETBALL_BASE,
    adapter: ADAPTERS.basketball_v1,
    isLive: isBasketballLiveGame_v1,
    isFinished: isBasketballFinishedGame_v1,
    leagueParam: BASKETBALL_NBA_LEAGUE_ID,
    label: "NBA (Basquete) - API-BASKETBALL v1",
  };
}

function yyyyMmDdLocal() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

// /nba/live
app.get("/nba/live", async (_req, res) => {
  const p = getNbaProvider();

  // FIX: se provider=basketball -> busca jogos do DIA e filtra ao vivo localmente
  const date = yyyyMmDdLocal();

  const cfg =
    NBA_PROVIDER === "basketball"
      ? p.adapter.getGames({ date, league: p.leagueParam })
      : p.adapter.getGames({ live: true });

  const data = await apiSports(p.base, cfg.path, cfg.params);
  const liveOnly = (data.response || []).filter((g) => p.isLive(g) && !p.isFinished(g));

  res.json({
    status: "ok",
    provider: NBA_PROVIDER,
    date,
    data: liveOnly.map(p.adapter.extractLiveGame),
    raw: data.errors ? { errors: data.errors } : undefined,
  });
});

// /nba/game/:gameId?analysis=true
app.get("/nba/game/:gameId", async (req, res) => {
  const p = getNbaProvider();

  const gameId = Number(req.params.gameId);
  const wantAnalysis = String(req.query.analysis || "").toLowerCase() === "true";

  const out = { gameId, provider: NBA_PROVIDER };

  const baseCfg = p.adapter.getGames({ id: gameId });
  const base = await apiSports(p.base, baseCfg.path, baseCfg.params);

  const game = base.response?.[0];
  if (!game) return res.status(404).json({ error: "Game não encontrado" });

  if (!p.isLive(game) || p.isFinished(game)) {
    return res.status(409).json({
      status: "not-live",
      error: "Somente jogos ao vivo são permitidos para NBA.",
      data: { gameId, status: game?.status, teams: game?.teams },
    });
  }

  out.game = game;
  out.live_game = p.adapter.extractLiveGame(game);

  // STATS / PLAYERS / ODDS
  if (NBA_PROVIDER === "nba") {
    const statsCfg = p.adapter.getGameStats({ game: gameId });
    const statsTry = await apiSportsRetryNonEmpty(p.base, statsCfg.path, statsCfg.params);
    out.team_stats = statsTry.response || [];

    const plyCfg = p.adapter.getPlayersStats({ game: gameId });
    const plyTry = await apiSportsRetryNonEmpty(p.base, plyCfg.path, plyCfg.params, 2, 900);
    out.player_stats = plyTry.response || [];
  } else {
    const statsCfg = p.adapter.getTeamStats({ game: gameId });
    const statsTry = await apiSportsRetryNonEmpty(p.base, statsCfg.path, statsCfg.params);
    out.team_stats = statsTry.response || [];

    const plyCfg = p.adapter.getPlayersStats({ game: gameId });
    const plyTry = await apiSportsRetryNonEmpty(p.base, plyCfg.path, plyCfg.params, 2, 900);
    out.player_stats = plyTry.response || [];
  }

  const oddsCfg = p.adapter.getOdds({ game: gameId });
  const oddsTry = await apiSportsRetryNonEmpty(p.base, oddsCfg.path, oddsCfg.params, 2, 900);
  out.live_odds = oddsTry.response || [];

  if (wantAnalysis) {
    out.ai_prediction = await getAIAnalysis(
      pick(out, ["live_game", "team_stats", "player_stats", "live_odds"]),
      p.label,
      `nba:${NBA_PROVIDER}:${gameId}`
    );
  }

  res.json({ status: "ok", data: out });
});

// =====================
// SERVER
// =====================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("Servidor rodando na porta", PORT));
