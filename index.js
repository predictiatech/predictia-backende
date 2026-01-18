// index.js
import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

const FOOTBALL_BASE = "https://v3.football.api-sports.io";
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";

app.get("/", (_, res) => res.send("PredictIA backend rodando"));

/**
 * ENV REQUIRED:
 * - FOOTBALL_API_KEY
 * - GEMINI_API_KEY
 *
 * ENV OPTIONAL:
 * - GEMINI_MODEL (ex: gemini-2.0-flash, gemini-1.5-pro, etc)
 */

function extractFirstJson(text) {
  const s = text.indexOf("{");
  const e = text.lastIndexOf("}");
  if (s === -1 || e === -1 || e <= s) return null;
  return text.slice(s, e + 1);
}

async function footballGet(path, qs = {}) {
  const url = new URL(FOOTBALL_BASE + path);
  Object.entries(qs).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  });

  const r = await fetch(url.toString(), {
    headers: {
      "x-apisports-key": process.env.FOOTBALL_API_KEY,
    },
  });

  const raw = await r.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`API_FOOTBALL_BAD_JSON: ${raw.slice(0, 400)}`);
  }

  if (!r.ok) {
    throw new Error(`API_FOOTBALL_HTTP_${r.status}: ${JSON.stringify(data).slice(0, 600)}`);
  }

  return data;
}

async function geminiListModels() {
  const r = await fetch(`${GEMINI_BASE}/models`, {
    headers: { "x-goog-api-key": process.env.GEMINI_API_KEY },
  });

  const raw = await r.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`GEMINI_MODELS_BAD_JSON: ${raw.slice(0, 400)}`);
  }

  if (!r.ok) {
    throw new Error(`GEMINI_MODELS_HTTP_${r.status}: ${raw.slice(0, 600)}`);
  }

  const models = (data.models ?? []).map((m) => m?.name).filter(Boolean); // "models/...."
  return models;
}

async function pickGeminiModel() {
  if (process.env.GEMINI_MODEL) return process.env.GEMINI_MODEL;

  const available = await geminiListModels(); // returns "models/<id>"
  const preferred = [
    "models/gemini-2.5-flash",
    "models/gemini-2.0-flash",
    "models/gemini-1.5-flash",
    "models/gemini-1.5-pro",
    "models/gemini-1.0-pro",
  ];

  const found = preferred.find((p) => available.includes(p));
  if (found) return found.replace("models/", "");

  const any = available.find((m) => typeof m === "string" && m.startsWith("models/"));
  if (!any) throw new Error("GEMINI_NO_MODELS_AVAILABLE");
  return any.replace("models/", "");
}

async function geminiGenerate(prompt) {
  const model = await pickGeminiModel();

  const r = await fetch(`${GEMINI_BASE}/models/${model}:generateContent`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": process.env.GEMINI_API_KEY,
    },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.2 },
    }),
  });

  const raw = await r.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`GEMINI_HTTP_BAD_JSON: ${raw.slice(0, 700)}`);
  }

  if (!r.ok) {
    throw new Error(`GEMINI_HTTP_${r.status}: ${raw.slice(0, 900)}`);
  }

  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  if (!text) throw new Error(`GEMINI_EMPTY_TEXT: ${raw.slice(0, 900)}`);

  return text;
}

app.post("/alerts/search", async (req, res) => {
  try {
    if (!process.env.FOOTBALL_API_KEY) {
      return res.status(500).json({ error: "missing_env", missing: "FOOTBALL_API_KEY" });
    }
    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({ error: "missing_env", missing: "GEMINI_API_KEY" });
    }

    const { sport, leagueId, teamId, all } = req.body ?? {};

    // Ajuste aqui se quiser aceitar "nba"
    if (sport !== "football") {
      return res.json({ status: "empty", opportunities: [] });
    }

    // 1) Buscar jogos ao vivo (ou filtrados)
    const fixtures = await footballGet("/fixtures", {
      live: "all",
      league: all ? undefined : leagueId,
      team: all ? undefined : teamId,
    });

    const list = fixtures?.response ?? [];

    // 2) Candidatos (você pode mudar esses filtros depois)
    const candidates = list
      .map((f) => ({
        fixtureId: f?.fixture?.id,
        league: f?.league?.name,
        leagueId: f?.league?.id,
        home: f?.teams?.home?.name,
        away: f?.teams?.away?.name,
        minute: f?.fixture?.status?.elapsed ?? 0,
        score: `${f?.goals?.home ?? 0}-${f?.goals?.away ?? 0}`,
      }))
      .filter((x) => x.fixtureId && x.minute >= 50 && x.minute <= 88)
      .slice(0, 8);

    if (candidates.length === 0) {
      return res.json({ status: "empty", opportunities: [] });
    }

    // 3) Prompt (mude seus critérios aqui)
    const prompt = `
RESPONDA APENAS COM JSON VÁLIDO (sem texto extra, sem markdown, sem crases).

Formato obrigatório:
{
  "status": "ok" | "empty",
  "opportunities": [
    {
      "fixtureId": number,
      "league": string,
      "home": string,
      "away": string,
      "minute": number,
      "score": string,
      "tip": string,
      "confidence": number
    }
  ]
}

Regras:
- Só retorne "ok" se houver uma oportunidade clara.
- confidence de 0 a 100 (número).
- Se não houver oportunidade: {"status":"empty","opportunities":[]}

Dados (jogos candidatos):
${JSON.stringify(candidates)}
`;

    // 4) Gemini analisa e devolve JSON
    const modelText = await geminiGenerate(prompt);
    const extracted = extractFirstJson(modelText);
    if (!extracted) {
      return res.status(502).json({
        error: "gemini_output_not_json",
        sample: modelText.slice(0, 300),
      });
    }

    let final;
    try {
      final = JSON.parse(extracted);
    } catch {
      return res.status(502).json({
        error: "gemini_output_parse_fail",
        sample: extracted.slice(0, 500),
      });
    }

    if (!final?.status || !Array.isArray(final?.opportunities)) {
      return res.status(502).json({ error: "gemini_bad_schema", final });
    }

    return res.json(final);
  } catch (e) {
    console.error("BACKEND_ERROR:", e);
    return res.status(500).json({
      error: "backend_error",
      detail: String(e?.message ?? e),
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Backend rodando na porta", PORT));
