// routes/liveRoutes.js
import express from "express";
import axios from "axios";

const router = express.Router();

const apiFootball = axios.create({
  baseURL: "https://v3.football.api-sports.io",
  headers: {
    "x-apisports-key": process.env.API_FOOTBALL_KEY,
  },
});

function normalizeFixture(f) {
  return {
    fixtureId: f?.fixture?.id ?? null,
    league: {
      id: f?.league?.id ?? null,
      name: f?.league?.name ?? null,
    },
    teams: {
      home: { name: f?.teams?.home?.name ?? null },
      away: { name: f?.teams?.away?.name ?? null },
    },
    time: f?.fixture?.status?.elapsed ?? 0,
  };
}

// GET /football/live?leagueId=475
router.get("/football/live", async (req, res) => {
  try {
    const { leagueId } = req.query;

    const params = { live: "all" };
    if (leagueId) params.league = leagueId;

    const r = await apiFootball.get("/fixtures", { params });

    const list = (r.data?.response ?? []).map(normalizeFixture);

    return res.json({
      success: true,
      data: list.filter((x) => x.fixtureId != null),
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: "Erro ao buscar jogos ao vivo",
      error: err?.message ?? String(err),
    });
  }
});

export default router;
