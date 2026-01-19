// PATCH COMPLETO (cole no seu index.js): retry + fallback p/ corners via odds + debug opcional
// - Se /fixtures/statistics vier vazio, tenta 3x com delay
// - Se ainda vier vazio, corners tenta ler do mercado "Total Corners / Match Corners" nas odds
// - Mantém tudo compatível com Render

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
// UTILS
// =====================
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

// retry helper: tenta buscar endpoint até "response" vir não vazio
async function apiSportsRetryNonEmpty(base, path, params, tries = 3, delayMs = 1200) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    last = await apiSports(base, path, params);
    const okNonEmpty = Array.isArray(last?.response) && last.response.length > 0;
    if (okNonEmpty) return { ...last, _retry: { tries: i + 1, ok: true } };
    if (i < tries - 1) await sleep(delayMs);
  }
  return { ...(last || { response: [] }), _retry: { tries, ok: false } };
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

    // fallback: se não há stats, tenta inferir "linha de cantos" via odds
    // (isso NÃO é a quantidade real de cantos; é só o handicap/linha do mercado)
    extractCornerLineFromOdds: (liveOdds = []) => {
      const markets = (liveOdds?.[0]?.odds || []);
      const m =
        markets.find((x) => /match corners/i.test(x?.name || "")) ||
        markets.find((x) => /total corners/i.test(x?.name || "")) ||
        markets.find((x) => /asian corners/i.test(x?.name || ""));
      if (!m) return null;

      // pega o primeiro handicap numérico que aparecer
      const vals = m.values || [];
      const pickVal = vals.find((v) => v?.handicap !== null && v?.handicap !== undefined) || vals[0];
      const handicap = pickVal?.handicap ?? null;

      return {
        market: m.name,
        handicap,
        sample: pickVal ? { value: pickVal.value, odd: pickVal.odd, handicap: pickVal.handicap } : null,
      };
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
// ROUTES
// =====================
app.get("/", (req, res) => res.send("PredictIA Engine Online"));

// =====================
// FOOTBALL
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

app.get("/football/match/:fixtureId", async (req, res) => {
  const fixtureId = Number(req.params.fixtureId);

  const includeRaw = req.query.include;
  const include =
    typeof includeRaw === "string" && includeRaw.trim().length > 0
      ? includeRaw.split(",")
      : ["score", "stats", "events", "goals", "corners", "cards", "odds"];

  const want = new Set(include.map((x) => x.trim()).filter(Boolean));
  const debug = String(req.query.debug || "").toLowerCase() === "true";

  const out = { fixtureId };

  // base fixture sempre
  const fixture = await apiSports(FOOTBALL_BASE, "/fixtures", { id: fixtureId });
  const item = (fixture.response || [])[0];
  if (!item) return res.status(404).json({ error: "Fixture não encontrado", fixtureId });

  out.game = item;
  out.live_score = ADAPTERS.football.extractLiveScore(item);

  // odds (pode ser usado como fallback de cantos)
  let oddsResp = null;
  if (want.has("odds") || want.has("corners")) {
    oddsResp = await apiSports(FOOTBALL_BASE, "/odds/live", { fixture: fixtureId });
    if (want.has("odds")) {
      out.live_odds = oddsResp.response || [];
      out._odds_errors = oddsResp.errors || undefined;
    }
  }

  // stats com retry
  if (want.has("stats") || want.has("corners")) {
    const sTry = await apiSportsRetryNonEmpty(FOOTBALL_BASE, "/fixtures/statistics", { fixture: fixtureId }, 3, 1200);

    if (want.has("stats")) out.live_stats = sTry.response || [];
    out._stats_errors = sTry.errors || undefined;
    if (debug) out._stats_retry = sTry._retry;

    if (want.has("corners")) {
      const cornersFromStats = ADAPTERS.football.extractCornersFromStats(sTry.response || []);
      const hasCorners = (cornersFromStats?.perTeam || []).length > 0;

      out.corners = cornersFromStats;

      // fallback: se stats ainda vazio, pelo menos retorna "linha" de cantos da odd
      if (!hasCorners) {
        const cornerLine = ADAPTERS.football.extractCornerLineFromOdds(oddsResp?.response || []);
        if (cornerLine) out.corners_fallback = cornerLine;
      }
    }
  }

  // events/goals/cards
  if (want.has("events") || want.has("goals") || want.has("cards")) {
    const e = await apiSports(FOOTBALL_BASE, "/fixtures/events", { fixture: fixtureId });
    const events = e.response || [];
    out._events_errors = e.errors || undefined;

    if (want.has("events")) out.events = events;
    if (want.has("goals")) out.goals = ADAPTERS.football.extractGoalsFromEvents(events);
    if (want.has("cards")) out.cards = ADAPTERS.football.extractCardsFromEvents(events);
  }

  // IA
  if (String(req.query.analysis || "").toLowerCase() === "true") {
    out.ai_prediction = await getAIAnalysis(
      pick(out, ["live_score", "live_stats", "goals", "cards", "corners", "corners_fallback", "live_odds"])
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
// NBA
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
  const gameId = req.params.gameId;
  const season = req.query.season || "2025";

  const include = String(req.query.include || "score,stats,odds").split(",");
  const want = new Set(include.map((x) => x.trim()).filter(Boolean));

  const out = { gameId, season };

  if (want.has("score")) {
    const g = await apiSports(NBA_BASE, "/games", { id: gameId, season });
    const item = (g.response || [])[0];
    out.game = item || null;
    out.live_score = item ? ADAPTERS.nba.extractLiveScore(item) : null;
    out._game_errors = g.errors || undefined;
  }

  if (want.has("stats")) {
    const s = await apiSports(NBA_BASE, "/games/statistics", { id: gameId });
    out.live_stats = s.response || [];
    out._stats_errors = s.errors || undefined;
  }

  if (want.has("odds")) {
    const o = await apiSports(NBA_BASE, "/odds", { game: gameId, league: "standard", season });
    out.live_odds = o.response || [];
    out._odds_errors = o.errors || undefined;
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
            sport === "football"
              ? ADAPTERS.football.extractLiveScore(game)
              : ADAPTERS.nba.extractLiveScore(game);
        }

        // stats (futebol com retry)
        if (include.stats) {
          if (sport === "football") {
            const sTry = await apiSportsRetryNonEmpty(FOOTBALL_BASE, "/fixtures/statistics", { fixture: id }, 3, 1200);
            details.live_stats = sTry.response || [];
          } else {
            const sCfg = adapter.stats(id);
            const s = await apiSports(adapter.base, sCfg.path, sCfg.params);
            details.live_stats = s.response || [];
          }
        }

        // odds
        let oddsResp = null;
        if (include.odds || (sport === "football" && include.corners)) {
          const oCfg = sport === "nba" ? adapter.odds(id, nbaSeason || season || "2025") : adapter.odds(id);
          oddsResp = await apiSports(adapter.base, oCfg.path, oCfg.params);
          if (include.odds) details.live_odds = oddsResp.response || [];
        }

        if (sport === "football") {
          if (include.goals || include.cards) {
            const e = await apiSports(FOOTBALL_BASE, "/fixtures/events", { fixture: id });
            const events = e.response || [];
            if (include.goals) details.goals = ADAPTERS.football.extractGoalsFromEvents(events);
            if (include.cards) details.cards = ADAPTERS.football.extractCardsFromEvents(events);
          }

          if (include.corners) {
            const cornersFromStats = ADAPTERS.football.extractCornersFromStats(details.live_stats || []);
            details.corners = cornersFromStats;

            const hasCorners = (cornersFromStats?.perTeam || []).length > 0;
            if (!hasCorners) {
              const cornerLine = ADAPTERS.football.extractCornerLineFromOdds(oddsResp?.response || []);
              if (cornerLine) details.corners_fallback = cornerLine;
            }
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
            corners_fallback: details.corners_fallback,
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
