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
  console.error("FALTA API_KEY: defina API_SPORTS_KEY ou FOOTBALL_API_KEY no Render.");
}

const FOOTBALL_BASE = "https://v3.football.api-sports.io";
const NBA_BASE = "https://v2.nba.api-sports.io";

// =====================
// GEMINI
// =====================
const genAI = GENAI_KEY ? new GoogleGenerativeAI(GENAI_KEY) : null;

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
  } catch {
    return "Erro na análise da IA.";
  }
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
      method: "GET",
      headers: {
        "x-apisports-key": API_KEY,
        Accept: "application/json",
      },
    });

    const json = await response.json();

    if (!response.ok) {
      return {
        response: [],
        errors: { http: response.status, message: json?.message || "HTTP error" },
        raw: json,
      };
    }

    return json;
  } catch (error) {
    return { response: [], errors: { internal: error.message } };
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isLiveFootballStatus(short) {
  // statuses comuns (API-Football): 1H, HT, 2H, ET, BT, P, LIVE
  const s = String(short || "").toUpperCase();
  return ["1H", "HT", "2H", "ET", "BT", "P", "LIVE"].includes(s);
}

async function apiSportsRetry({
  base,
  path,
  params,
  maxAttempts = 3,
  delayMs = 650,
  shouldRetry = (json) => Array.isArray(json?.response) && json.response.length === 0,
}) {
  let last = null;
  for (let i = 0; i < maxAttempts; i++) {
    last = await apiSports(base, path, params);
    if (!shouldRetry(last)) return last;
    if (i < maxAttempts - 1) await sleep(delayMs);
  }
  return last;
}

// =====================
// ADAPTERS
// =====================
const ADAPTERS = {
  football: {
    base: FOOTBALL_BASE,

    getGames: ({ date, live }) => ({
      path: "/fixtures",
      params: live ? { live: "all" } : { date },
    }),

    stats: (fixtureId) => ({
      path: "/fixtures/statistics",
      params: { fixture: fixtureId },
    }),

    events: (fixtureId) => ({
      path: "/fixtures/events",
      params: { fixture: fixtureId },
    }),

    odds: (fixtureId) => ({
      path: "/odds/live",
      params: { fixture: fixtureId },
    }),

    standings: ({ league, season }) => ({
      path: "/standings",
      params: { league, season },
    }),

    extractId: (item) => item?.fixture?.id,

    extractLiveScore: (item) => ({
      fixtureId: item?.fixture?.id,
      league: item?.league,
      teams: item?.teams,
      goals: item?.goals,
      score: item?.score,
      status: item?.fixture?.status,
      time: item?.fixture?.status?.elapsed,
    }),

    extractGoalsFromEvents: (events = []) =>
      (events || [])
        .filter((e) => e?.type === "Goal")
        .map((e) => ({
          time: e?.time,
          team: e?.team,
          player: e?.player,
          assist: e?.assist,
          detail: e?.detail,
          comments: e?.comments,
        })),

    extractCardsFromEvents: (events = []) =>
      (events || [])
        .filter((e) => e?.type === "Card")
        .map((e) => ({
          time: e?.time,
          team: e?.team,
          player: e?.player,
          detail: e?.detail,
          comments: e?.comments,
        })),

    extractCornersFromStats: (statsResponse = []) => {
      const perTeam = (statsResponse || []).map((row) => {
        const s = row?.statistics || [];
        const corners = s.find((x) => x?.type === "Corner Kicks")?.value ?? 0;
        return { team: row?.team, corners: corners ?? 0 };
      });

      const total = perTeam.reduce((acc, x) => acc + (Number(x.corners) || 0), 0);
      return { total, perTeam };
    },
  },

  nba: {
    base: NBA_BASE,

    getGames: ({ date, season }) => ({
      path: "/games",
      params: { date, season },
    }),

    extractLiveScore: (item) => ({
      gameId: item?.id,
      league: item?.league,
      teams: item?.teams,
      scores: item?.scores,
      status: item?.status,
      periods: item?.periods,
      date: item?.date,
    }),

    stats: (gameId) => ({
      path: "/games/statistics",
      params: { id: gameId },
    }),

    odds: (gameId, season) => ({
      path: "/odds",
      params: { game: gameId, league: "standard", season },
    }),

    standings: ({ league, season }) => ({
      path: "/standings",
      params: { league: league || "standard", season },
    }),

    extractId: (item) => item?.id,
  },
};

// =====================
// HELPERS
// =====================
function todayISO() {
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function pick(obj, keys) {
  const out = {};
  keys.forEach((k) => {
    if (obj?.[k] !== undefined) out[k] = obj[k];
  });
  return out;
}

function normalizeErrors(e) {
  if (!e) return undefined;
  if (Array.isArray(e) && e.length === 0) return undefined;
  if (typeof e === "object" && Object.keys(e).length === 0) return undefined;
  return e;
}

// =====================
// ROUTES
// =====================
app.get("/", (req, res) => res.send("PredictIA Engine Online"));

// =====================
// FOOTBALL ENDPOINTS
// =====================
app.get("/football/games", async (req, res) => {
  const date = req.query.date || todayISO();
  const live = String(req.query.live || "").toLowerCase() === "true";
  const max = Number(req.query.max || 20);

  const cfg = ADAPTERS.football.getGames({ date, live });
  const data = await apiSports(ADAPTERS.football.base, cfg.path, cfg.params);
  const games = (data.response || []).slice(0, max);

  res.json({
    status: "ok",
    count: games.length,
    data: games.map((g) => ADAPTERS.football.extractLiveScore(g)),
    raw: data.errors ? { errors: data.errors } : undefined,
  });
});

app.get("/football/live", async (req, res) => {
  const cfg = ADAPTERS.football.getGames({ live: true });
  const data = await apiSports(ADAPTERS.football.base, cfg.path, cfg.params);

  const games = data.response || [];
  res.json({
    status: "ok",
    count: games.length,
    data: games.map((g) => ADAPTERS.football.extractLiveScore(g)),
    raw: data.errors ? { errors: data.errors } : undefined,
  });
});

// FIX PRINCIPAL: sempre busca o fixture base; retries para stats/events quando jogo está ao vivo
app.get("/football/match/:fixtureId", async (req, res) => {
  const fixtureId = Number(req.params.fixtureId);
  if (!Number.isFinite(fixtureId)) return res.status(400).json({ error: "fixtureId inválido." });

  const includeRaw = req.query.include;
  const include =
    typeof includeRaw === "string" && includeRaw.trim().length > 0
      ? includeRaw.split(",")
      : ["score", "stats", "goals", "corners", "cards", "odds"];

  const want = new Set(include.map((x) => x.trim()).filter(Boolean));
  const out = { fixtureId };

  // 1) SEMPRE pegar base do jogo (para status/live e para não retornar só fixtureId)
  const fixture = await apiSports(FOOTBALL_BASE, "/fixtures", { id: fixtureId });
  const item = (fixture.response || [])[0];

  if (!item) return res.status(404).json({ error: "Fixture não encontrado." });

  out.game = item;
  out.live_score = ADAPTERS.football.extractLiveScore(item);

  const liveShort = out.live_score?.status?.short;
  const isLive = isLiveFootballStatus(liveShort);

  // 2) STATS (com retry se live e veio vazio)
  if (want.has("stats") || want.has("corners")) {
    const sCfg = ADAPTERS.football.stats(fixtureId);

    const s = await apiSportsRetry({
      base: FOOTBALL_BASE,
      path: sCfg.path,
      params: sCfg.params,
      maxAttempts: isLive ? 3 : 1,
      delayMs: 700,
      shouldRetry: (json) => isLive && Array.isArray(json?.response) && json.response.length === 0 && !json?.errors,
    });

    out.live_stats = s.response || [];
    out._stats_errors = normalizeErrors(s.errors) || undefined;

    if (want.has("corners")) {
      out.corners = ADAPTERS.football.extractCornersFromStats(out.live_stats || []);
    }
  }

  // 3) EVENTS (com retry se live e veio vazio)
  if (want.has("goals") || want.has("cards") || want.has("events")) {
    const eCfg = ADAPTERS.football.events(fixtureId);

    const e = await apiSportsRetry({
      base: FOOTBALL_BASE,
      path: eCfg.path,
      params: eCfg.params,
      maxAttempts: isLive ? 3 : 1,
      delayMs: 700,
      shouldRetry: (json) => isLive && Array.isArray(json?.response) && json.response.length === 0 && !json?.errors,
    });

    const events = e.response || [];
    out._events_errors = normalizeErrors(e.errors) || undefined;

    if (want.has("events")) out.events = events;
    if (want.has("goals")) out.goals = ADAPTERS.football.extractGoalsFromEvents(events);
    if (want.has("cards")) out.cards = ADAPTERS.football.extractCardsFromEvents(events);
  }

  // 4) ODDS
  if (want.has("odds")) {
    const oCfg = ADAPTERS.football.odds(fixtureId);
    const o = await apiSports(FOOTBALL_BASE, oCfg.path, oCfg.params);
    out.live_odds = o.response || [];
    out._odds_errors = normalizeErrors(o.errors) || undefined;
  }

  // 5) IA
  if (String(req.query.analysis || "").toLowerCase() === "true") {
    out.ai_prediction = await getAIAnalysis(
      pick(out, ["live_score", "live_stats", "goals", "cards", "corners", "live_odds"])
    );
  }

  res.json({ status: "ok", data: out });
});

app.get("/football/standings", async (req, res) => {
  const league = req.query.league;
  const season = req.query.season;

  if (!league || !season) {
    return res.status(400).json({ error: "Passe ?league=ID&season=YYYY" });
  }

  const s = await apiSports(FOOTBALL_BASE, "/standings", { league, season });
  res.json({ status: "ok", data: s.response || [], raw: s.errors ? { errors: s.errors } : undefined });
});

// =====================
// NBA ENDPOINTS
// =====================
app.get("/nba/games", async (req, res) => {
  const date = req.query.date || todayISO();
  const season = req.query.season || "2025";
  const max = Number(req.query.max || 20);

  const cfg = ADAPTERS.nba.getGames({ date, season });
  const data = await apiSports(NBA_BASE, cfg.path, cfg.params);
  const games = (data.response || []).slice(0, max);

  res.json({
    status: "ok",
    count: games.length,
    data: games.map((g) => ADAPTERS.nba.extractLiveScore(g)),
    raw: data.errors ? { errors: data.errors } : undefined,
  });
});

app.get("/nba/match/:gameId", async (req, res) => {
  const gameId = Number(req.params.gameId);
  if (!Number.isFinite(gameId)) return res.status(400).json({ error: "gameId inválido." });

  const season = req.query.season || "2025";
  const include = String(req.query.include || "score,stats,odds").split(",");
  const want = new Set(include.map((x) => x.trim()).filter(Boolean));

  const out = { gameId, season };

  if (want.has("score")) {
    const g = await apiSports(NBA_BASE, "/games", { id: gameId, season });
    const item = (g.response || [])[0];
    out.game = item || null;
    out.live_score = item ? ADAPTERS.nba.extractLiveScore(item) : null;
    out._game_errors = normalizeErrors(g.errors) || undefined;
  }

  if (want.has("stats")) {
    const s = await apiSports(NBA_BASE, "/games/statistics", { id: gameId });
    out.live_stats = s.response || [];
    out._stats_errors = normalizeErrors(s.errors) || undefined;
  }

  if (want.has("odds")) {
    const o = await apiSports(NBA_BASE, "/odds", { game: gameId, league: "standard", season });
    out.live_odds = o.response || [];
    out._odds_errors = normalizeErrors(o.errors) || undefined;
  }

  out.goals = [];
  out.corners = { total: 0, perTeam: [] };
  out.cards = [];

  if (String(req.query.analysis || "").toLowerCase() === "true") {
    out.ai_prediction = await getAIAnalysis(pick(out, ["live_score", "live_stats", "live_odds"]));
  }

  res.json({ status: "ok", data: out });
});

app.get("/nba/standings", async (req, res) => {
  const season = req.query.season || "2025";
  const league = req.query.league || "standard";

  const s = await apiSports(NBA_BASE, "/standings", { league, season });
  res.json({ status: "ok", data: s.response || [], raw: s.errors ? { errors: s.errors } : undefined });
});

// =====================
// UNIFIED SEARCH (POST)
// =====================
app.post("/alerts/search", async (req, res) => {
  try {
    const {
      sport,
      date,
      maxGames = 6,
      include = {
        score: true,
        stats: true,
        goals: true,
        corners: true,
        cards: true,
        odds: true,
        standings: false,
        analysis: false,
      },
      league,
      season,
      nbaSeason,
      live = true,
    } = req.body;

    const adapter = ADAPTERS[sport];
    if (!adapter) return res.status(400).json({ error: "Esporte inválido." });

    let standingsData = null;
    if (include.standings) {
      if (sport === "football") {
        if (!league || !season) return res.status(400).json({ error: "Para futebol standings: informe league e season." });
        const s = await apiSports(FOOTBALL_BASE, "/standings", { league, season });
        standingsData = s.response || [];
      } else if (sport === "nba") {
        const s = await apiSports(NBA_BASE, "/standings", {
          league: league || "standard",
          season: nbaSeason || season || "2025",
        });
        standingsData = s.response || [];
      }
    }

    let gamesCfg;
    if (sport === "football") {
      gamesCfg = ADAPTERS.football.getGames({ date: date || todayISO(), live: !!live });
    } else {
      gamesCfg = ADAPTERS.nba.getGames({ date: date || todayISO(), season: nbaSeason || season || "2025" });
    }

    const gamesData = await apiSports(adapter.base, gamesCfg.path, gamesCfg.params);
    const games = (gamesData.response || []).slice(0, maxGames);

    const fullData = await Promise.all(
      games.map(async (game) => {
        const id = adapter.extractId(game);
        const details = { ...game };

        if (include.score) {
          details.live_score =
            sport === "football" ? ADAPTERS.football.extractLiveScore(game) : ADAPTERS.nba.extractLiveScore(game);
        }

        const isLive = sport === "football" ? isLiveFootballStatus(details.live_score?.status?.short) : false;

        if (include.stats || (sport === "football" && include.corners)) {
          const sCfg = adapter.stats(id);
          const s = await apiSportsRetry({
            base: adapter.base,
            path: sCfg.path,
            params: sCfg.params,
            maxAttempts: isLive ? 3 : 1,
            delayMs: 700,
            shouldRetry: (json) => isLive && Array.isArray(json?.response) && json.response.length === 0 && !json?.errors,
          });
          details.live_stats = s.response || [];
        }

        if (include.odds) {
          const oCfg = sport === "nba" ? adapter.odds(id, nbaSeason || season || "2025") : adapter.odds(id);
          const o = await apiSports(adapter.base, oCfg.path, oCfg.params);
          details.live_odds = o.response || [];
        }

        if (sport === "football") {
          if (include.goals || include.cards) {
            const e = await apiSportsRetry({
              base: FOOTBALL_BASE,
              path: "/fixtures/events",
              params: { fixture: id },
              maxAttempts: isLive ? 3 : 1,
              delayMs: 700,
              shouldRetry: (json) => isLive && Array.isArray(json?.response) && json.response.length === 0 && !json?.errors,
            });
            const events = e.response || [];
            if (include.goals) details.goals = ADAPTERS.football.extractGoalsFromEvents(events);
            if (include.cards) details.cards = ADAPTERS.football.extractCardsFromEvents(events);
          }
          if (include.corners) {
            details.corners = ADAPTERS.football.extractCornersFromStats(details.live_stats || []);
          }
        } else {
          if (include.goals) details.goals = [];
          if (include.cards) details.cards = [];
          if (include.corners) details.corners = { total: 0, perTeam: [] };
        }

        if (include.analysis) {
          details.ai_prediction = await getAIAnalysis({
            sport,
            score: details.live_score,
            stats: details.live_stats,
            odds: details.live_odds,
            goals: details.goals,
            cards: details.cards,
            corners: details.corners,
          });
        }

        return details;
      })
    );

    res.json({
      status: "ok",
      sport,
      count: fullData.length,
      standings: standingsData,
      data: fullData,
      raw: gamesData.errors ? { errors: gamesData.errors } : undefined,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =====================
// SERVER
// =====================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
