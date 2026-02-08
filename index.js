import "dotenv/config";
import express from "express";
import cors from "cors";

// ---------- CONFIGURAÇÕES ----------
const API_KEY = process.env.API_SPORTS_KEY || process.env.FOOTBALL_API_KEY;
const FOOTBALL_BASE = "https://v3.football.api-sports.io";

const app = express();
app.use(cors());
app.use(express.json());

// ============================================
// CONFIGURAÇÕES E CONSTANTES
// ============================================
const config = {
  minGameMinute: 15,           // Analisar apenas após 15min
  oddRange: { min: 1.40, max: 2.00 },
  cacheDuration: 60,           // Cache de estatísticas por 60 segundos
  apiCalls: {
    count: 0,                  // Contador de chamadas API
    maxPerMinute: 10
  }
};

// ============================================
// CACHE DE ESTATÍSTICAS (PARA MÚLTIPLOS USUÁRIOS)
// ============================================
const statsCache = new Map();

// ============================================
// MERCADOS DEFINIDOS (CORRIGIDOS)
// ============================================

const MARKETS = {
  // =================== ESCANTEIOS ===================
  CORNERS: {
    id: "corners",
    name: 'Escanteios',
    types: ['1T', '2T', 'Match', 'Team'],
    
    rules: {
      minCornersForAnalysis: 2,
      considerPossession: true,
      weightRecent: 0.7
    },
    
    calculateEV: (stats, odd, marketType, handicap, selectionType) => {
      const elapsed = stats.match.time.elapsed;
      const cornersNow = stats.corners.total || 0;
      
      // Taxa de escanteios por minuto
      const cornersPerMin = cornersNow / Math.max(1, elapsed);
      const minutesRemaining = marketType === '1T' ? 45 - elapsed : 
                              marketType === '2T' ? 45 : 90 - elapsed;
      
      // Probabilidade baseada em histórico do jogo
      let probability = 0.5;
      
      if (cornersNow > 0) {
        const expectedCorners = cornersPerMin * minutesRemaining;
        // Normalização mais realista
        probability = Math.min(0.95, Math.max(0.05, expectedCorners / 12));
      }
      
      // Ajustar por handicap se existir
      if (handicap) {
        const target = parseFloat(handicap);
        if (selectionType === 'over') {
          probability = Math.max(0.05, Math.min(0.95, probability * 1.2));
        } else if (selectionType === 'under') {
          probability = Math.max(0.05, Math.min(0.95, probability * 0.8));
        }
      }
      
      // Cálculo EV: (Probabilidade * Odd) - 1
      const ev = (probability * odd) - 1;
      return {
        ev,
        probability,
        details: {
          cornersNow,
          cornersPerMin: cornersPerMin.toFixed(3),
          expectedCorners: (cornersPerMin * minutesRemaining).toFixed(2),
          marketType,
          minutesRemaining
        }
      };
    }
  },
  
  // =================== GOLS ===================
  GOALS: {
    id: "goals",
    name: 'Gols',
    types: ['Over/Under', 'Both Teams to Score', 'Exact Score', 'Team Goals'],
    
    rules: {
      useXG: true,
      considerShotsOnTarget: true,
      minShotsForAnalysis: 3
    },
    
    calculateEV: (stats, odd, marketType, handicap, selectionType) => {
      const elapsed = stats.match.time.elapsed;
      const score = stats.match.score;
      const totalGoals = score.home + score.away;
      
      // Taxa de gols por minuto
      const goalsPerMin = totalGoals / Math.max(1, elapsed);
      const minutesRemaining = marketType === '1T' ? 45 - elapsed : 
                              marketType === '2T' ? 45 : 90 - elapsed;
      
      let probability = 0.5;
      
      // Usar xG se disponível
      const xGTotal = (stats.xG.home || 0) + (stats.xG.away || 0);
      const effectiveGoalsPerMin = xGTotal > 0 ? 
        (xGTotal / elapsed) : 
        goalsPerMin;
      
      const lambda = effectiveGoalsPerMin * minutesRemaining;
      
      // Função Poisson corrigida
      const poissonProbability = (k) => {
        return (Math.exp(-lambda) * Math.pow(lambda, k)) / gamma(k + 1);
      };
      
      if (marketType.includes('Over') && handicap) {
        const target = parseFloat(handicap);
        // Probabilidade de ter MAIS que target gols
        let cumulative = 0;
        for (let k = 0; k <= Math.floor(target); k++) {
          cumulative += poissonProbability(k);
        }
        probability = Math.max(0.05, Math.min(0.95, 1 - cumulative));
      } else if (marketType.includes('Under') && handicap) {
        const target = parseFloat(handicap);
        // Probabilidade de ter MENOS que target gols
        let cumulative = 0;
        for (let k = 0; k <= Math.floor(target); k++) {
          cumulative += poissonProbability(k);
        }
        probability = Math.max(0.05, Math.min(0.95, cumulative));
      } else if (marketType === 'Both Teams to Score' || selectionType === 'yes') {
        // Probabilidade mais realista de ambos marcarem
        const homeAttackStrength = Math.min(1, (stats.shots.home.onTarget || 0) / 10);
        const awayAttackStrength = Math.min(1, (stats.shots.away.onTarget || 0) / 10);
        const homeScoringProb = 0.3 + (homeAttackStrength * 0.4);
        const awayScoringProb = 0.3 + (awayAttackStrength * 0.4);
        probability = Math.max(0.05, Math.min(0.95, homeScoringProb * awayScoringProb));
      } else if (selectionType === 'no') {
        // Probabilidade de não ambos marcarem
        probability = 0.6; // Base mais conservadora
      }
      
      const ev = (probability * odd) - 1;
      return {
        ev,
        probability,
        details: {
          totalGoals,
          goalsPerMin: goalsPerMin.toFixed(3),
          expectedGoals: lambda.toFixed(2),
          marketType,
          handicap,
          xGUsed: xGTotal > 0
        }
      };
    }
  },
  
  // =================== CARTÕES ===================
  CARDS: {
    id: "cards",
    name: 'Cartões',
    types: ['Amarelos', 'Vermelhos', 'Total Cards'],
    
    rules: {
      considerFouls: true,
      considerIntensity: true
    },
    
    calculateEV: (stats, odd, marketType, handicap, selectionType) => {
      const elapsed = stats.match.time.elapsed;
      const cardsNow = stats.cards.total || 0;
      const foulsNow = stats.fouls.total || 0;
      const yellowCards = stats.cards.yellow || 0;
      
      // Taxas por minuto
      const cardsPerMin = cardsNow / Math.max(1, elapsed);
      const foulsPerMin = foulsNow / Math.max(1, elapsed);
      const yellowPerMin = yellowCards / Math.max(1, elapsed);
      
      const minutesRemaining = marketType === '1T' ? 45 - elapsed : 
                              marketType === '2T' ? 45 : 90 - elapsed;
      
      // Modelo baseado em intensidade do jogo
      let probability = 0.25; // Base mais conservadora
      
      // Intensidade baseada em faltas
      const intensity = foulsPerMin * 0.3;
      probability += Math.min(0.4, intensity);
      
      // Cartões existentes indicam arbitragem mais rigorosa
      probability += cardsPerMin * 0.2;
      
      // Ajustar por handicap
      if (handicap) {
        const target = parseFloat(handicap);
        const expectedCards = cardsPerMin * minutesRemaining;
        if (selectionType === 'over') {
          probability = expectedCards > target ? 0.65 : 0.35;
        } else if (selectionType === 'under') {
          probability = expectedCards < target ? 0.65 : 0.35;
        }
      }
      
      probability = Math.max(0.05, Math.min(0.95, probability));
      
      const ev = (probability * odd) - 1;
      return {
        ev,
        probability,
        details: {
          cardsNow,
          foulsNow,
          cardsPerMin: cardsPerMin.toFixed(3),
          foulsPerMin: foulsPerMin.toFixed(3),
          expectedCards: (cardsPerMin * minutesRemaining).toFixed(2),
          marketType
        }
      };
    }
  },
  
  // =================== VITÓRIA ===================
  WIN: {
    id: "win",
    name: 'Vitória',
    types: ['1T', '2T', 'Match', 'Draw No Bet'],
    
    rules: {
      usePossession: true,
      useShotsRatio: true,
      homeAdvantage: 0.1
    },
    
    calculateEV: (stats, odd, marketType, handicap, selectionType) => {
      const elapsed = stats.match.time.elapsed;
      const score = stats.match.score;
      const possession = stats.possession;
      const shots = stats.shots;
      const xG = stats.xG || { home: 0, away: 0 };
      
      // Análise baseada em múltiplos fatores
      let probability = 0.5;
      
      // 1. Fator placar atual (mais peso)
      const goalDiff = score.home - score.away;
      if (selectionType === 'home') {
        probability += goalDiff * 0.15;
      } else if (selectionType === 'away') {
        probability -= goalDiff * 0.15;
      }
      
      // 2. Fator posse de bola (menos peso)
      if (selectionType === 'home') {
        probability += (possession.home - 50) * 0.002;
      } else if (selectionType === 'away') {
        probability += (possession.away - 50) * 0.002;
      }
      
      // 3. Fator xG (Expected Goals) - mais preciso que shots
      const xGDiff = (xG.home || 0) - (xG.away || 0);
      if (selectionType === 'home') {
        probability += xGDiff * 0.2;
      } else if (selectionType === 'away') {
        probability -= xGDiff * 0.2;
      }
      
      // 4. Vantagem de mando de campo (apenas para resultado final)
      if (selectionType === 'home' && marketType === 'Match') {
        probability += 0.08; // Reduzido de 0.1 para ser mais conservador
      }
      
      // 5. Fator tempo (momentum diminui com o tempo)
      const timeFactor = elapsed / 90;
      if (goalDiff > 0 && selectionType === 'home') {
        probability += 0.1 * (1 - timeFactor); // Vantagem diminui com o tempo
      } else if (goalDiff < 0 && selectionType === 'away') {
        probability += 0.1 * (1 - timeFactor);
      }
      
      probability = Math.max(0.1, Math.min(0.9, probability));
      
      const ev = (probability * odd) - 1;
      return {
        ev,
        probability,
        details: {
          score,
          possession,
          xGDiff: xGDiff.toFixed(2),
          shotsOnTarget: shots.total.onTarget || 0,
          marketType,
          selectionType,
          timeFactor: timeFactor.toFixed(2)
        }
      };
    }
  },
  
  // =================== ASIÁTICO ===================
  ASIAN_HANDICAP: {
    id: "asian",
    name: 'Asiático',
    types: ['-0.5', '-1', '-1.5', '+0.5', '+1', '+1.5'],
    
    rules: {
      minGoalDifference: 0,
      considerMomentum: true
    },
    
    calculateEV: (stats, odd, marketType, handicap, selectionType) => {
      const elapsed = stats.match.time.elapsed;
      const score = stats.match.score;
      const possession = stats.possession;
      const xG = stats.xG || { home: 0, away: 0 };
      
      let probability = 0.5;
      
      // Determinar handicap e time
      let handicapValue = 0;
      let isHomeSelection = selectionType === 'home';
      
      if (handicap) {
        handicapValue = parseFloat(handicap);
      }
      
      // Score ajustado pelo handicap
      const effectiveScore = (score.home + (isHomeSelection ? handicapValue : 0)) - 
                           (score.away + (isHomeSelection ? 0 : handicapValue));
      
      // 1. Diferença de xG (fator mais importante)
      const xGDiff = (xG.home || 0) - (xG.away || 0);
      probability += (isHomeSelection ? xGDiff : -xGDiff) * 0.25;
      
      // 2. Posse de bola
      probability += (isHomeSelection ? 
        (possession.home - 50) * 0.002 : 
        (possession.away - 50) * 0.002);
      
      // 3. Handicap adjustment
      probability -= Math.abs(handicapValue) * 0.08;
      
      // 4. Fator tempo e placar atual
      const timeFactor = elapsed / 90;
      if (effectiveScore > 0) {
        probability += (isHomeSelection ? 0.15 : -0.15) * timeFactor;
      } else if (effectiveScore < 0) {
        probability += (isHomeSelection ? -0.15 : 0.15) * timeFactor;
      }
      
      probability = Math.max(0.1, Math.min(0.9, probability));
      
      const ev = (probability * odd) - 1;
      return {
        ev,
        probability,
        details: {
          score,
          handicap: handicapValue,
          effectiveScore,
          xGDiff: xGDiff.toFixed(2),
          possessionDiff: (possession.home - possession.away).toFixed(1),
          marketType,
          selectionType,
          timeRemaining: (90 - elapsed)
        }
      };
    }
  }
};

// ============================================
// FUNÇÕES AUXILIARES CORRIGIDAS
// ============================================

// Função gamma (fatorial para números reais) - CORREÇÃO CRÍTICA
function gamma(n) {
  // Aproximação de Stirling para a função Gamma
  if (n === 0 || n === 1) return 1;
  if (Number.isInteger(n)) {
    let result = 1;
    for (let i = 2; i <= n - 1; i++) result *= i;
    return result;
  }
  // Aproximação para números não inteiros
  const g = 7;
  const p = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7
  ];
  
  if (n < 0.5) {
    return Math.PI / (Math.sin(Math.PI * n) * gamma(1 - n));
  }
  
  n -= 1;
  let x = p[0];
  for (let i = 1; i < g + 2; i++) {
    x += p[i] / (n + i);
  }
  const t = n + g + 0.5;
  return Math.sqrt(2 * Math.PI) * Math.pow(t, n + 0.5) * Math.exp(-t) * x;
}

// Função factorial usando gamma (para compatibilidade)
function factorial(n) {
  if (n < 0) return NaN;
  if (n === 0 || n === 1) return 1;
  return gamma(n + 1);
}

// Função de validação de EV para testes
function validateEVCalculation() {
  const testCases = [
    { probability: 0.7, odd: 1.5, expectedEV: 0.05 },
    { probability: 0.5, odd: 2.0, expectedEV: 0.0 },
    { probability: 0.3, odd: 4.0, expectedEV: 0.2 },
    { probability: 0.8, odd: 1.25, expectedEV: 0.0 },
  ];
  
  console.log('🧪 VALIDAÇÃO DE CÁLCULO EV:');
  console.log('============================');
  
  let allPassed = true;
  testCases.forEach((test, i) => {
    const ev = (test.probability * test.odd) - 1;
    const diff = Math.abs(ev - test.expectedEV);
    const passed = diff < 0.01;
    
    console.log(`Teste ${i + 1}: P=${test.probability}, Odd=${test.odd}`);
    console.log(`  Calculado: ${ev.toFixed(4)} | Esperado: ${test.expectedEV.toFixed(4)}`);
    console.log(`  Status: ${passed ? '✅' : '❌'}`);
    console.log('---');
    
    if (!passed) allPassed = false;
  });
  
  console.log(allPassed ? '✅ TODOS OS TESTES PASSARAM' : '❌ ALGUNS TESTES FALHARAM');
  return allPassed;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================
// API FOOTBALL CLIENT (OTIMIZADO)
// ============================================

class ApiFootballClient {
  constructor(apiKey, baseUrl = FOOTBALL_BASE) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
    this.callCount = 0;
  }
  
  async makeRequest(endpoint, params = {}) {
    this.callCount++;
    const url = new URL(this.baseUrl + endpoint);
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, String(value));
      }
    });
    
    try {
      const response = await fetch(url, {
        headers: {
          'x-apisports-key': this.apiKey,
          'Accept': 'application/json'
        }
      });
      
      const data = await response.json();
      
      if (!response.ok) {
        throw new Error(`API Error: ${response.status} - ${JSON.stringify(data)}`);
      }
      
      return data;
    } catch (error) {
      console.error(`API Request failed: ${endpoint}`, error);
      throw error;
    }
  }
  
  async getLiveFixtures(leagueId = null) {
    const params = { live: 'all' };
    if (leagueId) params.league = leagueId;
    
    const data = await this.makeRequest('/fixtures', params);
    return data.response || [];
  }
  
  async getFixtureDetails(fixtureId) {
    const data = await this.makeRequest('/fixtures', { id: fixtureId });
    return data.response?.[0] || null;
  }
  
  async getFixtureStatistics(fixtureId) {
    const data = await this.makeRequest('/fixtures/statistics', { fixture: fixtureId });
    return data.response || [];
  }
  
  async getFixtureEvents(fixtureId) {
    const data = await this.makeRequest('/fixtures/events', { fixture: fixtureId });
    return data.response || [];
  }
  
  async getLiveOdds(fixtureId) {
    const data = await this.makeRequest('/odds/live', { fixture: fixtureId });
    return data.response || [];
  }
  
  getCallCount() {
    return this.callCount;
  }
  
  resetCallCount() {
    this.callCount = 0;
  }
}

// ============================================
// ANALISADOR DE JOGOS CORRIGIDO
// ============================================

class MatchAnalyzer {
  constructor(apiClient) {
    this.apiClient = apiClient;
    this.statsCache = new Map();
  }
  
  async analyzeFixture(fixtureId) {
    console.log(`[ANALYZER] Iniciando análise para fixture ${fixtureId}`);
    
    // 1. Verificar se já tem cache válido
    const cached = this.statsCache.get(fixtureId);
    if (cached && (Date.now() - cached.timestamp < config.cacheDuration * 1000)) {
      console.log(`[CACHE] Usando estatísticas em cache para fixture ${fixtureId}`);
      return cached.data;
    }
    
    // 2. Coletar dados do jogo
    console.log(`[API] Coletando dados para fixture ${fixtureId}`);
    const [fixture, statistics, events, odds] = await Promise.all([
      this.apiClient.getFixtureDetails(fixtureId),
      this.apiClient.getFixtureStatistics(fixtureId),
      this.apiClient.getFixtureEvents(fixtureId),
      this.apiClient.getLiveOdds(fixtureId)
    ]);
    
    // 3. Processar estatísticas
    const processedStats = this.processStatistics(fixture, statistics, events, odds);
    
    // 4. Salvar no cache
    this.statsCache.set(fixtureId, {
      timestamp: Date.now(),
      data: processedStats
    });
    
    console.log(`[ANALYZER] Análise concluída. Chamadas API: ${this.apiClient.getCallCount()}`);
    
    return processedStats;
  }
  
  processStatistics(fixture, statistics, events, odds) {
    // Extrair dados básicos do jogo
    const matchData = {
      fixtureId: fixture.fixture.id,
      league: {
        id: fixture.league.id,
        name: fixture.league.name,
        season: fixture.league.season
      },
      teams: {
        home: fixture.teams.home.name,
        away: fixture.teams.away.name
      },
      time: {
        elapsed: fixture.fixture.status.elapsed,
        status: fixture.fixture.status.short
      },
      score: {
        home: fixture.goals.home,
        away: fixture.goals.away
      }
    };
    
    // Processar estatísticas dos times
    const stats = this.extractTeamStatistics(statistics);
    
    // Processar eventos
    const eventsData = this.processEvents(events);
    
    // Processar odds
    const oddsData = this.processOddsCorrigido(odds, matchData.teams);
    
    return {
      match: matchData,
      statistics: stats,
      events: eventsData,
      odds: oddsData,
      timestamp: new Date().toISOString(),
      apiCalls: this.apiClient.getCallCount()
    };
  }
  
  extractTeamStatistics(statistics) {
    const homeStats = statistics.find(s => s.team.id === statistics[0]?.team?.id);
    const awayStats = statistics.find(s => s.team.id !== statistics[0]?.team?.id);
    
    const extractValue = (statArray, key) => {
      const stat = statArray?.find(s => s.type === key);
      return stat ? parseFloat(stat.value) || 0 : 0;
    };
    
    const homeData = {
      shotsOnGoal: extractValue(homeStats?.statistics, 'Shots on Goal'),
      shotsOffGoal: extractValue(homeStats?.statistics, 'Shots off Goal'),
      totalShots: extractValue(homeStats?.statistics, 'Total Shots'),
      possession: extractValue(homeStats?.statistics, 'Ball Possession'),
      corners: extractValue(homeStats?.statistics, 'Corner Kicks'),
      fouls: extractValue(homeStats?.statistics, 'Fouls'),
      yellowCards: extractValue(homeStats?.statistics, 'Yellow Cards'),
      redCards: extractValue(homeStats?.statistics, 'Red Cards'),
      offsides: extractValue(homeStats?.statistics, 'Offsides'),
      passes: extractValue(homeStats?.statistics, 'Total passes'),
      accuratePasses: extractValue(homeStats?.statistics, 'Passes %'),
      xG: extractValue(homeStats?.statistics, 'Expected Goals')
    };
    
    const awayData = {
      shotsOnGoal: extractValue(awayStats?.statistics, 'Shots on Goal'),
      shotsOffGoal: extractValue(awayStats?.statistics, 'Shots off Goal'),
      totalShots: extractValue(awayStats?.statistics, 'Total Shots'),
      possession: extractValue(awayStats?.statistics, 'Ball Possession'),
      corners: extractValue(awayStats?.statistics, 'Corner Kicks'),
      fouls: extractValue(awayStats?.statistics, 'Fouls'),
      yellowCards: extractValue(awayStats?.statistics, 'Yellow Cards'),
      redCards: extractValue(awayStats?.statistics, 'Red Cards'),
      offsides: extractValue(awayStats?.statistics, 'Offsides'),
      passes: extractValue(awayStats?.statistics, 'Total passes'),
      accuratePasses: extractValue(awayStats?.statistics, 'Passes %'),
      xG: extractValue(awayStats?.statistics, 'Expected Goals')
    };
    
    return {
      home: homeData,
      away: awayData,
      totals: {
        shotsOnGoal: homeData.shotsOnGoal + awayData.shotsOnGoal,
        shotsOffGoal: homeData.shotsOffGoal + awayData.shotsOffGoal,
        totalShots: homeData.totalShots + awayData.totalShots,
        corners: homeData.corners + awayData.corners,
        fouls: homeData.fouls + awayData.fouls,
        yellowCards: homeData.yellowCards + awayData.yellowCards,
        redCards: homeData.redCards + awayData.redCards,
        offsides: homeData.offsides + awayData.offsides
      }
    };
  }
  
  processEvents(events) {
    const goals = events.filter(e => e.type === 'Goal');
    const cards = events.filter(e => e.type === 'Card');
    const corners = events.filter(e => e.type === 'Corner');
    
    return {
      goals: goals.length,
      yellowCards: cards.filter(c => c.detail === 'Yellow Card').length,
      redCards: cards.filter(c => c.detail === 'Red Card').length,
      corners: corners.length,
      allEvents: events
    };
  }
  
  processOddsCorrigido(odds, teams) {
    const markets = [];
    const homeTeam = teams.home.toLowerCase();
    const awayTeam = teams.away.toLowerCase();
    
    console.log(`[ODDS PROCESSOR] Processando odds para ${teams.home} vs ${teams.away}`);
    
    odds.forEach(oddGroup => {
      // Formato A: Com bookmakers (formato mais comum)
      if (oddGroup.bookmakers && Array.isArray(oddGroup.bookmakers)) {
        oddGroup.bookmakers.forEach(bookmaker => {
          const bmName = bookmaker.name || 'Unknown';
          
          if (bookmaker.bets && Array.isArray(bookmaker.bets)) {
            bookmaker.bets.forEach(bet => {
              const marketName = String(bet.name || '').trim();
              const marketLower = marketName.toLowerCase();
              
              const isRelevantMarket = 
                marketLower.includes('corner') ||
                marketLower.includes('escanteio') ||
                marketLower.includes('card') ||
                marketLower.includes('cartão') ||
                marketLower.includes('yellow card') ||
                marketLower.includes('red card') ||
                marketLower.includes('goal') ||
                marketLower.includes('gol') ||
                marketLower.includes('goals') ||
                marketLower.includes('winner') ||
                marketLower.includes('vencedor') ||
                marketLower.includes('handicap') ||
                marketLower.includes('asiatic') ||
                marketLower.includes('asian') ||
                marketLower.includes('1x2') ||
                marketLower.includes('match result') ||
                marketLower.includes('both teams to score') ||
                marketLower.includes('ambas marcam') ||
                marketLower.includes('over') ||
                marketLower.includes('under') ||
                marketLower.includes('mais') ||
                marketLower.includes('menos');
              
              if (!isRelevantMarket) return;
              
              let period = 'Match';
              if (marketLower.includes('1st') || marketLower.includes('1st half') || marketLower.includes('first half')) {
                period = '1H';
              } else if (marketLower.includes('2nd') || marketLower.includes('2nd half') || marketLower.includes('second half')) {
                period = '2H';
              }
              
              if (bet.values && Array.isArray(bet.values)) {
                bet.values.forEach(value => {
                  const oddValue = parseFloat(value.odd) || 0;
                  
                  if (oddValue >= config.oddRange.min && oddValue <= config.oddRange.max) {
                    const selection = String(value.value || '').trim();
                    const selectionLower = selection.toLowerCase();
                    
                    let selectionType = 'game';
                    let targetTeam = null;
                    
                    if (selectionLower.includes('home') || selection === '1' || selectionLower.includes(homeTeam)) {
                      selectionType = 'home';
                      targetTeam = teams.home;
                    } else if (selectionLower.includes('away') || selection === '2' || selectionLower.includes(awayTeam)) {
                      selectionType = 'away';
                      targetTeam = teams.away;
                    } else if (selectionLower.includes('over') || selectionLower.includes('mais')) {
                      selectionType = 'over';
                    } else if (selectionLower.includes('under') || selectionLower.includes('menos')) {
                      selectionType = 'under';
                    } else if (selectionLower.includes('yes') || selectionLower.includes('sim')) {
                      selectionType = 'yes';
                    } else if (selectionLower.includes('no') || selectionLower.includes('não')) {
                      selectionType = 'no';
                    } else if (selectionLower.includes('draw')) {
                      selectionType = 'draw';
                    }
                    
                    markets.push({
                      bookmaker: bmName,
                      market: marketName,
                      selection: selection,
                      selectionType: selectionType,
                      targetTeam: targetTeam,
                      odd: Number(oddValue.toFixed(2)),
                      handicap: value.handicap || null,
                      period: period,
                      rawMarketName: marketName,
                      rawSelection: selection
                    });
                  }
                });
              }
            });
          }
        });
      }
      
      // Formato B: Odds diretas
      if (oddGroup.odds && Array.isArray(oddGroup.odds)) {
        oddGroup.odds.forEach(bet => {
          const marketName = String(bet.name || '').trim();
          const marketLower = marketName.toLowerCase();
          
          const isRelevantMarket = 
            marketLower.includes('corner') ||
            marketLower.includes('escanteio') ||
            marketLower.includes('card') ||
            marketLower.includes('cartão') ||
            marketLower.includes('goal') ||
            marketLower.includes('gol') ||
            marketLower.includes('winner') ||
            marketLower.includes('vencedor') ||
            marketLower.includes('handicap') ||
            marketLower.includes('asiatic') ||
            marketLower.includes('1x2');
          
          if (!isRelevantMarket) return;
          
          let period = 'Match';
          if (marketLower.includes('1st') || marketLower.includes('1st half')) period = '1H';
          if (marketLower.includes('2nd') || marketLower.includes('2nd half')) period = '2H';
          
          if (bet.values && Array.isArray(bet.values)) {
            bet.values.forEach(value => {
              const oddValue = parseFloat(value.odd) || 0;
              
              if (oddValue >= config.oddRange.min && oddValue <= config.oddRange.max) {
                const selection = String(value.value || '').trim();
                const selectionLower = selection.toLowerCase();
                
                let selectionType = 'game';
                let targetTeam = null;
                
                if (selectionLower.includes('home') || selection === '1' || selectionLower.includes(homeTeam)) {
                  selectionType = 'home';
                  targetTeam = teams.home;
                } else if (selectionLower.includes('away') || selection === '2' || selectionLower.includes(awayTeam)) {
                  selectionType = 'away';
                  targetTeam = teams.away;
                }
                
                markets.push({
                  bookmaker: 'live',
                  market: marketName,
                  selection: selection,
                  selectionType: selectionType,
                  targetTeam: targetTeam,
                  odd: Number(oddValue.toFixed(2)),
                  handicap: value.handicap || null,
                  period: period,
                  rawMarketName: marketName,
                  rawSelection: selection
                });
              }
            });
          }
        });
      }
    });
    
    console.log(`[ODDS PROCESSOR] Encontrados ${markets.length} mercados no range ${config.oddRange.min}-${config.oddRange.max}`);
    
    if (markets.length > 0) {
      console.log('[ODDS SAMPLE] Primeiros mercados encontrados:');
      markets.slice(0, 3).forEach((m, i) => {
        console.log(`  ${i+1}. ${m.market} - ${m.selection} @ ${m.odd} (${m.period})`);
      });
    }
    
    return markets;
  }
}

// ============================================
// ANALISADOR DE MERCADOS CORRIGIDO
// ============================================

class MarketAnalyzer {
  constructor(matchAnalyzer) {
    this.matchAnalyzer = matchAnalyzer;
  }
  
  async analyzeMarkets(fixtureId, marketsToCheck = Object.keys(MARKETS)) {
    console.log(`[MARKET ANALYZER] Analisando mercados para fixture ${fixtureId}`);
    
    // 1. Obter dados do jogo
    const matchData = await this.matchAnalyzer.analyzeFixture(fixtureId);
    
    // 2. Verificar tempo de jogo
    if (matchData.match.time.elapsed < config.minGameMinute) {
      console.log(`[MARKET ANALYZER] Jogo com apenas ${matchData.match.time.elapsed} minutos. Aguardando 15min.`);
      return {
        eligible: false,
        minute: matchData.match.time.elapsed,
        message: `Jogo com apenas ${matchData.match.time.elapsed} minutos. Mínimo requerido: ${config.minGameMinute}`
      };
    }
    
    // 3. Preparar estatísticas para cálculo
    const stats = this.prepareStatsForAnalysis(matchData);
    
    // 4. Analisar cada mercado
    const results = [];
    
    for (const marketKey of marketsToCheck) {
      const market = MARKETS[marketKey];
      console.log(`[MARKET] Analisando mercado: ${market.name}`);
      
      const marketOdds = matchData.odds.filter(odd => 
        this.isMarketMatch(odd.market, market.name, market.types)
      );
      
      console.log(`[MARKET] ${market.name}: ${marketOdds.length} odds encontradas`);
      
      for (const oddData of marketOdds) {
        if (oddData.odd >= config.oddRange.min && oddData.odd <= config.oddRange.max) {
          const marketType = this.determineMarketType(oddData.market, oddData.period);
          const selection = oddData.selection;
          const handicap = oddData.handicap;
          const selectionType = oddData.selectionType;
          
          // Calcular EV com todos os parâmetros necessários
          const evResult = market.calculateEV(
            stats, 
            oddData.odd, 
            marketType, 
            handicap, 
            selectionType
          );
          
          // Log detalhado para debugging
          console.log(`[EV CALC] ${market.name} - ${selection} @ ${oddData.odd}`);
          console.log(`  Probabilidade: ${(evResult.probability * 100).toFixed(1)}%`);
          console.log(`  EV: ${evResult.ev.toFixed(4)}`);
          
          if (evResult.ev > 0) {
            console.log(`[EV+] ${market.name} - ${selection} @ ${oddData.odd} - EV: ${evResult.ev.toFixed(4)}`);
            
            results.push({
              market: {
                id: market.id,
                name: market.name,
                type: marketType,
                selection: selection,
                selectionType: selectionType,
                handicap: handicap
              },
              odd: oddData.odd,
              ev: evResult.ev,
              probability: evResult.probability,
              details: evResult.details,
              statistics: this.prepareStatsForAI(stats),
              matchInfo: {
                fixtureId: matchData.match.fixtureId,
                teams: matchData.match.teams,
                minute: matchData.match.time.elapsed,
                score: matchData.match.score
              },
              rawOddData: {
                bookmaker: oddData.bookmaker,
                period: oddData.period,
                market: oddData.market
              }
            });
          }
        }
      }
    }
    
    return {
      eligible: true,
      minute: matchData.match.time.elapsed,
      results: results,
      totalMarketsAnalyzed: results.length,
      totalOddsAvailable: matchData.odds.length,
      apiCalls: matchData.apiCalls,
      cacheHit: false
    };
  }
  
  prepareStatsForAnalysis(matchData) {
    // CORREÇÃO: Usar dados reais da API, não fallbacks incorretos
    const stats = matchData.statistics;
    const events = matchData.events;
    
    return {
      match: {
        time: {
          elapsed: matchData.match.time.elapsed
        },
        score: matchData.match.score
      },
      corners: {
        total: stats.totals.corners,
        home: stats.home.corners,
        away: stats.away.corners
      },
      possession: {
        home: stats.home.possession,
        away: stats.away.possession
      },
      shots: {
        total: {
          onTarget: stats.totals.shotsOnGoal,
          offTarget: stats.totals.shotsOffGoal
        },
        home: {
          onTarget: stats.home.shotsOnGoal,
          offTarget: stats.home.shotsOffGoal
        },
        away: {
          onTarget: stats.away.shotsOnGoal,
          offTarget: stats.away.shotsOffGoal
        }
      },
      cards: {
        total: events.yellowCards + events.redCards,
        yellow: events.yellowCards,
        red: events.redCards
      },
      fouls: {
        total: stats.totals.fouls,
        home: stats.home.fouls,
        away: stats.away.fouls
      },
      xG: {
        home: stats.home.xG,
        away: stats.away.xG
      },
      teams: {
        home: {
          shotsOnTarget: stats.home.shotsOnGoal,
          shotsOffTarget: stats.home.shotsOffGoal
        },
        away: {
          shotsOnTarget: stats.away.shotsOnGoal,
          shotsOffTarget: stats.away.shotsOffGoal
        }
      }
    };
  }
  
  prepareStatsForAI(stats) {
    return {
      matchMinute: stats.match.time.elapsed,
      score: stats.match.score,
      possession: stats.possession,
      shots: stats.shots,
      corners: stats.corners,
      cards: stats.cards,
      fouls: stats.fouls,
      xG: stats.xG
    };
  }
  
  isMarketMatch(marketName, marketType, marketTypes) {
    const name = marketName.toLowerCase();
    const type = marketType.toLowerCase();
    
    if (type === 'escanteios') {
      return name.includes('corner') || name.includes('escanteio');
    } else if (type === 'gols') {
      return name.includes('goal') || name.includes('gol') || name.includes('goals') || 
             name.includes('over') || name.includes('under') || name.includes('btts') ||
             name.includes('both teams to score') || name.includes('ambas marcam');
    } else if (type === 'cartões') {
      return name.includes('card') || name.includes('cartão') || name.includes('yellow') || 
             name.includes('red') || name.includes('cartoes');
    } else if (type === 'vitória') {
      return name.includes('winner') || name.includes('vencedor') || name.includes('1x2') || 
             name.includes('match result') || name.includes('resultado');
    } else if (type === 'asiático') {
      return name.includes('handicap') || name.includes('asiatic') || name.includes('asian');
    }
    
    return false;
  }
  
  determineMarketType(marketName, period) {
    if (period === '1H') return '1T';
    if (period === '2H') return '2T';
    return 'Match';
  }
}

// ============================================
// PAYLOAD BUILDER PARA IA
// ============================================

class IAPayloadBuilder {
  static buildPayload(marketResults) {
    if (!marketResults || marketResults.length === 0) {
      return null;
    }
    
    // Ordenar por EV (maior primeiro)
    const sortedResults = marketResults.sort((a, b) => b.ev - a.ev);
    
    // Pegar o melhor resultado
    const bestMarket = sortedResults[0];
    
    return {
      recommendation: {
        market: bestMarket.market.name,
        type: bestMarket.market.type,
        selection: bestMarket.market.selection,
        selectionType: bestMarket.market.selectionType,
        handicap: bestMarket.market.handicap,
        odd: bestMarket.odd,
        ev: bestMarket.ev,
        probability: bestMarket.probability,
        confidence: this.calculateConfidence(bestMarket.ev, bestMarket.probability)
      },
      matchInfo: bestMarket.matchInfo,
      statistics: bestMarket.statistics,
      marketDetails: bestMarket.details,
      alternatives: sortedResults.slice(1, 3).map(r => ({
        market: r.market.name,
        selection: r.market.selection,
        odd: r.odd,
        ev: r.ev,
        probability: r.probability
      })),
      timestamp: new Date().toISOString(),
      analysisType: 'EV_BASED_ANALYSIS',
      validation: {
        evFormula: 'EV = (Probability × Odd) - 1',
        evCalculation: `${bestMarket.probability.toFixed(2)} × ${bestMarket.odd} - 1 = ${bestMarket.ev.toFixed(4)}`
      }
    };
  }
  
  static calculateConfidence(ev, probability) {
    if (ev > 0.2 && probability > 0.7) return 'HIGH';
    if (ev > 0.1 && probability > 0.6) return 'MEDIUM';
    if (ev > 0.05) return 'LOW';
    return 'MINIMAL';
  }
}

// ============================================
// ROTAS DO APP (COM ROTAS DE DEBUG E TESTE)
// ============================================

// Inicializar clientes
const apiClient = new ApiFootballClient(API_KEY);
const matchAnalyzer = new MatchAnalyzer(apiClient);
const marketAnalyzer = new MarketAnalyzer(matchAnalyzer);

// Rota para testar cálculo EV
app.get('/api/test-ev', (req, res) => {
  try {
    const results = validateEVCalculation();
    res.json({
      success: true,
      results,
      formula: 'EV = (Probability × Odd) - 1',
      tests: [
        { probability: 0.7, odd: 1.5, expected: 0.05 },
        { probability: 0.5, odd: 2.0, expected: 0.00 },
        { probability: 0.3, odd: 4.0, expected: 0.20 }
      ]
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Rota para validar mercado específico
app.get('/api/debug/market-calculation', async (req, res) => {
  try {
    const { market, probability, odd } = req.query;
    
    if (!market || !probability || !odd) {
      return res.status(400).json({
        error: 'Parâmetros necessários: market, probability, odd'
      });
    }
    
    const prob = parseFloat(probability);
    const oddValue = parseFloat(odd);
    const ev = (prob * oddValue) - 1;
    
    res.json({
      market,
      probability: prob,
      odd: oddValue,
      ev: ev.toFixed(4),
      recommendation: ev > 0 ? 'APOSTAR' : 'EVITAR',
      confidence: ev > 0.2 ? 'ALTA' : ev > 0.1 ? 'MÉDIA' : ev > 0 ? 'BAIXA' : 'NENHUMA'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Rota para listar jogos ao vivo
app.get('/api/live-matches', async (req, res) => {
  try {
    const leagueId = req.query.leagueId ? parseInt(req.query.leagueId) : null;
    const fixtures = await apiClient.getLiveFixtures(leagueId);
    
    const liveMatches = fixtures.map(f => ({
      fixtureId: f.fixture.id,
      league: {
        id: f.league.id,
        name: f.league.name,
        country: f.league.country
      },
      teams: {
        home: f.teams.home.name,
        away: f.teams.away.name,
        homeLogo: f.teams.home.logo,
        awayLogo: f.teams.away.logo
      },
      score: {
        home: f.goals.home,
        away: f.goals.away
      },
      time: {
        elapsed: f.fixture.status.elapsed,
        status: f.fixture.status.short
      },
      venue: f.fixture.venue?.name
    }));
    
    res.json({
      success: true,
      data: liveMatches,
      apiCalls: apiClient.getCallCount()
    });
    
  } catch (error) {
    console.error('Error fetching live matches:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch live matches',
      details: error.message
    });
  }
});

// Rota principal de análise
app.post('/api/analyze-match', async (req, res) => {
  try {
    const { fixtureId, markets } = req.body;
    
    if (!fixtureId) {
      return res.status(400).json({
        success: false,
        error: 'fixtureId is required'
      });
    }
    
    console.log(`[ROUTE] Análise solicitada para fixture ${fixtureId}`);
    
    // Resetar contador de chamadas
    apiClient.resetCallCount();
    
    // Analisar mercados
    const analysis = await marketAnalyzer.analyzeMarkets(
      fixtureId, 
      markets || Object.keys(MARKETS)
    );
    
    if (!analysis.eligible) {
      return res.json({
        success: true,
        eligible: false,
        message: analysis.message,
        minute: analysis.minute,
        apiCalls: analysis.apiCalls || apiClient.getCallCount()
      });
    }
    
    // Construir payload para IA
    const iaPayload = IAPayloadBuilder.buildPayload(analysis.results);
    
    res.json({
      success: true,
      eligible: true,
      minute: analysis.minute,
      totalOpportunities: analysis.results.length,
      totalOddsAvailable: analysis.totalOddsAvailable,
      apiCalls: analysis.apiCalls || apiClient.getCallCount(),
      results: analysis.results,
      iaPayload: iaPayload,
      message: iaPayload ? 
        `Encontradas ${analysis.results.length} oportunidades com EV positivo.` :
        'Nenhuma oportunidade com EV positivo encontrada.'
    });
    
  } catch (error) {
    console.error('Error analyzing match:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to analyze match',
      details: error.message,
      apiCalls: apiClient.getCallCount()
    });
  }
});

// Rota para obter estatísticas detalhadas
app.get('/api/match-stats/:fixtureId', async (req, res) => {
  try {
    const fixtureId = parseInt(req.params.fixtureId);
    
    const matchData = await matchAnalyzer.analyzeFixture(fixtureId);
    
    res.json({
      success: true,
      data: matchData,
      apiCalls: matchData.apiCalls
    });
    
  } catch (error) {
    console.error('Error fetching match stats:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch match statistics',
      details: error.message
    });
  }
});

// Rota de saúde do sistema
app.get('/api/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    config: {
      minGameMinute: config.minGameMinute,
      oddRange: config.oddRange,
      cacheDuration: config.cacheDuration,
      markets: Object.keys(MARKETS).map(key => MARKETS[key].name)
    },
    cacheStats: {
      cachedMatches: statsCache.size
    },
    evValidation: validateEVCalculation()
  });
});

// ============================================
// ROTAS DE DEBUG PARA DIAGNÓSTICO
// ============================================

// Rota para debug de odds
app.get('/api/debug/odds/:fixtureId', async (req, res) => {
  try {
    const fixtureId = parseInt(req.params.fixtureId);
    
    const oddsData = await apiClient.getLiveOdds(fixtureId);
    
    const analysis = {
      fixtureId,
      totalResponseGroups: oddsData.length,
      allMarkets: [],
      marketSummary: {},
      oddsInRange: []
    };
    
    oddsData.forEach((group, groupIndex) => {
      if (group.bookmakers) {
        group.bookmakers.forEach(bm => {
          bm.bets?.forEach(bet => {
            const marketName = bet.name || 'Unknown';
            
            if (!analysis.marketSummary[marketName]) {
              analysis.marketSummary[marketName] = {
                count: 0,
                minOdd: 999,
                maxOdd: 0,
                values: []
              };
            }
            
            bet.values?.forEach(value => {
              const oddValue = parseFloat(value.odd) || 0;
              analysis.marketSummary[marketName].count++;
              analysis.marketSummary[marketName].minOdd = Math.min(
                analysis.marketSummary[marketName].minOdd, 
                oddValue
              );
              analysis.marketSummary[marketName].maxOdd = Math.max(
                analysis.marketSummary[marketName].maxOdd, 
                oddValue
              );
              analysis.marketSummary[marketName].values.push({
                selection: value.value,
                odd: oddValue,
                handicap: value.handicap
              });
              
              if (oddValue >= config.oddRange.min && oddValue <= config.oddRange.max) {
                analysis.oddsInRange.push({
                  market: marketName,
                  selection: value.value,
                  odd: oddValue,
                  handicap: value.handicap,
                  bookmaker: bm.name
                });
              }
            });
          });
        });
      }
    });
    
    analysis.topMarkets = Object.entries(analysis.marketSummary)
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 10)
      .map(([name, data]) => ({
        market: name,
        count: data.count,
        oddRange: `${data.minOdd.toFixed(2)} - ${data.maxOdd.toFixed(2)}`,
        hasOddsInRange: data.minOdd <= config.oddRange.max && data.maxOdd >= config.oddRange.min
      }));
    
    res.json({
      success: true,
      analysis,
      config: {
        oddRange: config.oddRange,
        oddsInRangeCount: analysis.oddsInRange.length,
        oddsInRangeSample: analysis.oddsInRange.slice(0, 5)
      }
    });
    
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Rota para debug rápido de corners
app.get('/api/debug/corners/:fixtureId', async (req, res) => {
  try {
    const fixtureId = parseInt(req.params.fixtureId);
    const odds = await apiClient.getLiveOdds(fixtureId);
    
    const cornerOdds = [];
    
    odds.forEach(group => {
      if (group.bookmakers) {
        group.bookmakers.forEach(bm => {
          bm.bets?.forEach(bet => {
            const marketName = bet.name || '';
            if (marketName.toLowerCase().includes('corner') || 
                marketName.toLowerCase().includes('escanteio')) {
              
              bet.values?.forEach(value => {
                const oddValue = parseFloat(value.odd) || 0;
                
                cornerOdds.push({
                  bookmaker: bm.name,
                  market: marketName,
                  selection: value.value,
                  odd: oddValue,
                  handicap: value.handicap,
                  inRange: oddValue >= config.oddRange.min && oddValue <= config.oddRange.max
                });
              });
            }
          });
        });
      }
    });
    
    res.json({
      fixtureId,
      cornerOddsFound: cornerOdds.length,
      cornerOddsInRange: cornerOdds.filter(o => o.inRange).length,
      allCornerOdds: cornerOdds,
      range: config.oddRange
    });
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// INICIAR SERVIDOR
// ============================================

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
  console.log('============================================');
  console.log('MERCADOS CONFIGURADOS (CORRIGIDOS):');
  Object.values(MARKETS).forEach(market => {
    console.log(`- ${market.name}: ${market.types.join(', ')}`);
  });
  console.log('============================================');
  console.log(`ODD RANGE: ${config.oddRange.min} - ${config.oddRange.max}`);
  console.log(`TEMPO MÍNIMO: ${config.minGameMinute} minutos`);
  console.log('============================================');
  console.log('ROTAS DISPONÍVEIS:');
  console.log('GET  /api/health');
  console.log('GET  /api/test-ev');
  console.log('GET  /api/debug/market-calculation');
  console.log('GET  /api/live-matches');
  console.log('GET  /api/live-matches?leagueId=39');
  console.log('GET  /api/match-stats/:fixtureId');
  console.log('POST /api/analyze-match');
  console.log('GET  /api/debug/odds/:fixtureId');
  console.log('GET  /api/debug/corners/:fixtureId');
  console.log('============================================');
  
  // Validar cálculos EV ao iniciar
  console.log('🧮 Validando cálculos EV...');
  validateEVCalculation();
  console.log('============================================');
});
