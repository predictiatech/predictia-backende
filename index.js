import 'dotenv/config';
import express from 'express';
import cors from 'cors';

const app = express();
app.use(cors());
app.use(express.json());

const API_KEY = process.env.API_SPORTS_KEY;
const FOOTBALL_BASE = "https://v3.football.api-sports.io";
const NBA_BASE = "https://v2.nba.api-sports.io";

async function apiSports(base, path, params = {}) {
  const url = new URL(base + path);
  Object.entries(params).forEach(([k, v]) => {
    if (v) url.searchParams.set(k, String(v));
  });

  try {
    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        "x-apisports-key": API_KEY,
        "Accept": "application/json",
      }
    });
    return await response.json();
  } catch (error) {
    return { response: [], errors: { internal: error.message } };
  }
}

const ADAPTERS = {
  football: {
    base: FOOTBALL_BASE,
    getGames: (date) => ({ path: "/fixtures", params: date ? { date } : { live: "all" } }),
    stats: (id) => ({ path: "/fixtures/statistics", params: { fixture: id } }),
    odds: (id) => ({ path: "/odds/live", params: { fixture: id } }), // Tenta odds ao vivo primeiro
    extractId: (item) => item.fixture?.id
  },
  nba: {
    base: NBA_BASE,
    getGames: (date) => ({ path: "/games", params: { date: date || "2026-01-18", season: "2025" } }),
    stats: (id) => ({ path: "/games/statistics", params: { id: id } }),
    odds: (id) => ({ path: "/odds", params: { game: id } }),
    extractId: (item) => item.id
  }
};

app.post("/alerts/search", async (req, res) => {
  try {
    const { sport, date, maxGames = 6, include = {} } = req.body;
    const adapter = ADAPTERS[sport];

    if (!adapter) return res.status(400).json({ error: "Esporte inválido." });

    const gamesCfg = adapter.getGames(date);
    const gamesData = await apiSports(adapter.base, gamesCfg.path, gamesCfg.params);
    const games = (gamesData.response || []).slice(0, maxGames);

    // Agora buscamos os detalhes (Odds e Stats) para cada jogo em paralelo
    const fullData = await Promise.all(games.map(async (game) => {
      const id = adapter.extractId(game);
      const details = { ...game };

      if (include.stats) {
        const s = await apiSports(adapter.base, adapter.stats(id).path, adapter.stats(id).params);
        details.live_stats = s.response || [];
      }
      
      if (include.odds) {
        const o = await apiSports(adapter.base, adapter.odds(id).path, adapter.odds(id).params);
        details.live_odds = o.response || [];
      }

      return details;
    }));

    res.json({ status: "ok", count: fullData.length, data: fullData });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/", (req, res) => res.send("PredictIA Full Engine Online"));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
