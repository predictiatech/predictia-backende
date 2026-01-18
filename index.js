// index.js (COMPLETE) — Football (v3) + NBA (v2) via API-SPORTS
// ENV no Render (recomendado):
//   FOOTBALL_API_KEY=xxxxxxxxxxxxxxxx
//   FOOTBALL_BASE=https://v3.football.api-sports.io
//   NBA_BASE=https://v2.nba.api-sports.io
// (Opcional: API_SPORTS_KEY também funciona como fallback)

import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

// =========================
// ENV
// =========================
const API_KEY =
  process.env.API_SPORTS_KEY ||
  process.env.API_SPORTS_API_KEY ||
  process.env.FOOTBALL_API_KEY || // ✅ você já tem isso no Render
  process.env.API_SPORTS_KEY_FALLBACK;

const FOOTBALL_BASE = process.env.FOOTBALL_BASE || "https://v3.football.api-sports.io";
const NBA_BASE = process.env.NBA_BASE || "https://v2.nba.api-sports.io";

if (!API_KEY) console.warn("MISSING: API_SPORTS_KEY (ou FOOTBALL_API_KEY)");
if (!FOOTBALL_BASE) console.warn("MISSING: FOOTBALL_BASE");
if (!NBA_BASE) console.warn("MISSING: NBA_BASE");

// =========================
// HTTP HELPERS
// =========================
function withTimeout(ms) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return { signal: c.signal, done: () => clearTimeout(t) };
}

async function apiSports(base, path, params = {}) {
  if (!API_KEY) throw new Error("MISSING_API_KEY");

  const url = new URL(base.replace(/\/$/, "") + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== null && v !== undefined && v !== "") url.searchParams.set(k, String(v));
  }

  const { signal, done } = withTimeout(25000);

  try {
    const r = await fetch(url.toString(), {
      method: "GET",
      headers: {
        "x-apisports-key": API_KEY,
        Accept: "application/json",
      },
      signal,
    });

    const text = await r.text();
    if (!r.ok) throw new Error(`API_SPORTS_HTTP_${r.status}: ${text}`);

    try {
      return JSON.parse(text);
    } catch (e) {
      throw new Error(`API_SPORTS_BAD_JSON: ${text.slice(0, 200)}`);
    }
  } finally {
    done();
  }
}

function takeFirstResponse(obj) {
  if (!obj) return null;
  if (Array.isArray(obj.response)) return obj.response[0] ?? null;
  return null;
}

// =========================
// ENDPOINT MAPS
// =========================

// ✅ FUTEBOL (v3.football.api-sports.io)
const football = {
  base: FOOTBALL_BASE,

  liveGames: () => ({ path: "/fixtures", params: { live: "all" } }),
  liveOdds: () => ({ path: "/odds/live", params: {} }),

  stats: (fixtureId) => ({ path: "/fixtures/statistics", params: { fixture: fixtureId } }),
  events: (fixtureId) => ({ path: "/fixtures/events", params: { fixture: fixtureId } }),
  lineups: (fixtureId) => ({ path: "/fixtures/lineups", params: { fixture: fixtureId } }),

  standings: (leagueId, season) => ({ path: "/standings", params: { league: leagueId, season } }),
  predictions: (fixtureId) => ({ path: "/predictions", params: { fixture: fixtureId } }),

  extractId: (liveItem) => liveItem?.fixture?.id ?? null,
  extractMeta: (liveItem) => ({
    fixtureId: liveItem?.fixture?.id ?? null,
    leagueId: liveItem?.league?.id ?? null,
    season: liveItem?.league?.season ?? null,
    league: liveItem?.league?.name ?? null,
    home: liveItem?.teams?.home?.name ?? null,
    away: liveItem?.teams?.away?.name ?? null,
    minute: liveItem?.fixture?.status?.elapsed ?? null,
    score:
      liveItem?.goals
        ? `${liveItem.goals.home ?? 0}-${liveItem.goals.away ?? 0}`
        : null,
  }),
};

// ✅ NBA (v2.nba.api-sports.io)
// IMPORTANTE: no produto NBA da API-SPORTS, os nomes de params podem variar (id vs game vs date).
// Aqui está o “mais comum”: /games?live=all e id no /games/statistics.
// Se algum endpoint/param der erro, você me manda o erro e eu ajusto 100%.
const nba = {
  base: NBA_BASE,

  liveGames: () => ({ path: "/games", params: { live: "all" } }),

  // odds pode existir como /odds ou /odds/live dependendo do produto
  liveOdds: () => ({ path: "/odds", params: { live: "all" } }),

  // estatísticas do jogo (comum: /games/statistics?id=)
  stats: (gameId) => ({ path: "/games/statistics", params: { id: gameId } }),

  // eventos (play-by-play) — se não existir no seu plano, vai dar 404
  events: (gameId) => ({ path: "/games/events", params: { id: gameId } }),

  // lineups (muitas vezes não existe em NBA v2) — se der 404, removemos
  lineups: (gameId) => ({ path: "/games/lineups", params: { id: gameId } }),

  // standings (normalmente /standings?league=&season=)
  standings: (league, season) => ({ path: "/standings", params: { league, season } }),

  // predictions geralmente não existe na NBA v2; deixo opcional
  predictions: (gameId) => ({ path: "/predictions", params: { id: gameId } }),

  extractId: (liveItem) => liveItem?.id ?? liveItem?.game?.id ?? null,
  extractMeta: (liveItem) => ({
    gameId: liveItem?.id ?? liveItem?.game?.id ?? null,
    league: liveItem?.league?.name ?? liveItem?.league ?? null,
    home: liveItem?.teams?.home?.name ?? liveItem?.home?.name ?? null,
    away: liveItem?.teams?.away?.name ?? liveItem?.away?.name ?? null,
    minute: liveItem?.status?.clock ?? liveItem?.game?.status?.clock ?? null,
    score:
      liveItem?.scores
        ? `${liveItem.scores.home?.points ?? 0}-${liveItem.scores.visitors?.points ?? 0}`
        : liveItem?.score
          ? `${liveItem.score.home ?? 0}-${liveItem.score.away ?? 0}`
          : null,
  }),
};

const ADAPTERS = {
  football,
  nba,
};

// =========================
// DEBUG ENDPOINTS
// =========================
app.get("/", (req, res) => res.send("PredictIA backend (football v3 + nba v2)"));

app.get("/debug/env", (req, res) => {
  res.json({
    ok: true,
    hasApiKey: Boolean(API_KEY),
    footballBase: FOOTBALL_BASE,
    nbaBase: NBA_BASE,
  });
});

app.get("/debug/football/ping", async (req, res) => {
  try {
    const cfg = football.liveGames();
    const data = await apiSports(football.base, cfg.path, cfg.params);
    res.json({ ok: true, base: football.base, keys: Object.keys(data), sample: takeFirstResponse(data) });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.get("/debug/nba/ping", async (req, res) => {
  try {
    const cfg = nba.liveGames();
    const data = await apiSports(nba.base, cfg.path, cfg.params);
    res.json({ ok: true, base: nba.base, keys: Object.keys(data), sample: takeFirstResponse(data) });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// =========================
// MAIN ENDPOINT (APP)
// =========================
// Body esperado:
// {
//   "sport": "football" | "nba",
//   "leagueId": 71,         // só football standings
//   "season": 2025,         // só football standings
//   "all": true,            // ignora filtros por time
//   "maxGames": 5,          // limita quantos jogos serão analisados
//   "include": {            // liga/desliga buscas pesadas
//     "odds": true,
//     "stats": true,
//     "events": true,
//     "lineups": true,
//     "standings": true,
//     "predictions": true
//   }
// }
app.post("/alerts/search", async (req, res) => {
  try {
    const { sport, leagueId, season, all, maxGames, include } = req.body || {};

    const a = ADAPTERS[sport];
    if (!a) return res.status(400).json({ error: "invalid_sport" });

    const inc = {
      odds: true,
      stats: true,
      events: false,     // pesado
      lineups: false,    // pesado
      standings: false,  // pesado
      predictions: false,// pesado
      ...(include || {}),
    };

    // 1) LIVE
    const liveCfg = a.liveGames();
    const live = await apiSports(a.base, liveCfg.path, liveCfg.params);
    const liveList = Array.isArray(live?.response) ? live.response : [];

    if (liveList.length === 0) {
      return res.json({ status: "ok", opportunities: [], note: "no_live_games" });
    }

    // limita pra não explodir custo/tempo
    const slice = liveList.slice(0, Math.max(1, Math.min(Number(maxGames || 3), 10)));

    // 2) PARA CADA JOGO, buscar dados extras (opcional)
    const results = [];
    for (const item of slice) {
      const id = a.extractId(item);
      if (!id) continue;

      const meta = a.extractMeta(item);

      const payload = {
        meta,
        live: item,
        odds: null,
        stats: null,
        events: null,
        lineups: null,
        standings: null,
        predictions: null,
      };

      if (inc.odds) {
        try {
          const oddsCfg = a.liveOdds();
          payload.odds = await apiSports(a.base, oddsCfg.path, oddsCfg.params);
        } catch (e) {
          payload.odds = { error: String(e.message || e) };
        }
      }

      if (inc.stats && a.stats) {
        try {
          const cfg = a.stats(id);
          payload.stats = await apiSports(a.base, cfg.path, cfg.params);
        } catch (e) {
          payload.stats = { error: String(e.message || e) };
        }
      }

      if (inc.events && a.events) {
        try {
          const cfg = a.events(id);
          payload.events = await apiSports(a.base, cfg.path, cfg.params);
        } catch (e) {
          payload.events = { error: String(e.message || e) };
        }
      }

      if (inc.lineups && a.lineups) {
        try {
          const cfg = a.lineups(id);
          payload.lineups = await apiSports(a.base, cfg.path, cfg.params);
        } catch (e) {
          payload.lineups = { error: String(e.message || e) };
        }
      }

      if (inc.standings && a.standings) {
        try {
          // futebol: precisa leagueId e season
          if (sport === "football" && leagueId && season) {
            const cfg = a.standings(leagueId, season);
            payload.standings = await apiSports(a.base, cfg.path, cfg.params);
          } else if (sport === "nba") {
            // nba: você ajusta league/season quando definir o formato real do endpoint
            // por enquanto só ignora se não passar
            payload.standings = { skipped: true };
          }
        } catch (e) {
          payload.standings = { error: String(e.message || e) };
        }
      }

      if (inc.predictions && a.predictions) {
        try {
          const cfg = a.predictions(id);
          payload.predictions = await apiSports(a.base, cfg.path, cfg.params);
        } catch (e) {
          payload.predictions = { error: String(e.message || e) };
        }
      }

      results.push(payload);
    }

    // 3) AQUI entra sua IA depois (Gemini) — por enquanto devolve “dados brutos” pra validar endpoints.
    // Você já tem a parte do Gemini funcionando; depois a gente pluga:
    // - montar um "contexto" com odds/stats/events/lineups/standings/predictions
    // - enviar pro Gemini
    // - receber oportunidades e montar cards

    return res.json({
      status: "ok",
      sport,
      fetched: results.length,
      opportunities: [],
      debug: {
        inc,
        sampleMeta: results[0]?.meta ?? null,
      },
      raw: results,
    });
  } catch (e) {
    return res.status(500).json({ error: "backend_error", detail: String(e.message || e) });
  }
});

// =========================
// START
// =========================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("Backend rodando na porta", PORT));
