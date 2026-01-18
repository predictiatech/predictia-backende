import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

app.get("/", (req, res) => {
  res.send("PredictIA backend rodando");
});

app.post("/alerts/search", async (req, res) => {
  try {
    const { sport, leagueId, all } = req.body;

    if (sport !== "football") {
      return res.json({ status: "empty", opportunities: [] });
    }

    const params = new URLSearchParams({ live: "all" });
    if (!all && leagueId) params.set("league", leagueId);

    const r = await fetch(
      `https://v3.football.api-sports.io/fixtures?${params}`,
      {
        headers: {
          "x-apisports-key": process.env.FOOTBALL_API_KEY
        }
      }
    );

    const data = await r.json();
    const fixtures = data.response ?? [];

    const candidates = fixtures.filter(f => {
      const m = f?.fixture?.status?.elapsed ?? 0;
      return m >= 55 && m <= 88;
    }).slice(0, 5);

    if (candidates.length === 0) {
      return res.json({ status: "empty", opportunities: [] });
    }

    const payload = candidates.map(f => ({
      fixtureId: f.fixture.id,
      league: f.league.name,
      home: f.teams.home.name,
      away: f.teams.away.name,
      minute: f.fixture.status.elapsed,
      score: `${f.goals.home}-${f.goals.away}`
    }));

    const prompt = `
Retorne APENAS JSON no formato:
{
 "status":"ok|empty",
 "opportunities":[
   {
     "fixtureId":number,
     "league":string,
     "home":string,
     "away":string,
     "minute":number,
     "score":string,
     "tip":string,
     "confidence":number
   }
 ]
}
Dados:
${JSON.stringify(payload)}
`;

    const gemini = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }]
        })
      }
    );

    const g = await gemini.json();
    const text = g.candidates[0].content.parts[0].text;

    const json = JSON.parse(
      text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)
    );

    res.json(json);

  } catch (e) {
    res.status(500).json({ error: "backend_error" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Backend rodando na porta", PORT);
});
