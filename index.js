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
// MERCADOS DEFINIDOS (SEPARADOS E COMENTADOS)
// ============================================

const MARKETS = {
  // =================== ESCANTEIOS ===================
  CORNERS: {
    id: "corners",
    name: 'Escanteios',
    types: ['1T', '2T', 'Match', 'Team'],
    
    // REGRAS ESPECÍFICAS PARA ESCANTEIOS
    rules: {
      minCornersForAnalysis: 2,
      considerPossession: true,
      weightRecent: 0.7
    },
    
    // FÓRMULA EV PARA ESCANTEIOS
    calculateEV: (stats, odd, marketType) => {
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
        probability = Math.min(0.95, expectedCorners / 10); // Normalização
      }
      
      // Cálculo EV: (Probabilidade * Odd) - 1
      const ev = (probability * odd) - 1;
      return {
        ev,
        probability,
        details: {
          cornersNow,
          cornersPerMin,
          expectedCorners: cornersPerMin * minutesRemaining,
          marketType
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
    
    calculateEV: (stats, odd, marketType, handicap) => {
      const elapsed = stats.match.time.elapsed;
      const score = stats.match.score;
      const totalGoals = score.home + score.away;
      
      // Taxa de gols por minuto
      const goalsPerMin = totalGoals / Math.max(1, elapsed);
      const minutesRemaining = marketType === '1T' ? 45 - elapsed : 
                              marketType === '2T' ? 45 : 90 - elapsed;
      
      let probability = 0.5;
      
      // Modelo Poisson simplificado
      const lambda = goalsPerMin * minutesRemaining;
      
      if (marketType.includes('Over') && handicap) {
        const target = parseFloat(handicap);
        // Probabilidade de mais de X gols
        probability = 1 - Math.exp(-lambda);
        for (let i = 0; i <= target; i++) {
          probability -= (Math.pow(lambda, i) * Math.exp(-lambda)) / factorial(i);
        }
      } else if (marketType.includes('Under') && handicap) {
        const target = parseFloat(handicap);
        // Probabilidade de menos de X gols
        probability = 0;
        for (let i = 0; i <= target; i++) {
          probability += (Math.pow(lambda, i) * Math.exp(-lambda)) / factorial(i);
        }
      } else if (marketType === 'Both Teams to Score') {
        // Probabilidade simplificada de ambos marcarem
        const homeScoringProb = stats.teams.home.shotsOnTarget > 0 ? 0.6 : 0.3;
        const awayScoringProb = stats.teams.away.shotsOnTarget > 0 ? 0.6 : 0.3;
        probability = homeScoringProb * awayScoringProb;
      }
      
      const ev = (probability * odd) - 1;
      return {
        ev,
        probability,
        details: {
          totalGoals,
          goalsPerMin,
          expectedGoals: lambda,
          marketType,
          handicap
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
    
    calculateEV: (stats, odd, marketType, handicap) => {
      const elapsed = stats.match.time.elapsed;
      const cardsNow = stats.cards.total || 0;
      const foulsNow = stats.fouls.total || 0;
      
      // Taxa de cartões por minuto
      const cardsPerMin = cardsNow / Math.max(1, elapsed);
      const foulsPerMin = foulsNow / Math.max(1, elapsed);
      
      const minutesRemaining = marketType === '1T' ? 45 - elapsed : 
                              marketType === '2T' ? 45 : 90 - elapsed;
      
      // Probabilidade baseada em intensidade
      let probability = 0.3; // Base
      probability += cardsPerMin * 0.2;
      probability += foulsPerMin * 0.1;
      probability = Math.min(0.9, probability);
      
      const ev = (probability * odd) - 1;
      return {
        ev,
        probability,
        details: {
          cardsNow,
          foulsNow,
          cardsPerMin,
          expectedCards: cardsPerMin * minutesRemaining,
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
    
    calculateEV: (stats, odd, marketType, selection) => {
      const elapsed = stats.match.time.elapsed;
      const score = stats.match.score;
      const possession = stats.possession;
      const shots = stats.shots;
      
      // Análise baseada em momentum atual
      let probability = 0.5;
      
      // Fator posse de bola
      if (selection === 'home') {
        probability += (possession.home - 50) * 0.005;
      } else if (selection === 'away') {
        probability += (possession.away - 50) * 0.005;
      }
      
      // Fator chutes ao gol
      if (selection === 'home') {
        probability += (shots.home.onTarget * 0.02);
      } else if (selection === 'away') {
        probability += (shots.away.onTarget * 0.02);
      }
      
      // Fator placar atual
      const goalDiff = score.home - score.away;
      if (selection === 'home' && goalDiff > 0) {
        probability += goalDiff * 0.1;
      } else if (selection === 'away' && goalDiff < 0) {
        probability += Math.abs(goalDiff) * 0.1;
      }
      
      // Vantagem de mando de campo
      if (selection === 'home' && marketType === 'Match') {
        probability += 0.1;
      }
      
      probability = Math.max(0.1, Math.min(0.9, probability));
      
      const ev = (probability * odd) - 1;
      return {
        ev,
        probability,
        details: {
          score,
          possession,
          shotsOnTarget: shots.total.onTarget,
          marketType,
          selection
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
    
    calculateEV: (stats, odd, marketType, handicap) => {
      const elapsed = stats.match.time.elapsed;
      const score = stats.match.score;
      const possession = stats.possession;
      const xG = stats.xG;
      
      const handicapValue = parseFloat(handicap);
      const effectiveScore = score.home - score.away - handicapValue;
      
      let probability = 0.5;
      
      // Baseado em xG e posse
      const xGDiff = xG.home - xG.away;
      probability += xGDiff * 0.15;
      
      // Baseado em posse
      probability += (possession.home - 50) * 0.003;
      
      // Ajuste pelo handicap
      probability -= handicapValue * 0.1;
      
      // Fator tempo
      const timeFactor = elapsed / 90;
      probability += (effectiveScore > 0 ? 0.2 : -0.2) * timeFactor;
      
      probability = Math.max(0.1, Math.min(0.9, probability));
      
      const ev = (probability * odd) - 1;
      return {
        ev,
        probability,
        details: {
          score,
          handicap: handicapValue,
          effectiveScore,
          xGDiff,
          possessionDiff: possession.home - possession.away,
          marketType
        }
      };
    }
  }
};

// ============================================
// FUNÇÕES AUXILIARES
// ============================================

function factorial(n) {
  if (n === 0 || n === 1) return 1;
  let result = 1;
  for (let i = 2; i <= n; i++) result *= i;
  return result;
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
// ANALISADOR DE JOGOS (COM PROCESSODDS CORRIGIDO)
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
    
    // Processar odds (COM A CORREÇÃO)
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
    
    return {
      home: {
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
      },
      away: {
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
      },
      totals: {
        shotsOnGoal: 0,
        shotsOffGoal: 0,
        totalShots: 0,
        corners: 0,
        fouls: 0,
        yellowCards: 0,
        redCards: 0,
        offsides: 0
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
  
  // ============================================
  // CORREÇÃO CRÍTICA: processOdds CORRIGIDO
  // ============================================
  
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
              
              // DETECTAR TODOS OS MERCADOS RELEVANTES (CORREÇÃO AQUI)
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
              
              // DETERMINAR PERÍODO
              let period = 'Match';
              if (marketLower.includes('1st') || marketLower.includes('1st half') || marketLower.includes('first half')) {
                period = '1H';
              } else if (marketLower.includes('2nd') || marketLower.includes('2nd half') || marketLower.includes('second half')) {
                period = '2H';
              }
              
              // PROCESSAR VALORES
              if (bet.values && Array.isArray(bet.values)) {
                bet.values.forEach(value => {
                  const oddValue = parseFloat(value.odd) || 0;
                  
                  // FILTRAR POR RANGE 1.40-2.00 (CONDIÇÃO DO SEU SISTEMA)
                  if (oddValue >= config.oddRange.min && oddValue <= config.oddRange.max) {
                    
                    const selection = String(value.value || '').trim();
                    const selectionLower = selection.toLowerCase();
                    
                    // DETECTAR TIPO DE SELEÇÃO
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
                      // Informações para debug
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
      
      // Formato B: Odds diretas (formato alternativo da API)
      if (oddGroup.odds && Array.isArray(oddGroup.odds)) {
        oddGroup.odds.forEach(bet => {
          const marketName = String(bet.name || '').trim();
          const marketLower = marketName.toLowerCase();
          
          // Mesma lógica de detecção
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
    
    // Log para debug
    if (markets.length > 0) {
      console.log('[ODDS SAMPLE] Primeiros mercados encontrados:');
      markets.slice(0, 3).forEach((m, i) => {
        console.log(`  ${i+1}. ${m.market} - ${m.selection} @ ${m.odd} (${m.period})`);
      });
    } else {
      console.log('[ODDS PROCESSOR] Nenhum mercado encontrado no range especificado');
      console.log('[ODDS PROCESSOR] Verificando se há odds fora do range...');
      
      // Debug: contar total de odds disponíveis
      let totalOdds = 0;
      odds.forEach(oddGroup => {
        if (oddGroup.bookmakers) {
          oddGroup.bookmakers.forEach(bm => {
            bm.bets?.forEach(bet => {
              totalOdds += bet.values?.length || 0;
            });
          });
        }
      });
      console.log(`[ODDS DEBUG] Total de odds disponíveis (qualquer valor): ${totalOdds}`);
    }
    
    return markets;
  }
}

// ============================================
// ANALISADOR DE MERCADOS (ATUALIZADO)
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
    
    // 3. Preparar estatísticas para cálculo (com fallback para eventos)
    const stats = this.prepareStatsForAnalysis(matchData);
    
    // 4. Analisar cada mercado
    const results = [];
    
    for (const marketKey of marketsToCheck) {
      const market = MARKETS[marketKey];
      console.log(`[MARKET] Analisando mercado: ${market.name}`);
      
      // Filtrar odds para este mercado (CORREÇÃO MELHORADA)
      const marketOdds = matchData.odds.filter(odd => 
        this.isMarketMatch(odd.market, market.name, market.types)
      );
      
      console.log(`[MARKET] ${market.name}: ${marketOdds.length} odds encontradas`);
      
      for (const oddData of marketOdds) {
        // Já está filtrado por range de odds, mas verificamos novamente
        if (oddData.odd >= config.oddRange.min && oddData.odd <= config.oddRange.max) {
          
          // Determinar tipo de mercado e seleção
          const marketType = this.determineMarketType(oddData.market, oddData.period);
          const selection = oddData.selection;
          const handicap = oddData.handicap;
          const selectionType = oddData.selectionType;
          
          // Calcular EV específico do mercado
          const evResult = market.calculateEV(stats, oddData.odd, marketType, handicap, selectionType);
          
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
    // Usar eventos como fallback quando estatísticas estão zeradas
    const events = matchData.events;
    
    return {
      match: {
        time: {
          elapsed: matchData.match.time.elapsed
        },
        score: {
          home: matchData.match.score.home,
          away: matchData.match.score.away
        }
      },
      corners: {
        total: matchData.statistics.totals.corners > 0 ? matchData.statistics.totals.corners : events.corners,
        home: matchData.statistics.home.corners,
        away: matchData.statistics.away.corners
      },
      possession: {
        home: matchData.statistics.home.possession,
        away: matchData.statistics.away.possession
      },
      shots: {
        total: {
          onTarget: matchData.statistics.totals.shotsOnGoal > 0 ? 
            matchData.statistics.totals.shotsOnGoal : 0,
          offTarget: matchData.statistics.totals.shotsOffGoal > 0 ? 
            matchData.statistics.totals.shotsOffGoal : 0
        },
        home: {
          onTarget: matchData.statistics.home.shotsOnGoal,
          offTarget: matchData.statistics.home.shotsOffGoal
        },
        away: {
          onTarget: matchData.statistics.away.shotsOnGoal,
          offTarget: matchData.statistics.away.shotsOffGoal
        }
      },
      cards: {
        total: matchData.events.yellowCards + matchData.events.redCards,
        yellow: matchData.events.yellowCards,
        red: matchData.events.redCards
      },
      fouls: {
        total: matchData.statistics.totals.fouls > 0 ? matchData.statistics.totals.fouls : 0,
        home: matchData.statistics.home.fouls,
        away: matchData.statistics.away.fouls
      },
      xG: {
        home: matchData.statistics.home.xG,
        away: matchData.statistics.away.xG
      }
    };
  }
  
  prepareStatsForAI(stats) {
    // Preparar estatísticas para envio à IA
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
  
  // CORREÇÃO: Função melhorada para detectar mercados
  isMarketMatch(marketName, marketType, marketTypes) {
    const name = marketName.toLowerCase();
    const type = marketType.toLowerCase();
    
    // Verificar se o nome do mercado contém palavras-chave do tipo
    if (type === 'escanteios') {
      return name.includes('corner') || name.includes('escanteio');
    } else if (type === 'gols') {
      return name.includes('goal') || name.includes('gol') || name.includes('goals') || 
             name.includes('over') || name.includes('under') || name.includes('btts');
    } else if (type === 'cartões') {
      return name.includes('card') || name.includes('cartão') || name.includes('yellow') || name.includes('red');
    } else if (type === 'vitória') {
      return name.includes('winner') || name.includes('vencedor') || name.includes('1x2') || 
             name.includes('match result');
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
        probability: bestMarket.probability
      },
      matchInfo: bestMarket.matchInfo,
      statistics: bestMarket.statistics,
      marketDetails: bestMarket.details,
      alternatives: sortedResults.slice(1, 3).map(r => ({
        market: r.market.name,
        selection: r.market.selection,
        odd: r.odd,
        ev: r.ev
      })),
      timestamp: new Date().toISOString(),
      analysisType: 'EV_BASED_ANALYSIS'
    };
  }
}

// ============================================
// ROTAS DO APP (COM ROTAS DE DEBUG)
// ============================================

// Inicializar clientes
const apiClient = new ApiFootballClient(API_KEY);
const matchAnalyzer = new MatchAnalyzer(apiClient);
const marketAnalyzer = new MarketAnalyzer(matchAnalyzer);

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
        `Encontradas ${analysis.results.length} oportunidades. Payload pronto para IA.` :
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
    }
  });
});

// ============================================
// ROTAS DE DEBUG PARA DIAGNÓSTICO
// ============================================

// Rota para debug de odds (ver estrutura completa)
app.get('/api/debug/odds/:fixtureId', async (req, res) => {
  try {
    const fixtureId = parseInt(req.params.fixtureId);
    
    // Buscar odds diretamente
    const oddsData = await apiClient.getLiveOdds(fixtureId);
    
    // Análise detalhada
    const analysis = {
      fixtureId,
      totalResponseGroups: oddsData.length,
      allMarkets: [],
      marketSummary: {},
      oddsInRange: []
    };
    
    // Processar todas as odds
    oddsData.forEach((group, groupIndex) => {
      if (group.bookmakers) {
        group.bookmakers.forEach(bm => {
          bm.bets?.forEach(bet => {
            const marketName = bet.name || 'Unknown';
            
            // Adicionar ao resumo
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
              
              // Verificar se está no range
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
    
    // Top 10 mercados por quantidade
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
  console.log('MERCADOS CONFIGURADOS:');
  Object.values(MARKETS).forEach(market => {
    console.log(`- ${market.name}: ${market.types.join(', ')}`);
  });
  console.log('============================================');
  console.log(`ODD RANGE: ${config.oddRange.min} - ${config.oddRange.max}`);
  console.log(`TEMPO MÍNIMO: ${config.minGameMinute} minutos`);
  console.log('============================================');
  console.log('ROTAS DISPONÍVEIS:');
  console.log('GET  /api/health');
  console.log('GET  /api/live-matches');
  console.log('GET  /api/live-matches?leagueId=39');
  console.log('GET  /api/match-stats/:fixtureId');
  console.log('POST /api/analyze-match');
  console.log('GET  /api/debug/odds/:fixtureId');
  console.log('GET  /api/debug/corners/:fixtureId');
  console.log('============================================');
});
