// COLE ESSE index.js COMPLETO (DEBUG + ERRO REAL NA RESPOSTA)
// ✅ Vai parar de responder só {"error":"Erro interno do servidor"}
// ✅ Vai mostrar o motivo real (API-FOOTBALL / GEMINI / TIMEOUT / QUOTA / KEY) via:
//    - /football/match/:id  (retorna error_detail quando DEBUG=1)
//    - /debug/last-error    (último erro capturado)
//    - logs no Render com stack

import "dotenv/config";
import express from "express";
import cors from "cors";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { LRUCache } from "lru-cache";

const app = express();
app.use(cors());
app.use(express.json());

// ---------------- ENV ----------------
const API_KEY = process.env.API_SPORTS_KEY || process.env.FOOTBALL_API_KEY; // fallback
const GENAI_KEY = process.env.GEMINI_API_KEY;
const GENAI_MODEL_RAW = (process.env.GEMINI_MODEL || "gemini-2.5-flash").trim();

const FOOTBALL_BASE = "https://v3.football.api-sports.io";
const ODD_MIN = Number(process.env.ODD_MIN || 1.4);
const ODD_MAX = Number(process.env.ODD_MAX || 2.3);

const SNAPSHOT_TTL_MS = Number(process.env.SNAPSHOT_TTL_MS || 1000 * 60); // ✅ 60s
const AI_TTL_MS = Number(process.env.AI_TTL_MS || 1000 * 120);
const LIVE_TTL_MS = Number(process.env.LIVE_TTL_MS || 1000 * 10);

const ODDS_LIMIT = Number(process.env.ODDS_LIMIT || 60);
const TOP_EVS_LIMIT = Number(process.env.TOP_EVS_LIMIT || 12);

const DEBUG = String(process.env.DEBUG || "0") === "1";

if (!API_KEY) console.error("FALTA API_SPORTS_KEY ou FOOTBALL_API_KEY");
if (!GENAI_KEY) console.error("FALTA GEMINI_API_KEY");

// ---------------- LAST ERROR STORE (DEBUG) ----------------
let LAST_ERROR = null;
function setLastError(where, err, extra = {}) {
  LAST_ERROR = {
    at: new Date().toISOString(),
    where,
    message: String(err?.message || err),
    stack: String(err?.stack || ""),
    extra,
  };
}

// ---------------- CACHES ----------------
const snapshotCache = new LRUCache({ max: 900, ttl: SNAPSHOT_TTL_MS });
const aiCache = new LRUCache({ max: 1600, ttl: AI_TTL_MS });

const liveCache = new LRUCache({ max: 120, ttl: LIVE_TTL_MS });
const liveInFlight = new Map();

const snapshotInFlight = new Map();
const aiInFlight = new Map();

// ---------------- HELPERS ----------------
const safeNumber = (v, d = 0) => {
  const n = Number(String(v ?? "").replace(",", "."));
  return Number.isFinite(n) ? n : d;
};

const isValidFixtureId = (n) => Number.isFinite(n) && Number.isInteger(n) && n > 0;
const lower = (s) => String(s ?? "").trim().toLowerCase();
const clamp = (n, a, b) => Math.min(b, Math.max(a, n));

const bucketMinute = (elapsed) => Math.floor(Number(elapsed || 0) / 1);
const aiKey = (fixtureId, elapsed) => `${fixtureId}:${bucketMinute(elapsed)}`;

// ---------------- ADAPTERS (COMPAT APP) ----------------
const ADAPTERS = {
  football: {
    extractLiveScore: (item) => ({
      fixtureId: item?.fixture?.id,
      league: item?.league ? { id: item.league.id, name: item.league.name } : null,
      teams: item?.teams,
      goals: item?.goals,
      score: item?.score,
      status: item?.fixture?.status,
      time: item?.fixture?.status?.elapsed,
    }),
  },
};

// ---------------- RESPONSE ERROR (COM DEBUG) ----------------
function respond500(res, where, err, extra = {}) {
  setLastError(where, err, extra);
  console.error(`[${where}]`, err?.message || err);
  if (err?.stack) console.error(err.stack);

  const payload = { error: "Erro interno do servidor" };
  if (DEBUG) {
    payload.error_detail = String(err?.message || err);
    payload.where = where;
    payload.extra = extra;
  }
  return res.status(500).json(payload);
}

// ---------------- API CLIENT ----------------
async function apiSports(path, params = {}) {
  if (!API_KEY) throw new Error("MISSING_API_SPORTS_KEY");

  const url = new URL(FOOTBALL_BASE + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }

  const r = await fetch(url, { headers: { "x-apisports-key": API_KEY } });
  const text = await r.text();

  if (!r.ok) {
    const e = new Error(`API_SPORTS_HTTP_${r.status}`);
    e._http = { status: r.status, body: text.slice(0, 500) };
    throw e;
  }

  try {
    return JSON.parse(text);
  } catch {
    const e = new Error("API_SPORTS_BAD_JSON");
    e._http = { status: r.status, body: text.slice(0, 500) };
    throw e;
  }
}

// ---------------- LIVE ----------------
async function fetchLiveFixtures() {
  const cacheKey = "live_all";
  if (liveCache.has(cacheKey)) return liveCache.get(cacheKey);
  if (liveInFlight.has(cacheKey)) return liveInFlight.get(cacheKey);

  const p = apiSports("/fixtures", { live: "all" })
    .then((data) => {
      const list = data?.response || [];
      liveCache.set(cacheKey, list);
      liveInFlight.delete(cacheKey);
      return list;
    })
    .catch((e) => {
      liveInFlight.delete(cacheKey);
      throw e;
    });

  liveInFlight.set(cacheKey, p);
  return p;
}

// ---------------- STATS NORMALIZATION ----------------
function statsToMap(teamStats) {
  const out = Object.create(null);
  const arr = Array.isArray(teamStats?.statistics) ? teamStats.statistics : [];
  for (const s of arr) out[lower(s?.type)] = s?.value;
  return out;
}
function percentToNumber(v) {
  const s = String(v ?? "").trim();
  if (!s) return null;
  const n = Number(s.replace("%", "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}
function maybeNumber(v) {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const n = Number(String(v).trim().replace(",", "."));
  return Number.isFinite(n) ? n : null;
}
function getStat(map, keys) {
  for (const k of keys) {
    const v = map[lower(k)];
    if (v !== undefined) return v;
  }
  return undefined;
}
function normalizeStats(statsResponse) {
  const resp = Array.isArray(statsResponse) ? statsResponse : [];
  if (resp.length < 2) return null;

  const homeObj = resp[0];
  const awayObj = resp[1];
  const homeMap = statsToMap(homeObj);
  const awayMap = statsToMap(awayObj);

  const norm = {
    home: { team: homeObj?.team ?? null, raw: homeObj ?? null, map: homeMap },
    away: { team: awayObj?.team ?? null, raw: awayObj ?? null, map: awayMap },
    parsed: {
      shotsOnGoal: {
        home: maybeNumber(getStat(homeMap, ["shots on goal", "shots on target"])),
        away: maybeNumber(getStat(awayMap, ["shots on goal", "shots on target"])),
      },
      totalShots: {
        home: maybeNumber(getStat(homeMap, ["total shots"])),
        away: maybeNumber(getStat(awayMap, ["total shots"])),
      },
      corners: {
        home: maybeNumber(getStat(homeMap, ["corner kicks", "corners"])),
        away: maybeNumber(getStat(awayMap, ["corner kicks", "corners"])),
      },
      possession: {
        home: percentToNumber(getStat(homeMap, ["ball possession", "possession"])),
        away: percentToNumber(getStat(awayMap, ["ball possession", "possession"])),
      },
      totalPasses: {
        home: maybeNumber(getStat(homeMap, ["total passes"])),
        away: maybeNumber(getStat(awayMap, ["total passes"])),
      },
      passesAccurate: {
        home: maybeNumber(getStat(homeMap, ["passes accurate"])),
        away: maybeNumber(getStat(awayMap, ["passes accurate"])),
      },
      fouls: {
        home: maybeNumber(getStat(homeMap, ["fouls"])),
        away: maybeNumber(getStat(awayMap, ["fouls"])),
      },
      yellow: {
        home: maybeNumber(getStat(homeMap, ["yellow cards"])),
        away: maybeNumber(getStat(awayMap, ["yellow cards"])),
      },
      red: {
        home: maybeNumber(getStat(homeMap, ["red cards"])),
        away: maybeNumber(getStat(awayMap, ["red cards"])),
      },
      attacksDangerous: {
        home: maybeNumber(getStat(homeMap, ["dangerous attacks"])),
        away: maybeNumber(getStat(awayMap, ["dangerous attacks"])),
      },
      attacks: {
        home: maybeNumber(getStat(homeMap, ["attacks"])),
        away: maybeNumber(getStat(awayMap, ["attacks"])),
      },
      expectedGoals: { home: null, away: null, total: null },
    },
  };

  const xgHome = maybeNumber(getStat(homeMap, ["expected goals", "xg"]));
  const xgAway = maybeNumber(getStat(awayMap, ["expected goals", "xg"]));
  norm.parsed.expectedGoals.home = xgHome;
  norm.parsed.expectedGoals.away = xgAway;
  if (Number.isFinite(xgHome) && Number.isFinite(xgAway)) {
    norm.parsed.expectedGoals.total = +(xgHome + xgAway).toFixed(2);
  }

  return norm;
}

// ---------------- EVENTS COUNTS ----------------
const countGoals = (events) => (events || []).filter((e) => e?.type === "Goal").length;
const countReds = (events) => (events || []).filter((e) => lower(e?.detail).includes("red")).length;
const countYellows = (events) => (events || []).filter((e) => lower(e?.detail).includes("yellow")).length;

// ---------------- ODDS PARSER ----------------
function extractOddsInRange(oddsResponse, oddMin, oddMax) {
  const out = [];
  for (const root of oddsResponse?.response || []) {
    for (const bm of root?.bookmakers || []) {
      for (const bet of bm?.bets || []) {
        const market = String(bet?.name || "");
        for (const v of bet?.values || []) {
          const odd = safeNumber(v?.odd, NaN);
          if (!Number.isFinite(odd)) continue;
          if (odd < oddMin || odd > oddMax) continue;

          out.push({
            id: out.length + 1,
            bookmaker: String(bm?.name || ""),
            market,
            selection: String(v?.value || ""),
            odd,
          });

          if (out.length >= ODDS_LIMIT) return out;
        }
      }
    }
  }
  return out;
}

// ---------------- EV (mantém seu motor; placeholder mínimo aqui pra não truncar) ----------------
// ⚠️ Se você já tem o bloco EV completo, mantenha ele. Aqui só garante que não dá crash.
function computeTopEVs(snap) {
  const out = [];
  const elapsed = safeNumber(snap?.match?.time?.elapsed, 0);
  for (const oddItem of snap?.odds || []) {
    const odd = safeNumber(oddItem?.odd, NaN);
    if (!Number.isFinite(odd)) continue;
    // se não tiver stats, não calcula
    out.push({
      odd_id: oddItem?.id,
      market: oddItem?.market,
      selection: oddItem?.selection,
      odd: +odd.toFixed(2),
      p: null,
      ev: null,
      minute: elapsed,
      model: "DEBUG_NO_PROB_MODEL",
    });
  }
  return { top: [], available: false, debug_all: out };
}

// ---------------- SNAPSHOT ENGINE ----------------
async function buildSnapshot(fixtureId) {
  console.log("[SNAPSHOT] building", fixtureId);

  const fx = await apiSports("/fixtures", { id: fixtureId });
  const item = fx?.response?.[0];
  if (!item) return null;

  const elapsed = safeNumber(item?.fixture?.status?.elapsed, 0);

  const snapshot = {
    match: {
      fixtureId,
      teams: {
        home: item?.teams?.home?.name ?? "Home",
        away: item?.teams?.away?.name ?? "Away",
      },
      time: { elapsed },
      score: {
        home: safeNumber(item?.goals?.home),
        away: safeNumber(item?.goals?.away),
      },
      status: item?.fixture?.status ?? null,
      league: item?.league ?? null,
    },
    events: { goals: 0, yellowcards: 0, redcards: 0, raw: [] },
    odds: [],
    stats: { available: false, data: null, norm: null },
    ev: { top_evs: [], top_evs_available: false, debug_all: [] },
  };

  // EVENTS
  const ev = await apiSports("/fixtures/events", { fixture: fixtureId });
  const events = ev?.response || [];
  snapshot.events.raw = events;
  snapshot.events.goals = countGoals(events);
  snapshot.events.yellowcards = countYellows(events);
  snapshot.events.redcards = countReds(events);

  // ODDS
  const odds = await apiSports("/odds/live", { fixture: fixtureId });
  snapshot.odds = extractOddsInRange(odds, ODD_MIN, ODD_MAX);

  // STATS (só se tiver odds válidas)
  if (snapshot.odds.length > 0) {
    const stats = await apiSports("/fixtures/statistics", { fixture: fixtureId });
    const resp = stats?.response || [];
    if (resp.length >= 2) {
      snapshot.stats.available = true;
      snapshot.stats.data = resp;
      snapshot.stats.norm = normalizeStats(resp);
    }
  }

  // EV (se tiver stats)
  if (snapshot.odds.length > 0 && snapshot.stats.available && snapshot.stats.norm) {
    const { top, available, debug_all } = computeTopEVs(snapshot);
    snapshot.ev.top_evs = top;
    snapshot.ev.top_evs_available = available;
    snapshot.ev.debug_all = debug_all;
  }

  return snapshot;
}

// ---------------- SNAPSHOT WRAPPER ----------------
async function getSnapshot(fixtureId) {
  if (snapshotCache.has(fixtureId)) return snapshotCache.get(fixtureId);
  if (snapshotInFlight.has(fixtureId)) return snapshotInFlight.get(fixtureId);

  const p = buildSnapshot(fixtureId)
    .then((snap) => {
      if (snap) snapshotCache.set(fixtureId, snap);
      snapshotInFlight.delete(fixtureId);
      return snap;
    })
    .catch((e) => {
      snapshotInFlight.delete(fixtureId);
      throw e;
    });

  snapshotInFlight.set(fixtureId, p);
  return p;
}

// ---------------- IA ENGINE ----------------
const genAI = new GoogleGenerativeAI(GENAI_KEY || "");

async function getAI(snapshot, fixtureId) {
  if (!GENAI_KEY) throw new Error("MISSING_GEMINI_API_KEY");

  const elapsed = snapshot?.match?.time?.elapsed ?? 0;
  const key = aiKey(fixtureId, elapsed);

  if (aiCache.has(key)) return { text: aiCache.get(key), status: "cached", key };
  if (aiInFlight.has(key)) return { text: null, status: "processing", key };

  const p = (async () => {
    const aiInput = {
      match: snapshot.match,
      live: {
        odds: snapshot.odds,
        events: {
          goals: snapshot.events.goals,
          yellowcards: snapshot.events.yellowcards,
          redcards: snapshot.events.redcards,
        },
        statistics_raw: snapshot.stats.data,
        statistics_norm: snapshot.stats.norm,
        top_evs: snapshot.ev.top_evs,
        top_evs_available: snapshot.ev.top_evs_available,
      },
    };

    const prompt = `PT-BR. TEXTO SIMPLES. MAX 6 LINHAS.
Se não houver oportunidade, responda "SEM OPORTUNIDADE — <motivo curto>".

FORMATO:
Recomendação: <mercado + linha> [ODD_ID=<N>]
Odd: <X.XX>
Probabilidade de Green: <XX%>
EV: <+0.00>
Risco: baixo|médio|alto
Justificativa: <1 frase>

JSON:
${JSON.stringify(aiInput)}`;

    const model = genAI.getGenerativeModel({ model: GENAI_MODEL_RAW });
    const res = await model.generateContent(prompt);
    const text = res.response.text();

    aiCache.set(key, text);
    aiInFlight.delete(key);
    return text;
  })().catch((e) => {
    aiInFlight.delete(key);
    throw e;
  });

  aiInFlight.set(key, p);
  const text = await p;
  return { text, status: "ok", key };
}

// ---------------- ROUTES ----------------
app.get("/debug/last-error", (req, res) => {
  res.json({ status: "ok", debug: DEBUG, last_error: LAST_ERROR });
});

app.get("/football/live", async (req, res) => {
  try {
    const liveList = await fetchLiveFixtures();
    const data = (liveList || [])
      .map(ADAPTERS.football.extractLiveScore)
      .filter((g) => isValidFixtureId(Number(g?.fixtureId)));
    res.json({ status: "ok", data });
  } catch (e) {
    return respond500(res, "LIVE", e);
  }
});

app.get("/football/match/:fixtureId", async (req, res) => {
  const fixtureId = Number(req.params.fixtureId);
  if (!isValidFixtureId(fixtureId)) return res.status(400).json({ error: "fixtureId inválido" });

  try {
    const snap = await getSnapshot(fixtureId);
    if (!snap) return res.status(404).json({ error: "Jogo não encontrado" });

    const aiRes = await getAI(snap, fixtureId);

    res.json({
      status: "ok",
      snapshot: snap,
      ai: aiRes?.text ?? null,
      ai_status: aiRes?.status ?? "unknown",
      ai_key: aiRes?.key ?? null,
    });
  } catch (e) {
    // ✅ aqui vai aparecer o motivo real quando DEBUG=1
    return respond500(res, "MATCH", e, { fixtureId });
  }
});

// ---------------- SERVER ----------------
const PORT = Number(process.env.PORT || 10000);
app.listen(PORT, () => {
  console.log("PredictIA Engine rodando na porta", PORT);
  console.log("DEBUG=", DEBUG, "| SNAPSHOT_TTL_MS=", SNAPSHOT_TTL_MS, "| LIVE_TTL_MS=", LIVE_TTL_MS);
});
