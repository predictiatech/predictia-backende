import "dotenv/config";
import express from "express";
import cors from "cors";
import { GoogleGenerativeAI } from "@google/generative-ai";

// ---------- BOOT SAFETY ----------
process.on("uncaughtException", (err) => console.error("UNCAUGHT_EXCEPTION:", err));
process.on("unhandledRejection", (reason) => console.error("UNHANDLED_REJECTION:", reason));

const app = express();
app.use(cors());
app.use(express.json());

// -----------------------------------------------------------
// ENV
// -----------------------------------------------------------
const API_KEY = process.env.API_SPORTS_KEY || process.env.FOOTBALL_API_KEY;
const GENAI_KEY = process.env.GEMINI_API_KEY;
const GENAI_MODEL_RAW = (process.env.GEMINI_MODEL || "gemini-2.5-flash").trim();

if (!API_KEY) console.error("FALTA API_SPORTS_KEY ou FOOTBALL_API_KEY");
if (!GENAI_KEY) console.error("FALTA GEMINI_API_KEY");

const FOOTBALL_BASE = "https://v3.football.api-sports.io";

const ODDS_TRIES = Number(process.env.ODDS_TRIES || 4);
const ODDS_DELAY_MS = Number(process.env.ODDS_DELAY_MS || 1200);

const STATS_TRIES = Number(process.env.STATS_TRIES || 4);
const STATS_DELAY_MS = Number(process.env.STATS_DELAY_MS || 1200);

const ODD_MIN = Number(process.env.ODD_MIN || 1.4);
const ODD_MAX = Number(process.env.ODD_MAX || 2.3);

// -----------------------------------------------------------
// HELPERS (BÁSICOS)
// -----------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function safeNumber(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function hasApiErrors(json) {
  const e = json?.errors;
  if (!e) return false;
  if (Array.isArray(e)) return e.length > 0;
  if (typeof e === "object") return Object.keys(e).length > 0;
  return Boolean(e);
}

// ✅ flags de disponibilidade (sem bloquear IA)
function getStatsXGFlags(snapshot) {
  const statsAvailable = Boolean(snapshot?.stats?.available) && Boolean(snapshot?.stats?.data);

  const xgHome = snapshot?.stats?.data?.xg?.home ?? null;
  const xgAway = snapshot?.stats?.data?.xg?.away ?? null;
  const xgAvailable = statsAvailable && (xgHome !== null || xgAway !== null);

  return { statsAvailable, xgAvailable };
}

// -----------------------------------------------------------
// ✅ CORNERS FALLBACK (events vs stats)
// Regra:
// - Se corners_events.total > 0 => usar events
// - Se corners_events.total == 0 e corners_stats.total > 0 => usar stats
// - Se ambos 0 => corners indisponível (IA não recomenda mercado de escanteios)
// -----------------------------------------------------------
function pickCornersForAI(snapshot) {
  const cornersEvents = snapshot?.corners || null; // {total,home,away}
  const cornersStats = snapshot?.stats?.data?.corners_stats || null; // {home,away} pode ter null

  const evHome = safeNumber(cornersEvents?.home, 0);
  const evAway = safeNumber(cornersEvents?.away, 0);
  const evTotal = safeNumber(cornersEvents?.total, evHome + evAway);

  const stHomeRaw = cornersStats?.home ?? null;
  const stAwayRaw = cornersStats?.away ?? null;

  const stHome = stHomeRaw === null ? null : safeNumber(stHomeRaw, 0);
  const stAway = stAwayRaw === null ? null : safeNumber(stAwayRaw, 0);

  const stHomeN = safeNumber(stHome, 0);
  const stAwayN = safeNumber(stAway, 0);
  const stTotal = stHomeN + stAwayN;

  const hasEvents = evTotal > 0;
  const hasStats = stTotal > 0;

  if (hasEvents) {
    return {
      available: true,
      source: "events",
      total: evTotal,
      home: evHome,
      away: evAway,
      raw: { corners_events: cornersEvents, corners_stats: cornersStats },
    };
  }

  if (!hasEvents && hasStats) {
    return {
      available: true,
      source: "stats",
      total: stTotal,
      home: stHomeN,
      away: stAwayN,
      raw: { corners_events: cornersEvents, corners_stats: cornersStats },
    };
  }

  return {
    available: false,
    source: "none",
    total: 0,
    home: 0,
    away: 0,
    raw: { corners_events: cornersEvents, corners_stats: cornersStats },
  };
}

// -----------------------------------------------------------
// API-SPORTS CLIENT (com detecção de errors mesmo em HTTP 200)
// -----------------------------------------------------------
async function apiSports(base, path, params = {}) {
  const url = new URL(base + path);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  });

  try {
    const r = await fetch(url.toString(), { headers: { "x-apisports-key": API_KEY } });
    const j = await r.json().catch(() => ({}));

    const httpErr = !r.ok;
    const apiErr = hasApiErrors(j);

    if (httpErr || apiErr) {
      return {
        response: Array.isArray(j?.response) ? j.response : [],
        errors: {
          http: httpErr ? r.status : undefined,
          api: apiErr ? j?.errors : undefined,
        },
        results: j?.results ?? null,
        paging: j?.paging ?? null,
        raw: j,
        _url: url.toString(),
      };
    }

    return { ...j, _url: url.toString() };
  } catch (e) {
    return { response: [], errors: { internal: e?.message || String(e) }, _url: url.toString() };
  }
}

async function apiSportsRetryWhere(base, path, params, predicateFn, tries = 3, delayMs = 1200) {
  let last = null;

  for (let i = 0; i < tries; i++) {
    last = await apiSports(base, path, params);

    const ok = (() => {
      try {
        return predicateFn(last);
      } catch {
        return false;
      }
    })();

    if (ok) return { ...last, _retry: { tries: i + 1, ok: true } };
    if (i < tries - 1) await sleep(delayMs);
  }

  return { ...(last || { response: [] }), _retry: { tries, ok: false } };
}

// -----------------------------------------------------------
// DATA NORMALIZATION (STATS / EVENTS / ODDS)
// -----------------------------------------------------------
function extractStatAny(statsTeamRow, aliases = []) {
  const s = statsTeamRow?.statistics || [];
  const norm = (x) => String(x || "").toLowerCase().trim();

  for (const a of aliases) {
    const it = s.find((x) => norm(x?.type) === norm(a));
    if (!it) continue;

    const v = it?.value;

    if (typeof v === "string") {
      const vv = v.replace(",", ".").replace(/[^\d.%-]/g, "");
      if (vv.endsWith("%")) return safeNumber(vv.replace("%", ""), 0);
      return safeNumber(vv, 0);
    }

    return safeNumber(v, 0);
  }

  return null; // ✅ null quando não tem dado
}

function extractStatValue(statsTeamRow, type) {
  const s = statsTeamRow?.statistics || [];
  const it = s.find((x) => x?.type === type);
  const v = it?.value;
  if (v === null || v === undefined) return null;
  if (typeof v === "string" && v.endsWith("%")) return safeNumber(v.replace("%", ""), 0);
  return safeNumber(v, 0);
}

function extractXG(statsTeamRow) {
  return extractStatAny(statsTeamRow, [
    "Expected Goals",
    "Expected goals",
    "Expected Goals (xG)",
    "Expected goals (xG)",
    "xG",
    "xGoals",
  ]);
}

// ✅ compacta stats (opcional)
function compactLiveStats(live_stats = []) {
  const home = live_stats?.[0] || null;
  const away = live_stats?.[1] || null;

  if (!home || !away) {
    return { available: false, data: null };
  }

  const xgHome = extractXG(home);
  const xgAway = extractXG(away);

  const mk = (a, b) => ({ home: a, away: b });

  return {
    available: true,
    data: {
      home: home?.team?.name || null,
      away: away?.team?.name || null,
      xg: mk(xgHome, xgAway),
      shots_on_goal: mk(
        extractStatValue(home, "Shots on Goal"),
        extractStatValue(away, "Shots on Goal")
      ),
      shots_off_goal: mk(
        extractStatValue(home, "Shots off Goal"),
        extractStatValue(away, "Shots off Goal")
      ),
      total_shots: mk(extractStatValue(home, "Total Shots"), extractStatValue(away, "Total Shots")),
      dangerous_attacks: mk(
        extractStatValue(home, "Dangerous Attacks"),
        extractStatValue(away, "Dangerous Attacks")
      ),
      attacks: mk(extractStatValue(home, "Attacks"), extractStatValue(away, "Attacks")),
      possession: mk(
        extractStatValue(home, "Ball Possession"),
        extractStatValue(away, "Ball Possession")
      ),
      corners_stats: mk(
        extractStatAny(home, ["Corner Kicks", "Corners", "Total Corners"]),
        extractStatAny(away, ["Corner Kicks", "Corners", "Total Corners"])
      ),
      fouls: mk(
        extractStatAny(home, ["Fouls", "Fouls Committed"]),
        extractStatAny(away, ["Fouls", "Fouls Committed"])
      ),
      yellow: mk(extractStatValue(home, "Yellow Cards"), extractStatValue(away, "Yellow Cards")),
      red: mk(extractStatValue(home, "Red Cards"), extractStatValue(away, "Red Cards")),
    },
  };
}

// ✅ compacta eventos: gols/cartões contagem
function compactEvents(events = []) {
  const ev = Array.isArray(events) ? events : [];
  const goals = ev.filter((e) => String(e?.type || "").toLowerCase() === "goal");
  const cards = ev.filter((e) => String(e?.type || "").toLowerCase() === "card");
  const yellow = cards.filter((e) => String(e?.detail || "").toLowerCase().includes("yellow")).length;
  const red = cards.filter((e) => String(e?.detail || "").toLowerCase().includes("red")).length;
  return { goals: goals.length, cards: cards.length, yellow, red };
}

// ✅ corners ESSENCIAL via events
function cornersFromEvents(events = [], homeName, awayName) {
  const ev = Array.isArray(events) ? events : [];
  const corners = ev.filter((e) => {
    const t = String(e?.type || "").toLowerCase();
    const d = String(e?.detail || "").toLowerCase();
    return t === "corner" || d.includes("corner");
  });

  const home = corners.filter((e) => String(e?.team?.name || "") === String(homeName || "")).length;
  const away = corners.filter((e) => String(e?.team?.name || "") === String(awayName || "")).length;
  return { total: home + away, home, away };
}

// ✅ odds/live predicate: precisa ter odds internas
function oddsLiveHasData(j) {
  if (!j) return false;
  if (j?.errors?.http || j?.errors?.api || j?.errors?.internal) return false;

  const roots = Array.isArray(j?.response) ? j.response : [];
  if (roots.length === 0) return false;

  const anyOddsArr = roots.some((r) => Array.isArray(r?.odds) && r.odds.length > 0);
  if (anyOddsArr) return true;

  const anyBookmakers =
    roots.some((r) => Array.isArray(r?.bookmakers) && r.bookmakers.length > 0) &&
    roots.some((r) =>
      (r?.bookmakers || []).some((bm) => Array.isArray(bm?.bets) && bm.bets.length > 0)
    );

  return anyBookmakers;
}

// ✅ statistics predicate: precisa ter 2 times
function statsHasTwoTeams(j) {
  if (!j) return false;
  if (j?.errors?.http || j?.errors?.api || j?.errors?.internal) return false;
  return Array.isArray(j?.response) && j.response.length >= 2;
}

// ✅ compacta odds ao vivo para catálogo (ODD_ID interno sequencial)
function compactLiveOdds(live_odds = [], teamsNames = {}, oddMin = 1.4, oddMax = 2.3) {
  const homeTeam = teamsNames?.home || null;
  const awayTeam = teamsNames?.away || null;

  const arr = Array.isArray(live_odds) ? live_odds : [];
  const out = [];
  let idSeq = 1;

  const pushRow = (bmName, marketName, selectionRaw, handicap, period, odd) => {
    const selection = String(selectionRaw || "").toLowerCase();

    let side = "game";
    let team = null;

    if (selection.includes("home") || String(selectionRaw) === "1") {
      side = "home";
      team = homeTeam;
    } else if (selection.includes("away") || String(selectionRaw) === "2") {
      side = "away";
      team = awayTeam;
    } else if (homeTeam && selection.includes(homeTeam.toLowerCase())) {
      side = "home";
      team = homeTeam;
    } else if (awayTeam && selection.includes(awayTeam.toLowerCase())) {
      side = "away";
      team = awayTeam;
    }

    out.push({
      id: idSeq++,
      bookmaker: bmName || null,
      market: marketName || null,
      selection: selectionRaw || null,
      handicap: handicap ?? null,
      side,
      team,
      period,
      odd: Number(Number(odd).toFixed(2)),
    });
  };

  // Formato B: response[].odds -> {name, values}
  for (const root of arr) {
    const oddsArr = Array.isArray(root?.odds) ? root.odds : [];
    if (oddsArr.length === 0) continue;

    const bmName = "live";

    for (const bet of oddsArr) {
      const market = String(bet?.name || "");
      const marketName = String(bet?.name || "").toLowerCase();

      let period = "FT";
      if (marketName.includes("1st") || marketName.includes("1st half")) period = "1H";
      if (marketName.includes("2nd") || marketName.includes("2nd half")) period = "2H";

      const values = Array.isArray(bet?.values) ? bet.values : [];
      for (const v of values) {
        const odd = safeNumber(v?.odd, 0);
        if (odd < oddMin || odd > oddMax) continue;

        pushRow(bmName, market, String(v?.value || ""), v?.handicap, period, odd);
        if (out.length >= 160) return out;
      }
    }
  }

  // Formato A: response[].bookmakers[].bets[].values[]
  for (const root of arr) {
    const bookmakers = Array.isArray(root?.bookmakers) ? root.bookmakers : [];
    if (bookmakers.length === 0) continue;

    for (const bm of bookmakers) {
      const bets = Array.isArray(bm?.bets) ? bm.bets : [];
      for (const bet of bets) {
        const market = String(bet?.name || "");
        const marketName = String(bet?.name || "").toLowerCase();

        let period = "FT";
        if (marketName.includes("1st") || marketName.includes("1st half")) period = "1H";
        if (marketName.includes("2nd") || marketName.includes("2nd half")) period = "2H";

        const values = Array.isArray(bet?.values) ? bet.values : [];
        for (const v of values) {
          const odd = safeNumber(v?.odd, 0);
          if (odd < oddMin || odd > oddMax) continue;

          pushRow(bm?.name, market, String(v?.value || ""), v?.handicap, period, odd);
          if (out.length >= 160) return out;
        }
      }
    }
  }

  return out;
}

// -----------------------------------------------------------
// ----------- DATA ENGINE (SNAPSHOT) ------------------------
// -----------------------------------------------------------
async function buildFootballSnapshot(fixtureId, opts = {}) {
  const oddMin = Number(opts.oddMin ?? ODD_MIN);
  const oddMax = Number(opts.oddMax ?? ODD_MAX);

  const triesOdds = Number(opts.triesOdds ?? ODDS_TRIES);
  const delayOdds = Number(opts.delayOdds ?? ODDS_DELAY_MS);

  const triesStats = Number(opts.triesStats ?? STATS_TRIES);
  const delayStats = Number(opts.delayStats ?? STATS_DELAY_MS);

  const snapshot = {
    meta: {
      fixtureId: Number(fixtureId),
      snapshot_ts: new Date().toISOString(),
      sources: { fixtures: null, odds_live: null, events: null, statistics: null },
      availability: { fixtures: false, odds_live: false, events: false, statistics: false },
      retry: { odds_live: null, statistics: null },
      errors: {},
    },
    match: null,
    events: null,
    corners: null,
    stats: null,
    odds: null,
    rawCounts: null,
  };

  // 1) fixtures (essencial)
  const fx = await apiSports(FOOTBALL_BASE, "/fixtures", { id: fixtureId });
  snapshot.meta.sources.fixtures = fx?._url || null;

  const item = fx?.response?.[0];
  if (!item) {
    snapshot.meta.errors.fixtures = fx?.errors || { notFound: true };
    snapshot.rawCounts = { events: 0, oddsRoots: 0, statsTeams: 0 };
    return snapshot;
  }

  snapshot.meta.availability.fixtures = true;

  const status = item?.fixture?.status || {};
  snapshot.match = {
    fixtureId: item?.fixture?.id || Number(fixtureId),
    league: item?.league
      ? { id: item.league.id, name: item.league.name, season: item.league.season }
      : null,
    teams: {
      home: item?.teams?.home?.name || null,
      away: item?.teams?.away?.name || null,
    },
    time: {
      elapsed: safeNumber(status?.elapsed, 0),
      short: status?.short || null,
      long: status?.long || null,
    },
    score: {
      home: safeNumber(item?.goals?.home, 0),
      away: safeNumber(item?.goals?.away, 0),
    },
  };

  const homeName = snapshot.match.teams.home;
  const awayName = snapshot.match.teams.away;

  // 2) events (essencial)
  const ev = await apiSports(FOOTBALL_BASE, "/fixtures/events", { fixture: fixtureId });
  snapshot.meta.sources.events = ev?._url || null;
  snapshot.meta.availability.events = true;

  const eventsList = Array.isArray(ev?.response) ? ev.response : [];
  snapshot.events = compactEvents(eventsList);
  snapshot.corners = cornersFromEvents(eventsList, homeName, awayName);

  // 3) odds/live (essencial)
  const oddsLiveTry = await apiSportsRetryWhere(
    FOOTBALL_BASE,
    "/odds/live",
    { fixture: fixtureId },
    oddsLiveHasData,
    triesOdds,
    delayOdds
  );

  snapshot.meta.sources.odds_live = oddsLiveTry?._url || null;
  snapshot.meta.retry.odds_live = oddsLiveTry?._retry || null;

  const oddsRoots = Array.isArray(oddsLiveTry?.response) ? oddsLiveTry.response : [];
  snapshot.meta.availability.odds_live = oddsRoots.length > 0;

  if (!snapshot.meta.availability.odds_live) {
    snapshot.meta.errors.odds_live = oddsLiveTry?.errors || { empty: true };
  }

  snapshot.odds = compactLiveOdds(oddsRoots, { home: homeName, away: awayName }, oddMin, oddMax);

  // 4) statistics + xG (opcional)
  const statsTry = await apiSportsRetryWhere(
    FOOTBALL_BASE,
    "/fixtures/statistics",
    { fixture: fixtureId },
    statsHasTwoTeams,
    triesStats,
    delayStats
  );

  snapshot.meta.sources.statistics = statsTry?._url || null;
  snapshot.meta.retry.statistics = statsTry?._retry || null;

  const statsRows = Array.isArray(statsTry?.response) ? statsTry.response : [];
  snapshot.meta.availability.statistics = statsRows.length >= 2;

  if (!snapshot.meta.availability.statistics) {
    snapshot.meta.errors.statistics = statsTry?.errors || { empty: true };
    snapshot.stats = { available: false, data: null };
  } else {
    snapshot.stats = compactLiveStats(statsRows);
  }

  snapshot.rawCounts = {
    events: eventsList.length,
    oddsRoots: oddsRoots.length,
    statsTeams: statsRows.length,
  };

  snapshot.meta.oddMin = oddMin;
  snapshot.meta.oddMax = oddMax;

  return snapshot;
}

// -----------------------------------------------------------
// ----------- AI ENGINE (GEMINI) ----------------------------
// -----------------------------------------------------------
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
  return models.filter((m) => (m?.supportedGenerationMethods || []).includes("generateContent"));
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

// ---------- IA normalization ----------
function ensureAIFormat(text) {
  const t = String(text || "").trim();
  if (!t) return "Erro na análise da IA.";

  const cleaned = t.replace(/\n{3,}/g, "\n\n").trim();
  const lines = cleaned
    .split("\n")
    .map((x) => x.trim())
    .filter((x) => x.length > 0)
    .slice(0, 6);

  return lines.join("\n");
}

// ---------- ODD_ID validation ----------
function parseOddIdFromAI(text) {
  const m = String(text || "").match(/ODD_ID\s*=\s*(\d+)/i);
  return m ? Number(m[1]) : null;
}

function validateAIWithOddsDetailed(aiText, oddsCatalog, oddMin = ODD_MIN, oddMax = ODD_MAX) {
  const t = String(aiText || "").trim();
  const catalog = Array.isArray(oddsCatalog) ? oddsCatalog : [];

  if (!t) return { ok: false, reason: "AI_EMPTY" };
  if (catalog.length === 0) return { ok: false, reason: "CATALOG_EMPTY" };

  const oddId = parseOddIdFromAI(t);
  if (!oddId) return { ok: false, reason: "NO_ODD_ID" };

  const row = catalog.find((x) => Number(x?.id) === Number(oddId));
  if (!row) return { ok: false, reason: "ODD_ID_NOT_FOUND" };

  const odd = safeNumber(row?.odd, 0);
  if (odd < oddMin || odd > oddMax) return { ok: false, reason: "ODD_OUT_OF_RANGE" };

  return { ok: true, reason: "OK", row };
}

function patchOddLineWithRealOdd(aiText, realOdd) {
  const oddReal = Number(safeNumber(realOdd, 0)).toFixed(2);
  const text = String(aiText || "");

  if (/\bOdd\s*:\s*/i.test(text)) {
    return text.replace(/\bOdd\s*:\s*[0-9]+(?:[.,][0-9]+)?\b/i, `Odd: ${oddReal}`);
  }
  return `${text}\nOdd: ${oddReal}`;
}

function buildOddsHintList(oddsCatalog, max = 25) {
  const odds = Array.isArray(oddsCatalog) ? oddsCatalog : [];
  return odds.slice(0, max).map((o) => ({
    id: o.id,
    market: o.market,
    selection: o.selection,
    handicap: o.handicap ?? null,
    period: o.period,
    side: o.side,
    team: o.team ?? null,
    odd: o.odd,
  }));
}

// ---------- IA queue/rate limit ----------
const AI_CACHE_TTL_MS = Number(process.env.AI_CACHE_TTL_MS || 60_000);
const _aiCache = new Map();

function aiCacheGet(key) {
  const row = _aiCache.get(key);
  if (!row) return null;
  if (Date.now() > row.exp) {
    _aiCache.delete(key);
    return null;
  }
  return row.value;
}

function aiCacheSet(key, value) {
  _aiCache.set(key, { value, exp: Date.now() + AI_CACHE_TTL_MS });
}

const AI_MAX_CONCURRENCY = Number(process.env.AI_MAX_CONCURRENCY || 1);
const AI_MIN_INTERVAL_MS = Number(process.env.AI_MIN_INTERVAL_MS || 1200);
const AI_QUEUE_MAX = Number(process.env.AI_QUEUE_MAX || 300);

let _aiActive = 0;
let _aiLastStartAt = 0;
const _aiQueue = [];
const _aiInFlight = new Map();

function _aiRunNext() {
  if (_aiActive >= AI_MAX_CONCURRENCY) return;
  if (_aiQueue.length === 0) return;

  const now = Date.now();
  const wait = Math.max(0, (_aiLastStartAt + AI_MIN_INTERVAL_MS) - now);

  const job = _aiQueue.shift();
  _aiActive++;

  setTimeout(async () => {
    _aiLastStartAt = Date.now();
    try {
      const result = await job.fn();
      job.resolve(result);
    } catch (e) {
      job.reject(e);
    } finally {
      _aiActive--;
      _aiRunNext();
    }
  }, wait);
}

function enqueueAI(cacheKey, fn) {
  if (cacheKey && _aiInFlight.has(cacheKey)) return _aiInFlight.get(cacheKey);

  if (_aiQueue.length >= AI_QUEUE_MAX) {
    return Promise.resolve("IA em fila cheia. Tente novamente.");
  }

  const p = new Promise((resolve, reject) => {
    _aiQueue.push({ fn, resolve, reject });
    _aiRunNext();
  });

  if (cacheKey) {
    _aiInFlight.set(cacheKey, p);
    p.finally(() => _aiInFlight.delete(cacheKey));
  }

  return p;
}

// ---------- AI decision ----------
async function getAIAnalysisFromSnapshot(snapshot, cacheKey = "") {
  if (!genAI) return "IA não configurada.";

  if (cacheKey) {
    const cached = aiCacheGet(cacheKey);
    if (cached) return cached;
  }

  const oddMin = Number(snapshot?.meta?.oddMin ?? ODD_MIN);
  const oddMax = Number(snapshot?.meta?.oddMax ?? ODD_MAX);

  const oddsCatalog = Array.isArray(snapshot?.odds) ? snapshot.odds : [];
  const match = snapshot?.match || {};
  const events = snapshot?.events || {};

  const { statsAvailable, xgAvailable } = getStatsXGFlags(snapshot);
  const stats = statsAvailable ? snapshot?.stats?.data : null;

  // ✅ aplica regra corners (events vs stats)
  const cornersPick = pickCornersForAI(snapshot);

  const aiData = {
    match,
    live: {
      odds: oddsCatalog,
      events,
      // mantém ambos pra debug (opcional)
      corners_events: snapshot?.corners || null,
      corners_stats: statsAvailable ? snapshot?.stats?.data?.corners_stats || null : null,

      // ✅ campo PRINCIPAL para IA (já com fallback aplicado)
      corners: cornersPick.available
        ? { source: cornersPick.source, total: cornersPick.total, home: cornersPick.home, away: cornersPick.away }
        : null,
      corners_available: Boolean(cornersPick.available),

      statistics: stats,
      statistics_available: statsAvailable,
      xg_available: xgAvailable,
    },
    meta: {
      snapshot_ts: snapshot?.meta?.snapshot_ts,
      sources: snapshot?.meta?.sources,
      availability: snapshot?.meta?.availability,
    },
  };

  const prompt = `Você é um analista profissional de apostas esportivas (futebol) para o app PredictIA.
Contexto: jogo AO VIVO, com dados em tempo real. Cada requisição é independente.

OBJETIVO:
Selecionar UM ÚNICO palpite com o melhor Valor Esperado (EV) PARA O MOMENTO ATUAL DO JOGO.

REGRAS OBRIGATÓRIAS:
1) Responda em PT-BR, APENAS texto simples (sem Markdown).
2) Máximo 6 linhas.
3) Escolha somente 1 mercado (sempre especificar período quando aplicável):
   - GOLS: Over/Under (FT quando não especificar)
   - VITÓRIA: 1X2 ou Dupla Chance (1X, X2, 12)
   - ESCANTEIOS: Over/Under (Período: 1ºT | 2ºT | FT) -> use SOMENTE live.corners (já tem fallback events/stats)
   - CARTÕES: Over/Under (Período: 1ºT | 2ºT | FT)
   - HANDICAP: Asiático ou 3-Way Handicap (informar linha/handicap)
4) A ODD do palpite DEVE estar entre ${oddMin.toFixed(2)} e ${oddMax.toFixed(2)} (inclusive).
   - A ODD DEVE ser REAL e EXISTIR em live.odds (catálogo).
   - NUNCA use odd estimada. Se não existir odd real no range, responda exatamente: Sem oportunidades no range ${oddMin.toFixed(
     2
   )}–${oddMax.toFixed(2)}.
5) Probabilidade de GREEN (P) deve estar entre 65% e 100% (inclusive).
6) EV = (P_decimal * odd) - 1, mostrar EV com 2 casas e sinal.
7) CONSISTÊNCIA:
   - Sempre informar ALVO: JOGO | CASA | FORA
8) SELEÇÃO:
   - Você DEVE escolher 1 item do catálogo live.odds e usar o ID dele.

REGRAS DE USO DE DADOS (MUITO IMPORTANTE):
- ESCANTEIOS:
  - Se live.corners_available=false => é PROIBIDO recomendar mercado de ESCANTEIOS (pule para GOLS/CARTÕES/HANDICAP/VITÓRIA).
  - Se live.corners_available=true => use live.corners como verdade (fonte já escolhida automaticamente).
- Se statistics_available=false E xg_available=false:
  -> NÃO analise posse/chutes/xG/faltas/cartões por statistics.
  -> Baseie a decisão somente em match + odds + events + live.corners (se disponível).
- Se statistics_available=true:
  -> Você pode usar os campos presentes em statistics, MAS qualquer campo null deve ser ignorado.
- Se xg_available=false:
  -> NÃO cite xG nem expected goals.

FORMATO EXATO:
Recomendação: <mercado + linha + período> (ALVO: JOGO|CASA|FORA) [ODD_ID=<N>]
Odd: <X.XX>
Probabilidade de GREEN: <XX%>
EV: <+0.00>
Risco: baixo|médio|alto
Justificativa: <1 frase objetiva baseada nos dados ao vivo e odds>

DADOS AO VIVO (use somente isto):
${JSON.stringify(aiData)}`;

  const run = async () => {
    try {
      const raw1 = await generateGemini(prompt);
      const v1 = validateAIWithOddsDetailed(raw1, oddsCatalog, oddMin, oddMax);

      if (!v1.ok) {
        const hintList = buildOddsHintList(oddsCatalog, 25);

        const retryPrompt = `Escolha OBRIGATORIAMENTE 1 ODD_ID da lista abaixo (não invente IDs).
Retorne no FORMATO EXATO e inclua [ODD_ID=<N>] NA PRIMEIRA LINHA.

LISTA_DE_ODDS_VALIDAS:
${JSON.stringify(hintList)}

DADOS AO VIVO:
${JSON.stringify(aiData)}`;

        const raw2 = await generateGemini(retryPrompt);
        const v2 = validateAIWithOddsDetailed(raw2, oddsCatalog, oddMin, oddMax);

        if (!v2.ok) {
          const msg = `Sem oportunidades no range ${oddMin.toFixed(2)}–${oddMax.toFixed(2)}.`;
          if (cacheKey) aiCacheSet(cacheKey, msg);
          return msg;
        }

        const formatted2 = ensureAIFormat(raw2);
        const patched2 = patchOddLineWithRealOdd(formatted2, v2.row.odd);
        if (cacheKey) aiCacheSet(cacheKey, patched2);
        return patched2;
      }

      const formatted1 = ensureAIFormat(raw1);
      const patched1 = patchOddLineWithRealOdd(formatted1, v1.row.odd);
      if (cacheKey) aiCacheSet(cacheKey, patched1);
      return patched1;
    } catch (err) {
      console.error("GEMINI_MODEL_RAW:", GENAI_MODEL_RAW);
      console.error("GEMINI_RESOLVED_MODEL:", _cachedResolvedModel);
      console.error("GEMINI ERROR:", err);

      const fallback = "Erro na análise da IA.";
      if (cacheKey) aiCacheSet(cacheKey, fallback);
      return fallback;
    }
  };

  return enqueueAI(cacheKey || "", run);
}

// -----------------------------------------------------------
// ----------- ROUTES ----------------------------------------
// -----------------------------------------------------------
app.get("/", (_, res) => res.send("PredictIA Engine Online"));

// ✅ Lista jogos AO VIVO (por liga opcional)
app.get("/football/live", async (req, res) => {
  const leagueId = req.query.leagueId ? Number(req.query.leagueId) : undefined;

  const data = await apiSports(
    FOOTBALL_BASE,
    "/fixtures",
    leagueId ? { live: "all", league: leagueId } : { live: "all" }
  );

  res.json({
    status: "ok",
    data: (data.response || []).map((item) => ({
      fixtureId: item?.fixture?.id,
      league: item?.league ? { id: item.league.id, name: item.league.name } : null,
      teams: item?.teams,
      goals: item?.goals,
      status: item?.fixture?.status,
      time: item?.fixture?.status?.elapsed,
    })),
    raw: data.errors ? { errors: data.errors } : undefined,
  });
});

// ✅ Snapshot: SÓ DADOS
app.get("/football/snapshot/:fixtureId", async (req, res) => {
  const fixtureId = Number(req.params.fixtureId);
  const wantDebug = String(req.query.debug || "").toLowerCase() === "true";

  const oddMin = req.query.oddMin ? Number(req.query.oddMin) : ODD_MIN;
  const oddMax = req.query.oddMax ? Number(req.query.oddMax) : ODD_MAX;

  const snap = await buildFootballSnapshot(fixtureId, { oddMin, oddMax });

  const flags = getStatsXGFlags(snap);
  const cornersPick = pickCornersForAI(snap);

  if (!wantDebug) {
    return res.json({
      status: "ok",
      data: {
        match: snap.match,
        events: snap.events,
        corners: cornersPick.available
          ? { source: cornersPick.source, total: cornersPick.total, home: cornersPick.home, away: cornersPick.away }
          : null,
        cornersAvailable: Boolean(cornersPick.available),
        oddsCount: Array.isArray(snap.odds) ? snap.odds.length : 0,
        statsAvailable: flags.statsAvailable,
        xgAvailable: flags.xgAvailable,
        stats: flags.statsAvailable ? snap.stats.data : null,
        rawCounts: snap.rawCounts,
      },
    });
  }

  return res.json({
    status: "ok",
    data: {
      ...snap,
      flags,
      corners_pick: cornersPick,
    },
  });
});

// ✅ Snapshot + IA (sem bloquear)
app.get("/football/match/:fixtureId", async (req, res) => {
  const fixtureId = Number(req.params.fixtureId);
  const wantAnalysis = String(req.query.analysis || "").toLowerCase() === "true";
  const wantDebug = String(req.query.debug || "").toLowerCase() === "true";

  const oddMin = req.query.oddMin ? Number(req.query.oddMin) : ODD_MIN;
  const oddMax = req.query.oddMax ? Number(req.query.oddMax) : ODD_MAX;

  const snap = await buildFootballSnapshot(fixtureId, { oddMin, oddMax });

  const flags = getStatsXGFlags(snap);
  const cornersPick = pickCornersForAI(snap);

  const out = {
    fixtureId,
    snapshot: wantDebug ? snap : undefined,
    data: {
      match: snap.match,
      events: snap.events,
      corners: cornersPick.available
        ? { source: cornersPick.source, total: cornersPick.total, home: cornersPick.home, away: cornersPick.away }
        : null,
      cornersAvailable: Boolean(cornersPick.available),
      statsAvailable: flags.statsAvailable,
      xgAvailable: flags.xgAvailable,
      stats: flags.statsAvailable ? snap.stats.data : null,
      oddsCount: Array.isArray(snap.odds) ? snap.odds.length : 0,
      rawCounts: snap.rawCounts,
    },
  };

  if (!wantAnalysis) {
    return res.json({ status: "ok", data: out });
  }

  const prediction = await getAIAnalysisFromSnapshot(snap, `football:${fixtureId}`);
  out.ai_prediction = prediction;

  if (wantDebug) {
    const oddId = parseOddIdFromAI(prediction);
    const v = validateAIWithOddsDetailed(prediction, snap.odds, oddMin, oddMax);
    out.ai_debug = {
      validationReason: v?.reason || "UNKNOWN",
      extractedOddId: oddId,
      oddsCatalogSize: Array.isArray(snap.odds) ? snap.odds.length : 0,
      statsTeams: snap?.rawCounts?.statsTeams ?? 0,
      corners_pick: cornersPick,
      stats_available: flags.statsAvailable,
      xg_available: flags.xgAvailable,
    };
  }

  return res.json({ status: "ok", data: out });
});

// -----------------------------------------------------------
// SERVER
// -----------------------------------------------------------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("Servidor rodando na porta", PORT));
