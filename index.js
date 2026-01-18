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

if (!API_KEY) {
  console.warn("AVISO: Variável API_SPORTS_KEY não encontrada no ambiente!");
}

// =========================
// AUXILIAR DE REQUISIÇÃO (FETCH NATIVO)
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

    if (!response.ok) {
      throw new Error(`Erro HTTP: ${response.status}`);
    }

    const data = await response.json();
    
    if (data.errors && Object.keys(data.errors).length > 0) {
      console.error(`Erro reportado pela API em ${path}:`, data.errors);
    }
    
    return data;
  } catch (error) {
    console.error(`Falha na chamada API (${path}):`, error.message);
    return { response: [], errors: [error.message] };
  }
}

// =========================
// ADAPTADORES DE DADOS
// =========================
const ADAPTERS = {
  football: {
    base: FOOTBALL_BASE,
    liveGames: () => ({ path: "/fixtures", params: { live: "all" } }),
    // Endpoints detalhados
    stats: (id) => ({ path: "/fixtures/statistics", params: { fixture: id } }),
    events: (id) => ({ path: "/fixtures/events", params: { fixture: id } }),
    lineups: (id) => ({ path: "/fixtures/lineups", params: { fixture: id } }),
    predictions: (id) => ({ path: "/predictions", params: { fixture: id } }),
    preLiveOdds: (id) => ({ path: "/odds", params: { fixture: id } }),
    liveOdds: (id) => ({ path: "/odds/live", params: { fixture: id } }),
    
    extractId: (item) => item.fixture?.id,
    extractMeta: (item) => ({
      id: item.fixture?.id,
      league: item.league?.name,
      home: item.teams?.home?.name,
      away: item.teams?.away?.name,
      score: `${item.goals?.home ?? 0}-${item.goals?.away ?? 0}`,
      timer: item.fixture?.status?.elapsed
    })
  },
  nba: {
    base: NBA_BASE,
    liveGames: () => ({ path: "/games", params: { live: "all" } }),
    // Endpoints detalhados (NBA v2 usa padrões de busca diferentes)
    stats: (id) => ({ path: "/games/statistics", params: { id: id } }),
    events: (id) => ({ path: "/games/events", params: { game: id } }), 
    lineups: (id) => ({ path: "/games/lineups", params: { game: id } }),
    predictions: (id) => ({ path: "/predictions", params: { game: id } }),
    preLiveOdds: (id) => ({ path: "/odds", params: { game: id } }),
    liveOdds: (id) => ({ path: "/odds", params: { game: id } }),

    extractId: (item) => item.id,
    extractMeta: (item) => ({
      id: item.id,
      league: "NBA",
      home: item.teams?.home?.name,
      away: item.teams?.visitors?.name,
      score: `${item.scores?.home?.points ?? 0}-${item.scores?.visitors?.points ?? 0}`,
      timer: item.status?.clock || item.status?.long
    })
  }
