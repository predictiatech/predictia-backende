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
    return await response.json();
  } catch (error) {
    return { response: [], errors: [error.message] };
  }
}

const ADAPTERS = {
  football: {
    base: FOOTBALL_BASE,
    // Se passar data, usa data. Se não, usa live.
    getGamesPath: (date) => ({ path: "/fixtures", params: date ? { date } : { live: "all" } }),
    stats: (id) => ({ path: "/fixtures/statistics", params: { fixture: id } }),
    odds: (id) => ({ path: "/odds", params: { fixture: id } }),
    extractId: (item) => item.fixture?.id,
    extractMeta: (item) => ({
      id: item.fixture?.id,
      teams: `${item.teams?.home?.name} vs ${item.teams?.away?.name}`,
      score: `${item.goals?.home ?? 0}-${item.goals?.away ?? 0}`
    })
  },
  nba: {
    base: NBA_BASE,
    getGamesPath: (date) => ({ path: "/games", params: date ? { date } : { live: "all" } }),
    stats: (id) => ({ path: "/games/statistics", params: { id: id } }),
    odds: (id) => ({ path: "/odds", params: { game: id } }),
    extractId: (item) => item.id,
    extractMeta: (item) => ({
      id: item.id,
      teams: `${item.teams?.home?.name} vs ${item.teams?.visitors?.name}`,
      score: `${item.scores?.home?.points ?? 0}-${item.scores?.visitors?.points ?? 0}`
    })
  }
};

app.post("/alerts/search", async (req, res) => {
  try {
    const { sport, maxGames = 3, include = {}, date } = req.body;
    const adapter = ADAPTERS[sport];

    if (!adapter) return res.status(400).json({ error: "Sport inválido." });

    // Busca jogos (Live ou por Data)
    const gamesCfg = adapter.getGamesPath(date);
    const gamesData = await apiSports(adapter.base, gamesCfg.path, gamesCfg.params);
    const games = (gamesData.response || []).slice(0, maxGames);

    const results = await Promise.all(games.map(async (game) => {
      const id = adapter.extractId(game);
      const details = { meta: adapter.extractMeta(game), live: game };

      if (include.stats) {
        const cfg = adapter.stats(id);
        details.stats = await apiSports(adapter.base, cfg.path, cfg.params);
      }
      if (include.odds) {
        const cfg = adapter.odds(id);
        details.odds = await apiSports(adapter.base, cfg.path, cfg.params);
      }
      return details;
    }));

    res.json({ status: "ok", count: results.length, data: results });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/", (req, res) => res.send("PredictIA API Online"));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Servidor ativo na porta ${PORT}`));
