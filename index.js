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

if (!API_KEY) console.error("FALTA API_SPORTS_KEY ou FOOTBALL_API_KEY");
if (!GENAI_KEY) console.error("FALTA GEMINI_API_KEY");

const FOOTBALL_BASE = "https://v3.football.api-sports.io";

// ======================================================
// ✅ SEÇÃO: GEMINI (IA) - (EXISTENTE)
// ======================================================
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

// ======================================================
// ✅ SEÇÃO: IA RESPONSE NORMALIZATION (AJUSTADA)
// ======================================================
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

// ======================================================
// ✅ IMPLEMENTAÇÃO (SOMENTE): VALIDADORES DE ODD REAL (CATÁLOGO)
// ======================================================
function safeNumber(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function parseOddIdFromAI(text) {
  const m = String(text || "").match(/ODD_ID\s*=\s*(\d+)/i);
  return m ? Number(m[1]) : null;
}

function validateAIWithOdds(aiText, aiInput) {
  const t = String(aiText || "").trim();
  const catalog = aiInput?.live?.odds || [];

  if (!t) return null;
  if (!Array.isArray(catalog) || catalog.length === 0) return null;

  const oddId = parseOddIdFromAI(t);
  if (!oddId) return null;

  const row = catalog.find((x) => Number(x?.id) === Number(oddId));
  if (!row) return null;

  const odd = safeNumber(row?.odd, 0);
  if (odd < 1.5 || odd > 2.3) return null;

  return row;
}

function validateAIWithOddsDetailed(aiText, aiInput) {
  const t = String(aiText || "").trim();
  const catalog = aiInput?.live?.odds || [];

  if (!t) return { ok: false, reason: "AI_EMPTY" };
  if (!Array.isArray(catalog) || catalog.length === 0) return { ok: false, reason: "CATALOG_EMPTY" };

  const oddId = parseOddIdFromAI(t);
  if (!oddId) return { ok: false, reason: "NO_ODD_ID" };

  const row = catalog.find((x) => Number(x?.id) === Number(oddId));
  if (!row) return { ok: false, reason: "ODD_ID_NOT_FOUND" };

  const odd = safeNumber(row?.odd, 0);
  if (odd < 1.5 || odd > 2.3) return { ok: false, reason: "ODD_OUT_OF_RANGE" };

  return { ok: true, reason: "OK", row };
}

function patchOddLineWithRealOdd(aiText, realOdd) {
  const oddReal = Number(safeNumber(realOdd, 0)).toFixed(2);
  const text = String(aiText || "");

  if (/\bOdd\s*:\s*/i.test(text)) {
    return text.replace(
      /\bOdd\s*:\s*[0-9]+(?:[.,][0-9]+)?\b/i,
      `Odd: ${oddReal}`
    );
  }

  return `${text}\nOdd: ${oddReal}`;
}

// ======================================================
// ✅ SEÇÃO: IA QUOTA PROTECTION (CACHE + RETRY 429) (EXISTENTE)
// ======================================================
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

function parseRetryDelaySeconds(err) {
  const details = err?.errorDetails;
  if (!Array.isArray(details)) return null;

  const retryInfo = details.find((d) => d?.["@type"] === "type.googleapis.com/google.rpc.RetryInfo");
  const raw = retryInfo?.retryDelay;
  if (!raw) return null;

  const m = String(raw).match(/(\d+)\s*s/i);
  if (!m) return null;

  const sec = Number(m[1]);
  if (!Number.isFinite(sec) || sec <= 0) return null;

  return sec;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ======================================================
// ✅ NOVO: IA RATE LIMIT (FILA + CONCORRÊNCIA + ESPAÇAMENTO + DEDUPE)
// ======================================================
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

async function getAIAnalysisQueued(gameInfo, sportLabel = "Esporte", cacheKey = "") {
  if (!genAI) return "IA não configurada.";

  if (cacheKey) {
    const cached = aiCacheGet(cacheKey);
    if (cached) return cached;
  }

  return enqueueAI(cacheKey || "", async () => {
    return getAIAnalysis(gameInfo, sportLabel, cacheKey);
  });
}

// ======================================================
// ✅ NOVO: COMPACTAÇÃO DO INPUT PARA IA (EVITA PROMPT GIGANTE)
// ======================================================
function extractStatValue(statsTeamRow, type) {
  const s = statsTeamRow?.statistics || [];
  const it = s.find((x) => x?.type === type);
  const v = it?.value;
  if (typeof v === "string" && v.endsWith("%")) return safeNumber(v.replace("%", ""), 0);
  return safeNumber(v, 0);
}

// ======================================================
// ✅ IMPLEMENTAÇÃO (SOMENTE) - XG / EXPECTED GOALS
// ======================================================
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

  return 0;
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

// ✅ FIX: Red cards invertido (corrigido)
function compactLiveStats(live_stats = []) {
  const home = live_stats?.[0] || null;
  const away = live_stats?.[1] || null;

  const xgHome = extractXG(home);
  const xgAway = extractXG(away);

  return {
    home: home?.team?.name || null,
    away: away?.team?.name || null,

    xg: {
      home: xgHome,
      away: xgAway,
      total: Number((xgHome + xgAway).toFixed(2)),
    },

    shots_on_goal: {
      home: extractStatValue(home, "Shots on Goal"),
      away: extractStatValue(away, "Shots on Goal"),
    },
    shots_off_goal: {
      home: extractStatValue(home, "Shots off Goal"),
      away: extractStatValue(away, "Shots off Goal"),
    },
    total_shots: {
      home: extractStatValue(home, "Total Shots"),
      away: extractStatValue(away, "Total Shots"),
    },
    dangerous_attacks: {
      home: extractStatValue(home, "Dangerous Attacks"),
      away: extractStatValue(away, "Dangerous Attacks"),
    },
    attacks: {
      home: extractStatValue(home, "Attacks"),
      away: extractStatValue(away, "Attacks"),
    },
    possession: {
      home: extractStatValue(home, "Ball Possession"),
      away: extractStatValue(away, "Ball Possession"),
    },
    corners: {
      home: extractStatValue(home, "Corner Kicks"),
      away: extractStatValue(away, "Corner Kicks"),
    },
    yellow: {
      home: extractStatValue(home, "Yellow Cards"),
      away: extractStatValue(away, "Yellow Cards"),
    },
    red: {
      home: extractStatValue(home, "Red Cards"),
      away: extractStatValue(away, "Red Cards"),
    },
  };
}

function compactEvents(goals = [], cards = []) {
  const g = Array.isArray(goals) ? goals : [];
  const c = Array.isArray(cards) ? cards : [];

  const yellow = c.filter((x) => String(x?.detail || "").toLowerCase().includes("yellow")).length;
  const red = c.filter((x) => String(x?.detail || "").toLowerCase().includes("red")).length;

  return {
    goals: g.length,
    cards: c.length,
    yellow,
    red,
  };
}

// ======================================================
// ✅ IMPLEMENTAÇÃO (SOMENTE): CATÁLOGO DE ODD REAL (COM ODD_ID)
// ✅ SUPORTA 2 FORMATOS:
//   (A) odds.live v3 (bookmakers -> bets -> values)
//   (B) odds.live "antigo" (root.odds -> {id,name,values})
// ======================================================
function compactLiveOdds(live_odds = [], live_score = null) {
  const homeTeam = live_score?.teams?.home?.name || null;
  const awayTeam = live_score?.teams?.away?.name || null;

  const arr = Array.isArray(live_odds) ? live_odds : [];
  const out = [];
  let idSeq = 1;

  const pushCatalogRow = (bmName, marketName, selectionRaw, handicap, period, odd) => {
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

  // -------- FORMATO (A): bookmakers/bets/values --------
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
          if (odd < 1.5 || odd > 2.3) continue;

          pushCatalogRow(bm?.name, market, String(v?.value || ""), v?.handicap, period, odd);

          if (out.length >= 80) return out;
        }
      }
    }
  }

  // -------- FORMATO (B): root.odds -> {id,name,values} --------
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
        if (odd < 1.5 || odd > 2.3) continue;

        pushCatalogRow(bmName, market, String(v?.value || ""), v?.handicap, period, odd);

        if (out.length >= 80) return out;
      }
    }
  }

  return out;
}

function buildAIInput(out) {
  const live_score = out?.live_score || {};
  const status = live_score?.status || out?.game?.fixture?.status || {};
  const elapsed = safeNumber(live_score?.time ?? status?.elapsed, 0);

  const goals = live_score?.goals || out?.game?.goals || {};

  return {
    match: {
      fixtureId: live_score?.fixtureId || out?.fixtureId || null,
      league: live_score?.league?.name || null,
      teams: {
        home: live_score?.teams?.home?.name || null,
        away: live_score?.teams?.away?.name || null,
      },
      time: {
        elapsed,
        short: status?.short || null,
        long: status?.long || null,
      },
      score: {
        home: safeNumber(goals?.home, 0),
        away: safeNumber(goals?.away, 0),
      },
    },
    live: {
      corners_total: safeNumber(out?.corners?.total, 0),
      events: compactEvents(out?.goals, out?.cards),
      stats: compactLiveStats(out?.live_stats || []),
      odds: compactLiveOdds(out?.live_odds || [], live_score),
    },
  };
}

// ======================================================
// ✅ DEBUG: resumo do input (odds/stats/elapsed)
// ======================================================
function summarizeAIInput(aiInput) {
  const odds = Array.isArray(aiInput?.live?.odds) ? aiInput.live.odds : [];
  const stats = aiInput?.live?.stats || {};
  const elapsed = safeNumber(aiInput?.match?.time?.elapsed, 0);

  const markets = {};
  for (const o of odds) {
    const k = String(o?.market || "unknown");
    markets[k] = (markets[k] || 0) + 1;
  }

  return {
    elapsed,
    oddsCount: odds.length,
    oddsFirst10: odds.slice(0, 10),
    marketsTop: Object.entries(markets)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([market, count]) => ({ market, count })),
    statsSnapshot: stats,
  };
}

function buildOddsHintList(aiInput, max = 25) {
  const odds = Array.isArray(aiInput?.live?.odds) ? aiInput.live.odds : [];
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

// ======================================================
// ✅ FUNÇÃO ORIGINAL: getAIAnalysis (LÓGICA MANTIDA + RETRY FORÇADO)
// ======================================================
async function getAIAnalysis(gameInfo, sportLabel = "Esporte", cacheKey = "") {
  if (!genAI) return "IA não configurada.";

  if (cacheKey) {
    const cached = aiCacheGet(cacheKey);
    if (cached) return cached;
  }

  const prompt = `Você é um analista profissional de apostas esportivas (futebol) para o app PredictIA.
Contexto: jogo AO VIVO, com estatísticas em tempo real. O usuário pode atualizar a página e solicitar nova análise; cada requisição é independente.
OBJETIVO:
Selecionar UM ÚNICO palpite com o melhor Valor Esperado (EV) PARA O MOMENTO ATUAL DO JOGO. Ao ser chamado novamente, reavalie os dados atualizados e gere um novo palpite se fizer sentido.

REGRAS OBRIGATÓRIAS:
1) Responda em PT-BR, APENAS texto simples (sem Markdown).
2) Máximo 6 linhas.
3) Escolha somente 1 mercado dentre (sempre especificar período quando aplicável):
   - GOLS: Over/Under (ex: Over 0.5, Over 1.5, Under 3.5 etc.) (Período: FT quando não especificar)
   - VITÓRIA: 1X2 ou Dupla Chance (1X, X2, 12)
   - ESCANTEIOS: Over/Under (Período: 1ºT | 2ºT | FT)
   - CARTÕES: Over/Under (Período: 1ºT | 2ºT | FT)
   - HANDICAP: Asiático ou 3-Way Handicap (informar linha/handicap)
4) A ODD do palpite DEVE estar entre 1.50 e 2.30 (inclusive).
   - A ODD DEVE ser REAL e EXISTIR no JSON em live.odds (catálogo).
   - NUNCA use odd estimada. Se não existir odd real no range, responda exatamente: Sem oportunidades no range 1.50–2.30.
5) Probabilidade de GREEN (P) deve estar entre 65% e 100% (inclusive).
   - Nunca escreva abaixo de 65%.
6) Cálculo do EV (fundamental):
   - EV = (P_decimal * odd) - 1
   - P_decimal = P% / 100
   - Mostre EV com 2 casas e sinal (ex: +0.26, -0.05).
7) CONSISTÊNCIA DO MERCADO:
   - Sempre informar ALVO: JOGO | CASA | FORA
   - Quando houver linha/handicap, informar a linha real (handicap).
8) SELEÇÃO DA ODD:
   - Você DEVE escolher 1 item do catálogo live.odds e usar o ID dele.

FORMATO EXATO (copie exatamente as chaves e ordem):
Recomendação: <mercado + linha + período> (ALVO: JOGO|CASA|FORA) [ODD_ID=<N>]
Odd: <X.XX>
Probabilidade de GREEN: <XX%>
EV: <+0.00>
Risco: baixo|médio|alto
Justificativa: <1 frase objetiva baseada nos dados ao vivo e odds>

DADOS AO VIVO (use somente isto):
${JSON.stringify(gameInfo)}`;

  try {
    const text = await generateGemini(prompt);
    const finalText = ensureAIFormat(text);

    const v1 = validateAIWithOddsDetailed(finalText, gameInfo);
    if (!v1.ok) {
      const hintList = buildOddsHintList(gameInfo, 25);

      const retryPrompt = `Você FALHOU em escolher um ODD_ID válido do catálogo.
Agora escolha OBRIGATORIAMENTE um ODD_ID da lista abaixo (não invente IDs).

LISTA_DE_ODDS_VALIDAS (use exatamente um ID daqui):
${JSON.stringify(hintList)}

Mantenha o mesmo FORMATO EXATO de resposta (máx 6 linhas) e regras:
- Odd 1.50–2.30 (já está na lista)
- Probabilidade >= 65%
- EV = (P_decimal*odd)-1
- Retorne com [ODD_ID=<N>] na primeira linha

DADOS AO VIVO:
${JSON.stringify(gameInfo)}`;

      const text2 = await generateGemini(retryPrompt);
      const finalText2 = ensureAIFormat(text2);

      const v2 = validateAIWithOddsDetailed(finalText2, gameInfo);
      if (!v2.ok) {
        const msg = "Sem oportunidades no range 1.50–2.30.";
        if (cacheKey) aiCacheSet(cacheKey, msg);
        return msg;
      }

      const patched2 = patchOddLineWithRealOdd(finalText2, v2.row.odd);
      if (cacheKey) aiCacheSet(cacheKey, patched2);
      return patched2;
    }

    const patched = patchOddLineWithRealOdd(finalText, v1.row.odd);
    if (cacheKey) aiCacheSet(cacheKey, patched);
    return patched;
  } catch (err) {
    const status = err?.status;

    if (status === 429) {
      const sec = parseRetryDelaySeconds(err);
      const msg = sec
        ? `IA em limite de uso. Tente novamente em ~${sec}s.`
        : `IA em limite de uso. Tente novamente mais tarde.`;

      if (cacheKey) aiCacheSet(cacheKey, msg);
      return msg;
    }

    console.error("GEMINI_MODEL_RAW:", GENAI_MODEL_RAW);
    console.error("GEMINI_RESOLVED_MODEL:", _cachedResolvedModel);
    console.error("GEMINI ERROR (FULL):", err);

    const fallback = "Erro na análise da IA.";
    if (cacheKey) aiCacheSet(cacheKey, fallback);
    return fallback;
  }
}

// ======================================================
// ✅ SEÇÃO: API-SPORTS CORE (EXISTENTE)
// ======================================================
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

// ======================================================
// ✅ SEÇÃO: ADAPTERS (EXISTENTE)
// ======================================================
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
};

// ======================================================
// ✅ SEÇÃO: ROUTES (EXISTENTE)
// ======================================================
app.get("/", (_, res) => res.send("PredictIA Engine Online"));

// ======================================================
// ✅ ROTAS: FUTEBOL (MANTIDAS - NÃO ALTERAR)
// ======================================================
app.get("/football/live", async (req, res) => {
  const leagueId = req.query.leagueId ? Number(req.query.leagueId) : undefined;

  const data = await apiSports(
    FOOTBALL_BASE,
    "/fixtures",
    leagueId ? { live: "all", league: leagueId } : { live: "all" }
  );

  res.json({
    status: "ok",
    data: (data.response || []).map(ADAPTERS.football.extractLiveScore),
    raw: data.errors ? { errors: data.errors } : undefined,
  });
});

app.get("/football/match/:fixtureId", async (req, res) => {
  const fixtureId = Number(req.params.fixtureId);
  const wantAnalysis = String(req.query.analysis || "").toLowerCase() === "true";
  const wantDebug = String(req.query.debug || "").toLowerCase() === "true";

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
    const aiInput = buildAIInput(out);

    if (wantDebug) {
      out.ai_debug = {
        catalogSize: Array.isArray(aiInput?.live?.odds) ? aiInput.live.odds.length : 0,
        sample: Array.isArray(aiInput?.live?.odds) ? aiInput.live.odds.slice(0, 12) : [],
        inputSummary: summarizeAIInput(aiInput),
        rawCounts: {
          statsTeams: Array.isArray(out.live_stats) ? out.live_stats.length : 0,
          eventsGoals: Array.isArray(out.goals) ? out.goals.length : 0,
          eventsCards: Array.isArray(out.cards) ? out.cards.length : 0,
          oddsRoots: Array.isArray(out.live_odds) ? out.live_odds.length : 0,
        },
      };

      console.log("[AI_DEBUG] fixture:", fixtureId, "elapsed:", aiInput?.match?.time?.elapsed);
      console.log(
        "[AI_DEBUG] oddsCatalog:",
        Array.isArray(aiInput?.live?.odds) ? aiInput.live.odds.length : 0
      );
      console.log(
        "[AI_DEBUG] oddsSample:",
        Array.isArray(aiInput?.live?.odds) ? aiInput.live.odds.slice(0, 5) : []
      );
      console.log("[AI_DEBUG] statsSnapshot:", aiInput?.live?.stats);
    }

    const prediction = await getAIAnalysisQueued(aiInput, "Futebol", `football:${fixtureId}`);
    out.ai_prediction = prediction;

    if (wantDebug) {
      const v = validateAIWithOddsDetailed(prediction, aiInput);
      out.ai_debug = out.ai_debug || {};
      out.ai_debug.validationReason = v?.reason || "UNKNOWN";
      out.ai_debug.extractedOddId = parseOddIdFromAI(prediction);
    }
  }

  res.json({ status: "ok", data: out });
});

// ======================================================
// ✅ SERVER (EXISTENTE)
// ======================================================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("Servidor rodando na porta", PORT));
