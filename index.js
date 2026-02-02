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
// ✅ (1) CACHE SNAPSHOT 60s + REQUEST COLLAPSING
// -----------------------------------------------------------
const SNAPSHOT_TTL_MS = Number(process.env.SNAPSHOT_TTL_MS || 60_000);

// fixtureId|oddMin|oddMax -> { exp, value }
const snapshotCache = new Map();

// fixtureId|oddMin|oddMax -> Promise<snapshot>
const snapshotInFlight = new Map();

function snapshotCacheKey(fixtureId, oddMin, oddMax) {
  return `fx:${Number(fixtureId)}:${Number(oddMin).toFixed(2)}:${Number(oddMax).toFixed(2)}`;
}

function snapshotCacheGet(key) {
  const row = snapshotCache.get(key);
  if (!row) return null;
  if (Date.now() > row.exp) {
    snapshotCache.delete(key);
    return null;
  }
  return row.value;
}

function snapshotCacheSet(key, value) {
  snapshotCache.set(key, { value, exp: Date.now() + SNAPSHOT_TTL_MS });
}

// -----------------------------------------------------------
// ✅ EV / TOP EVs (CONSENSO MULTI-BOOK) + SINGLE-BOOK (STATS MODEL)
// -----------------------------------------------------------
const EV_TOP_N = Number(process.env.EV_TOP_N || 6); // quantos TOP EVs mandar
const EV_MIN_PCT = Number(process.env.EV_MIN_PCT || 2.0); // mínimo EV% p/ entrar na lista
const EV_TTL_MS = Number(process.env.EV_TTL_MS || 12_000); // cache curto live (12s)
const EV_REQUIRE_MULTI_BOOK = String(process.env.EV_REQUIRE_MULTI_BOOK || "true").toLowerCase() !== "false";

// ✅ NOVO (single-book):
// auto = usa multi se books>=2, senão single (modelo stats)
// single = força single sempre
// multi = força multi sempre
const EV_MODE = String(process.env.EV_MODE || "auto").toLowerCase(); // auto|single|multi
const EV_MIN_PCT_SINGLE = Number(process.env.EV_MIN_PCT_SINGLE || EV_MIN_PCT);

const _evCache = new Map(); // key -> {exp, value}

function evCacheGet(key) {
  const row = _evCache.get(key);
  if (!row) return null;
  if (Date.now() > row.exp) {
    _evCache.delete(key);
    return null;
  }
  return row.value;
}
function evCacheSet(key, value) {
  _evCache.set(key, { value, exp: Date.now() + EV_TTL_MS });
}

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

function clamp01(p) {
  if (!Number.isFinite(p)) return 0;
  if (p < 0) return 0;
  if (p > 1) return 1;
  return p;
}

function clamp(x, a, b) {
  if (!Number.isFinite(x)) return a;
  return Math.max(a, Math.min(b, x));
}

function sigmoid(z) {
  if (!Number.isFinite(z)) return 0.5;
  if (z > 20) return 1;
  if (z < -20) return 0;
  return 1 / (1 + Math.exp(-z));
}

function median(arr) {
  const a = (arr || []).filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
  if (!a.length) return null;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

function normStr(x) {
  return String(x ?? "").trim().toLowerCase();
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
// ✅ TRAVAS PARA NÃO CALCULAR EV EM MERCADOS JÁ VERDES OU MUITO FÁCEIS
// -----------------------------------------------------------
function isGameTooAdvancedOrFinished(snapshot) {
  const elapsed = safeNumber(snapshot?.match?.time?.elapsed, 0);
  const status = String(snapshot?.match?.time?.short || "").toLowerCase();
  const statusLong = String(snapshot?.match?.time?.long || "").toLowerCase();
  
  // Jogo já terminou
  if (status === "ft" || status === "aet" || status === "pen" || 
      statusLong.includes("finished") || statusLong.includes("ended")) {
    return { blocked: true, reason: "Jogo já terminado" };
  }
  
  // Jogo em intervalo
  if (status === "ht" || statusLong.includes("halftime") || statusLong.includes("break")) {
    return { blocked: true, reason: "Jogo em intervalo" };
  }
  
  // Tempo regulamentar muito avançado (últimos minutos críticos)
  if (elapsed >= 88 && elapsed < 90) {
    return { blocked: true, reason: "Fim do jogo aproximando (88+ min)" };
  }
  
  // Prorrogação muito avançada
  if (elapsed >= 118 && elapsed < 120) {
    return { blocked: true, reason: "Fim da prorrogação aproximando" };
  }
  
  return { blocked: false, reason: "" };
}

function isMarketAlreadyGreen(snapshot, market, selection, handicap, period) {
  if (!snapshot) return false;
  
  const scoreHome = safeNumber(snapshot?.match?.score?.home, 0);
  const scoreAway = safeNumber(snapshot?.match?.score?.away, 0);
  const totalGoals = scoreHome + scoreAway;
  
  const elapsed = safeNumber(snapshot?.match?.time?.elapsed, 0);
  const marketStr = String(market || "").toLowerCase();
  const selectionStr = String(selection || "").toLowerCase();
  const handicapNum = parseFloat(handicap) || 0;
  
  // 1. VERIFICAÇÃO DE GOLS (Over/Under)
  if (marketStr.includes("goal") || marketStr.includes("gol")) {
    // Para mercados de "Mais de X gols" - verifica se já bateu
    if (selectionStr.includes("over") || selectionStr.includes("mais")) {
      const line = parseLineX5(handicap) || 0;
      const target = line + 0.5;
      
      // Se já tem mais gols que a linha, já bateu
      if (totalGoals >= Math.ceil(target)) {
        return true;
      }
      
      // No 2º tempo, cálculo de minutos restantes
      if (elapsed > 45) {
        const minutesRemaining = 90 - elapsed;
        const goalsNeeded = Math.ceil(target) - totalGoals;
        
        // Se precisa de MUITOS gols em pouco tempo, é quase impossível
        if (goalsNeeded > 0 && (goalsNeeded / minutesRemaining) > 0.15) { // > 0.15 gols/min
          return true; // Travado - muito difícil
        }
      }
    }
    
    // Para mercados de "Menos de X gols" - verifica se já perdeu
    if (selectionStr.includes("under") || selectionStr.includes("menos")) {
      const line = parseLineX5(handicap) || 0;
      const target = line + 0.5;
      
      // Se já tem mais gols que a linha, já PERDEU (não é "já green")
      // Mas se tem MUITO menos, pode ser green fácil demais
      if (elapsed > 70 && totalGoals <= Math.floor(target) - 2) {
        // Menos de 20 minutos e faltam 2+ gols para perder - MUITO provável
        return true;
      }
    }
  }
  
  // 2. VERIFICAÇÃO DE ESCANTEIOS
  if (marketStr.includes("corner") || marketStr.includes("escanteio")) {
    const cornersNow = pickCornersForAI(snapshot);
    const cornersTotal = safeNumber(cornersNow?.total, 0);
    
    if (selectionStr.includes("over") || selectionStr.includes("mais")) {
      const line = parseLineX5(handicap) || 0;
      const target = line + 0.5;
      
      if (cornersTotal >= Math.ceil(target)) {
        return true; // Já bateu
      }
      
      // Últimos minutos e precisa de muitos escanteios
      if (elapsed > 75) {
        const minutesRemaining = 90 - elapsed;
        const cornersNeeded = Math.ceil(target) - cornersTotal;
        
        if (cornersNeeded > 0 && (cornersNeeded / minutesRemaining) > 0.2) {
          return true; // Muito difícil
        }
      }
    }
  }
  
  // 3. VERIFICAÇÃO DE CARTÕES
  if (marketStr.includes("card") || marketStr.includes("cartão")) {
    const cardsNow = getCardsNow(snapshot);
    const cardsTotal = safeNumber(cardsNow?.total, 0);
    
    if (selectionStr.includes("over") || selectionStr.includes("mais")) {
      const line = parseLineX5(handicap) || 0;
      const target = line + 0.5;
      
      if (cardsTotal >= Math.ceil(target)) {
        return true; // Já bateu
      }
    }
  }
  
  // 4. VERIFICAÇÃO DE HANDICAP/VITÓRIA
  if (marketStr.includes("handicap") || marketStr.includes("vencedor") || 
      marketStr.includes("winner") || marketStr.includes("1x2")) {
    
    const goalDiff = scoreHome - scoreAway;
    
    // Handicap Asiático
    if (handicapNum !== 0) {
      const effectiveDiff = goalDiff - handicapNum;
      
      if (selectionStr.includes("home") || selectionStr === "1") {
        // Casa precisa vencer por handicap
        if (effectiveDiff >= 1 && elapsed > 80) {
          return true; // Provavelmente já garantido
        }
      }
      
      if (selectionStr.includes("away") || selectionStr === "2") {
        // Fora precisa vencer por handicap
        if (effectiveDiff <= -1 && elapsed > 80) {
          return true; // Provavelmente já garantido
        }
      }
    }
    
    // Vitória simples
    if (Math.abs(goalDiff) >= 3 && elapsed > 85) {
      // Diferença de 3+ gols nos minutos finais - quase certo
      return true;
    }
  }
  
  return false;
}

// -----------------------------------------------------------
// ✅ NOVO: CONSISTÊNCIA (anti flip-flop) — GOLS Over/Under 0.5
// (NÃO MEXER nas validações desta função)
// -----------------------------------------------------------
const PICK_MEMORY_TTL_MS = Number(process.env.PICK_MEMORY_TTL_MS || 1000 * 60 * 180); // 3h
const pickMemory = new Map(); // fixtureId -> marketKey -> { pick, line, goalsAtPick, ts, confidence, aiTextPatched }

function _nowMs() {
  return Date.now();
}

function _purgeOldPicks() {
  const t = _nowMs();
  for (const [fixtureId, markets] of pickMemory.entries()) {
    for (const [mk, rec] of markets.entries()) {
      if (!rec || t - rec.ts > PICK_MEMORY_TTL_MS) markets.delete(mk);
    }
    if (markets.size === 0) pickMemory.delete(fixtureId);
  }
}

function _getTotalGoalsFromSnapshot(snapshot) {
  const h = safeNumber(snapshot?.match?.score?.home, 0);
  const a = safeNumber(snapshot?.match?.score?.away, 0);
  return h + a;
}

function _marketKeyGoalsFT(line) {
  return `FT_GOALS_${Number(line).toFixed(2)}`;
}

function _parseConfidence01(aiText) {
  const m = String(aiText || "").match(/Probabilidade\s+de\s+GREEN\s*:\s*(\d{1,3})\s*%/i);
  if (!m) return 0;
  const p = safeNumber(m[1], 0);
  const v = Math.max(0, Math.min(100, p));
  return v / 100;
}

function _extractRecommendationLine(aiText) {
  const lines = String(aiText || "")
    .split("\n")
    .map((x) => x.trim())
    .filter(Boolean);
  const rec = lines.find((ln) => /^Recomendação\s*:/i.test(ln));
  return rec || "";
}

function _normalizeGoalsOU05FromAIText(aiText) {
  const rec = _extractRecommendationLine(aiText);
  if (!rec) return { ok: false };

  const low = rec.toLowerCase();

  const isGoals = low.includes("gols") || low.includes("gol") || low.includes("goals") || low.includes("total goals");
  if (!isGoals) return { ok: false };

  const isOver = low.includes("over") || low.includes("mais de") || low.includes("acima de");
  const isUnder = low.includes("under") || low.includes("menos de") || low.includes("abaixo de");
  if (!isOver && !isUnder) return { ok: false };

  let line = null;
  const m = low.match(/(\d+(?:[.,]\d+)?)/);
  if (m) line = safeNumber(String(m[1]).replace(",", "."), null);
  if (line === null) return { ok: false };

  if (Number(line) !== 0.5) return { ok: false };

  return { ok: true, dir: isOver ? "OVER" : "UNDER", line: 0.5 };
}

function _getLastPick(fixtureId, marketKey) {
  _purgeOldPicks();
  const markets = pickMemory.get(Number(fixtureId));
  if (!markets) return null;
  return markets.get(marketKey) || null;
}

function _setLastPick(fixtureId, marketKey, payload) {
  _purgeOldPicks();
  const id = Number(fixtureId);
  if (!pickMemory.has(id)) pickMemory.set(id, new Map());
  pickMemory.get(id).set(marketKey, payload);
}

function applyConsistencyGoalsOU05(snapshot, fixtureId, aiTextPatched) {
  const norm = _normalizeGoalsOU05FromAIText(aiTextPatched);
  if (!norm.ok) return aiTextPatched;

  const goalsNow = _getTotalGoalsFromSnapshot(snapshot);
  const mk = _marketKeyGoalsFT(norm.line);

  const last = _getLastPick(fixtureId, mk);

  if (norm.dir === "UNDER" && goalsNow >= 1) {
    return last?.aiTextPatched || aiTextPatched;
  }

  if (!last) {
    _setLastPick(fixtureId, mk, {
      pick: norm.dir,
      line: norm.line,
      goalsAtPick: goalsNow,
      ts: _nowMs(),
      confidence: _parseConfidence01(aiTextPatched),
      aiTextPatched,
    });
    return aiTextPatched;
  }

  if (Number(goalsNow) !== Number(last.goalsAtPick)) {
    _setLastPick(fixtureId, mk, {
      pick: norm.dir,
      line: norm.line,
      goalsAtPick: goalsNow,
      ts: _nowMs(),
      confidence: _parseConfidence01(aiTextPatched),
      aiTextPatched,
    });
    return aiTextPatched;
  }

  if (String(last.pick) !== String(norm.dir)) {
    return last.aiTextPatched || aiTextPatched;
  }

  _setLastPick(fixtureId, mk, {
    pick: norm.dir,
    line: norm.line,
    goalsAtPick: goalsNow,
    ts: _nowMs(),
    confidence: _parseConfidence01(aiTextPatched),
    aiTextPatched,
  });

  return aiTextPatched;
}

// -----------------------------------------------------------
// ✅ CORNERS FALLBACK (events vs stats)
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
// ✅ SINGLE-BOOK EV MODEL (STATS) — para quando books=1
// -----------------------------------------------------------
function getElapsed(snapshot) {
  return safeNumber(snapshot?.match?.time?.elapsed, 0);
}
function getScore(snapshot) {
  const h = safeNumber(snapshot?.match?.score?.home, 0);
  const a = safeNumber(snapshot?.match?.score?.away, 0);
  return { home: h, away: a, total: h + a };
}
function getRedcards(snapshot) {
  const evRed = safeNumber(snapshot?.events?.red, 0);
  const stHomeRed = safeNumber(snapshot?.stats?.data?.red?.home, 0);
  const stAwayRed = safeNumber(snapshot?.stats?.data?.red?.away, 0);
  const stRed = stHomeRed + stAwayRed;
  return {
    total: Math.max(evRed, stRed),
    home: Math.max(safeNumber(snapshot?.events?.red_home, 0), stHomeRed),
    away: Math.max(safeNumber(snapshot?.events?.red_away, 0), stAwayRed),
  };
}
function getSOT(snapshot) {
  const s = snapshot?.stats?.data;
  const home = safeNumber(s?.shots_on_goal?.home, 0);
  const away = safeNumber(s?.shots_on_goal?.away, 0);
  return { home, away, total: home + away };
}
function getShots(snapshot) {
  const s = snapshot?.stats?.data;
  const home = safeNumber(s?.total_shots?.home, 0);
  const away = safeNumber(s?.total_shots?.away, 0);
  return { home, away, total: home + away };
}
function getDAPM(snapshot) {
  const s = snapshot?.stats?.data;
  const daHome = safeNumber(s?.dangerous_attacks?.home, 0);
  const daAway = safeNumber(s?.dangerous_attacks?.away, 0);
  const el = Math.max(1, getElapsed(snapshot));
  return {
    home: daHome / el,
    away: daAway / el,
    total: (daHome + daAway) / el,
    daHome,
    daAway,
  };
}
function getCornersNow(snapshot) {
  const cp = pickCornersForAI(snapshot);
  return { home: safeNumber(cp?.home, 0), away: safeNumber(cp?.away, 0), total: safeNumber(cp?.total, 0) };
}
function getCardsNow(snapshot) {
  const yEv = safeNumber(snapshot?.events?.yellow, 0);
  const rEv = safeNumber(snapshot?.events?.red, 0);
  const s = snapshot?.stats?.data;
  const ySt = safeNumber(s?.yellow?.home, 0) + safeNumber(s?.yellow?.away, 0);
  const rSt = safeNumber(s?.red?.home, 0) + safeNumber(s?.red?.away, 0);

  const yellow = Math.max(yEv, ySt);
  const red = Math.max(rEv, rSt);
  return { yellow, red, total: yellow + red };
}

function minutesRemainingByPeriod(elapsed, period) {
  const el = safeNumber(elapsed, 0);
  const p = String(period || "FT").toUpperCase();
  if (p === "1H") return clamp(45 - el, 0, 45);
  if (p === "2H") return clamp(90 - el, 0, 45);
  return clamp(90 - el, 0, 90);
}

function intensity01(snapshot) {
  const el = Math.max(1, getElapsed(snapshot));
  const sot = getSOT(snapshot);
  const shots = getShots(snapshot);
  const dapm = getDAPM(snapshot);
  const score = getScore(snapshot);
  const reds = getRedcards(snapshot).total;

  const sotRate = sot.total / el; // ~0..0.3
  const shotsRate = shots.total / el; // ~0..0.6
  const dapmN = dapm.total;

  const z = -1.2 + 10.0 * sotRate + 3.0 * shotsRate + 2.2 * dapmN + 0.25 * score.total - 0.8 * reds;

  return clamp(sigmoid(z), 0.05, 0.98);
}

function lambdaGoalsFT(snapshot) {
  const el = Math.max(1, getElapsed(snapshot));
  const score = getScore(snapshot);
  const sot = getSOT(snapshot);
  const dapm = getDAPM(snapshot);
  const reds = getRedcards(snapshot).total;

  const I = intensity01(snapshot);
  const sotRate = sot.total / el;
  const dapmRate = dapm.total;

  let base = 0.018;
  base += 0.10 * sotRate;
  base += 0.010 * dapmRate;
  base += 0.006 * score.total;
  base -= 0.006 * reds;

  base = base * (0.65 + 0.75 * I);

  return clamp(base, 0.005, 0.060);
}

function lambdaGoalsTeamFT(snapshot, side /*home|away*/) {
  const s = snapshot?.stats?.data;
  const score = getScore(snapshot);
  const reds = getRedcards(snapshot);
  const I = intensity01(snapshot);

  const sotHome = safeNumber(s?.shots_on_goal?.home, 0);
  const sotAway = safeNumber(s?.shots_on_goal?.away, 0);
  const da = getDAPM(snapshot);

  const share = clamp(
    0.50 +
      1.2 * (sotHome - sotAway) / Math.max(1, sotHome + sotAway) +
      0.8 * (da.home - da.away),
    0.15,
    0.85
  );

  let base = lambdaGoalsFT(snapshot);
  base = base * share;

  const hasRed = side === "home" ? reds.home > 0 : reds.away > 0;
  if (hasRed) base *= 0.65;

  const isLosing = side === "home" ? score.home < score.away : score.away < score.home;
  if (isLosing) base *= 1.05;

  base = base * (0.8 + 0.4 * I);

  return clamp(base, 0.002, 0.050);
}

function lambdaCornersFT(snapshot) {
  const el = Math.max(1, getElapsed(snapshot));
  const corners = getCornersNow(snapshot);
  const dapm = getDAPM(snapshot);
  const shots = getShots(snapshot);
  const I = intensity01(snapshot);

  const cornersRateObs = corners.total / el;
  const shotsRate = shots.total / el;
  const dapmRate = dapm.total;

  let base = 0.10;
  base += 0.40 * cornersRateObs;
  base += 0.20 * shotsRate;
  base += 0.05 * dapmRate;

  base *= (0.70 + 0.70 * I);

  return clamp(base, 0.03, 0.30);
}

function lambdaCardsFT(snapshot) {
  const el = Math.max(1, getElapsed(snapshot));
  const cards = getCardsNow(snapshot);
  const dapm = getDAPM(snapshot);
  const I = intensity01(snapshot);

  const cardsRateObs = cards.total / el;

  let base = 0.055;
  base += 0.55 * cardsRateObs;
  base += 0.01 * dapm.total;

  base *= (0.80 + 0.50 * I);

  return clamp(base, 0.015, 0.20);
}

function poissonTailGTE(lambda, tMinutes, k) {
  const mu = safeNumber(lambda, 0) * safeNumber(tMinutes, 0);
  const K = Math.max(0, Math.floor(k));

  if (!(mu > 0)) return K === 0 ? 1 : 0;
  if (K <= 0) return 1;

  let sum = 0;
  let term = 1;
  for (let i = 0; i < K; i++) {
    if (i > 0) term *= mu / i;
    sum += term;
  }
  const cdf = Math.exp(-mu) * sum;
  return clamp(1 - cdf, 0, 1);
}

function poissonTailLTE(lambda, tMinutes, k) {
  const mu = safeNumber(lambda, 0) * safeNumber(tMinutes, 0);
  const K = Math.max(0, Math.floor(k));

  if (!(mu > 0)) return 1;

  let sum = 0;
  let term = 1;
  for (let i = 0; i <= K; i++) {
    if (i > 0) term *= mu / i;
    sum += term;
  }
  const cdf = Math.exp(-mu) * sum;
  return clamp(cdf, 0, 1);
}

function parseLineX5(handicapRaw) {
  if (handicapRaw === null || handicapRaw === undefined) return null;
  const v = String(handicapRaw).replace(",", ".").trim();
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function marketKind(marketNameRaw) {
  const m = String(marketNameRaw || "").toLowerCase();

  if (m.includes("goals") || m.includes("goal") || m.includes("total goals") || m.includes("match goals")) return "goals_total";
  if (m.includes("team goals") || m.includes("goals team")) return "goals_team";

  if (m.includes("corners") || m.includes("corner")) return "corners_total";
  if (m.includes("team corners")) return "corners_team";

  if (m.includes("cards") || m.includes("card")) return "cards_total";
  if (m.includes("team cards")) return "cards_team";

  if (m.includes("handicap") || m.includes("asian handicap") || m.includes("ah")) return "handicap";

  if (m.includes("match winner") || m.includes("match result") || m.includes("1x2")) return "match_odds";

  return "unknown";
}

function selectionSide(selectionRaw, rowSide) {
  const s = String(selectionRaw || "").toLowerCase();
  if (rowSide === "home" || s.includes("home") || s === "1") return "home";
  if (rowSide === "away" || s.includes("away") || s === "2") return "away";
  return "game";
}

function selectionDirOU(selectionRaw) {
  const s = String(selectionRaw || "").toLowerCase();
  if (s.includes("over") || s.includes("mais")) return "over";
  if (s.includes("under") || s.includes("menos")) return "under";
  return null;
}

function pModelForRow(snapshot, row) {
  const kind = marketKind(row?.market);
  const period = String(row?.period || "FT").toUpperCase();
  const elapsed = getElapsed(snapshot);
  const rem = minutesRemainingByPeriod(elapsed, period);

  const score = getScore(snapshot);

  if (elapsed < 10) return null;
  if (rem <= 0) return null;

  const odd = safeNumber(row?.odd, 0);
  if (!(odd > 1.0001)) return null;

  const side = selectionSide(row?.selection, row?.side);
  const dir = selectionDirOU(row?.selection);
  const line = parseLineX5(row?.handicap);

  if (kind === "goals_total" && dir && line !== null) {
    const goalsNow = score.total;
    const targetTotal = line + 0.5;
    const need = Math.max(0, Math.floor(targetTotal - goalsNow + 1e-9));

    const lam = lambdaGoalsFT(snapshot);

    if (dir === "over") {
      return poissonTailGTE(lam, rem, need);
    } else {
      const maxAdd = Math.floor(targetTotal - goalsNow - 1e-9);
      return poissonTailLTE(lam, rem, Math.max(0, maxAdd));
    }
  }

  if (kind === "goals_team" && dir && line !== null && (side === "home" || side === "away")) {
    const goalsNow = side === "home" ? score.home : score.away;
    const target = line + 0.5;
    const need = Math.max(0, Math.floor(target - goalsNow + 1e-9));

    const lam = lambdaGoalsTeamFT(snapshot, side);

    if (dir === "over") {
      return poissonTailGTE(lam, rem, need);
    } else {
      const maxAdd = Math.floor(target - goalsNow - 1e-9);
      return poissonTailLTE(lam, rem, Math.max(0, maxAdd));
    }
  }

  if (kind === "corners_total" && dir && line !== null) {
    const cNow = getCornersNow(snapshot).total;
    const target = line + 0.5;
    const need = Math.max(0, Math.floor(target - cNow + 1e-9));

    const lam = lambdaCornersFT(snapshot);

    if (dir === "over") {
      return poissonTailGTE(lam, rem, need);
    } else {
      const maxAdd = Math.floor(target - cNow - 1e-9);
      return poissonTailLTE(lam, rem, Math.max(0, maxAdd));
    }
  }

  if (kind === "cards_total" && dir && line !== null) {
    const cardsNow = getCardsNow(snapshot).total;
    const target = line + 0.5;
    const need = Math.max(0, Math.floor(target - cardsNow + 1e-9));

    const lam = lambdaCardsFT(snapshot);

    if (dir === "over") {
      return poissonTailGTE(lam, rem, need);
    } else {
      const maxAdd = Math.floor(target - cardsNow - 1e-9);
      return poissonTailLTE(lam, rem, Math.max(0, maxAdd));
    }
  }

  if (kind === "handicap" && line !== null && (side === "home" || side === "away")) {
    const reds = getRedcards(snapshot);
    const sot = getSOT(snapshot);
    const dapm = getDAPM(snapshot);

    const goalDiff = score.home - score.away;
    const diff = side === "home" ? goalDiff : -goalDiff;

    const mom =
      0.35 * (side === "home" ? dapm.home - dapm.away : dapm.away - dapm.home) +
      0.25 * (side === "home" ? sot.home - sot.away : sot.away - sot.home);

    const redPenalty = side === "home" ? (reds.home > 0 ? -1.1 : 0) : (reds.away > 0 ? -1.1 : 0);

    const w = clamp(1 - rem / 90, 0.1, 0.95);

    let z = (2.2 * w) * diff + 0.9 * mom + redPenalty;
    z -= 1.1 * line;

    return clamp(sigmoid(z), 0.02, 0.98);
  }

  if (kind === "match_odds") {
    const sel = String(row?.selection || "").toLowerCase();
    const reds = getRedcards(snapshot);
    const sot = getSOT(snapshot);
    const dapm = getDAPM(snapshot);

    const goalDiff = score.home - score.away;

    const momH = 0.45 * (dapm.home - dapm.away) + 0.25 * (sot.home - sot.away);
    const redH = (reds.home > 0 ? -1.2 : 0) + (reds.away > 0 ? +0.8 : 0);
    const w = clamp(1 - rem / 90, 0.1, 0.95);

    const pHome = clamp(sigmoid(1.8 * w * goalDiff + 1.0 * momH + redH), 0.01, 0.98);
    const pAway = clamp(sigmoid(-1.8 * w * goalDiff - 1.0 * momH - redH), 0.01, 0.98);
    const pDraw = clamp(1 - (pHome + pAway), 0.02, 0.60);

    if (sel.includes("home") || sel === "1") return pHome;
    if (sel.includes("away") || sel === "2") return pAway;
    if (sel.includes("draw") || sel.includes("empate") || sel === "x") return pDraw;

    return null;
  }

  return null;
}

function computeTopEvsSingleBook(snapshot, oddsCatalog = [], topN = 6, minEvPct = 2.0) {
  // ✅ TRAVA: Verificar se o jogo está muito avançado/terminado
  const gameCheck = isGameTooAdvancedOrFinished(snapshot);
  if (gameCheck.blocked) {
    console.log(`[EV-SINGLE-BLOCKED] ${gameCheck.reason} - Fixture ${snapshot?.meta?.fixtureId}`);
    return []; // Retorna array vazio
  }
  
  const catalog = Array.isArray(oddsCatalog) ? oddsCatalog : [];
  const out = [];

  for (const o of catalog) {
    const odd = safeNumber(o?.odd, 0);
    if (!(odd > 1.0001)) continue;

    const marketName = String(o?.market || "").trim();
    const selection = String(o?.selection || "").trim();
    const handicap = o?.handicap ?? null;
    const period = String(o?.period || "FT").trim();
    
    // ✅ TRAVA: Verificar se mercado já bateu green
    if (isMarketAlreadyGreen(snapshot, marketName, selection, handicap, period)) {
      continue; // Pula este mercado
    }

    const p = pModelForRow(snapshot, o);
    if (!Number.isFinite(p)) continue;

    const ev = clamp01(p) * odd - 1;
    const evPct = ev * 100;

    if (!Number.isFinite(evPct)) continue;
    if (evPct < minEvPct) continue;

    out.push({
      odd_id: Number(o?.id),
      market: o?.market ?? null,
      selection: o?.selection ?? null,
      handicap: o?.handicap ?? null,
      period: o?.period ?? null,
      odd: Number(odd.toFixed(2)),
      p_model: Number(clamp01(p).toFixed(4)),
      ev_pct: Number(evPct.toFixed(2)),
      books: 1,
      method: "single_book_stats_model",
    });
  }

  out.sort((a, b) => b.ev_pct - a.ev_pct);

  const seen = new Set();
  const picks = [];
  for (const p of out) {
    const k = mkEvKey(p.market, p.selection, p.handicap, p.period);
    if (seen.has(k)) continue;
    seen.add(k);
    picks.push(p);
    if (picks.length >= topN) break;
  }

  return picks;
}

// -----------------------------------------------------------
// ✅ "SEM OPORTUNIDADE" HELPERS (NOVO)
// -----------------------------------------------------------
function isSemOportunidade(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  const lines = t.split("\n").map((x) => x.trim()).filter(Boolean);
  return String(lines[0] || "").toUpperCase() === "SEM OPORTUNIDADE";
}

function normalizeSemOportunidade(text) {
  const t = String(text || "").trim();
  const lines = t.split("\n").map((x) => x.trim()).filter(Boolean);
  const motivoLine = lines.find((ln) => /^Motivo\s*:/i.test(ln)) || "Motivo: Nenhum mercado passou nos filtros.";
  return ["SEM OPORTUNIDADE", motivoLine].join("\n");
}

// -----------------------------------------------------------
// ✅ FORMATADOR PARA UI (remove ODD_ID/EV/ALVO e deixa só 5 linhas)
// -----------------------------------------------------------
function toTitleCaseRisk(x) {
  const t = String(x || "").trim().toLowerCase();
  if (!t) return "";
  if (t === "baixo") return "Baixo";
  if (t === "médio" || t === "medio") return "Médio";
  if (t === "alto") return "Alto";
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function simplifyRecommendationLine(line) {
  let s = String(line || "").trim();
  s = s.replace(/\[ODD_ID=\d+\]/gi, "").trim();
  s = s.replace(/\(ALVO:\s*(JOGO|CASA|FORA)\)/gi, "").trim();
  s = s.replace(/\s{2,}/g, " ");

  if (/^Recomendação\s*:/i.test(s)) {
    const lower = s.toLowerCase();
    let alvo = "";
    if (lower.includes("home") || lower.includes("casa")) alvo = "Time da Casa";
    else if (lower.includes("away") || lower.includes("fora")) alvo = "Time de Fora";

    if (lower.includes("score a goal") || lower.includes("to score") || lower.includes("marcar")) {
      if (alvo) return `Recomendação: GOL - ${alvo}`;
      return "Recomendação: GOL";
    }

    s = s.replace(/Recomendação:\s*GOLS?\s*:\s*/i, "Recomendação: ").trim();
    s = s.replace(/\bHome Team\b/gi, "Time da Casa");
    s = s.replace(/\bAway Team\b/gi, "Time de Fora");
  }

  return s.trim();
}

// ✅ PATCH: impede UI mostrar só "Odd: X" quando IA veio incompleta
function formatForUI(text) {
  const raw = String(text || "").trim();
  if (!raw) return "Erro na análise da IA.";

  if (isSemOportunidade(raw)) return normalizeSemOportunidade(raw);

  const lines = raw
    .split("\n")
    .map((x) => x.trim())
    .filter(Boolean);

  let rec = "";
  let odd = "";
  let prob = "";
  let risk = "";
  let just = "";

  for (const ln of lines) {
    if (!rec && /^Recomendação\s*:/i.test(ln)) rec = simplifyRecommendationLine(ln);
    if (!odd && /^Odd\s*:/i.test(ln)) odd = ln.replace(/\s{2,}/g, " ").trim();
    if (!prob && /^Probabilidade/i.test(ln)) {
      prob = ln
        .replace(/^Probabilidade\s+de\s+GREEN\s*:/i, "Probabilidade de Green:")
        .replace(/^Probabilidade\s+de\s+Green\s*:/i, "Probabilidade de Green:")
        .replace(/\s{2,}/g, " ")
        .trim();
    }
    if (!risk && /^Risco\s*:/i.test(ln)) {
      const v = ln.replace(/^Risco\s*:\s*/i, "").trim();
      risk = `Risco: ${toTitleCaseRisk(v)}`;
    }
    if (!just && /^Justificativa\s*:/i.test(ln)) just = ln.replace(/\s{2,}/g, " ").trim();
  }

  if (!rec) {
    return "SEM OPORTUNIDADE\nMotivo: IA não retornou recomendação válida (saída incompleta).";
  }

  const out = [rec, odd, prob, risk, just]
    .filter(Boolean)
    .map((x) =>
      String(x)
        .replace(/\[ODD_ID=\d+\]/gi, "")
        .replace(/EV:\s*[+-]?\d+(?:[.,]\d+)?/gi, "")
        .replace(/\(ALVO:\s*(JOGO|CASA|FORA)\)/gi, "")
        .replace(/\s{2,}/g, " ")
        .trim()
    )
    .filter(Boolean);

  return out.slice(0, 5).join("\n");
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

  return null;
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
      shots_on_goal: mk(extractStatValue(home, "Shots on Goal"), extractStatValue(away, "Shots on Goal")),
      shots_off_goal: mk(extractStatValue(home, "Shots off Goal"), extractStatValue(away, "Shots off Goal")),
      total_shots: mk(extractStatValue(home, "Total Shots"), extractStatValue(away, "Total Shots")),
      dangerous_attacks: mk(extractStatValue(home, "Dangerous Attacks"), extractStatValue(away, "Dangerous Attacks")),
      attacks: mk(extractStatValue(home, "Attacks"), extractStatValue(away, "Attacks")),
      possession: mk(extractStatValue(home, "Ball Possession"), extractStatValue(away, "Ball Possession")),
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

function compactEvents(events = []) {
  const ev = Array.isArray(events) ? events : [];
  const goals = ev.filter((e) => String(e?.type || "").toLowerCase() === "goal");
  const cards = ev.filter((e) => String(e?.type || "").toLowerCase() === "card");
  const yellow = cards.filter((e) => String(e?.detail || "").toLowerCase().includes("yellow")).length;
  const red = cards.filter((e) => String(e?.detail || "").toLowerCase().includes("red")).length;
  return { goals: goals.length, cards: cards.length, yellow, red };
}

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

function oddsLiveHasData(j) {
  if (!j) return false;
  if (j?.errors?.http || j?.errors?.api || j?.errors?.internal) return false;

  const roots = Array.isArray(j?.response) ? j.response : [];
  if (roots.length === 0) return false;

  const anyOddsArr = roots.some((r) => Array.isArray(r?.odds) && r.odds.length > 0);
  if (anyOddsArr) return true;

  const anyBookmakers =
    roots.some((r) => Array.isArray(r?.bookmakers) && r.bookmakers.length > 0) &&
    roots.some((r) => (r?.bookmakers || []).some((bm) => Array.isArray(bm?.bets) && bm.bets.length > 0));

  return anyBookmakers;
}

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
// ✅ EV ENGINE (CONSENSO MULTI-BOOK) -> TOP EVs DA PARTIDA
// (NÃO ALTERAR computeTopEvsForCatalog)
// -----------------------------------------------------------
function extractOddsBookmakers(oddsRoots = []) {
  const roots = Array.isArray(oddsRoots) ? oddsRoots : [];

  for (const r of roots) {
    if (Array.isArray(r?.bookmakers) && r.bookmakers.length > 0) return r.bookmakers;
  }

  for (const r of roots) {
    if (Array.isArray(r?.odds) && r.odds.length > 0) {
      return [
        {
          id: 0,
          name: "live",
          bets: r.odds.map((o, idx) => ({
            id: o?.id ?? idx,
            name: o?.name ?? "market",
            values: Array.isArray(o?.values) ? o.values : [],
          })),
        },
      ];
    }
  }

  return [];
}

function inferPeriodFromMarketName(marketName) {
  const m = String(marketName || "").toLowerCase();
  if (m.includes("1st") || m.includes("1st half")) return "1H";
  if (m.includes("2nd") || m.includes("2nd half")) return "2H";
  return "FT";
}

function mkEvKey(marketName, selection, handicap, period) {
  return `${normStr(marketName)}|${normStr(selection)}|${String(handicap ?? "")}|${normStr(period)}`;
}

function buildConsensusPFairMap(bookmakers = []) {
  const bms = Array.isArray(bookmakers) ? bookmakers : [];
  const pMap = new Map(); // key -> {pList:[], books:Set}

  for (const bm of bms) {
    const bookName = String(bm?.name || bm?.id || "book").trim();
    const bets = Array.isArray(bm?.bets) ? bm.bets : [];

    for (const bet of bets) {
      const marketName = String(bet?.name || "").trim();
      if (!marketName) continue;

      const period = inferPeriodFromMarketName(marketName);

      const values = Array.isArray(bet?.values) ? bet.values : [];
      const outcomes = [];

      for (const v of values) {
        const selection = String(v?.value ?? "").trim();
        const odd = safeNumber(v?.odd, 0);
        if (!selection || !(odd > 1.0001)) continue;

        outcomes.push({
          selection,
          odd,
          handicap: v?.handicap ?? null,
          period,
        });
      }

      if (outcomes.length < 2) continue;

      const pImpl = outcomes.map((o) => 1 / o.odd);
      const sum = pImpl.reduce((a, b) => a + b, 0);
      if (!(sum > 0)) continue;

      for (let i = 0; i < outcomes.length; i++) {
        const o = outcomes[i];
        const pNoVig = clamp01(pImpl[i] / sum);

        const key = mkEvKey(marketName, o.selection, o.handicap, o.period);

        if (!pMap.has(key)) {
          pMap.set(key, { pList: [], books: new Set() });
        }

        const row = pMap.get(key);
        row.pList.push(pNoVig);
        row.books.add(bookName);
      }
    }
  }

  const out = new Map(); // key -> {pFair, booksCount}
  for (const [k, v] of pMap.entries()) {
    const pFair = median(v.pList);
    const booksCount = v.books.size;

    if (!Number.isFinite(pFair)) continue;
    out.set(k, { pFair, booksCount });
  }

  return out;
}

function computeTopEvsForCatalog(oddsCatalog = [], bookmakers = [], topN = 6, minEvPct = 2.0, snapshot = null) {
  const catalog = Array.isArray(oddsCatalog) ? oddsCatalog : [];
  
  // ✅ TRAVA: Verificar se o jogo está muito avançado/terminado
  if (snapshot) {
    const gameCheck = isGameTooAdvancedOrFinished(snapshot);
    if (gameCheck.blocked) {
      console.log(`[EV-BLOCKED] ${gameCheck.reason} - Fixture ${snapshot?.meta?.fixtureId}`);
      return []; // Retorna array vazio - não calcula EV
    }
  }
  
  const consensus = buildConsensusPFairMap(bookmakers);
  const picks = [];
  
  for (const o of catalog) {
    const marketName = String(o?.market || "").trim();
    const selection = String(o?.selection || "").trim();
    const handicap = o?.handicap ?? null;
    const period = String(o?.period || "FT").trim();
    
    // ✅ TRAVA: Verificar se mercado já bateu green
    if (snapshot && isMarketAlreadyGreen(snapshot, marketName, selection, handicap, period)) {
      continue; // Pula este mercado
    }
    
    const key = mkEvKey(marketName, selection, handicap, period);
    const c = consensus.get(key);
    if (!c) continue;
    
    if (EV_REQUIRE_MULTI_BOOK && (c.booksCount || 0) < 2) continue;
    
    const odd = safeNumber(o?.odd, 0);
    if (!(odd > 1.0001)) continue;
    
    const pFair = clamp01(c.pFair);
    const ev = pFair * odd - 1;
    const evPct = ev * 100;
    
    if (!Number.isFinite(evPct)) continue;
    if (evPct < minEvPct) continue;
    
    picks.push({
      odd_id: Number(o?.id),
      market: o?.market ?? null,
      selection: o?.selection ?? null,
      handicap: o?.handicap ?? null,
      period: o?.period ?? null,
      odd: Number(odd.toFixed(2)),
      p_fair: Number(pFair.toFixed(4)),
      ev_pct: Number(evPct.toFixed(2)),
      books: Number(c.booksCount || 0),
    });
  }
  
  picks.sort((a, b) => b.ev_pct - a.ev_pct);
  
  const seen = new Set();
  const out = [];
  for (const p of picks) {
    const k = mkEvKey(p.market, p.selection, p.handicap, p.period);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(p);
    if (out.length >= topN) break;
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

  // ✅ (1) Cache de snapshot (60s) — antes de QUALQUER fetch
  const sKey = snapshotCacheKey(fixtureId, oddMin, oddMax);
  const cachedSnap = snapshotCacheGet(sKey);
  if (cachedSnap) return cachedSnap;

  // ✅ Request Collapsing — se já existe uma promise em voo para esse key, aguarda ela
  if (snapshotInFlight.has(sKey)) {
    return snapshotInFlight.get(sKey);
  }

  // ✅ monta a promise "única" que fará os fetchs
  const inFlightPromise = (async () => {
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
      _oddsBookmakers: null,
    };

    // 1) fixtures (essencial)
    const fx = await apiSports(FOOTBALL_BASE, "/fixtures", { id: fixtureId });
    snapshot.meta.sources.fixtures = fx?._url || null;

    const item = fx?.response?.[0];
    if (!item) {
      snapshot.meta.errors.fixtures = fx?.errors || { notFound: true };
      snapshot.rawCounts = { events: 0, oddsRoots: 0, statsTeams: 0, books: 0 };
      snapshot.meta.oddMin = oddMin;
      snapshot.meta.oddMax = oddMax;

      snapshotCacheSet(sKey, snapshot);
      return snapshot;
    }

    snapshot.meta.availability.fixtures = true;

    const status = item?.fixture?.status || {};
    snapshot.match = {
      fixtureId: item?.fixture?.id || Number(fixtureId),
      league: item?.league ? { id: item.league.id, name: item.league.name, season: item.league.season } : null,
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

    snapshot._oddsBookmakers = extractOddsBookmakers(oddsRoots);
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
      books: Array.isArray(snapshot._oddsBookmakers) ? snapshot._oddsBookmakers.length : 0,
    };

    snapshot.meta.oddMin = oddMin;
    snapshot.meta.oddMax = oddMax;

    // ✅ grava cache 60s
    snapshotCacheSet(sKey, snapshot);
    return snapshot;
  })();

  snapshotInFlight.set(sKey, inFlightPromise);
  inFlightPromise.finally(() => snapshotInFlight.delete(sKey));

  return inFlightPromise;
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
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(GENAI_KEY)}`;
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
    const flash25 = names.find((n) => n.toLowerCase().includes("2.5") && n.toLowerCase().includes("flash"));
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

// ---------- ✅ IA cache (60s) ----------
const AI_CACHE_TTL_MS = 60_000; // ✅ fixo 60s conforme instrução
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

// -----------------------------------------------------------
// ✅ CONTROLE DE TRÁFEGO (SERIAL + THROTTLE + RESPONSE PADRÃO)
// -----------------------------------------------------------
const AI_QUEUE_WAIT_MSG = String(process.env.AI_QUEUE_WAIT_MSG || "IA processando análise...");
const AI_QUEUE_FULL_MSG = String(process.env.AI_QUEUE_FULL_MSG || "IA em fila cheia. Tente novamente.");

const _envConcurrency = Number(process.env.AI_MAX_CONCURRENCY || 1);
const AI_MAX_CONCURRENCY = Math.min(1, Number.isFinite(_envConcurrency) ? _envConcurrency : 1);

const AI_MIN_INTERVAL_MS = Number(process.env.AI_MIN_INTERVAL_MS || 2000);
const AI_QUEUE_MAX = Number(process.env.AI_QUEUE_MAX || 300);

let _aiActive = 0;
let _aiLastFinishAt = 0;

const _aiQueue = [];

// cacheKey -> Promise<string> (resultado final)
const _aiInFlight = new Map();

function _aiRunNext() {
  if (_aiActive >= AI_MAX_CONCURRENCY) return;
  if (_aiQueue.length === 0) return;

  const now = Date.now();
  const wait = Math.max(0, _aiLastFinishAt + AI_MIN_INTERVAL_MS - now);

  const job = _aiQueue.shift();
  _aiActive++;

  setTimeout(async () => {
    try {
      const result = await job.fn();
      job.resolve(result);
    } catch (e) {
      job.reject(e);
    } finally {
      _aiLastFinishAt = Date.now();
      _aiActive--;
      _aiRunNext();
    }
  }, wait);
}

// ✅ (3) Cache de análise: se já existe resultado nos últimos 60s, retorna IMEDIATO (sem Gemini)
function enqueueAI(cacheKey, fn) {
  if (cacheKey) {
    const cached = aiCacheGet(cacheKey);
    if (cached) return Promise.resolve(cached);

    if (_aiInFlight.has(cacheKey)) {
      return Promise.resolve(AI_QUEUE_WAIT_MSG);
    }
  }

  if (_aiQueue.length >= AI_QUEUE_MAX) {
    return Promise.resolve(AI_QUEUE_FULL_MSG);
  }

  let resolveRef, rejectRef;
  const p = new Promise((resolve, reject) => {
    resolveRef = resolve;
    rejectRef = reject;
  });

  if (cacheKey) {
    _aiInFlight.set(cacheKey, p);
    p.finally(() => _aiInFlight.delete(cacheKey));
  }

  const job = { fn, resolve: resolveRef, reject: rejectRef };

  const willWait = !(
    _aiActive < AI_MAX_CONCURRENCY &&
    _aiQueue.length === 0 &&
    Date.now() >= _aiLastFinishAt + AI_MIN_INTERVAL_MS
  );

  _aiQueue.push(job);
  _aiRunNext();

  if (willWait) return Promise.resolve(AI_QUEUE_WAIT_MSG);
  return p;
}

// -----------------------------------------------------------
// ✅ FLUXO EV ANTES DA IA (Top 6 EVs já filtrados)
// -----------------------------------------------------------
function buildTopEvsFromSnapshot(snapshot, oddMin, oddMax) {
  const oddsCatalog = Array.isArray(snapshot?.odds) ? snapshot.odds : [];
  const bms = Array.isArray(snapshot?._oddsBookmakers) ? snapshot._oddsBookmakers : [];
  const booksCount = Array.isArray(bms) ? bms.length : 0;

  const filteredCatalog = oddsCatalog.filter((o) => {
    const odd = safeNumber(o?.odd, 0);
    return odd >= oddMin && odd <= oddMax;
  });

  // força modo
  if (EV_MODE === "multi") {
    const top = computeTopEvsForCatalog(filteredCatalog, bms, EV_TOP_N, EV_MIN_PCT, snapshot);
    return Array.isArray(top) ? top.slice(0, 6) : [];
  }
  if (EV_MODE === "single") {
    const top = computeTopEvsSingleBook(snapshot, filteredCatalog, EV_TOP_N, EV_MIN_PCT_SINGLE);
    return Array.isArray(top) ? top.slice(0, 6) : [];
  }

  // auto: se tiver 2+ books usa multi, senão single
  if (booksCount >= 2) {
    const top = computeTopEvsForCatalog(filteredCatalog, bms, EV_TOP_N, EV_MIN_PCT, snapshot);
    return Array.isArray(top) ? top.slice(0, 6) : [];
  }

  const top = computeTopEvsSingleBook(snapshot, filteredCatalog, EV_TOP_N, EV_MIN_PCT_SINGLE);
  return Array.isArray(top) ? top.slice(0, 6) : [];
}

// ---------- AI decision ----------
async function getAIAnalysisFromSnapshot(snapshot, cacheKey = "") {
  if (!genAI) return "IA não configurada.";

  // ✅ cache de análise 60s (retorno imediato)
  if (cacheKey) {
    const cached = aiCacheGet(cacheKey);
    if (cached) return cached;
    if (_aiInFlight.has(cacheKey)) return AI_QUEUE_WAIT_MSG;
  }

  const oddMin = Number(snapshot?.meta?.oddMin ?? ODD_MIN);
  const oddMax = Number(snapshot?.meta?.oddMax ?? ODD_MAX);

  const oddsCatalog = Array.isArray(snapshot?.odds) ? snapshot.odds : [];
  const match = snapshot?.match || {};
  const events = snapshot?.events || {};

  const { statsAvailable, xgAvailable } = getStatsXGFlags(snapshot);
  const stats = statsAvailable ? snapshot?.stats?.data : null;

  const cornersPick = pickCornersForAI(snapshot);

  // ✅ TOP EVs - cache curtíssimo por fixture+elapsed+range (mantido)
  const elapsed = safeNumber(snapshot?.match?.time?.elapsed, 0);
  const evKey = `ev:${snapshot?.meta?.fixtureId}:${elapsed}:${oddMin}:${oddMax}`;
  let topEvs = evCacheGet(evKey);

  if (!topEvs) {
    topEvs = buildTopEvsFromSnapshot(snapshot, oddMin, oddMax);
    evCacheSet(evKey, topEvs);
  }

  const usedBooks = safeNumber(snapshot?.rawCounts?.books, 0);
  const usedEvMode =
    EV_MODE === "single"
      ? "single"
      : EV_MODE === "multi"
        ? "multi"
        : usedBooks >= 2
          ? "multi"
          : "single";

  const aiData = {
    match,
    live: {
      events,

      corners_events: snapshot?.corners || null,
      corners_stats: statsAvailable ? snapshot?.stats?.data?.corners_stats || null : null,

      corners: cornersPick.available
        ? { source: cornersPick.source, total: cornersPick.total, home: cornersPick.home, away: cornersPick.away }
        : null,
      corners_available: Boolean(cornersPick.available),

      statistics: stats,
      statistics_available: statsAvailable,
      xg_available: xgAvailable,

      top_evs: Array.isArray(topEvs) ? topEvs.slice(0, 6) : [],
      top_evs_available: Array.isArray(topEvs) && topEvs.length > 0,
      top_evs_rules: {
        mode: usedEvMode,
        method: usedEvMode === "multi" ? "consensus_median_devig" : "single_book_stats_model",
        require_multi_book: usedEvMode === "multi" ? EV_REQUIRE_MULTI_BOOK : false,
        min_ev_pct: usedEvMode === "multi" ? EV_MIN_PCT : EV_MIN_PCT_SINGLE,
        top_n: 6,
        note:
          usedEvMode === "multi"
            ? "Se top_evs_available=false, não há base confiável (sem multi-book) ou nenhum EV passou no filtro."
            : "Single-book: EV estimado com modelo próprio (stats). Se top_evs_available=false, o modelo não achou edge >= mínimo.",
      },
    },
    meta: {
      snapshot_ts: snapshot?.meta?.snapshot_ts,
      sources: snapshot?.meta?.sources,
      availability: snapshot?.meta?.availability,
      rawCounts: snapshot?.rawCounts,
    },
  };

 const prompt = `## 🚀 PREDICTIA ENGINE v4.0 - SISTEMA DE CRIAÇÃO DE PALPITES 10/10
## PROTOCOLO: GERADOR DE VALOR BASEADO EM DADOS REAIS

⚠️ **MODO PRÁTICO ATIVADO:** Trabalhe APENAS com dados não-zerados. Dados = 0 ou null são DESCONSIDERADOS.

════════════════════════════════════════════════════════════════════════════════════════
## 📊 DADOS RECEBIDOS (USE APENAS O QUE TEM VALOR)
════════════════════════════════════════════════════════════════════════════════════════
${JSON.stringify(aiData, null, 2)}

REGRA ABSOLUTA: Se dado = 0, null ou não existe → NÃO USE. Ignore completamente.

════════════════════════════════════════════════════════════════════════════════════════
## 🧠 SISTEMA DE PRIORIZAÇÃO DE DADOS
════════════════════════════════════════════════════════════════════════════════════════

### 🎯 DADOS PRIMÁRIOS (SEMPRE USE SE DISPONÍVEIS):
1. **EV calculado** (live.top_evs) → MÁXIMA PRIORIDADE
2. **Odds atuais** (oddsCatalog) → DADOS CONCRETOS
3. **Tempo de jogo** (match.elapsed) → FATO

### 📈 DADOS SECUNDÁRIOS (USE SE > 0):
4. **DAPM** (dangerous_attacks_per_minute) → se > 0.1
5. **Chutes no gol** (shots_on_target) → se ≥ 1
6. **Escanteios** (corners) → se ≥ 1
7. **Posse de bola** (possession) → se entre 1-99
8. **Cartões** (cards) → se ≥ 1

### ⚠️ DADOS IGNORADOS (SE = 0):
- Qualquer estatística = 0 → não mencionar
- Dados missing → não mencionar

════════════════════════════════════════════════════════════════════════════════════════
## 🔥 GERADOR DE PALPITES 10/10
════════════════════════════════════════════════════════════════════════════════════════

### PASSO 1: VERIFICAÇÃO MÍNIMA
Se NÃO HOUVER:
- Pelo menos 1 odd válida EM live.top_evs OU oddsCatalog
- EV ≥ +0.05
- match.elapsed ≥ 15 min
→ "SEM OPORTUNIDADE: Dados insuficientes"

### PASSO 2: SELEÇÃO DO MELHOR MERCADO
1. **Ordene por EV decrescente** (maior EV primeiro)
2. **Filtre por odd entre ${oddMin.toFixed(2)} e ${oddMax.toFixed(2)}**
3. **Escolha o TOP 1** que passe no filtro básico

### PASSO 3: ANÁLISE COM DADOS DISPONÍVEIS
Para o mercado escolhido, verifique COM OS DADOS QUE EXISTEM:

**Se houver DAPM:**
- Time A DAPM > 0.8 → favorável
- Time B DAPM > 0.8 → favorável
- Total DAPM > 1.0 → bom para over

**Se houver SOT:**
- SOT ≥ 3 → conversão boa
- SOT ≤ 1 após 25min → cuidado

**Se houver corners:**
- ≥ 3 corners → pressão ofensiva
- Crescimento recente → momentum

**Se houver posse:**
- >60% + DAPM > 0.5 → domínio real
- <40% mas DAPM alto → contra-ataque eficaz

### PASSO 4: DECISÃO BINÁRIA
**✅ APROVA** se:
1. EV ≥ +0.05 (CONFIRMADO)
2. Odd na faixa permitida (CONFIRMADO)
3. Tempo ≥ 15min (CONFIRMADO)
4. **Pelo menos 1 dado secundário suporta** (DAPM OU SOT OU corners > 0)

**❌ REJEITA** se:
- Falhar 1, 2 ou 3 acima
- **TODOS** dados secundários = 0 ou negativos
- Contradição clara (ex: EV alto mas DAPM = 0 e SOT = 0)

════════════════════════════════════════════════════════════════════════════════════════
## 💎 FORMATO DE SAÍDA
════════════════════════════════════════════════════════════════════════════════════════

### ✅ CASO APROVADO (7 linhas EXATAS):
RECOMENDAÇÃO: [MERCADO] (ALVO: [TIME/TOTAL]) [ODD_ID=<NÚMERO>]
ODD: [X.XX]
PROBABILIDADE REAL: [XX%] (do cálculo EV)
EV: [+0.XX]
NÍVEL DE CONFIANÇA: [ALTO/MÉDIO] (baseado em dados disponíveis)
JUSTIFICATIVA: [Baseada APENAS nos dados NÃO-ZERADOS. Ex: "EV +0.15, 3 SOT, DAPM 1.2"]
+18 aposte com responsabilidade

### ❌ CASO REJEITADO (2 linhas EXATAS):
SEM OPORTUNIDADE
Motivo: [ESPECÍFICO. Ex: "EV abaixo do mínimo" ou "Dados ao vivo insuficientes"]

════════════════════════════════════════════════════════════════════════════════════════
## 📋 EXEMPLOS REAIS
════════════════════════════════════════════════════════════════════════════════════════

✅ COM DADOS:
Dados: {live.top_evs: [{market: "Over 2.5", ev: +0.18}], match: {elapsed: 35}, stats: {sot_total: 4, dapm_total: 1.3}}
→ 
RECOMENDAÇÃO: Over 2.5 Gols (ALVO: TOTAL) [ODD_ID=456]
ODD: 2.10
PROBABILIDADE REAL: 68%
EV: +0.18
NÍVEL DE CONFIANÇA: ALTO
JUSTIFICATIVA: EV +0.18, 4 chutes no gol, DAPM 1.3 mostra jogo aberto
+18 aposte com responsabilidade

✅ COM POUCOS DADOS:
Dados: {live.top_evs: [{market: "Vitória Casa", ev: +0.12}], match: {elapsed: 60}, stats: {corners_home: 6}}
→ 
RECOMENDAÇÃO: Vitória do Barcelona (ALVO: CASA) [ODD_ID=789]
ODD: 1.90
PROBABILIDADE REAL: 63%
EV: +0.12
NÍVEL DE CONFIANÇA: MÉDIO
JUSTIFICATIVA: EV +0.12, 6 escanteios mostram pressão ofensiva
+18 aposte com responsabilidade

❌ DADOS INSUFICIENTES:
Dados: {live.top_evs: [{market: "Ambas marcam", ev: +0.08}], match: {elapsed: 20}}
→ 
SEM OPORTUNIDADE
Motivo: EV abaixo do mínimo +0.05 e tempo insuficiente

❌ TODOS DADOS ZERADOS:
Dados: {live.top_evs: [{market: "Vitória Fora", ev: +0.20}], match: {elapsed: 45}, stats: {dapm_away: 0, sot_total: 0, corners: 0}}
→ 
SEM OPORTUNIDADE
Motivo: EV bom (+0.20) mas todos dados ao vivo zerados (DAPM=0, SOT=0)

════════════════════════════════════════════════════════════════════════════════════════
## 🚨 REGRAS FINAIS (OBRIGATÓRIO)
════════════════════════════════════════════════════════════════════════════════════════

1. **NUNCA INVENTE** dados. Se = 0, não existe.
2. **USE O QUE TEM**: EV + 1 dado secundário > 0 já basta.
3. **SEJA CONSERVADOR**: Prefira "SEM OPORTUNIDADE" se dúvida.
4. **PALPITE TOP 1 APENAS**: Melhor EV que passe nos filtros.
5. **FORMATO EXATO**: 7 linhas para ✅ ou 2 linhas para ❌
6. **LINHA FINAL OBRIGATÓRIA**: "+18 aposte com responsabilidade" em TODOS palpites aprovados

**ANALISE OS DADOS ACIMA E RESPONDA NO FORMATO EXATO:**`;

  const run = async () => {
    try {
      const raw1 = await generateGemini(prompt);

      // ✅ aceita SEM OPORTUNIDADE sem exigir ODD_ID
      if (isSemOportunidade(raw1)) {
        const uiNo = normalizeSemOportunidade(raw1);
        if (cacheKey) aiCacheSet(cacheKey, uiNo);
        return uiNo;
      }

      const v1 = validateAIWithOddsDetailed(raw1, oddsCatalog, oddMin, oddMax);

      if (!v1.ok) {
        const hintList = buildOddsHintList(oddsCatalog, 25);

        const retryPrompt = `Você tem DUAS opções:
1) Se existir pick válido, escolha OBRIGATORIAMENTE 1 ODD_ID da lista abaixo (não invente IDs) e retorne no FORMATO EXATO (6 linhas).
2) Se NÃO existir pick válido após filtros, retorne EXATAMENTE 2 linhas:
SEM OPORTUNIDADE
Motivo: Nenhum mercado passou nos filtros de EV + momentum + segurança.

LISTA_DE_ODDS_VALIDAS:
${JSON.stringify(hintList)}

DADOS AO VIVO:
${JSON.stringify(aiData)}`;

        const raw2 = await generateGemini(retryPrompt);

        if (isSemOportunidade(raw2)) {
          const uiNo2 = normalizeSemOportunidade(raw2);
          if (cacheKey) aiCacheSet(cacheKey, uiNo2);
          return uiNo2;
        }

        const v2 = validateAIWithOddsDetailed(raw2, oddsCatalog, oddMin, oddMax);

        if (!v2.ok) {
          const msg = "SEM OPORTUNIDADE\nMotivo: Nenhuma odd válida/consistente no catálogo dentro do range.";
          if (cacheKey) aiCacheSet(cacheKey, msg);
          return msg;
        }

        const formatted2 = ensureAIFormat(raw2);
        const patched2 = patchOddLineWithRealOdd(formatted2, v2.row.odd);

        const patched2Consistent = applyConsistencyGoalsOU05(
          snapshot,
          snapshot?.match?.fixtureId || snapshot?.meta?.fixtureId,
          patched2
        );

        const ui2 = formatForUI(patched2Consistent);
        if (cacheKey) aiCacheSet(cacheKey, ui2);
        return ui2;
      }

      const formatted1 = ensureAIFormat(raw1);
      const patched1 = patchOddLineWithRealOdd(formatted1, v1.row.odd);

      const patched1Consistent = applyConsistencyGoalsOU05(
        snapshot,
        snapshot?.match?.fixtureId || snapshot?.meta?.fixtureId,
        patched1
      );

      const ui1 = formatForUI(patched1Consistent);
      if (cacheKey) aiCacheSet(cacheKey, ui1);
      return ui1;
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

app.get("/football/snapshot/:fixtureId", async (req, res) => {
  const fixtureId = Number(req.params.fixtureId);
  const wantDebug = String(req.query.debug || "").toLowerCase() === "true";

  const oddMin = req.query.oddMin ? Number(req.query.oddMin) : ODD_MIN;
  const oddMax = req.query.oddMax ? Number(req.query.oddMax) : ODD_MAX;

  const snap = await buildFootballSnapshot(fixtureId, { oddMin, oddMax });

  const flags = getStatsXGFlags(snap);
  const cornersPick = pickCornersForAI(snap);

  const elapsed = safeNumber(snap?.match?.time?.elapsed, 0);
  const evKey = `ev:${snap?.meta?.fixtureId}:${elapsed}:${oddMin}:${oddMax}`;
  let topEvs = evCacheGet(evKey);
  if (!topEvs) {
    topEvs = buildTopEvsFromSnapshot(snap, oddMin, oddMax);
    evCacheSet(evKey, topEvs);
  }

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
        topEvs: topEvs,
        topEvsAvailable: Array.isArray(topEvs) && topEvs.length > 0,
      },
    });
  }

  return res.json({
    status: "ok",
    data: {
      ...snap,
      flags,
      corners_pick: cornersPick,
      top_evs: topEvs,
      top_evs_available: Array.isArray(topEvs) && topEvs.length > 0,
    },
  });
});

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

  const aiKey = `football:${fixtureId}:${oddMin.toFixed(2)}:${oddMax.toFixed(2)}`;
  const prediction = await getAIAnalysisFromSnapshot(snap, aiKey);
  out.ai_prediction = prediction;

  if (wantDebug) {
    const elapsed = safeNumber(snap?.match?.time?.elapsed, 0);
    const evKey = `ev:${snap?.meta?.fixtureId}:${elapsed}:${oddMin}:${oddMax}`;
    const topEvs = evCacheGet(evKey) || [];
    out.ai_debug = {
      oddsCatalogSize: Array.isArray(snap.odds) ? snap.odds.length : 0,
      statsTeams: snap?.rawCounts?.statsTeams ?? 0,
      corners_pick: cornersPick,
      stats_available: flags.statsAvailable,
      xg_available: flags.xgAvailable,
      books: snap?.rawCounts?.books ?? 0,
      topEvs,
      topEvsAvailable: Array.isArray(topEvs) && topEvs.length > 0,
      snapshot_cache_ttl_ms: SNAPSHOT_TTL_MS,
      ai_cache_ttl_ms: AI_CACHE_TTL_MS,
      ev_mode: EV_MODE,
      ev_min_pct_single: EV_MIN_PCT_SINGLE,
    };
  }

  return res.json({ status: "ok", data: out });
});

// -----------------------------------------------------------
// SERVER
// -----------------------------------------------------------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("Servidor rodando na porta", PORT));
