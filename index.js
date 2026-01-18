// PASSO 2 — Cole ISTO no seu index.js (substitua o endpoint /alerts/search inteiro)
// Depois COMMIT no GitHub -> o Render redeploya -> aí o curl vai mostrar o erro real.

import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

app.get("/", (req, res) => res.send("PredictIA backend rodando"));

function safeJsonExtract(text) {
  const s = text.indexOf("{");
  const e = text.lastIndexOf("}");
  if (s === -1 || e === -1 || e <= s) return null;
  return text.slice(s, e + 1);
}

app.post("/alerts/search", async (req, res) => {
  try {
    const { sport, leagueId, all } = req.body ?? {};

    if (!process.env.FOOTBALL_API_KEY) {
      return res.status(500).json({ error: "missing_env", missing: "FOOTBALL_API_KEY" });
    }
    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({ error: "missing_env", missing: "GEMINI_API_KEY" });
    }

    if (sport !== "football") {
      return res.json({ status: "empty", opportunities: [] });
    }

    // 1) API-Football
    const params = new URLSearchParams({ live: "all" });
    if (!all && leagueId) params.set("league", String(leagueId));

    const r = await fetch(
      `https://v3.football.api-sports.io/fixtures?${params.toString()}`,
      { headers: { "x-apisports-key": process.env.FOOTBALL_API_KEY } }
    );

    const raw = await r.text();

    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      console.error("API_FOOTBALL_BAD_JSON:", raw.slice(0, 800));
      return res.status(502).json({ error: "api_football_bad_json" });
    }

    if (!r.ok) {
      console.error("API_FOOTBALL_HTTP_ERROR:", r.status, data);
      return res.status(502).json({ error: "api_football_http_error", status: r.status, data });
    }

    const fixtures = data.response ?? [];
    const candidates = fixtures
      .filter(f => {
        const m = f?.fixture?.status?.elapsed ?? 0;
        return m >= 55 && m <= 88;
      })
      .slice(0, 5);

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

    // 2) Gemini
    const prompt = `
RESPONDA APENAS COM JSON VÁLIDO (sem markdown, sem texto fora).
Se não houver oportunidades:
{"status":"empty","opportunities":[]}

Formato:
{"status":"ok","opportunities":[{"fixtureId":0,"league":"","home":"","away":"","minute":0,"score":"","tip":"","confidence":0}]}

Dados:
${JSON.stringify(payload)}
`;

    const g = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.2 }
        })
      }
    );

    const gRaw = await g.text();

    let gJson;
    try {
      gJson = JSON.parse(gRaw);
    } catch {
      console.error("GEMINI_BAD_JSON_HTTP:", gRaw.slice(0, 1200));
      return res.status(502).json({ error: "gemini_http_bad_json" });
    }

    if (!g.ok) {
      console.error("GEMINI_HTTP_ERROR:", g.status, gJson);
      return res.status(502).json({ error: "gemini_http_error", status: g.status, gJson });
    }

    const text = gJson?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    if (!text) {
      console.error("GEMINI_EMPTY_TEXT:", gJson);
      return res.status(502).json({ error: "gemini_empty_text" });
    }

    const extracted = safeJsonExtract(text);
    if (!extracted) {
      console.error("GEMINI_NOT_JSON_OUTPUT:", text.slice(0, 1200));
      return res.status(502).json({ error: "gemini_output_not_json", sample: text.slice(0, 300) });
    }

    let final;
    try {
      final = JSON.parse(extracted);
    } catch {
      console.error("GEMINI_OUTPUT_JSON_PARSE_FAIL:", extracted.slice(0, 1200));
      return res.status(502).json({ error: "gemini_output_parse_fail" });
    }

    if (!final.status || !Array.isArray(final.opportunities)) {
      return res.status(502).json({ error: "gemini_bad_schema", final });
    }

    return res.json(final);
  } catch (e) {
    console.error("BACKEND_ERROR:", e);
    return res.status(500).json({
      error: "backend_error",
      detail: String(e?.message ?? e),
      stack: String(e?.stack ?? "")
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Backend rodando na porta", PORT));
