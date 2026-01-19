// ======================================================
// PredictIA Engine – index.js (FOOTBALL + NBA LIVE ONLY + GEMINI + GREEN % FIX)
// - NBA: SOMENTE jogos AO VIVO (bloqueia jogos finalizados/passados)
// - IA: nunca retorna % duplicado (mantém só a primeira %)
// - IA: não roda em jogo finalizado (retorna mensagem padrão)
// - Mantém FUTEBOL como está
// ======================================================

import "dotenv/config";
import express from "express";
import cors from "cors";
import { GoogleGenerativeAI } from "@google/generative-ai";

// ---------- BOOT SAFETY ----------
process.on("uncaughtException", (err) => console.error("UNCAUGHT_EXCEPTION:", err));
process.on("unhandledRejection", (reason) => console.error("UNHANDLED_REJECTION:", reason));

// ---------- APP ----------
const app = express();
app.use(cors());
app.use(express.json());

// =====================
// ENV
// =====================
const API_KEY = process.env.API_SPORTS_KEY || process.env.FOOTBALL_API_KEY;
const GENAI_KEY = process.env.GEMINI_API_KEY;
const GENAI_MODEL_RAW = (process.env.GEMINI_MODEL || "gemini-2.5-flash").trim();

// Odds (opcional)
const ODDS_API_KEY = process.env.ODDS_API_KEY || "";
const ODDS_BASE = "https://api.the-odds-api.com/v4";

if (!API_KEY) console.error("FALTA API_SPORTS_KEY ou FOOTBALL_API_KEY");
if (!GENAI_KEY) console.error("FALTA GEMINI_API_KEY");

const FOOTBALL_BASE = "https://v3.football.api-sports.io";
const NBA_BASE = "https://v2.nba.api-sports.io";

// =====================
// GEMINI (AUTO-LISTMODELS)
// =====================
const genAI = GENAI_KEY ? new GoogleGenerativeAI(GENAI_KEY) : null;

let _cachedResolvedModel = null;
let _cachedAt = 0;

function normalizeModelName(x) {
  return String(x || "").replace(/^models\//, "").trim();
}

async function listGeminiModels() {
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(
    GENAI_KEY
  )}`;

  const r = await fetch(url);
  const j = await r.json();

  if (!r.ok) {
    const e = new Error(j?.error?.message || `HTTP ${r.status}`);
    e.status = r.status;
    e.raw = j;
    throw e;
  }
  return Array.isArray(j?.models) ? j.models : [];
}

function pickSupportedGenerateContent(models) {
  return models.filter((m) =>
    (m?.supportedGenerationMethods || []).includes("generateContent")
  );
}

function resolveByHint(models, hintRaw) {
  const hint = normalizeModelName(hintRaw).toLowerCase();
  const supported = pickSupportedGenerateContent(models);
  const names = supported.map((m) => normalizeModelName(m?.name));

  const exact = names.find((n) => n.toLowerCase() === hint);
  if (exact) return exact;

  const prefix = names.find((n) => n.toLowerCase().startsWith(hint));
  if (prefix) return prefix;

  if (hint.includes("2.5") && hint.includes("flash")) {
    const flash25 = names.find(
      (n) => n.toLowerCase().includes("2.5") && n.toLowerCase().includes("flash")
    );
    if (flash25) return flash25;
  }

  return names[0] || null;
}

async function getResolvedModelName() {
  if (!genAI) return null;

  const now = Date.now();
  if (_cachedResolvedModel && now - _cachedAt < 10 * 60 * 1000) return _cachedResolvedModel;

  const models = await listGeminiModels();
  const resolved = resolveByHint(models, GENAI_MODEL_RAW);

  _cachedResolvedModel = resolved;
  _cachedAt = now;

  return _cachedResolvedModel;
}

async function generateGemini(prompt) {
  const resolved = await getResolvedModelName();
  if (!resolved) throw new Error("Nenhum modelo Gemini disponível para generateContent.");

  const model = genAI.getGenerativeModel({ model: resolved });

  const result = await model.generateContent({
    contents: [{ role: "user", parts: [{ text: prompt }] }],
  });

  return result?.response?.text?.() || "";
}

// mantém APENAS a primeira porcentagem e remove duplicadas;
// se não tiver %, adiciona um fallback (uma só vez).
function ensureSingleGreenPercent(text) {
  const t = String(text || "").trim();
  const matches = [...t.matchAll(/(\d{2,3})%/g)];

  if (matches.length === 0) {
    return `${t}\nProbabilidade de GREEN: 65%\nRisco: médio\nJustificativa: Estimativa padrão.`;
  }

  const first = matches[0][1]; // só o número
  // remove QUALQUER linha "Probabilidade de GREEN: xx%" existente
  // e remove qualquer "%"" restante
  let cleaned = t
    .replace(/(?i)probabilidade\s+de\s+green\s*:\s*\d{2,3}%/g, "")
    .replace(/(\d{2,3})%/g, "")
    .replace(/\n{2,}/g, "\n")
    .trim();

  // garante formato final com UMA única % no padrão
  // mantém até 3 linhas acima; se vier mais, o app ainda aceita, mas aqui reduzimos
  const lines = cleaned.split("\n").map((x) => x.trim()).filter(Boolean).slice(0, 3);
  cleaned = lines.join("\n");

  return `${cleaned}\nProbabilidade de GREEN: ${first}%`;
}

async function getAIAnalysis(gameInfo, sportLabel = "Esporte") {
  if (!genAI) return "IA não configurada.";

  const prompt = `Aja como um analista esportivo profissional para o app PredictIA.
Esporte: ${sportLabel}
Responda em PT-BR.
Retorne APENAS texto simples (sem Markdown).
Máximo 4 linhas.
Formato EXATO:
Recomendação: <aposta>
Probabilidade de GREEN: <XX%>
Risco: baixo|médio|alto
Justificativa: <1 frase>
Dados: ${JSON.stringify(gameInfo)}`;

  try {
    const text = await generateGemini(prompt);
    return ensureSingleGreenPercent(text || "Erro na análise da IA.");
  } catch (err) {
    console.error("GEMINI_MODEL_RAW:", GENAI_MODEL_RAW);
    console.error("GEMINI_RESOLVED_MODEL:", _cachedResolvedModel);
    console.error("GEMINI ERROR (FULL):", err);
    console.error("GEMINI ERROR (STATUS):", err?.status);
    console.error("GEMINI ERROR (RAW):", err?.raw);
    return "Erro na análise da IA.";
  }
}

// =====================
// UTILS
// =====================
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pick(obj, keys) {
  const out = {};
  keys.forEach((k) => {
    if (obj?.[k] !== undefined) out[k] = obj[k];
  });
  return out;
}

// NBA: considera "ao vivo" somente se clock existir OU short indicar em andamento.
// (mantém tolerante porque a API pode variar)
function isNbaLiveGame(game) {
  const short = Number(game?.status?.short);
  const clock = game?.status?.clock;

  // heurística segura:
  // - clock presente => ao vivo
  if (clock !== null && clock !== undefined && String(clock).trim() !== "") return true;

  // alguns retornos: short 1/2 = em andamento; 3 = finished
  // se for diferente de 3 e tiver periods.current > 0, trata como em andamento
  const periodsCurrent = Number(game?.periods?.current || 0);
  if (short && short !== 3 && periodsCurrent > 0) return true;

  // fallback: status.long contém "live"/"in play"
  const long = String(game?.status?.long || "").toLowerCase();
  if (long.includes("live") || long.includes("in play") || long.includes("in progress")) return true;

  return false;
}

function isNbaFinishedGame(game) {
  const short = Number(game?.status?.short);
  const long = String(game?.status?.long || "").toLowerCase();
  return short === 3 || long.includes("finished") || long.includes("final");
}

// =====================
// API-SPORTS CORE
// =====================
async function apiSports(base, path, params = {}) {
  const url = new URL(base + path);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  });

  try {
    const response = await fetch(url.toString(), {
      headers: { "x-apisports-key": API_KEY },
    });

    const json = await response.json();
    if (!response.ok) return { response: [], errors: { http: response.status }, raw: json };
    return json;
  } catch (e) {
    return { response: [], errors: { internal: e?.message || String(e) } };
  }
}

async function apiSportsRetryNonEmpty(base, path, params, tries = 3, delayMs = 1200) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    last = await apiSports(base, path, params);
    if (Array.isArray(last.response) && last.response.length > 0) {
      return { ...last, _retry: { tries: i + 1, ok: true } };
    }
    if (i < tries - 1) await sleep(delayMs);
  }
  return { ...(last || { response: [] }), _retry: { tries, ok: false } };
}

// =====================
// THE ODDS API (OPCIONAL) - NBA
// =====================
async function getNbaOddsFromOddsApi({
  regions = "us",
  markets = "h2h,spreads,totals",
  oddsFormat = "decimal",
} = {}) {
  if (!ODDS_API_KEY) return { ok: false, data: [], error: "ODDS_API_KEY não configurada." };

  const url = new URL(`${ODDS_BASE}/sports/basketball_nba/odds`);
  url.searchParams.set("apiKey", ODDS_API_KEY);
  url.searchParams.set("regions", regions);
  url.searchParams.set("markets", markets);
  url.searchParams.set("oddsFormat", oddsFormat);

  try {
    const r = await fetch(url.toString());
    const j = await r.json();
    if (!r.ok) return { ok: false, data: [], error: `HTTP ${r.status}`, raw: j };
    return { ok: true, data: j };
  } catch (e) {
    return { ok: false, data: [], error: e?.message || String(e) };
  }
}

function matchOddsByTeams(oddsEvents, homeName, awayName) {
  const h = String(homeName || "").toLowerCase();
  const a = String(awayName || "").toLowerCase();

  const ev = (oddsEvents || []).find((x) => {
    const oh = String(x?.home_team || "").toLowerCase();
    const oa = String(x?.away_team || "").toLowerCase();
    return (oh.includes(h) && oa.includes(a)) || (oh.includes(a) && oa.includes(h));
  });

  return ev || null;
}

// =====================
// ADAPTERS
// =====================
const ADAPTERS = {
  football: {
    getGames: ({ date, live, leagueId }) => ({
      path: "/fixtures",
      params: live
        ? leagueId
          ? { live: "all", league: leagueId }
          : { live: "all" }
        : leagueId
          ? { date, league: leagueId }
          : { date },
    }),

    extractLiveScore: (item) => ({
      fixtureId: item?.fixture?.id,
      league: item?.league ? { id: item.league.id, name: item.league.name } : null,
      teams: item?.teams,
      goals: item?.goals,
      score: item?.score,
      status: item?.fixture?.status,
      time: item?.fixture?.status?.elapsed,
    }),

    extractGoalsFromEvents: (events = []) => events.filter((e) => e?.type === "Goal"),
    extractCardsFromEvents: (events = []) => events.filter((e) => e?.type === "Card"),

    extractCornersFromStats: (stats = []) => {
      const perTeam = stats.map((row) => {
        const s = row.statistics || [];
        const c = s.find((x) => x.type === "Corner Kicks")?.value ?? 0;
        return { team: row.team, corners: c };
      });
      const total = perTeam.reduce((a, b) => a + Number(b.corners || 0), 0);
      return { total, perTeam };
    },
  },

  nba: {
    getGames: ({ id, live, date, season, league }) => ({
      path: "/games",
      params: id
        ? { id }
        : live
          ? { live: "all", season, league }
          : { date, season, league },
    }),

    getGameStats: ({ game }) => ({ path: "/games/statistics", params: { game } }),
    getPlayersStats: ({ game, season }) => ({
      path: "/players/statistics",
      params: { game, season },
    }),

    extractLiveGame: (item) => ({
      gameId: item?.id,
      league: item?.league
        ? { id: item.league.id, name: item.league.name, season: item.league.season }
        : null,
      teams: item?.teams,
      scores: item?.scores,
      status: item?.status,
      periods: item?.periods,
    }),
  },
};

// =====================
// ROUTES
// =====================
app.get("/", (_, res) => res.send("PredictIA Engine Online"));

// DEBUG: modelos Gemini
app.get("/gemini/models", async (_, res) => {
  try {
    if (!genAI) return res.status(500).json({ status: "error", error: "IA não configurada." });

    const models = await listGeminiModels();
    const supported = pickSupportedGenerateContent(models).map((m) => ({
      name: normalizeModelName(m?.name),
      supportedGenerationMethods: m?.supportedGenerationMethods,
    }));
    const resolved = await getResolvedModelName();

    res.json({ status: "ok", raw: GENAI_MODEL_RAW, resolved, supported });
  } catch (e) {
    res.status(500).json({ status: "error", error: e?.message || String(e), raw: e?.raw });
  }
});

// ---------------------
// FOOTBALL (mantido)
// ---------------------
app.get("/football/live", async (req, res) => {
  const leagueId = req.query.leagueId ? Number(req.query.leagueId) : undefined;

  const cfg = ADAPTERS.football.getGames({ live: true, leagueId });
  const data = await apiSports(FOOTBALL_BASE, cfg.path, cfg.params);

  res.json({
    status: "ok",
    data: (data.response || []).map(ADAPTERS.football.extractLiveScore),
    raw: data.errors ? { errors: data.errors } : undefined,
  });
});

app.get("/football/match/:fixtureId", async (req, res) => {
  const fixtureId = Number(req.params.fixtureId);
  const wantAnalysis = String(req.query.analysis || "").toLowerCase() === "true";

  const out = { fixtureId };

  const base = await apiSports(FOOTBALL_BASE, "/fixtures", { id: fixtureId });
  const item = base.response?.[0];
  if (!item) return res.status(404).json({ error: "Fixture não encontrado" });

  out.game = item;
  out.live_score = ADAPTERS.football.extractLiveScore(item);

  const statsTry = await apiSportsRetryNonEmpty(
    FOOTBALL_BASE,
    "/fixtures/statistics",
    { fixture: fixtureId }
  );
  out.live_stats = statsTry.response || [];
  out.corners = ADAPTERS.football.extractCornersFromStats(out.live_stats);

  const events = await apiSports(FOOTBALL_BASE, "/fixtures/events", { fixture: fixtureId });
  out.goals = ADAPTERS.football.extractGoalsFromEvents(events.response || []);
  out.cards = ADAPTERS.football.extractCardsFromEvents(events.response || []);

  const odds = await apiSports(FOOTBALL_BASE, "/odds/live", { fixture: fixtureId });
  out.live_odds = odds.response || [];

  if (wantAnalysis) {
    out.ai_prediction = await getAIAnalysis(
      pick(out, ["live_score", "live_stats", "goals", "cards", "corners", "live_odds"]),
      "Futebol"
    );
  }

  res.json({ status: "ok", data: out });
});

// ---------------------
// NBA (LIVE ONLY)
// ---------------------

// /nba/live?season=2024&league=12
app.get("/nba/live", async (req, res) => {
  const season = req.query.season ? Number(req.query.season) : undefined;
  const league = req.query.league ? Number(req.query.league) : 12;

  const cfg = ADAPTERS.nba.getGames({ live: true, season, league });
  const data = await apiSports(NBA_BASE, cfg.path, cfg.params);

  // GARANTE: só retorna os que estão ao vivo (heurística)
  const liveOnly = (data.response || []).filter((g) => isNbaLiveGame(g));

  res.json({
    status: "ok",
    data: liveOnly.map(ADAPTERS.nba.extractLiveGame),
    raw: data.errors ? { errors: data.errors } : undefined,
  });
});

// /nba/game/:gameId?analysis=true&season=2024&league=12
// BLOQUEIA jogos não-ao-vivo (passados/finalizados)
app.get("/nba/game/:gameId", async (req, res) => {
  const gameId = Number(req.params.gameId);
  const wantAnalysis = String(req.query.analysis || "").toLowerCase() === "true";
  const season = req.query.season ? Number(req.query.season) : undefined;
  const league = req.query.league ? Number(req.query.league) : 12;

  const out = { gameId };

  const baseCfg = ADAPTERS.nba.getGames({ id: gameId, season, league });
  const base = await apiSports(NBA_BASE, baseCfg.path, baseCfg.params);

  const game = base.response?.[0];
  if (!game) return res.status(404).json({ error: "Game não encontrado" });

  // SE NÃO ESTIVER AO VIVO, BLOQUEIA
  if (!isNbaLiveGame(game) || isNbaFinishedGame(game)) {
    return res.status(409).json({
      status: "not-live",
      error: "Somente jogos ao vivo são permitidos para NBA.",
      data: { gameId, status: game?.status, teams: game?.teams },
    });
  }

  out.game = game;
  out.live_game = ADAPTERS.nba.extractLiveGame(game);

  const statsCfg = ADAPTERS.nba.getGameStats({ game: gameId });
  const statsTry = await apiSportsRetryNonEmpty(NBA_BASE, statsCfg.path, statsCfg.params);
  out.team_stats = statsTry.response || [];

  const plyCfg = ADAPTERS.nba.getPlayersStats({ game: gameId, season });
  const plyTry = await apiSportsRetryNonEmpty(NBA_BASE, plyCfg.path, plyCfg.params, 2, 900);
  out.player_stats = plyTry.response || [];

  const homeName = game?.teams?.home?.name || "";
  const awayName = game?.teams?.visitors?.name || game?.teams?.away?.name || "";

  if (ODDS_API_KEY) {
    const oddsAll = await getNbaOddsFromOddsApi();
    out.odds_source = oddsAll.ok ? "the-odds-api" : "the-odds-api-error";
    out.odds_error = oddsAll.ok ? undefined : oddsAll.error;
    out.odds_raw = oddsAll.ok ? undefined : oddsAll.raw;

    if (oddsAll.ok) {
      out.odds_event = matchOddsByTeams(oddsAll.data, homeName, awayName);
    }
  } else {
    out.odds_source = "not-configured";
  }

  if (wantAnalysis) {
    out.ai_prediction = await getAIAnalysis(
      pick(out, ["live_game", "team_stats", "player_stats", "odds_event"]),
      "NBA (Basquete)"
    );
  }

  res.json({ status: "ok", data: out });
});

// =====================
// SERVER
// =====================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("Servidor rodando na porta", PORT));
