import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

const API_KEY = process.env.API_SPORTS_KEY;
const FOOTBALL_BASE = process.env.FOOTBALL_BASE || "https://v3.football.api-sports.io";
const NBA_BASE = process.env.NBA_BASE; // << OBRIGATÓRIO preencher no Render

if (!API_KEY) console.warn("MISSING: API_SPORTS_KEY");
if (!NBA_BASE) console.warn("MISSING: NBA_BASE");

async function apiSports(base, path, params = {}) {
  const url = new URL(base + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== null && v !== undefined) url.searchParams.set(k, String(v));
  }

  const r = await fetch(url.toString(), {
    headers: { "x-apisports-key": API_KEY },
  });

  const text = await r.text();
  if (!r.ok) throw new Error(`API_SPORTS_HTTP_${r.status}: ${text}`);
  return JSON.parse(text);
}

// ✅ MAPA DE ENDPOINTS
// FUTEBOL (confirmado)
const football = {
  base: FOOTBALL_BASE,
  liveGames: () => ({ path: "/fixtures", params: { live: "all" } }),
  liveOdds: () => ({ path: "/odds/live", params: {} }),
  stats: (fixtureId) => ({ path: "/fixtures/statistics", params: { fixture: fixtureId } }),
  events: (fixtureId) => ({ path: "/fixtures/events", params: { fixture: fixtureId } }),
  lineups: (fixtureId) => ({ path: "/fixtures/lineups", params: { fixture: fixtureId } }),
  standings: (leagueId, season) => ({ path: "/standings", params: { league: leagueId, season } }),
  predictions: (fixtureId) => ({ path: "/predictions", params: { fixture: fixtureId } }),
};

// NBA (você vai colar os paths CERTOS do seu doc NBA)
// ⚠️ Eu deixei placeholders porque cada produto NBA pode ter nomes diferentes.
// Você vai só trocar as strings dos "path" abaixo conforme a doc da SUA conta.
const nba = {
  base: NBA_BASE,
  liveGames: () => ({ path: "/games", params: { live: "all" } }),                 // <-- AJUSTE
  liveOdds: () => ({ path: "/odds", params: { live: "all" } }),                   // <-- AJUSTE
  stats: (gameId) => ({ path: "/games/statistics", params: { game: gameId } }),   // <-- AJUSTE
  events: (gameId) => ({ path: "/games/events", params: { game: gameId } }),      // <-- AJUSTE (se existir)
  lineups: (gameId) => ({ path: "/games/lineups", params: { game: gameId } }),    // <-- AJUSTE (se existir)
  standings: (leagueId, season) => ({ path: "/standings", params: { league: leagueId, season } }), // <-- AJUSTE
  predictions: (gameId) => ({ path: "/predictions", params: { game: gameId } }),  // <-- AJUSTE (se existir)
};

const ADAPTERS = { football, nba };

// ✅ DEBUG: ver se a BASE NBA está certa e retorna algo
app.get("/debug/nba/ping", async (req, res) => {
  try {
    if (!NBA_BASE) return res.status(500).json({ error: "missing_env", missing: "NBA_BASE" });
    const { path, params } = nba.liveGames(); // tenta listar ao vivo
    const data = await apiSports(nba.base, path, params);
    return res.json({ ok: true, base: nba.base, sampleKeys: Object.keys(data) });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// ✅ Endpoint principal do app
app.post("/alerts/search", async (req, res) => {
  try {
    const { sport } = req.body; // "football" ou "nba"
    const a = ADAPTERS[sport];
    if (!a) return res.status(400).json({ error: "invalid_sport" });
    if (sport === "nba" && !NBA_BASE) return res.status(500).json({ error: "missing_env", missing: "NBA_BASE" });

    // 1) pega jogos ao vivo
    const liveCfg = a.liveGames();
    const live = await apiSports(a.base, liveCfg.path, liveCfg.params);

    // 2) para cada jogo, você chama odds/stats/events/lineups/predictions/standings
    // (aqui eu deixo só um exemplo com 1 jogo pra não explodir custo/tempo)
    const first = live?.response?.[0];
    if (!first) return res.json({ status: "ok", opportunities: [] });

    const id = sport === "football" ? first.fixture?.id : (first.game?.id ?? first.id);

    const odds = await apiSports(a.base, a.liveOdds().path, a.liveOdds().params);
    const stats = await apiSports(a.base, a.stats(id).path, a.stats(id).params);

    // (opcional) events/lineups/predictions/standings — só chamar igual:
    // const events = await apiSports(a.base, a.events(id).path, a.events(id).params);

    return res.json({
      status: "ok",
      debug: { sport, id },
      live_sample: first,
      odds_sample: odds?.response?.[0] ?? null,
      stats_sample: stats?.response?.[0] ?? null,
    });
  } catch (e) {
    return res.status(500).json({ error: "backend_error", detail: String(e.message || e) });
  }
});

app.get("/", (req, res) => res.send("PredictIA backend (football+nba bases)"));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("Backend rodando na porta", PORT));
