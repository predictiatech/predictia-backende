// FILE: index.js (COMPLETO) — COMPAT APP (ADAPTERS) + ECONÔMICO + EV PRÉ-CALCULADO + TODAS STATS NO aiInput

import "dotenv/config";
import express from "express";
import cors from "cors";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { LRUCache } from "lru-cache";

const app = express();
app.use(cors());
app.use(express.json());

// ---------------- ENV ----------------
const API_KEY = process.env.API_SPORTS_KEY || process.env.FOOTBALL_API_KEY; // ✅ fallback mantido
const GENAI_KEY = process.env.GEMINI_API_KEY;
const GENAI_MODEL_RAW = (process.env.GEMINI_MODEL || "gemini-2.5-flash").trim();

const FOOTBALL_BASE = "https://v3.football.api-sports.io";
const ODD_MIN = Number(process.env.ODD_MIN || 1.4);
const ODD_MAX = Number(process.env.ODD_MAX || 2.3);

if (!API_KEY) console.error("FALTA API_SPORTS_KEY ou FOOTBALL_API_KEY");
if (!GENAI_KEY) console.error("FALTA GEMINI_API_KEY");

// ---------------- CACHES ----------------
const snapshotCache = new LRUCache({ max: 700, ttl: 1000 * 45 }); // 45s
const aiCache = new LRUCache({ max: 700, ttl: 1000 * 45 });       // 45s

// Cache live list (curto p/ não spammar live=all)
const liveCache = new LRUCache({ max: 80, ttl: 1000 * 10 }); // 10s
const liveInFlight = new Map();

// Anti race condition (dedup por fixtureId)
const snapshotInFlight = new Map();
const aiInFlight = new Map();

// ---------------- HELPERS ----------------
const safeNumber = (v, d = 0) => {
  const n = Number(String(v ?? "").replace(",", "."));
  return Number.isFinite(n) ? n : d;
};

const isValidFixtureId = (n) =>
  Number.isFinite(n) && Number.isInteger(n) && n > 0;

const lower = (s) => String(s ?? "").trim().toLowerCase();

const clamp = (n, a, b) => Math.min(b, Math.max(a, n));

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

// ---------------- API CLIENT ----------------
async function apiSports(path, params = {}) {
  try {
    if (!API_KEY) throw new Error("MISSING_API_SPORTS_KEY");

    const url = new URL(FOOTBALL_BASE + path);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }

    const r = await fetch(url, { headers: { "x-apisports-key": API_KEY } });
    if (!r.ok) throw new Error(`API_SPORTS_HTTP_${r.status}`);
    return await r.json();
  } catch (e) {
    console.error("[API-SPORTS ERROR]", path, e.message);
    throw e;
  }
}

// ---------------- LIVE (JOGOS AO VIVO) ----------------
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
// API-Football /fixtures/statistics geralmente:
// response: [ { team:{...}, statistics:[{type,value},...] }, { team:{...}, statistics:[...]} ]
function statsToMap(teamStats) {
  const out = Object.create(null);
  const arr = Array.isArray(teamStats?.statistics) ? teamStats.statistics : [];
  for (const s of arr) {
    const key = lower(s?.type);
    out[key] = s?.value;
  }
  return out;
}

function percentToNumber(v) {
  // "54%" -> 54
  const s = String(v ?? "").trim();
  if (!s) return null;
  const n = Number(s.replace("%", "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function maybeNumber(v) {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const s = String(v).trim().replace(",", ".");
  const n = Number(s);
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
    home: {
      team: homeObj?.team ?? null,
      raw: homeObj ?? null,
      map: homeMap,
    },
    away: {
      team: awayObj?.team ?? null,
      raw: awayObj ?? null,
      map: awayMap,
    },
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
      expectedGoals: {
        home: null,
        away: null,
        total: null,
      },
    },
  };

  // xG (Expected Goals)
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
function countGoals(events) {
  return (events || []).filter((e) => e?.type === "Goal").length;
}
function countReds(events) {
  // Detail pode variar, então pega "Red Card", "Second Yellow Card", etc.
  return (events || []).filter((e) => lower(e?.detail).includes("red")).length;
}
function countYellows(events) {
  return (events || []).filter((e) => lower(e?.detail).includes("yellow")).length;
}

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
            // ODD_ID do seu catálogo (por snapshot)
            id: out.length + 1,
            bookmaker: String(bm?.name || ""),
            market,
            selection: String(v?.value || ""),
            odd,
          });
        }
      }
    }
  }
  return out;
}

// ---------------- PROBABILITY + EV ENGINE ----------------
function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}

function computeP_from_xgWinner(xgHome, xgAway, scoreH, scoreA, elapsed, side) {
  // side: "home"|"away"|"draw"
  const t = clamp(safeNumber(elapsed, 0), 0, 90);
  const lead = (scoreH - scoreA);
  const xgd = (safeNumber(xgHome, 0) - safeNumber(xgAway, 0));

  // urgência/tempo: quanto mais tarde, mais o placar pesa
  const timeWeight = clamp(t / 90, 0.05, 1.0);
  const xgWeight = 1.0 - 0.35 * timeWeight;

  // vantagem home/away
  const strength = (xgd * xgWeight) + (lead * (0.9 * timeWeight));

  // draw: prob maior quando jogo equilibrado e placar empatado
  if (side === "draw") {
    const balance = Math.abs(xgd) + Math.abs(lead);
    const base = 0.26 + 0.10 * (1 - timeWeight); // mais cedo -> mais empate
    const p = clamp(base * Math.exp(-0.85 * balance), 0.05, 0.55);
    return p;
  }

  const dir = side === "home" ? 1 : -1;
  const p = sigmoid(dir * strength * 1.4);
  // limites conservadores
  return clamp(p, 0.05, 0.92);
}

function computeP_over_under_goals(xgTotal, goalsTotal, elapsed, line, over) {
  const t = clamp(safeNumber(elapsed, 0), 1, 90);
  const g = safeNumber(goalsTotal, 0);
  const xg = safeNumber(xgTotal, 0);

  // expectativa final aproximada: combina xG + ritmo real (g/t)
  const paceG = (g / t) * 90;
  const expFinal = 0.65 * xg + 0.35 * paceG;

  // delta para a linha
  const delta = (expFinal - line);

  // ajuste por tempo: quanto mais tarde, menos variância
  const late = clamp(t / 90, 0, 1);
  const k = 1.15 + 0.9 * late;

  const pOver = sigmoid(delta * k);
  const p = over ? pOver : (1 - pOver);

  return clamp(p, 0.05, 0.95);
}

function computeP_over_under_corners(cornersTotal, elapsed, line, over) {
  const t = clamp(safeNumber(elapsed, 0), 1, 90);
  const c = safeNumber(cornersTotal, 0);

  // projeção simples por ritmo
  const pace = (c / t) * 90;
  const delta = (pace - line);

  const late = clamp(t / 90, 0, 1);
  const k = 1.1 + 0.8 * late;

  const pOver = sigmoid(delta * k);
  const p = over ? pOver : (1 - pOver);

  return clamp(p, 0.05, 0.95);
}

function computeP_over_under_cards(cardsTotal, elapsed, line, over) {
  const t = clamp(safeNumber(elapsed, 0), 1, 90);
  const c = safeNumber(cardsTotal, 0);

  const pace = (c / t) * 90;
  const delta = (pace - line);

  const late = clamp(t / 90, 0, 1);
  const k = 1.05 + 0.7 * late;

  const pOver = sigmoid(delta * k);
  const p = over ? pOver : (1 - pOver);

  return clamp(p, 0.05, 0.95);
}

function computeP_btts(xgHome, xgAway, shotsOnGoalHome, shotsOnGoalAway, elapsed, goalsH, goalsA) {
  const t = clamp(safeNumber(elapsed, 0), 1, 90);

  // já saiu gol pros 2 => BTTS quase certo
  if (safeNumber(goalsH, 0) > 0 && safeNumber(goalsA, 0) > 0) return 0.96;

  const xgH = safeNumber(xgHome, 0);
  const xgA = safeNumber(xgAway, 0);
  const sotH = safeNumber(shotsOnGoalHome, 0);
  const sotA = safeNumber(shotsOnGoalAway, 0);

  // proxy de chance de marcar:
  const rateH = 0.65 * xgH + 0.35 * ((sotH / t) * 90) * 0.12;
  const rateA = 0.65 * xgA + 0.35 * ((sotA / t) * 90) * 0.12;

  // converte pra prob de pelo menos 1 gol (Poisson-like aproximado)
  const pH = clamp(1 - Math.exp(-rateH), 0.05, 0.98);
  const pA = clamp(1 - Math.exp(-rateA), 0.05, 0.98);

  const pBTTS = clamp(pH * pA, 0.05, 0.95);

  // mais tarde e ainda 0 do time -> reduz
  const late = clamp(t / 90, 0, 1);
  if (late > 0.7) return clamp(pBTTS - 0.10, 0.05, 0.90);

  return pBTTS;
}

function parseLineFromSelection(sel) {
  // tenta extrair linha "2.5", "9.5", etc
  const m = String(sel ?? "").match(/([0-9]+(?:\.[0-9]+)?)/);
  return m ? safeNumber(m[1], NaN) : NaN;
}

function estimateProbabilityForOdd(oddItem, snap) {
  const market = lower(oddItem?.market);
  const selRaw = String(oddItem?.selection ?? "");
  const sel = lower(selRaw);

  const elapsed = safeNumber(snap?.match?.time?.elapsed, 0);
  const goalsH = safeNumber(snap?.match?.score?.home, 0);
  const goalsA = safeNumber(snap?.match?.score?.away, 0);
  const goalsTotal = goalsH + goalsA;

  const stats = snap?.stats?.norm?.parsed;
  const xgHome = stats?.expectedGoals?.home;
  const xgAway = stats?.expectedGoals?.away;
  const xgTotal = stats?.expectedGoals?.total;

  const cornersH = safeNumber(stats?.corners?.home, 0);
  const cornersA = safeNumber(stats?.corners?.away, 0);
  const cornersTotal = cornersH + cornersA;

  const yH = safeNumber(stats?.yellow?.home, 0);
  const yA = safeNumber(stats?.yellow?.away, 0);
  const rH = safeNumber(stats?.red?.home, 0);
  const rA = safeNumber(stats?.red?.away, 0);
  const cardsTotal = yH + yA + rH + rA;

  const sotH = safeNumber(stats?.shotsOnGoal?.home, 0);
  const sotA = safeNumber(stats?.shotsOnGoal?.away, 0);

  // anti-under cedo (igual sua regra)
  const isUnderMarket = market.includes("under") || sel.includes("under") || sel.includes("menos");
  if (elapsed < 25 && isUnderMarket) {
    // bloqueia UNDER cedo (IA pode receber como "blocked")
    return { p: null, reason: "UNDER_TOO_EARLY" };
  }

  // 1X2 / Match Winner
  if (market.includes("match winner") || market.includes("match odds") || market === "1x2") {
    if (sel.includes("home") || sel.includes("casa") || sel === "1") {
      return { p: computeP_from_xgWinner(xgHome, xgAway, goalsH, goalsA, elapsed, "home"), reason: "MODEL_1X2" };
    }
    if (sel.includes("away") || sel.includes("fora") || sel === "2") {
      return { p: computeP_from_xgWinner(xgHome, xgAway, goalsH, goalsA, elapsed, "away"), reason: "MODEL_1X2" };
    }
    if (sel.includes("draw") || sel.includes("empate") || sel === "x") {
      return { p: computeP_from_xgWinner(xgHome, xgAway, goalsH, goalsA, elapsed, "draw"), reason: "MODEL_1X2" };
    }
  }

  // BTTS
  if (market.includes("both teams to score") || market.includes("btts") || market.includes("both teams score")) {
    if (sel.includes("yes") || sel.includes("sim")) {
      return { p: computeP_btts(xgHome, xgAway, sotH, sotA, elapsed, goalsH, goalsA), reason: "MODEL_BTTS" };
    }
    if (sel.includes("no") || sel.includes("não") || sel.includes("nao")) {
      const pYes = computeP_btts(xgHome, xgAway, sotH, sotA, elapsed, goalsH, goalsA);
      return { p: clamp(1 - pYes, 0.05, 0.95), reason: "MODEL_BTTS" };
    }
  }

  // Over/Under Goals
  if (market.includes("over/under") && (market.includes("goals") || market.includes("goal"))) {
    const line = parseLineFromSelection(selRaw);
    if (!Number.isFinite(line)) return { p: null, reason: "NO_LINE" };
    if (sel.includes("over") || sel.includes("mais")) {
      return { p: computeP_over_under_goals(xgTotal, goalsTotal, elapsed, line, true), reason: "MODEL_OU_GOALS" };
    }
    if (sel.includes("under") || sel.includes("menos")) {
      return { p: computeP_over_under_goals(xgTotal, goalsTotal, elapsed, line, false), reason: "MODEL_OU_GOALS" };
    }
  }

  // Over/Under Corners
  if (market.includes("corners") || market.includes("corner")) {
    const line = parseLineFromSelection(selRaw);
    if (!Number.isFinite(line)) return { p: null, reason: "NO_LINE" };
    if (sel.includes("over") || sel.includes("mais")) {
      return { p: computeP_over_under_corners(cornersTotal, elapsed, line, true), reason: "MODEL_OU_CORNERS" };
    }
    if (sel.includes("under") || sel.includes("menos")) {
      return { p: computeP_over_under_corners(cornersTotal, elapsed, line, false), reason: "MODEL_OU_CORNERS" };
    }
  }

  // Cards (Over/Under)
  if (market.includes("cards") || market.includes("card") || market.includes("yellow")) {
    const line = parseLineFromSelection(selRaw);
    if (!Number.isFinite(line)) return { p: null, reason: "NO_LINE" };
    if (sel.includes("over") || sel.includes("mais")) {
      return { p: computeP_over_under_cards(cardsTotal, elapsed, line, true), reason: "MODEL_OU_CARDS" };
    }
    if (sel.includes("under") || sel.includes("menos")) {
      return { p: computeP_over_under_cards(cardsTotal, elapsed, line, false), reason: "MODEL_OU_CARDS" };
    }
  }

  // fallback (não reconhecido)
  return { p: null, reason: "UNSUPPORTED_MARKET" };
}

function computeTopEVs(snap) {
  const out = [];
  const elapsed = safeNumber(snap?.match?.time?.elapsed, 0);

  // se muito cedo, ainda computa EV mas IA vai barrar pelo hard rule
  for (const oddItem of snap?.odds || []) {
    const odd = safeNumber(oddItem?.odd, NaN);
    if (!Number.isFinite(odd)) continue;

    const { p, reason } = estimateProbabilityForOdd(oddItem, snap);
    if (!Number.isFinite(p)) {
      out.push({
        odd_id: oddItem?.id,
        market: oddItem?.market,
        selection: oddItem?.selection,
        odd: oddItem?.odd,
        p: null,
        ev: null,
        blocked_reason: reason || "NO_P",
      });
      continue;
    }

    // EV = P*odd - 1
    const ev = +(p * odd - 1).toFixed(4);

    out.push({
      odd_id: oddItem?.id,
      market: oddItem?.market,
      selection: oddItem?.selection,
      odd: +odd.toFixed(2),
      p: +p.toFixed(4),
      ev,
      minute: elapsed,
      model: reason || "MODEL",
    });
  }

  // filtra só os com EV válido e > 0 (edge)
  const valid = out
    .filter((x) => Number.isFinite(x?.ev) && x.ev > 0)
    .sort((a, b) => (b.ev - a.ev));

  // mantém top 12 (economia no prompt)
  const top = valid.slice(0, 12);

  return { top, available: top.length > 0, debug_all: out };
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
    events: {
      goals: 0,
      yellowcards: 0,
      redcards: 0,
      raw: [],
    },
    odds: [],
    stats: {
      available: false,
      data: null,     // bruto da API
      norm: null,     // normalizado e parseado
    },
    ev: {
      top_evs: [],
      top_evs_available: false,
      debug_all: [],
    },
  };

  // EVENTS
  const ev = await apiSports("/fixtures/events", { fixture: fixtureId });
  const events = ev?.response || [];
  snapshot.events.raw = events;

  snapshot.events.goals = countGoals(events);
  snapshot.events.yellowcards = countYellows(events);
  snapshot.events.redcards = countReds(events);

  // ODDS (somente odds no range)
  const odds = await apiSports("/odds/live", { fixture: fixtureId });
  snapshot.odds = extractOddsInRange(odds, ODD_MIN, ODD_MAX);

  // STATS (só se tiver odds válidas no range -> economia)
  if (snapshot.odds.length > 0) {
    const stats = await apiSports("/fixtures/statistics", { fixture: fixtureId });
    const resp = stats?.response || [];

    if (resp.length >= 2) {
      snapshot.stats.available = true;
      snapshot.stats.data = resp;
      snapshot.stats.norm = normalizeStats(resp);
    }
  }

  // EV (só calcula se tiver stats + odds)
  if (snapshot.odds.length > 0 && snapshot.stats.available && snapshot.stats.norm) {
    const { top, available, debug_all } = computeTopEVs(snapshot);
    snapshot.ev.top_evs = top;
    snapshot.ev.top_evs_available = available;
    snapshot.ev.debug_all = debug_all;
  }

  return snapshot;
}

// ---------------- SNAPSHOT WRAPPER (LRU + DEDUP) ----------------
async function getSnapshot(fixtureId) {
  if (snapshotCache.has(fixtureId)) return snapshotCache.get(fixtureId);
  if (snapshotInFlight.has(fixtureId)) return snapshotInFlight.get(fixtureId);

  const p = buildSnapshot(fixtureId)
    .then((snap) => {
      if (snap) snapshotCache.set(fixtureId, snap); // evita cachear null
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
const genAI = new GoogleGenerativeAI(GENAI_KEY || ""); // erro tratado em getAI

async function getAI(snapshot, fixtureId) {
  if (!GENAI_KEY) throw new Error("MISSING_GEMINI_API_KEY");

  if (aiCache.has(fixtureId)) return aiCache.get(fixtureId);
  if (aiInFlight.has(fixtureId)) return aiInFlight.get(fixtureId);

  const p = (async () => {
    try {
      const aiInput = {
        match: snapshot.match,
        live: {
          // odds selecionadas (range) com ODD_ID real
          odds: snapshot.odds,

          // eventos + cartões + gols
          events: {
            goals: snapshot.events.goals,
            yellowcards: snapshot.events.yellowcards,
            redcards: snapshot.events.redcards,
          },

          // TODAS as estatísticas (raw + normalizadas)
          statistics_raw: snapshot.stats.data,
          statistics_norm: snapshot.stats.norm,

          // ✅ EV pré-calculado
          top_evs: snapshot.ev.top_evs,
          top_evs_available: snapshot.ev.top_evs_available,
        },
      };

      const prompt = `Você é o "PredictIA Engine v2.1 Elite", um sistema de inteligência quantitativa para futebol ao vivo.

MISSÃO:
Escolher 1 (um) único palpite com maior "Edge" real AGORA.

REGRAS DE SAÍDA (PT-BR, texto simples, sem markdown):
Recomendação: <mercado + linha + período> (ALVO: JOGO|CASA|FORA) [ODD_ID=<N>]
Odd: <X.XX>
Probabilidade de Green: <XX%>
EV: <+0.00>
Risco: baixo|médio|alto
Justificativa: <1 frase ligando EV + stats/xG + game state>

HARD RULES:
- Se match.time.elapsed < 10 -> "INSUFFICIENT DATA — match too early for analysis."
- Proibido inventar ODD_ID: use apenas os IDs de live.odds
- Odd obrigatoriamente entre ${ODD_MIN.toFixed(2)} e ${ODD_MAX.toFixed(2)}
- Se live.top_evs_available = true:
  * O palpite DEVE sair de live.top_evs (lista já ordenada por EV desc).
  * Se o cenário (momentum/game state) contradizer, descarte como VALUE TRAP e avalie o próximo item.
  * Se nenhum sobreviver, recuse sem palpite.

FILTRO ANTI-UNDER-CEDO:
- Proibido recomendar "Menos de X gols" se match.time.elapsed < 25
- Se bloqueado, responda: "SEM OPORTUNIDADE — Minuto cedo para Under; risco alto de mudança de ritmo."

DADOS PARA PROCESSAMENTO (JSON):
${JSON.stringify(aiInput)}`;

      const model = genAI.getGenerativeModel({ model: GENAI_MODEL_RAW });
      const res = await model.generateContent(prompt);
      const text = res.response.text();

      aiCache.set(fixtureId, text);
      aiInFlight.delete(fixtureId);
      return text;
    } catch (e) {
      aiInFlight.delete(fixtureId);
      console.error("[IA ERROR]", e.message);
      throw e;
    }
  })();

  aiInFlight.set(fixtureId, p);
  return p;
}

// ---------------- ROUTES ----------------

// ✅ LISTA DE JOGOS AO VIVO (COMPAT APP: { status:"ok", data:[...] })
app.get("/football/live", async (req, res) => {
  try {
    const liveList = await fetchLiveFixtures();
    const data = (liveList || [])
      .map(ADAPTERS.football.extractLiveScore)
      .filter((g) => isValidFixtureId(Number(g?.fixtureId)));

    res.json({ status: "ok", data });
  } catch (e) {
    console.error("[LIVE ERROR]", e.message);
    res.status(500).json({ error: "Erro ao buscar jogos ao vivo" });
  }
});

// ✅ SNAPSHOT + IA POR FIXTURE
app.get("/football/match/:fixtureId", async (req, res) => {
  const fixtureId = Number(req.params.fixtureId);

  if (!isValidFixtureId(fixtureId)) {
    return res.status(400).json({ error: "fixtureId inválido" });
  }

  try {
    const snap = await getSnapshot(fixtureId);
    if (!snap) return res.status(404).json({ error: "Jogo não encontrado" });

    const ai = await getAI(snap, fixtureId);

    // snapshot inclui odds filtradas + stats + EV calculado (debug_all fica no snapshot.ev.debug_all)
    res.json({ status: "ok", snapshot: snap, ai });
  } catch (e) {
    console.error("[ROUTE ERROR]", fixtureId, e.message);
    res.status(500).json({ error: "Erro interno do servidor" });
  }
});

// ---------------- SERVER ----------------
const PORT = Number(process.env.PORT || 10000);
app.listen(PORT, () => {
  console.log("PredictIA Engine PRO rodando na porta", PORT);
});
