import 'dotenv/config';
import express from 'express';
import cors from 'cors';

const app = express();

// Middlewares
app.use(cors());
app.use(express.json());

// =========================
// CONFIGURAÇÃO DE AMBIENTE
// =========================
const API_KEY = process.env.API_SPORTS_KEY;
const FOOTBALL_BASE = "https://v3.football.api-sports.io";
const NBA_BASE = "https://v2.nba.api-sports.io";

// =========================
// AUXILIAR DE REQUISIÇÃO
// =========================
async function apiSports(base, path, params = {}) {
  const url = new URL(base + path);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  });

  try {
    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        "x-apisports-key": API_KEY,
        "x-rapidapi-host": base.replace("https://", ""),
        "Accept": "application/json",
      }
    });

    const data = await response.json();
    return data;
  } catch (error) {
    console.error(`Erro na chamada API ${path}:`, error.message);
    return { response: [], errors: [error.message] };
  }
}

// =========================
// ADAPTADORES
// =========================
const ADAPTERS = {
  football: {
    base: FOOTBALL_BASE,
    liveGames: () => ({ path: "/fixtures", params: { live: "all" } }),
    stats: (id) => ({ path: "/fixtures/statistics", params: { fixture: id } }),
    events: (id) => ({ path: "/fixtures/events", params: { fixture: id } }),
    lineups: (id) => ({ path: "/fixtures/lineups", params: { fixture: id } }),
    preLiveOdds: (id) => ({ path: "/odds", params: { fixture: id } }),
    liveOdds: (id) => ({ path: "/odds/live", params: { fixture: id } }),
    extractId: (item) => item.fixture?.id,
    extractMeta: (item) => ({
      id: item.fixture?.id,
      home: item.teams?.home?.name,
      away: item.teams?.away?.name,
      score: `${item.goals?.home ?? 0}-${item.goals?.away ?? 0}`,
      timer: item.fixture?.status?.elapsed
    })
  },
  nba: {
    base: NBA_BASE,
    liveGames: () => ({ path: "/games", params: { live: "all" } }),
    stats: (id) => ({ path: "/games/statistics", params: { id: id } }),
    events: (id) => ({ path: "/games/events", params: { game: id } }),
    lineups: (id) => ({ path: "/games/lineups", params: { game: id } }),
    preLiveOdds: (id) => ({ path: "/odds", params: { game: id } }),
    liveOdds: (id) => ({ path: "/odds", params: { game: id } }),
    extractId: (item) => item.id,
    extractMeta: (item) => ({
      id: item.id,
      home: item.teams?.home?.name,
      away: item.teams?.visitors?.name,
      score: `${item.scores?.home?.points ?? 0}-${item.scores?.visitors?.points ?? 0}`,
      timer: item.status?.clock || item.status?.long
    })
  }
};

// =========================
// ROTA PRINCIPAL
// =========================
app.post("/alerts/search", async (req, res) => {
  try {
    const { sport, maxGames = 3, include = {} } = req.body;
    const adapter = ADAPTERS[sport];

    if (!adapter) return res.status(400).json({ error: "Sport inválido." });

    const liveData = await apiSports(adapter.base, adapter.liveGames().path, adapter.liveGames().params);
    const games = (liveData.response || []).slice(0, maxGames);

    const results = await Promise.all(games.map(async (game) => {
      const id = adapter.extractId(game);
      const meta = adapter.extractMeta(game);
      const details = { meta, live: game };

      if (include.stats) {
        const cfg = adapter.stats(id);
        details.stats = await apiSports(adapter.base, cfg.path, cfg.params);
      }
      if (include.odds) {
        const pre = adapter.preLiveOdds(id);
        const live = adapter.liveOdds(id);
        details.odds = {
          preLive: await apiSports(adapter.base, pre.path, pre.params),
          live: await apiSports(adapter.base, live.path, live.params)
        };
      }
      return details;
    }));

    res.json({ status: "ok", data: results });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/", (req, res) => res.send("PredictIA API Online"));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
