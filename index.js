// index.js (VERSÃO CORRIGIDA E OTIMIZADA)
import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

// =========================
// CONFIGURAÇÃO DE AMBIENTE
// =========================
const API_KEY = process.env.API_SPORTS_KEY || "SUA_CHAVE_AQUI"; 
const FOOTBALL_BASE = "https://v3.football.api-sports.io";
const NBA_BASE = "https://v2.nba.api-sports.io";

// =========================
// AUXILIAR DE REQUISIÇÃO
// =========================
async function apiSports(base, path, params = {}) {
  const url = new URL(base + path);
  Object.entries(params).forEach(([k, v]) => {
    if (v) url.searchParams.set(k, String(v));
  });

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: {
      "x-apisports-key": API_KEY,
      "x-rapidapi-host": base.replace("https://", ""),
      "Accept": "application/json",
    }
  });

  const data = await response.json();
  if (data.errors && Object.keys(data.errors).length > 0) {
    console.error(`Erro na API (${path}):`, data.errors);
  }
  return data;
}

// =========================
// ADAPTADORES (MAPAS DE ENDPOINTS)
// =========================
const ADAPTERS = {
  football: {
    base: FOOTBALL_BASE,
    liveGames: () => ({ path: "/fixtures", params: { live: "all" } }),
    // Endpoints específicos por jogo
    stats: (id) => ({ path: "/fixtures/statistics", params: { fixture: id } }),
    events: (id) => ({ path: "/fixtures/events", params: { fixture: id } }),
    lineups: (id) => ({ path: "/fixtures/lineups", params: { fixture: id } }),
    preLiveOdds: (id) => ({ path: "/odds", params: { fixture: id } }),
    liveOdds: (id) => ({ path: "/odds/live", params: { fixture: id } }),
    
    extractId: (item) => item.fixture.id,
    extractMeta: (item) => ({
      id: item.fixture.id,
      status: item.fixture.status.long,
      timer: item.fixture.status.elapsed,
      home: item.teams.home.name,
      away: item.teams.away.name,
      score: `${item.goals.home}-${item.goals.away}`
    })
  },
  nba: {
    base: NBA_BASE,
    liveGames: () => ({ path: "/games", params: { live: "all" } }),
    // Na NBA o parâmetro de ID costuma ser "id" ou "game"
    stats: (id) => ({ path: "/games/statistics", params: { id: id } }),
    events: (id) => ({ path: "/games/events", params: { game: id } }), 
    lineups: (id) => ({ path: "/games/lineups", params: { game: id } }),
    preLiveOdds: (id) => ({ path: "/odds", params: { game: id } }),
    liveOdds: (id) => ({ path: "/odds", params: { game: id } }), // NBA raramente tem live odds separado

    extractId: (item) => item.id,
    extractMeta: (item) => ({
      id: item.id,
      status: item.status.long,
      timer: item.status.clock,
      home: item.teams.home.name,
      away: item.teams.visitors.name,
      score: `${item.scores.home.points}-${item.scores.visitors.points}`
    })
  }
};

// =========================
// ENDPOINT PRINCIPAL (ALERTS/SEARCH)
// =========================
app.post("/alerts/search", async (req, res) => {
  try {
    const { sport, maxGames = 3, include = {} } = req.body;
    const adapter = ADAPTERS[sport];

    if (!adapter) return res.status(400).json({ error: "Esporte inválido (use 'football' ou 'nba')" });

    // 1. Pega jogos ao vivo
    const liveData = await apiSports(adapter.base, adapter.liveGames().path, adapter.liveGames().params);
    const games = (liveData.response || []).slice(0, maxGames);

    const fullResults = await Promise.all(games.map(async (game) => {
      const id = adapter.extractId(game);
      const meta = adapter.extractMeta(game);

      // 2. Coleta dados paralelos para cada jogo
      const details = { meta, live: game };

      // Executa as chamadas extras conforme o "include" do body
      if (include.stats) {
        const cfg = adapter.stats(id);
        details.stats = await apiSports(adapter.base, cfg.path, cfg.params);
      }
      if (include.events) {
        const cfg = adapter.events(id);
        details.events = await apiSports(adapter.base, cfg.path, cfg.params);
      }
      if (include.odds) {
        // Tenta pegar Odds Pré-live e Live
        const preCfg = adapter.preLiveOdds(id);
        const liveCfg = adapter.liveOdds(id);
        details.odds = {
          preLive: await apiSports(adapter.base, preCfg.path, preCfg.params),
          live: await apiSports(adapter.base, liveCfg.path, liveCfg.params)
        };
      }

      return details;
    }));

    res.json({
      status: "ok",
      results_count: fullResults.length,
      data: fullResults
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Port e Start
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Servidor PredictIA ativo na porta ${PORT}`));
