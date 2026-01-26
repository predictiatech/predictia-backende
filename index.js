// FILE: index.js — PREDICT IA (VERSÃO PRO)
import "dotenv/config";
import express from "express";
import cors from "cors";
import { GoogleGenerativeAI } from "@google/generative-ai";

// ---------- SETUP ----------
const app = express();
app.use(cors());
app.use(express.json());

const API_KEY = process.env.FOOTBALL_API_KEY || process.env.API_SPORTS_KEY;
const GENAI_KEY = process.env.GEMINI_API_KEY;
const MODEL_NAME = (process.env.GEMINI_MODEL || "gemini-1.5-flash").trim();

const genAI = new GoogleGenerativeAI(GENAI_KEY);
const FOOTBALL_BASE = "https://v3.football.api-sports.io";

// ======================================================
// 🧠 LÓGICA DE TRATAMENTO DE DADOS (O SEGREDO DO GREEN)
// ======================================================

// Extrai estatísticas específicas do array da API-Sports
function getStat(statsArray, type) {
  const stat = statsArray.find(s => s.type === type);
  if (!stat) return 0;
  return typeof stat.value === "string" ? parseInt(stat.value.replace("%", "")) : (stat.value || 0);
}

// Cria um resumo de pressão para a IA não se perder no JSON
function prepareScoutReport(gameData) {
  const homeStats = gameData.live_stats[0]?.statistics || [];
  const awayStats = gameData.live_stats[1]?.statistics || [];

  const report = {
    home: {
      name: gameData.live_stats[0]?.team?.name,
      attacks: getStat(homeStats, "Attacks"),
      dangerousAttacks: getStat(homeStats, "Dangerous Attacks"),
      shotsOnGoal: getStat(homeStats, "Shots on Goal"),
      possession: getStat(homeStats, "Ball Possession"),
      corners: getStat(homeStats, "Corner Kicks")
    },
    away: {
      name: gameData.live_stats[1]?.team?.name,
      attacks: getStat(awayStats, "Attacks"),
      dangerousAttacks: getStat(awayStats, "Dangerous Attacks"),
      shotsOnGoal: getStat(awayStats, "Shots on Goal"),
      possession: getStat(awayStats, "Ball Possession"),
      corners: getStat(awayStats, "Corner Kicks")
    }
  };

  // Cálculo de Índice de Pressão (Ataques Perigosos por Minuto)
  const elapsed = gameData.match?.time?.elapsed || 1;
  report.pressureIndex = {
    home: (report.home.dangerousAttacks / elapsed).toFixed(2),
    away: (report.away.dangerousAttacks / elapsed).toFixed(2)
  };

  return report;
}

// Filtra o catálogo de Odds para enviar apenas o que interessa à IA
function filterOdds(oddsArray) {
  const catalog = [];
  let idCounter = 1;

  oddsArray.forEach(bookmaker => {
    (bookmaker.odds || []).forEach(market => {
      market.values.forEach(v => {
        const val = parseFloat(v.odd);
        // Abrimos um pouco o range para 1.40-2.50 para dar mais opções à IA
        if (val >= 1.40 && val <= 2.50) {
          catalog.push({
            id: idCounter++,
            m: market.name, // mercado
            s: v.value,     // seleção
            o: val,         // odd
            h: v.handicap || null
          });
        }
      });
    });
  });
  return catalog.slice(0, 35); // Limite para não estourar o prompt
}

// ======================================================
// 🤖 CORE DA IA (GEMINI)
// ======================================================

async function getAIAnalysis(gameInfo) {
  const scout = prepareScoutReport(gameInfo);
  const odds = filterOdds(gameInfo.live_odds || []);

  if (odds.length === 0) return "Sem oportunidades no range de Odds no momento.";

  const model = genAI.getGenerativeModel({ model: MODEL_NAME });

  const prompt = `Você é o motor de análise do PredictIA. Analise este jogo de futebol e forneça a melhor entrada.

DADOS DO JOGO:
- Placar: ${gameInfo.match.teams.home}: ${gameInfo.match.score.home} vs ${gameInfo.match.teams.away}: ${gameInfo.match.score.away}
- Tempo: ${gameInfo.match.time.elapsed}' min
- Scout: ${JSON.stringify(scout)}

CATÁLOGO DE ODDS (Escolha uma pelo ID):
${JSON.stringify(odds)}

REGRAS OBRIGATÓRIAS:
1. Escolha 1 palpite do catálogo acima que tenha o maior Valor Esperado ($$EV = (Probabilidade * Odd) - 1$$).
2. Se a pressão ofensiva de um time for muito superior (>0.7 AP/min), priorize mercados a favor desse time.
3. Responda em PT-BR, no formato exato abaixo, SEM Markdown. Máximo 6 linhas.

FORMATO DE RESPOSTA:
Recomendação: <mercado + linha> [ODD_ID=<ID_ESCOLHIDO>]
Odd: <X.XX>
Probabilidade de GREEN: <XX%>
EV: <+0.XX>
Risco: baixo|médio|alto
Justificativa: <frase técnica baseada nos ataques e pressão>`;

  try {
    const result = await model.generateContent(prompt);
    const response = result.response.text();
    
    // Verificação simples de segurança
    if (!response.includes("ODD_ID")) return "A IA não encontrou um padrão de entrada seguro. Aguarde nova atualização.";
    
    return response.trim();
  } catch (error) {
    console.error("Erro Gemini:", error);
    return "Erro ao processar análise.";
  }
}

// ======================================================
// 🚀 ROTAS DA API
// ======================================================

app.get("/football/match/:fixtureId", async (req, res) => {
  const { fixtureId } = req.params;
  const h = { "x-apisports-key": API_KEY };

  try {
    // Busca paralela para ganhar velocidade
    const [fixRes, statsRes, oddsRes] = await Promise.all([
      fetch(`${FOOTBALL_BASE}/fixtures?id=${fixtureId}`, { headers: h }).then(r => r.json()),
      fetch(`${FOOTBALL_BASE}/fixtures/statistics?fixture=${fixtureId}`, { headers: h }).then(r => r.json()),
      fetch(`${FOOTBALL_BASE}/odds/live?fixture=${fixtureId}`, { headers: h }).then(r => r.json())
    ]);

    const match = fixRes.response[0];
    if (!match) return res.status(404).json({ error: "Jogo não encontrado" });

    const gameContext = {
      match: {
        teams: match.teams,
        score: match.goals,
        time: match.fixture.status,
      },
      live_stats: statsRes.response || [],
      live_odds: oddsRes.response || []
    };

    const prediction = await getAIAnalysis(gameContext);

    res.json({
      status: "ok",
      data: {
        fixtureId,
        teams: `${match.teams.home.name} vs ${match.teams.away.name}`,
        prediction
      }
    });

  } catch (err) {
    res.status(500).json({ error: "Falha na conexão com a API de Esportes" });
  }
});

// Inicialização
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`--- PREDICT IA ENGINE ONLINE ---`);
  console.log(`Porta: ${PORT} | Modelo: ${MODEL_NAME}`);
});
