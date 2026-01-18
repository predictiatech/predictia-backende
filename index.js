// index.js (COMPLETO) — Football v3 + NBA v2 + Debug extra (stats/odds/events/lineups/standings/predictions) + DEBUG FOOTBALL ODDS

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
  process.env.FOOTBALL_API_KEY ||
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
    } catch {
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

// FUTEBOL (v3.football.api-sports.io)
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
    score: liveItem?.goals ? `${liveItem.goals.home ?? 0}-${liveItem.goals.away ?? 0}` : null,
  }),
};

// NBA (v2.nba.api-sports.io)
const nba = {
  base: NBA_BASE,

  liveGames: () => ({ path: "/games", params: { live: "all" } }),
  liveOdds: () => ({ path: "/odds", params: { live: "all" } }),

  stats: (gameId) => ({ path: "/games/statistics", params: { id: gameId } }),
  events: (gameId) => ({ path: "/games/events", params: { id: gameId } }),
  lineups: (gameId) => ({ path: "/games/lineups", params: { id: gameId } }),

  standings: (league, season) => ({ path: "/standings", params: { league, season } }),
  predictions: (gameId) => ({ path: "/predictions", params: { id: gameId } }),

  extractId: (liveItem) => liveItem?.id ?? liveItem?.game?.id ?? null,
  extractMeta: (liveItem) => ({
    gameId: liveItem?.id ?? liveItem?.game?.id ?? null,
    league: liveItem?.league?.name ?? liveItem?.league ?? null,
    season: liveItem?.season ?? null,
    home: liveItem?.teams?.home?.name ?? liveItem?.home?.name ?? null,
    away: liveItem?.teams?.visitors?.name ?? liveItem?.teams?.away?.name ?? liveItem?.away?.name ?? null,
    clock: liveItem?.status?.clock ?? liveItem?.game?.status?.clock ?? null,
    period: liveItem?.periods?.current ?? null,
    score:
      liveItem?.scores
        ? `${liveItem.scores.home?.points ?? 0}-${liveItem.scores.visitors?.points ?? 0}`
        : null,
  }),
};

const ADAPTERS = { football, nba };

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
// DEBUG FOOTBALL ODDS
// =========================

// 1) Lista mercados (bets)
app.get("/debug/football/odds/bets", async (req, res) => {
  try {
    const data = await apiSports(football.base, "/odds/bets", {});
    return res.json({
      ok: true,
      endpoint: { path: "/odds/bets", params: {} },
      results: data?.results ?? null,
      errors: data?.errors ?? null,
      sample: takeFirstResponse(data),
      rawKeys: Object.keys(data || {}),
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// 2) Odds ao vivo (por fixture + bet)
app.get("/debug/football/odds/live", async (req, res) => {
  try {
    const fixture = req.query.fixture;
    const bet = req.query.bet;

    if (!fixture) return res.status(400).json({ error: "missing_query", missing: "fixture" });
    if (!bet) return res.status(400).json({ error: "missing_query", missing: "bet" });

    const data = await apiSports(football.base, "/odds/live", { fixture, bet });
    return res.json({
      ok: true,
      endpoint: { path: "/odds/live", params: { fixture, bet } },
      results: data?.results ?? null,
      errors: data?.errors ?? null,
      sample: takeFirstResponse(data),
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// 3) Odds pré-jogo (por fixture + bet)
app.get("/debug/football/odds", async (req, res) => {
  try {
    const fixture = req.query.fixture;
    const bet = req.query.bet;

    if (!fixture) return res.status(400).json({ error: "missing_query", missing: "fixture" });
    if (!bet) return res.status(400).json({ error: "missing_query", missing: "bet" });

    const data = await apiSports(football.base, "/odds", { fixture, bet });
    return res.json({
      ok: true,
      endpoint: { path: "/odds", params: { fixture, bet } },
      results: data?.results ?? null,
      errors: data?.errors ?? null,
      sample: takeFirstResponse(data),
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// ===== DEBUG NBA EXTRA =====
app.get("/debug/nba/stats", async (req, res) => {
  try {
    const id = req.query.id;
    if (!id) return res.status(400).json({ error: "missing_query", missing: "id" });

    const cfg = nba.stats(id);
    const data = await apiSports(nba.base, cfg.path, cfg.params);
    return res.json({ ok: true, endpoint: cfg, keys: Object.keys(data), sample: takeFirstResponse(data) });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.get("/debug/nba/odds", async (req, res) => {
  try {
    const cfg = nba.liveOdds();
    const data = await apiSports(nba.base, cfg.path, cfg.params);
    return res.json({ ok: true, endpoint: cfg, keys: Object.keys(data), sample: takeFirstResponse(data) });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.get("/debug/nba/standings", async (req, res) => {
  try {
    const league = req.query.league || "standard";
    const season = req.query.season || "2025";

    const cfg = nba.standings(league, season);
    const data = await apiSports(nba.base, cfg.path, cfg.params);
    return res.json({ ok: true, endpoint: cfg, keys: Object.keys(data), sample: takeFirstResponse(data) });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.get("/debug/nba/events", async (req, res) => {
  try {
    const id = req.query.id;
    if (!id) return res.status(400).json({ error: "missing_query", missing: "id" });

    const cfg = nba.events(id);
    const data = await apiSports(nba.base, cfg.path, cfg.params);
    return res.json({ ok: true, endpoint: cfg, keys: Object.keys(data), sample: takeFirstResponse(data) });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.get("/debug/nba/lineups", async (req, res) => {
  try {
    const id = req.query.id;
    if (!id) return res.status(400).json({ error: "missing_query", missing: "id" });

    const cfg = nba.lineups(id);
    const data = await apiSports(nba.base, cfg.path, cfg.params);
    return res.json({ ok: true, endpoint: cfg, keys: Object.keys(data), sample: takeFirstResponse(data) });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.get("/debug/nba/predictions", async (req, res) => {
  try {
    const id = req.query.id;
    if (!id) return res.status(400).json({ error: "missing_query", missing: "id" });

    const cfg = nba.predictions(id);
    const data = await apiSports(nba.base, cfg.path, cfg.params);
    return res.json({ ok: true, endpoint: cfg, keys: Object.keys(data), sample: takeFirstResponse(data) });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// =========================
// MAIN ENDPOINT (coleta dados)
// =========================
app.post("/alerts/search", async (req, res) => {
  try {
    const { sport, leagueId, season, maxGames, include } = req.body || {};

    const a = ADAPTERS[sport];
    if (!a) return res.status(400).json({ error: "invalid_sport" });

    const inc = {
      odds: true,
      stats: true,
      events: false,
      lineups: false,
      standings: false,
      predictions: false,
      ...(include || {}),
    };

    const liveCfg = a.liveGames();
    const live = await apiSports(a.base, liveCfg.path, liveCfg.params);
    const liveList = Array.isArray(live?.response) ? live.response : [];

    if (liveList.length === 0) {
      return res.json({ status: "ok", opportunities: [], note: "no_live_games" });
    }

    const slice = liveList.slice(0, Math.max(1, Math.min(Number(maxGames || 3), 10)));

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
          if (sport === "football" && leagueId && season) {
            const cfg = a.standings(leagueId, season);
            payload.standings = await apiSports(a.base, cfg.path, cfg.params);
          } else if (sport === "nba") {
            payload.standings = { skipped: true, note: "use /debug/nba/standings to validate league/season params" };
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

    return res.json({
      status: "ok",
      sport,
      fetched: results.length,
      opportunities: [],
      debug: { inc, sampleMeta: results[0]?.meta ?? null },
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
