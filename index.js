

import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

const FOOTBALL_BASE = "https://v3.football.api-sports.io";
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";

app.get("/", (_, res) => res.send("PredictIA backend rodando"));

function extractJson(text) {
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
    headers: { "x-apisports-key": process.env.FOOTBALL_API_KEY },
  });

  const raw = await r.text();
  let data;
  try { data = JSON.parse(raw); } catch { throw new Error(`API_FOOTBALL_BAD_JSON: ${raw.slice(0, 500)}`); }
  if (!r.ok) throw new Error(`API_FOOTBALL_HTTP_${r.status}: ${raw.slice(0, 700)}`);

  return data;
}

async function geminiListModels() {
  const r = await fetch(`${GEMINI_BASE}/models`, {
    headers: { "x-goog-api-key": process.env.GEMINI_API_KEY },
  });

  const raw = await r.text();
  let data;
  try { data = JSON.parse(raw); } catch { throw new Error(`GEMINI_MODELS_BAD_JSON: ${raw.slice(0, 700)}`); }
  if (!r.ok) throw new Error(`GEMINI_MODELS_HTTP_${r.status}: ${raw.slice(0, 900)}`);

  return data.models ?? [];
}

function supportsGenerateContent(modelObj) {
  const methods = modelObj?.supportedGenerationMethods ?? [];
  return Array.isArray(methods) && methods.includes("generateContent");
}

async function pickGeminiModelId() {
  // SE VOCE DEFINIR GEMINI_MODEL NO RENDER, VAI USAR ELE
  // EX: GEMINI_MODEL=gemini-pro
  if (process.env.GEMINI_MODEL) return process.env.GEMINI_MODEL;

  const models = await geminiListModels();

  // Mesma logica do seu Android: preferir "flash" se existir
  const flash = models.find(m => supportsGenerateContent(m) && (m?.name ?? "").toLowerCase().includes("flash"));
  if (flash?.name) return flash.name.replace("models/", "");

  // fallback: primeiro que suporta generateContent
  const any = models.find(m => supportsGenerateContent(m) && (m?.name ?? "").startsWith("models/"));
  if (any?.name) return any.name.replace("models/", "");

  throw new Error("GEMINI_NO_COMPATIBLE_MODEL");
}

async function geminiGenerate(prompt) {
  const modelId = await pickGeminiModelId();

  const r = await fetch(`${GEMINI_BASE}/models/${modelId}:generateContent`, {
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
  try { data = JSON.parse(raw); } catch { throw new Error(`GEMINI_HTTP_BAD_JSON: ${raw.slice(0, 900)}`); }
  if (!r.ok) throw new Error(`GEMINI_HTTP_${r.status}: ${raw.slice(0, 1200)}`);

  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  if (!text) throw new Error(`GEMINI_EMPTY_TEXT: ${raw.slice(0, 900)}`);

  return text;
}

app.post("/alerts/search", async (req, res) => {
  try {
    if (!process.env.FOOTBALL_API_KEY) return res.status(500).json({ error: "missing_env", missing: "FOOTBALL_API_KEY" });
    if (!process.env.GEMINI_API_KEY) return res.status(500).json({ error: "missing_env", missing: "GEMINI_API_KEY" });

    const { sport, leagueId, teamId, all } = req.body ?? {};
    if (sport !== "football") return res.json({ status: "empty", opportunities: [] });

    const fixtures = await footballGet("/fixtures", {
      live: "all",
      league: all ? undefined : leagueId,
      team: all ? undefined : teamId,
    });

    const list = fixtures?.response ?? [];

    const candidates = list
      .map((f) => ({
        fixtureId: f?.fixture?.id,
        league: f?.league?.name,
        home: f?.teams?.home?.name,
        away: f?.teams?.away?.name,
        minute: f?.fixture?.status?.elapsed ?? 0,
        score: `${f?.goals?.home ?? 0}-${f?.goals?.away ?? 0}`,
      }))
      .filter((x) => x.fixtureId && x.minute >= 50 && x.minute <= 88)
      .slice(0, 8);

    if (candidates.length === 0) return res.json({ status: "empty", opportunities: [] });

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

Se não houver oportunidade:
{"status":"empty","opportunities":[]}

Dados:
${JSON.stringify(candidates)}
`;

    const modelText = await geminiGenerate(prompt);

    const extracted = extractJson(modelText);
    if (!extracted) {
      return res.status(502).json({ error: "gemini_output_not_json", sample: modelText.slice(0, 400) });
    }

    let final;
    try { final = JSON.parse(extracted); }
    catch { return res.status(502).json({ error: "gemini_output_parse_fail", sample: extracted.slice(0, 600) }); }

    if (!final?.status || !Array.isArray(final?.opportunities)) {
      return res.status(502).json({ error: "gemini_bad_schema", final });
    }

    return res.json(final);

  } catch (e) {
    return res.status(500).json({
      error: "backend_error",
      detail: String(e?.message ?? e),
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Backend rodando na porta", PORT));
