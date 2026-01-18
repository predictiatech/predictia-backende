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
    const json = await response.json();
    return json;
  } catch (error) {
    return { errors: { internal: error.message } };
  }
}

app.post("/alerts/search", async (req, res) => {
  try {
    const { sport, date, season = "2025" } = req.body;
    const adapter = sport === 'nba' ? 
      { base: NBA_BASE, path: "/games", params: { date, season } } :
      { base: FOOTBALL_BASE, path: "/fixtures", params: { date } };

    // Caso não tenha data, tenta o live
    if (!date) {
      adapter.params = { live: "all" };
    }

    const gamesData = await apiSports(adapter.base, adapter.path, adapter.params);

    // Retornamos TUDO para ver o que está acontecendo
    res.json({
      status: "check",
      endpoint_chamado: adapter.path,
      params_usados: adapter.params,
      api_sports_errors: gamesData.errors, // <--- VEJA ISSO
      api_sports_results: gamesData.results,
      data: gamesData.response || []
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/", (req, res) => res.send("PredictIA Debug Mode Online"));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Rodando na porta ${PORT}`));
