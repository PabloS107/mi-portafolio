// ============================================================================
// DASHBOARD DE INVERSIONES — LOGICA FINANCIERA, XIRR, GRAFICOS Y GESTION
// ============================================================================

let state = {
  sheetId: "13QoyWvgekHxJSeWj6fsxn4MOekdYI_X_jLe1odB_lxU",
  lastSync: "",
  precioMep: 1405.5,
  benchmarks: {},
  portafolio: [],
  movimientos: [],
  rentaFija: [],
  serieComparacion: [],
  // Historical series cache from /api/history
  historySeries: {}, // { TICKER: { 'YYYY-MM-DD': closePrice } }
  historyNames: {},  // { TICKER: 'Short Name' }
  // UI state
  activeTab: "total",
  onlyReportFilter: true,
  centralPeriod: "ALL", // 'ALL' | 'YTD' | '6M' | '3M' | '1M'
  activeBenchmarks: ["SPY", "QQQ"], // currently visible on central chart
  customBenchmarks: [], // extra ETFs added via search box
  rankingMode: "pct", // 'pct' | 'usd' | 'xirr'
  selectedTicker: "GOOGL"
};

// Known CEDEAR ratios from user's sheet for convenience
const KNOWN_META = {
  "AAPL": { sector: "Tecnologico", ratio: 20 },
  "AMZN": { sector: "Tecnologico", ratio: 144 },
  "GOOGL": { sector: "Tecnologico", ratio: 58 },
  "META": { sector: "Tecnologico", ratio: 24 },
  "MSFT": { sector: "Tecnologico", ratio: 30 },
  "NVDA": { sector: "Tecnologico", ratio: 24 },
  "MELI": { sector: "Ecomerce", ratio: 120 },
  "BRK.B": { sector: "Finanzas", ratio: 22 },
  "MA": { sector: "Finanzas", ratio: 33 },
  "NU": { sector: "Finanzas", ratio: 2 },
  "PAM": { sector: "Oil", ratio: 25 },
  "VIST": { sector: "Oil", ratio: 3 },
  "YPF": { sector: "Oil", ratio: 1 },
  "NFLX": { sector: "Servicio tecnologico", ratio: 48 },
  "UBER": { sector: "Transporte", ratio: 2 },
  "DECK": { sector: "Consumo Ciclico", ratio: 25 },
  "EVVTY": { sector: "Casino", ratio: 1 },
  "LLY": { sector: "Salud", ratio: 56 },
  "SPY": { sector: "Indice", ratio: 60 },
  "QQQ": { sector: "Indice", ratio: 20 },
  "XNAS": { sector: "Indice", ratio: null },
  "SPYL": { sector: "Indice", ratio: null },
  "CURRENCY:BTCUSD": { sector: "Crypto", ratio: null }
};

const SECTOR_COLORS = {
  "tecnologico": "#10b981",
  "ecomerce": "#f59e0b",
  "crypto": "#f97316",
  "finanzas": "#3b82f6",
  "indice": "#6366f1",
  "oil": "#eab308",
  "transporte": "#06b6d4",
  "consumo ciclico": "#ec4899",
  "casino": "#a855f7",
  "cacino": "#a855f7",
  "salud": "#14b8a6",
  "servicio tecnologico": "#8b5cf6"
};

const BENCHMARK_PALETTE = {
  "SPY": "#3b82f6",
  "QQQ": "#a855f7"
};
const EXTRA_ETF_COLORS = ["#f59e0b", "#06b6d4", "#ec4899", "#eab308", "#14b8a6", "#f97316"];

let chartCentral = null;
let chartRanking = null;
let chartSector = null;
let chartWeights = null;
let chartEvolution = null;
let chartSelectedAsset = null;
let etfSearchTimeout = null;

// ============================================================================
// 1. INITIALIZATION & DATA LOADING
// ============================================================================
// Puedes pegar tu URL de Google Apps Script aquí para que quede fija en todos tus dispositivos:
const DEFAULT_APPS_SCRIPT_URL = "";

function getAppsScriptUrl() {
  return localStorage.getItem("inversiones_apps_script_url") || DEFAULT_APPS_SCRIPT_URL;
}

document.addEventListener("DOMContentLoaded", async () => {
  lucide.createIcons();
  document.getElementById("formFecha").value = new Date().toISOString().slice(0, 10);
  updateCloudBadgeUI();

  document.addEventListener("click", (e) => {
    const drop = document.getElementById("etfSearchResultsDropdown");
    const inp = document.getElementById("etfSearchInput");
    if (drop && !drop.contains(e.target) && e.target !== inp) {
      drop.classList.add("hidden");
    }
  });

  await loadData();
  await loadHistorySeries();
});

async function loadData() {
  const gasUrl = getAppsScriptUrl();
  if (gasUrl) {
    try {
      const res = await fetch(`${gasUrl}?action=get_data`);
      if (res.ok) {
        const cloudData = await res.json();
        if (cloudData && cloudData.movimientos) {
          applyLoadedData(cloudData);
          return;
        }
      }
    } catch (e) {
      console.warn("Aviso al leer Apps Script, usando respaldo:", e);
    }
  }

  try {
    const res = await fetch("/api/data");
    if (res.ok) {
      const serverData = await res.json();
      applyLoadedData(serverData);
      return;
    }
  } catch (e) {
    // Fallback for GitHub Pages static hosting
  }

  const cached = localStorage.getItem("inversiones_dashboard_data");
  if (cached) {
    applyLoadedData(JSON.parse(cached));
    return;
  }

  try {
    const resStatic = await fetch("./data.json");
    if (resStatic.ok) {
      const staticData = await resStatic.json();
      applyLoadedData(staticData);
    }
  } catch (e) {
    console.warn("No se pudo cargar ./data.json:", e);
  }
}

async function loadHistorySeries(extraTickers = [], forceRefresh = false) {
  const portfolioTickers = state.portafolio.map(p => p.ticker);
  const allTickers = Array.from(new Set([
    ...portfolioTickers,
    "SPY",
    "QQQ",
    ...state.customBenchmarks,
    ...extraTickers
  ]));

  // 1. Try local Python server /api/history first
  try {
    const url = `/api/history?tickers=${encodeURIComponent(allTickers.join(","))}${forceRefresh ? "&refresh=1" : ""}`;
    const res = await fetch(url);
    if (res.ok) {
      const payload = await res.json();
      state.historySeries = { ...state.historySeries, ...(payload.series || {}) };
      state.historyNames = { ...state.historyNames, ...(payload.names || {}) };
      renderCentralPerformanceChart();
      return;
    }
  } catch (e) {
    // Running on GitHub Pages (static mode)
  }

  // 2. Load static ./history_cache.json bundled in the GitHub repository
  if (Object.keys(state.historySeries).length === 0) {
    try {
      const resCache = await fetch("./history_cache.json");
      if (resCache.ok) {
        const cacheData = await resCache.json();
        state.historySeries = { ...state.historySeries, ...(cacheData.series || {}) };
        state.historyNames = { ...state.historyNames, ...(cacheData.names || {}) };
      }
    } catch (e) {
      console.warn("No se encontró ./history_cache.json:", e);
    }
  }

  // 3. Fetch any missing extra tickers via Apps Script or CORS proxy
  const gasUrl = getAppsScriptUrl();
  for (const tk of extraTickers) {
    const tUp = tk.toUpperCase();
    if (state.historySeries[tUp] && Object.keys(state.historySeries[tUp]).length > 0 && !forceRefresh) continue;
    try {
      if (gasUrl) {
        const r = await fetch(`${gasUrl}?action=history&ticker=${encodeURIComponent(tUp)}`);
        if (r.ok) {
          const d = await r.json();
          if (d.series) state.historySeries[tUp] = d.series;
        }
      } else {
        const yf = tUp === "CURRENCY:BTCUSD" ? "BTC-USD" : (tUp === "BRK.B" ? "BRK-B" : tUp);
        const target = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yf)}?interval=1d&range=2y`;
        const r = await fetch(`https://corsproxy.io/?${encodeURIComponent(target)}`);
        if (r.ok) {
          const payload = await r.json();
          const res0 = payload.chart.result[0];
          const ts = res0.timestamp || [];
          const closes = res0.indicators.quote[0].close || [];
          const series = {};
          let lastV = null;
          ts.forEach((tSec, idx) => {
            if (closes[idx] != null && closes[idx] > 0) lastV = Number(closes[idx].toFixed(4));
            if (lastV != null) {
              const dtStr = new Date(tSec * 1000).toISOString().slice(0, 10);
              series[dtStr] = lastV;
            }
          });
          state.historySeries[tUp] = series;
        }
      }
    } catch (err) {
      console.warn("No se pudo obtener serie para", tUp, err);
    }
  }

  renderCentralPerformanceChart();
}

function applyLoadedData(data) {
  state.sheetId = data.sheetId || state.sheetId;
  state.lastSync = data.lastSync || new Date().toLocaleString();
  state.precioMep = Number(data.precioMep) || 1405.5;
  state.benchmarks = data.benchmarks || {};
  state.portafolio = data.portafolio || [];
  state.movimientos = data.movimientos || [];
  state.serieComparacion = data.serieComparacion || [];

  state.movimientos.forEach((m, i) => {
    if (!m.id) m.id = `mov-${i}-${Date.now()}`;
    m.ticker = String(m.ticker || "").trim().toUpperCase();
    m.sector = normalizeSectorName(m.sector);
    if (m.cedears && m.ratio) {
      KNOWN_META[m.ticker] = { sector: m.sector, ratio: Number(m.ratio) };
    }
  });

  recalculatePortfolio();
  if (!state.selectedTicker && state.portafolio.length > 0) {
    state.selectedTicker = state.portafolio[0].ticker;
  }
  renderAll();
}

async function saveData() {
  localStorage.setItem("inversiones_dashboard_data", JSON.stringify(state));
  try {
    const res = await fetch("/api/data", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sheetId: state.sheetId,
        precioMep: state.precioMep,
        benchmarks: state.benchmarks,
        portafolio: state.portafolio,
        movimientos: state.movimientos,
        rentaFija: state.rentaFija,
        serieComparacion: state.serieComparacion
      })
    });
    if (res.ok) {
      const out = await res.json();
      if (out.lastSync) {
        state.lastSync = out.lastSync;
        document.getElementById("lastSyncLabel").textContent = `Guardado: ${state.lastSync}`;
      }
    }
  } catch (e) {
    console.warn("Guardado solo en navegador:", e);
  }
}

function normalizeSectorName(raw) {
  if (!raw) return "Otro";
  const s = String(raw).trim();
  const low = s.toLowerCase();
  if (low === "tecnologico" || low === "tecnológico") return "Tecnologico";
  if (low === "finanzas") return "Finanzas";
  if (low === "oil") return "Oil";
  if (low === "ecomerce" || low === "ecommerce") return "Ecomerce";
  if (low === "cacino" || low === "casino") return "Casino";
  if (low === "indice" || low === "índice") return "Indice";
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ============================================================================
// 2. FINANCIAL ENGINE: PORTFOLIO RECALCULATION & XIRR SOLVER
// ============================================================================
function computeXIRR(cashflows, fallbackRate = 0) {
  if (!cashflows || cashflows.length < 2) return fallbackRate;
  const valid = cashflows.filter(c => Number.isFinite(c.amount) && c.amount !== 0 && c.date instanceof Date && !isNaN(c.date));
  if (valid.length < 2) return fallbackRate;

  const hasPos = valid.some(c => c.amount > 0);
  const hasNeg = valid.some(c => c.amount < 0);
  if (!hasPos || !hasNeg) return fallbackRate;

  valid.sort((a, b) => a.date - b.date);
  const t0 = valid[0].date.getTime();
  const days = valid.map(c => (c.date.getTime() - t0) / (1000 * 3600 * 24 * 365.0));

  const maxYears = Math.max(...days);
  if (maxYears < 0.02) return fallbackRate;

  function npv(rate) {
    let sum = 0;
    for (let i = 0; i < valid.length; i++) {
      sum += valid[i].amount / Math.pow(1 + rate, days[i]);
    }
    return sum;
  }

  function dnpv(rate) {
    let sum = 0;
    for (let i = 0; i < valid.length; i++) {
      if (days[i] !== 0) {
        sum -= (days[i] * valid[i].amount) / Math.pow(1 + rate, days[i] + 1);
      }
    }
    return sum;
  }

  let rate = 0.15;
  for (let iter = 0; iter < 60; iter++) {
    const y = npv(rate);
    if (Math.abs(y) < 1e-6) return rate;
    const dy = dnpv(rate);
    if (Math.abs(dy) < 1e-10) break;
    let nextRate = rate - y / dy;
    if (nextRate <= -0.99) nextRate = -0.95;
    if (nextRate > 10) nextRate = 10;
    if (Math.abs(nextRate - rate) < 1e-6) return nextRate;
    rate = nextRate;
  }

  return Number.isFinite(rate) ? rate : fallbackRate;
}

function recalculatePortfolio() {
  const existingMap = {};
  state.portafolio.forEach(p => {
    const t = String(p.ticker).trim().toUpperCase();
    existingMap[t] = p;
  });

  const movByTicker = {};
  state.movimientos.forEach(m => {
    const t = String(m.ticker).trim().toUpperCase();
    if (!movByTicker[t]) movByTicker[t] = [];
    movByTicker[t].push(m);
  });

  const allTickers = new Set([...Object.keys(existingMap), ...Object.keys(movByTicker)]);
  const updatedPortfolio = [];
  const today = new Date();

  allTickers.forEach(ticker => {
    const movs = movByTicker[ticker] || [];
    const prev = existingMap[ticker] || {};

    let tenencia = 0;
    let totalInvertido = 0;
    let sector = prev.sector || (KNOWN_META[ticker] && KNOWN_META[ticker].sector) || "Otro";
    let ratio = (KNOWN_META[ticker] && KNOWN_META[ticker].ratio) || null;

    const cashflows = [];

    if (movs.length > 0) {
      movs.forEach(m => {
        const cant = Number(m.cantidad) || 0;
        const inv = Math.abs(Number(m.invertido) || (cant * Number(m.precioCompra)));
        tenencia += cant;
        totalInvertido += inv;
        if (m.sector) sector = normalizeSectorName(m.sector);
        if (m.ratio) ratio = Number(m.ratio);
        const dt = m.fecha ? new Date(m.fecha + "T00:00:00") : new Date();
        cashflows.push({ amount: -inv, date: dt });
      });
    } else if (prev.tenencia > 0) {
      tenencia = Number(prev.tenencia);
      totalInvertido = tenencia * Number(prev.ppc || 0);
    }

    if (tenencia <= 1e-9) return;

    const ppc = tenencia > 0 ? totalInvertido / tenencia : 0;
    const precioHoy = Number(prev.precioHoy) > 0 ? Number(prev.precioHoy) : ppc;
    const valorMercado = tenencia * precioHoy;
    const gananciaUsd = valorMercado - totalInvertido;
    const gananciaPct = ppc > 0 ? (precioHoy - ppc) / ppc : 0;

    cashflows.push({ amount: valorMercado, date: today });
    const computedXirr = movs.length > 0 ? computeXIRR(cashflows, prev.anualizado || gananciaPct) : (prev.anualizado || gananciaPct);
    const incluirEnReporte = prev.incluirEnReporte !== undefined ? Boolean(prev.incluirEnReporte) : true;

    updatedPortfolio.push({
      ticker,
      sector: normalizeSectorName(sector),
      ratio,
      tenencia,
      ppc,
      invertido: totalInvertido,
      precioHoy,
      valorMercado,
      gananciaUsd,
      gananciaPct,
      anualizado: computedXirr,
      pesoCartera: 0,
      incluirEnReporte,
      movimientosCount: movs.length
    });
  });

  const totalMarketAll = updatedPortfolio.reduce((acc, p) => acc + p.valorMercado, 0);
  updatedPortfolio.forEach(p => {
    p.pesoCartera = totalMarketAll > 0 ? p.valorMercado / totalMarketAll : 0;
  });

  state.portafolio = updatedPortfolio;
}

function getFilteredPortfolio() {
  return state.portafolio.filter(p => p.incluirEnReporte);
}

// ============================================================================
// 3. RENDER ALL VIEWS, ASSET SELECTOR CHIPS & KPIS
// ============================================================================
function renderAll() {
  document.getElementById("lastSyncLabel").textContent = `Sincronizado: ${state.lastSync}`;
  document.getElementById("navMovCount").textContent = state.movimientos.length;

  renderTotalAssetSelector();
  renderTopKPIs();
  renderCentralPerformanceChart();
  renderTotalViewCharts();
  populateSectorFilterDropdown();
  renderAssetViews();
  renderMovimientosTable();
  lucide.createIcons();
}

function renderTotalAssetSelector() {
  const container = document.getElementById("totalAssetSelectorChips");
  const badge = document.getElementById("activeFilterSummaryBadge");
  const activeCount = state.portafolio.filter(p => p.incluirEnReporte).length;
  if (badge) {
    badge.textContent = `${activeCount} / ${state.portafolio.length} activos`;
  }
  if (!container) return;

  const sorted = [...state.portafolio].sort((a, b) => b.valorMercado - a.valorMercado);
  container.innerHTML = sorted.map(p => {
    const active = p.incluirEnReporte;
    const shortName = p.ticker.replace("CURRENCY:", "");
    return `
      <button
        onclick="toggleAssetReport('${p.ticker}', ${!active})"
        class="flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-xs font-mono-num transition select-none ${
          active
            ? "bg-emerald-500/15 border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/25"
            : "bg-slate-900/60 border-slate-800 text-slate-500 hover:text-slate-300 line-through"
        }"
        title="${active ? "Incluido en el cálculo total (clic para excluir)" : "Excluido del cálculo total (clic para incluir)"}"
      >
        <span class="text-[10px]">${active ? "✓" : "✕"}</span>
        <span class="font-semibold">${shortName}</span>
      </button>
    `;
  }).join("");
}

function presetAssetSelection(mode) {
  state.portafolio.forEach(p => {
    const sec = p.sector.toLowerCase();
    const isBtc = p.ticker.includes("BTC") || sec === "crypto";
    const isIndex = sec === "indice" || ["SPY", "QQQ", "XNAS", "SPYL"].includes(p.ticker);

    if (mode === "all") {
      p.incluirEnReporte = true;
    } else if (mode === "no_btc") {
      p.incluirEnReporte = !isBtc;
    } else if (mode === "no_indices") {
      p.incluirEnReporte = !isBtc && !isIndex;
    }
  });
  saveData();
  renderAll();
  const label = mode === "all" ? "Todos los activos incluidos" : (mode === "no_btc" ? "BTC / Crypto excluido del cálculo" : "Solo acciones individuales (sin BTC ni índices)");
  showToast(label);
}

function renderTopKPIs() {
  const activeList = getFilteredPortfolio();

  const totalValue = activeList.reduce((s, p) => s + p.valorMercado, 0);
  const totalInvested = activeList.reduce((s, p) => s + (p.invertido ?? (p.tenencia * p.ppc)), 0);

  const totalGainUsd = totalValue - totalInvested;
  const totalReturnPct = totalInvested > 0 ? (totalValue / totalInvested) - 1 : 0;

  const activeTickers = new Set(activeList.map(p => p.ticker));
  const portfolioCashflows = [];
  let minDateStr = "2025-03-26";
  let minDateObj = new Date("2099-01-01");

  state.movimientos.forEach(m => {
    if (activeTickers.has(m.ticker)) {
      const dt = new Date(m.fecha + "T00:00:00");
      if (dt < minDateObj) {
        minDateObj = dt;
        minDateStr = m.fecha;
      }
      portfolioCashflows.push({ amount: -Math.abs(m.invertido), date: dt });
    }
  });
  portfolioCashflows.push({ amount: totalValue, date: new Date() });
  const portfolioXirr = computeXIRR(portfolioCashflows, state.benchmarks["TIR CARTERA"] || totalReturnPct);

  const winners = activeList.filter(p => p.gananciaPct >= 0).length;
  const losers = activeList.filter(p => p.gananciaPct < 0).length;

  const sortedByPct = [...activeList].sort((a, b) => b.gananciaPct - a.gananciaPct);
  const sortedByVal = [...activeList].sort((a, b) => b.valorMercado - a.valorMercado);

  const best = sortedByPct[0];
  const worst = sortedByPct[sortedByPct.length - 1];
  const largest = sortedByVal[0];

  document.getElementById("kpiTotalValue").textContent = formatUsd(totalValue);
  document.getElementById("kpiTotalArs").textContent = `≈ $${Math.round(totalValue * state.precioMep).toLocaleString("es-AR")} ARS`;
  document.getElementById("kpiActiveAssetsCount").textContent = `${activeList.length} activos`;

  document.getElementById("kpiTotalInvested").textContent = formatUsd(totalInvested);
  document.getElementById("kpiFirstDate").textContent = activeList.length > 0 ? minDateStr : "—";

  const gainEl = document.getElementById("kpiTotalGainUsd");
  gainEl.textContent = (totalGainUsd >= 0 ? "+" : "") + formatUsd(totalGainUsd);
  gainEl.className = `text-2xl font-bold font-mono-num ${totalGainUsd >= 0 ? "text-emerald-400" : "text-rose-400"}`;

  document.getElementById("kpiWinLossCount").innerHTML = `<span class="text-emerald-400">${winners} ▲</span> / <span class="text-rose-400">${losers} ▼</span>`;

  const retEl = document.getElementById("kpiTotalReturnPct");
  retEl.textContent = formatPct(totalReturnPct, true);
  retEl.className = `text-2xl font-bold font-mono-num ${totalReturnPct >= 0 ? "text-emerald-400" : "text-rose-400"}`;

  const xirrEl = document.getElementById("kpiPortfolioXirr");
  xirrEl.textContent = formatPct(portfolioXirr, true);
  xirrEl.className = `font-mono-num font-semibold ${portfolioXirr >= 0 ? "text-indigo-400" : "text-rose-400"}`;

  document.getElementById("kpiBestAsset").textContent = best ? `${best.ticker.replace("CURRENCY:", "")} (${formatPct(best.gananciaPct, true)})` : "—";
  document.getElementById("kpiWorstAsset").textContent = worst ? `${worst.ticker.replace("CURRENCY:", "")} (${formatPct(worst.gananciaPct, true)})` : "—";
  document.getElementById("kpiLargestPosition").textContent = largest
    ? `${largest.ticker.replace("CURRENCY:", "")} (${formatPct(totalValue > 0 ? largest.valorMercado / totalValue : 0, false)})`
    : "—";
}

// ============================================================================
// 4. CENTRAL PERFORMANCE CHART: MI CARTERA VS SPY, QQQ & CUSTOM ETFs
// ============================================================================
function setCentralPeriod(period) {
  state.centralPeriod = period;
  ["ALL", "YTD", "6M", "3M", "1M"].forEach(p => {
    const btn = document.getElementById(`btnPeriod-${p}`);
    if (btn) {
      btn.className = p === period
        ? "px-2.5 py-1 rounded-md bg-emerald-600 text-white font-semibold transition"
        : "px-2.5 py-1 rounded-md text-slate-400 hover:text-white transition";
    }
  });
  renderCentralPerformanceChart();
}

function toggleBenchmarkLine(symbol) {
  const sym = symbol.toUpperCase();
  if (state.activeBenchmarks.includes(sym)) {
    state.activeBenchmarks = state.activeBenchmarks.filter(s => s !== sym);
  } else {
    state.activeBenchmarks.push(sym);
  }
  renderCentralPerformanceChart();
}

function removeCustomBenchmark(symbol, event) {
  if (event) event.stopPropagation();
  const sym = symbol.toUpperCase();
  state.customBenchmarks = state.customBenchmarks.filter(s => s !== sym);
  state.activeBenchmarks = state.activeBenchmarks.filter(s => s !== sym);
  renderCentralPerformanceChart();
}

function renderBenchmarkChips() {
  const container = document.getElementById("benchmarkChipsContainer");
  if (!container) return;

  const allBench = ["SPY", "QQQ", ...state.customBenchmarks];
  container.innerHTML = allBench.map((sym, idx) => {
    const isActive = state.activeBenchmarks.includes(sym);
    const color = BENCHMARK_PALETTE[sym] || EXTRA_ETF_COLORS[idx % EXTRA_ETF_COLORS.length];
    const isCustom = !["SPY", "QQQ"].includes(sym);
    return `
      <button
        onclick="toggleBenchmarkLine('${sym}')"
        class="flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-xs font-mono-num font-semibold transition ${
          isActive
            ? "bg-slate-800 border-slate-600 text-white shadow-sm"
            : "bg-slate-900/50 border-slate-800 text-slate-500"
        }"
      >
        <span class="w-2.5 h-2.5 rounded-full inline-block" style="background:${isActive ? color : "#475569"}"></span>
        <span>${sym}</span>
        ${isCustom ? `<span onclick="removeCustomBenchmark('${sym}', event)" class="ml-1 text-slate-400 hover:text-rose-400" title="Quitar ETF">✕</span>` : ""}
      </button>
    `;
  }).join("");
}

function getPriceOnOrBefore(ticker, dateStr, sortedDatesCache) {
  const series = state.historySeries[ticker];
  if (!series) return null;
  if (series[dateStr] !== undefined) return series[dateStr];
  // Binary or backward search for closest prior date
  const dates = sortedDatesCache[ticker] || Object.keys(series).sort();
  sortedDatesCache[ticker] = dates;
  if (dates.length === 0) return null;
  if (dateStr <= dates[0]) return series[dates[0]];
  let lo = 0, hi = dates.length - 1, best = dates[0];
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (dates[mid] <= dateStr) {
      best = dates[mid];
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return series[best];
}

function renderCentralPerformanceChart() {
  renderBenchmarkChips();
  const canvas = document.getElementById("chartCentralPerformance");
  if (!canvas) return;

  const activeAssets = getFilteredPortfolio();
  const activeTickers = new Set(activeAssets.map(p => p.ticker));
  const activeMovs = state.movimientos
    .filter(m => activeTickers.has(m.ticker))
    .sort((a, b) => (a.fecha || "").localeCompare(b.fecha || ""));

  // Determine start date and end date based on state.centralPeriod
  const spySeries = state.historySeries["SPY"] || {};
  const availableDates = Object.keys(spySeries).sort();

  const todayStr = availableDates.length > 0
    ? availableDates[availableDates.length - 1]
    : new Date().toISOString().slice(0, 10);

  let firstMovDate = activeMovs.length > 0 ? activeMovs[0].fecha : "2025-03-26";
  let startDate = firstMovDate;
  const endObj = new Date(todayStr + "T00:00:00");

  if (state.centralPeriod === "YTD") {
    startDate = `${endObj.getFullYear()}-01-01`;
  } else if (state.centralPeriod === "6M") {
    const d = new Date(endObj);
    d.setMonth(d.getMonth() - 6);
    startDate = d.toISOString().slice(0, 10);
  } else if (state.centralPeriod === "3M") {
    const d = new Date(endObj);
    d.setMonth(d.getMonth() - 3);
    startDate = d.toISOString().slice(0, 10);
  } else if (state.centralPeriod === "1M") {
    const d = new Date(endObj);
    d.setMonth(d.getMonth() - 1);
    startDate = d.toISOString().slice(0, 10);
  }

  if (startDate < firstMovDate) {
    startDate = firstMovDate;
  }

  // Build timeline of dates in [startDate, todayStr]
  let timeline = availableDates.filter(d => d >= startDate && d <= todayStr);
  if (timeline.length === 0) {
    // Fallback to serieComparacion if historySeries not loaded yet
    timeline = state.serieComparacion.map(r => r.fecha);
  }
  // Downsample to ~80 points max if very long so chart is super crisp and fast
  if (timeline.length > 90) {
    const step = Math.ceil(timeline.length / 80);
    const sampled = [];
    for (let i = 0; i < timeline.length - 1; i += step) {
      sampled.push(timeline[i]);
    }
    sampled.push(timeline[timeline.length - 1]);
    timeline = sampled;
  }

  const sortedDatesCache = {};
  const currentPriceMap = {};
  activeAssets.forEach(p => {
    currentPriceMap[p.ticker] = p.precioHoy;
  });

  // Compute Portfolio Cumulative Return (%) series over timeline
  // At startDate: compute initial holdings (from movs <= startDate)
  const isAllPeriod = state.centralPeriod === "ALL" || startDate <= firstMovDate;
  const tStartMs = new Date(startDate + "T00:00:00").getTime();

  // Pre-calculate initial holdings before startDate if period is YTD/6M/3M/1M
  const initHoldings = {};
  if (!isAllPeriod) {
    activeMovs.forEach(m => {
      if (m.fecha <= startDate) {
        initHoldings[m.ticker] = (initHoldings[m.ticker] || 0) + Number(m.cantidad || 0);
      }
    });
  }

  let vInicio = 0;
  if (!isAllPeriod) {
    Object.entries(initHoldings).forEach(([tk, qty]) => {
      const p0 = getPriceOnOrBefore(tk, startDate, sortedDatesCache) || currentPriceMap[tk] || 0;
      vInicio += qty * p0;
    });
  }

  const portfolioPctSeries = timeline.map((dtStr, idx) => {
    const isLastPoint = idx === timeline.length - 1;
    const tCurrMs = new Date(dtStr + "T00:00:00").getTime();
    const totalSpanDays = Math.max(1, (tCurrMs - tStartMs) / (1000 * 3600 * 24));

    if (isAllPeriod) {
      // Total cumulative ROI up to dtStr: (MarketValue(t) - Invested(t)) / Invested(t)
      let valAtT = 0;
      let invAtT = 0;
      const holdingsAtT = {};

      activeMovs.forEach(m => {
        if (m.fecha <= dtStr) {
          holdingsAtT[m.ticker] = (holdingsAtT[m.ticker] || 0) + Number(m.cantidad || 0);
          invAtT += Math.abs(Number(m.invertido || 0));
        }
      });

      Object.entries(holdingsAtT).forEach(([tk, qty]) => {
        const px = isLastPoint
          ? (currentPriceMap[tk] || getPriceOnOrBefore(tk, dtStr, sortedDatesCache) || 0)
          : (getPriceOnOrBefore(tk, dtStr, sortedDatesCache) || currentPriceMap[tk] || 0);
        valAtT += qty * px;
      });

      if (invAtT <= 0) return 0;
      return Number((((valAtT / invAtT) - 1) * 100).toFixed(2));
    } else {
      // Sub-period Modified Dietz return from startDate to dtStr
      const holdingsAtT = { ...initHoldings };
      let newCap = 0;
      let weightedNewCap = 0;

      activeMovs.forEach(m => {
        if (m.fecha > startDate && m.fecha <= dtStr) {
          holdingsAtT[m.ticker] = (holdingsAtT[m.ticker] || 0) + Number(m.cantidad || 0);
          const c = Math.abs(Number(m.invertido || 0));
          newCap += c;
          const mMs = new Date(m.fecha + "T00:00:00").getTime();
          const daysHeld = Math.max(0, (tCurrMs - mMs) / (1000 * 3600 * 24));
          const w = Math.min(1, daysHeld / totalSpanDays);
          weightedNewCap += c * w;
        }
      });

      let valAtT = 0;
      Object.entries(holdingsAtT).forEach(([tk, qty]) => {
        const px = isLastPoint
          ? (currentPriceMap[tk] || getPriceOnOrBefore(tk, dtStr, sortedDatesCache) || 0)
          : (getPriceOnOrBefore(tk, dtStr, sortedDatesCache) || currentPriceMap[tk] || 0);
        valAtT += qty * px;
      });

      const gainPeriod = valAtT - vInicio - newCap;
      const denom = vInicio + weightedNewCap;
      if (denom <= 0) return 0;
      return Number(((gainPeriod / denom) * 100).toFixed(2));
    }
  });

  // Build Benchmark Datasets (SPY, QQQ, Custom ETFs)
  const benchmarkDatasets = [];
  const summaryStats = [];

  const portfolioFinalPct = portfolioPctSeries.length > 0 ? portfolioPctSeries[portfolioPctSeries.length - 1] : 0;
  summaryStats.push({
    symbol: "MI CARTERA",
    name: `${activeAssets.length} activos medidos`,
    pct: portfolioFinalPct,
    color: "#10b981",
    isPortfolio: true
  });

  const allBench = ["SPY", "QQQ", ...state.customBenchmarks];
  allBench.forEach((sym, idx) => {
    if (!state.activeBenchmarks.includes(sym)) return;
    const color = BENCHMARK_PALETTE[sym] || EXTRA_ETF_COLORS[idx % EXTRA_ETF_COLORS.length];
    const p0 = getPriceOnOrBefore(sym, timeline[0] || startDate, sortedDatesCache);
    if (!p0 || p0 <= 0) return;

    const seriesPct = timeline.map(dtStr => {
      const pt = getPriceOnOrBefore(sym, dtStr, sortedDatesCache) || p0;
      return Number((((pt / p0) - 1) * 100).toFixed(2));
    });

    const finalBenchPct = seriesPct.length > 0 ? seriesPct[seriesPct.length - 1] : 0;
    summaryStats.push({
      symbol: sym,
      name: state.historyNames[sym] || sym,
      pct: finalBenchPct,
      diff: portfolioFinalPct - finalBenchPct,
      color,
      isPortfolio: false
    });

    benchmarkDatasets.push({
      label: `${sym} (${finalBenchPct >= 0 ? "+" : ""}${finalBenchPct.toFixed(2)}%)`,
      data: seriesPct,
      borderColor: color,
      backgroundColor: "transparent",
      borderWidth: 2,
      borderDash: sym === "SPY" ? [5, 4] : (sym === "QQQ" ? [3, 3] : []),
      pointRadius: 0,
      pointHoverRadius: 5,
      tension: 0.25
    });
  });

  // Render Summary Cards above Central Chart
  const cardsEl = document.getElementById("centralComparisonSummaryCards");
  if (cardsEl) {
    cardsEl.innerHTML = summaryStats.map(st => {
      const isPos = st.pct >= 0;
      if (st.isPortfolio) {
        return `
          <div class="bg-emerald-950/25 border border-emerald-500/40 rounded-xl p-3">
            <div class="flex items-center justify-between">
              <span class="text-xs font-bold text-emerald-300">${st.symbol}</span>
              <span class="w-2.5 h-2.5 rounded-full bg-emerald-400"></span>
            </div>
            <div class="text-xl font-bold font-mono-num ${isPos ? "text-emerald-400" : "text-rose-400"} mt-1">
              ${isPos ? "+" : ""}${st.pct.toFixed(2)}%
            </div>
            <div class="text-[11px] text-slate-400 truncate mt-0.5">${st.name} (${startDate} → Hoy)</div>
          </div>
        `;
      }
      const diffPos = st.diff >= 0;
      return `
        <div class="bg-slate-900/90 border border-slate-800 rounded-xl p-3">
          <div class="flex items-center justify-between">
            <span class="text-xs font-bold text-white font-mono-num">${st.symbol}</span>
            <span class="w-2.5 h-2.5 rounded-full" style="background:${st.color}"></span>
          </div>
          <div class="text-xl font-bold font-mono-num ${isPos ? "text-emerald-400" : "text-rose-400"} mt-1">
            ${isPos ? "+" : ""}${st.pct.toFixed(2)}%
          </div>
          <div class="text-[11px] font-mono-num mt-0.5 ${diffPos ? "text-emerald-400" : "text-amber-400"}">
            Vs Cartera: ${diffPos ? "+" : ""}${st.diff.toFixed(2)}%
          </div>
        </div>
      `;
    }).join("");
  }

  // Draw Chart.js Line Chart
  const ctx = canvas.getContext("2d");
  if (chartCentral) chartCentral.destroy();
  chartCentral = new Chart(ctx, {
    type: "line",
    data: {
      labels: timeline,
      datasets: [
        {
          label: `Mi Cartera (${portfolioFinalPct >= 0 ? "+" : ""}${portfolioFinalPct.toFixed(2)}%)`,
          data: portfolioPctSeries,
          borderColor: "#10b981",
          backgroundColor: "rgba(16, 185, 129, 0.14)",
          borderWidth: 3,
          pointRadius: 0,
          pointHoverRadius: 6,
          fill: true,
          tension: 0.25
        },
        ...benchmarkDatasets
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        mode: "index",
        intersect: false
      },
      plugins: {
        legend: {
          position: "top",
          labels: {
            color: "#e2e8f0",
            font: { family: "JetBrains Mono", size: 11 },
            usePointStyle: true
          }
        },
        tooltip: {
          callbacks: {
            label: (ctx) => `${ctx.dataset.label.split(" (")[0]}: ${ctx.parsed.y >= 0 ? "+" : ""}${ctx.parsed.y.toFixed(2)}%`
          }
        }
      },
      scales: {
        x: {
          ticks: { color: "#94a3b8", font: { family: "JetBrains Mono", size: 10 }, maxTicksLimit: 10 },
          grid: { display: false }
        },
        y: {
          ticks: {
            color: "#94a3b8",
            font: { family: "JetBrains Mono", size: 11 },
            callback: v => `${v >= 0 ? "+" : ""}${v}%`
          },
          grid: { color: "rgba(51, 65, 85, 0.35)" }
        }
      }
    }
  });
}

// ETF Search & Autocomplete functions
function onEtfSearchInput(val) {
  clearTimeout(etfSearchTimeout);
  const q = String(val || "").trim();
  const drop = document.getElementById("etfSearchResultsDropdown");
  if (q.length < 1) {
    drop.classList.add("hidden");
    return;
  }
  etfSearchTimeout = setTimeout(async () => {
    try {
      let results = null;
      // 1. Try local Python server
      try {
        const res = await fetch(`/api/etf-search?q=${encodeURIComponent(q)}`);
        if (res.ok) {
          const data = await res.json();
          results = data.results;
        }
      } catch (e) {}

      // 2. Try Google Apps Script if configured
      if (!results) {
        const gasUrl = getAppsScriptUrl();
        if (gasUrl) {
          try {
            const res = await fetch(`${gasUrl}?action=etf_search&q=${encodeURIComponent(q)}`);
            if (res.ok) {
              const data = await res.json();
              results = data.results;
            }
          } catch (e) {}
        }
      }

      // 3. Fallback for GitHub Pages: query Yahoo Finance search via CORS proxy
      if (!results) {
        try {
          const yUrl = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=10&newsCount=0`;
          const res = await fetch(`https://corsproxy.io/?${encodeURIComponent(yUrl)}`);
          if (res.ok) {
            const data = await res.json();
            results = (data.quotes || [])
              .filter(item => item.symbol && ["ETF", "EQUITY", "INDEX", "MUTUALFUND", "CRYPTOCURRENCY"].includes(item.quoteType))
              .slice(0, 8)
              .map(item => ({
                symbol: item.symbol,
                name: item.shortname || item.longname || item.symbol,
                type: item.quoteType || "ETF",
                exchange: item.exchDisp || item.exchange || ""
              }));
          }
        } catch (e) {}
      }

      if (!results || results.length === 0) {
        drop.innerHTML = `<div class="p-3 text-slate-400">Presiona Enter para buscar "${q.toUpperCase()}"</div>`;
        drop.classList.remove("hidden");
        return;
      }
      drop.innerHTML = results.map(r => `
        <button
          type="button"
          onclick="addCustomBenchmark('${r.symbol}')"
          class="w-full text-left px-3 py-2 hover:bg-slate-800 flex items-center justify-between gap-2 transition"
        >
          <div>
            <span class="font-mono-num font-bold text-emerald-400">${r.symbol}</span>
            <span class="text-slate-300 ml-1.5">${r.name}</span>
          </div>
          <span class="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-400 border border-slate-700">${r.type}</span>
        </button>
      `).join("");
      drop.classList.remove("hidden");
    } catch (e) {
      console.warn("Error searching ETF:", e);
    }
  }, 220);
}

function onEtfSearchKeydown(event) {
  if (event.key === "Enter") {
    event.preventDefault();
    addCustomEtfFromInput();
  }
}

function addCustomEtfFromInput() {
  const inp = document.getElementById("etfSearchInput");
  const sym = String(inp?.value || "").trim().toUpperCase();
  if (!sym) return;
  addCustomBenchmark(sym);
}

async function addCustomBenchmark(symbol) {
  const sym = String(symbol || "").trim().toUpperCase();
  if (!sym) return;
  document.getElementById("etfSearchResultsDropdown")?.classList.add("hidden");
  const inp = document.getElementById("etfSearchInput");
  if (inp) inp.value = "";

  if (!["SPY", "QQQ"].includes(sym) && !state.customBenchmarks.includes(sym)) {
    state.customBenchmarks.push(sym);
  }
  if (!state.activeBenchmarks.includes(sym)) {
    state.activeBenchmarks.push(sym);
  }

  showToast(`Cargando serie histórica de ${sym}...`);
  await loadHistorySeries([sym]);
  if (state.historySeries[sym] && Object.keys(state.historySeries[sym]).length > 0) {
    showToast(`${sym} agregado a la comparación.`);
  } else {
    state.customBenchmarks = state.customBenchmarks.filter(s => s !== sym);
    state.activeBenchmarks = state.activeBenchmarks.filter(s => s !== sym);
    renderCentralPerformanceChart();
    showToast(`No se encontró serie histórica para "${sym}".`, "error");
  }
}

// ============================================================================
// 5. SECONDARY CHARTS IN TAB 1: RANKING, SECTOR, WEIGHTS, CASHFLOW
// ============================================================================
function renderTotalViewCharts() {
  const activeList = getFilteredPortfolio();

  // 1. Asset Ranking Chart
  const ctxRank = document.getElementById("chartAssetRanking").getContext("2d");
  const sortedForRank = [...activeList].sort((a, b) => {
    if (state.rankingMode === "usd") return b.gananciaUsd - a.gananciaUsd;
    if (state.rankingMode === "xirr") return b.anualizado - a.anualizado;
    return b.gananciaPct - a.gananciaPct;
  });

  const labelsRank = sortedForRank.map(p => p.ticker.replace("CURRENCY:", ""));
  const dataRank = sortedForRank.map(p => {
    if (state.rankingMode === "usd") return Number(p.gananciaUsd.toFixed(2));
    if (state.rankingMode === "xirr") return Number((p.anualizado * 100).toFixed(2));
    return Number((p.gananciaPct * 100).toFixed(2));
  });
  const colorsRank = dataRank.map(v => v >= 0 ? "rgba(16, 185, 129, 0.85)" : "rgba(244, 63, 94, 0.85)");

  if (chartRanking) chartRanking.destroy();
  chartRanking = new Chart(ctxRank, {
    type: "bar",
    data: {
      labels: labelsRank,
      datasets: [{
        label: state.rankingMode === "usd" ? "Ganancia USD ($)" : (state.rankingMode === "xirr" ? "TIR Anualizada (%)" : "Rendimiento (%)"),
        data: dataRank,
        backgroundColor: colorsRank,
        borderRadius: 5
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      onClick: (_, elements) => {
        if (elements && elements.length > 0) {
          const idx = elements[0].index;
          inspectAsset(sortedForRank[idx].ticker);
        }
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const p = sortedForRank[ctx.dataIndex];
              return [
                `Rendimiento: ${formatPct(p.gananciaPct, true)}`,
                `Ganancia USD: ${formatUsd(p.gananciaUsd)}`,
                `Valor Actual: ${formatUsd(p.valorMercado)}`,
                `TIR Anual (XIRR): ${formatPct(p.anualizado, true)}`
              ];
            }
          }
        }
      },
      scales: {
        x: {
          ticks: { color: "#94a3b8", font: { family: "JetBrains Mono", size: 11 } },
          grid: { display: false }
        },
        y: {
          ticks: {
            color: "#94a3b8",
            font: { family: "JetBrains Mono", size: 11 },
            callback: (val) => state.rankingMode === "usd" ? `$${val}` : `${val}%`
          },
          grid: { color: "rgba(51, 65, 85, 0.35)" }
        }
      }
    }
  });

  // 2. Sector Allocation Doughnut
  const sectorTotals = {};
  let totalVal = 0;
  activeList.forEach(p => {
    const sec = normalizeSectorName(p.sector);
    sectorTotals[sec] = (sectorTotals[sec] || 0) + p.valorMercado;
    totalVal += p.valorMercado;
  });

  const sortedSectors = Object.entries(sectorTotals).sort((a, b) => b[1] - a[1]);
  const secLabels = sortedSectors.map(s => s[0]);
  const secValues = sortedSectors.map(s => Number(s[1].toFixed(2)));
  const secColors = secLabels.map((s, i) => SECTOR_COLORS[s.toLowerCase()] || `hsl(${(i * 47) % 360}, 70%, 55%)`);

  const ctxSec = document.getElementById("chartSectorAllocation").getContext("2d");
  if (chartSector) chartSector.destroy();
  chartSector = new Chart(ctxSec, {
    type: "doughnut",
    data: {
      labels: secLabels,
      datasets: [{
        data: secValues,
        backgroundColor: secColors,
        borderColor: "#0f172a",
        borderWidth: 2
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: "66%",
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const v = ctx.raw;
              const pct = totalVal > 0 ? (v / totalVal) * 100 : 0;
              return ` ${ctx.label}: ${formatUsd(v)} (${pct.toFixed(1)}%)`;
            }
          }
        }
      }
    }
  });

  const legendEl = document.getElementById("sectorLegendList");
  legendEl.innerHTML = sortedSectors.map(([secName, val], i) => {
    const pct = totalVal > 0 ? (val / totalVal) * 100 : 0;
    return `
      <div class="flex items-center justify-between py-1 px-2 rounded hover:bg-slate-800/50">
        <div class="flex items-center gap-2">
          <span class="w-2.5 h-2.5 rounded-full inline-block" style="background:${secColors[i]}"></span>
          <span class="text-slate-200 font-medium">${secName}</span>
        </div>
        <div class="font-mono-num text-slate-300">
          <span>${formatUsd(val)}</span>
          <span class="text-slate-500 ml-1">(${pct.toFixed(1)}%)</span>
        </div>
      </div>
    `;
  }).join("");

  // 3. Asset Weights Bar Chart
  const sortedByWeight = [...activeList].sort((a, b) => b.valorMercado - a.valorMercado);
  const ctxW = document.getElementById("chartAssetWeights").getContext("2d");
  if (chartWeights) chartWeights.destroy();
  chartWeights = new Chart(ctxW, {
    type: "bar",
    data: {
      labels: sortedByWeight.map(p => p.ticker.replace("CURRENCY:", "")),
      datasets: [{
        label: "Valor Mercado (USD)",
        data: sortedByWeight.map(p => Number(p.valorMercado.toFixed(2))),
        backgroundColor: "rgba(99, 102, 241, 0.8)",
        borderRadius: 4
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      onClick: (_, elements) => {
        if (elements && elements.length > 0) {
          inspectAsset(sortedByWeight[elements[0].index].ticker);
        }
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const p = sortedByWeight[ctx.dataIndex];
              const pct = totalVal > 0 ? (p.valorMercado / totalVal) * 100 : 0;
              return `Valor: ${formatUsd(p.valorMercado)} (${pct.toFixed(2)}% de la selección)`;
            }
          }
        }
      },
      scales: {
        x: {
          ticks: { color: "#94a3b8", font: { family: "JetBrains Mono", size: 10 } },
          grid: { display: false }
        },
        y: {
          ticks: { color: "#94a3b8", font: { family: "JetBrains Mono", size: 11 }, callback: v => `$${v}` },
          grid: { color: "rgba(51, 65, 85, 0.35)" }
        }
      }
    }
  });

  // 4. Evolution of Cumulative Capital Invested vs Current Market Value
  const ctxEvo = document.getElementById("chartEvolution").getContext("2d");
  if (chartEvolution) chartEvolution.destroy();

  const activeTickers = new Set(activeList.map(p => p.ticker));
  const sortedMovs = [...state.movimientos]
    .filter(m => activeTickers.has(m.ticker))
    .sort((a, b) => (a.fecha || "").localeCompare(b.fecha || ""));

  const monthlyMap = {};
  let runningTotal = 0;
  sortedMovs.forEach(m => {
    const ym = (m.fecha || "2025-04").slice(0, 7);
    runningTotal += Math.abs(m.invertido || 0);
    monthlyMap[ym] = Number(runningTotal.toFixed(2));
  });

  const months = Object.keys(monthlyMap);
  const cumValues = Object.values(monthlyMap);

  chartEvolution = new Chart(ctxEvo, {
    type: "line",
    data: {
      labels: [...months, "Valor Hoy"],
      datasets: [{
        label: "Capital Invertido Acumulado USD vs Valor Mercado Hoy",
        data: [...cumValues, Number(totalVal.toFixed(2))],
        borderColor: "#10b981",
        backgroundColor: "rgba(16, 185, 129, 0.15)",
        pointBackgroundColor: [...cumValues.map(() => "#38bdf8"), "#10b981"],
        pointRadius: [...cumValues.map(() => 4), 7],
        fill: true,
        tension: 0.25
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { labels: { color: "#cbd5e1", font: { size: 11 } } }
      },
      scales: {
        x: { ticks: { color: "#94a3b8", font: { family: "JetBrains Mono", size: 10 } }, grid: { display: false } },
        y: { ticks: { color: "#94a3b8", font: { family: "JetBrains Mono", size: 11 }, callback: v => `$${v}` }, grid: { color: "rgba(51, 65, 85, 0.35)" } }
      }
    }
  });
}

function setRankingMode(mode) {
  state.rankingMode = mode;
  document.getElementById("btnRankPct").className = mode === "pct" ? "px-2.5 py-1 rounded-md bg-emerald-600 text-white font-medium transition" : "px-2.5 py-1 rounded-md text-slate-400 hover:text-white transition";
  document.getElementById("btnRankUsd").className = mode === "usd" ? "px-2.5 py-1 rounded-md bg-emerald-600 text-white font-medium transition" : "px-2.5 py-1 rounded-md text-slate-400 hover:text-white transition";
  document.getElementById("btnRankXirr").className = mode === "xirr" ? "px-2.5 py-1 rounded-md bg-emerald-600 text-white font-medium transition" : "px-2.5 py-1 rounded-md text-slate-400 hover:text-white transition";
  renderTotalViewCharts();
}

// ============================================================================
// 6. VIEW 2: RENDIMIENTO POR ACTIVO SEPARADO (DEEP DIVE & POSITIONS TABLE)
// ============================================================================
function populateSectorFilterDropdown() {
  const select = document.getElementById("sectorFilterSelect");
  const currentVal = select.value || "ALL";
  const sectors = Array.from(new Set(state.portafolio.map(p => normalizeSectorName(p.sector)))).sort();
  select.innerHTML = `<option value="ALL">Todos los sectores (${state.portafolio.length})</option>` +
    sectors.map(s => `<option value="${s}">${s}</option>`).join("");
  if (sectors.includes(currentVal)) select.value = currentVal;
}

function inspectAsset(ticker) {
  state.selectedTicker = ticker;
  switchTab("activos");
  renderAssetViews();
}

function renderAssetViews() {
  const query = (document.getElementById("assetSearchInput")?.value || "").trim().toLowerCase();
  const sectorFilter = document.getElementById("sectorFilterSelect")?.value || "ALL";

  const filtered = state.portafolio.filter(p => {
    const matchSearch = !query || p.ticker.toLowerCase().includes(query) || p.sector.toLowerCase().includes(query);
    const matchSector = sectorFilter === "ALL" || normalizeSectorName(p.sector) === sectorFilter;
    return matchSearch && matchSector;
  });

  if (!state.portafolio.some(p => p.ticker === state.selectedTicker) && state.portafolio.length > 0) {
    state.selectedTicker = state.portafolio[0].ticker;
  }

  const pillsEl = document.getElementById("assetPillsContainer");
  pillsEl.innerHTML = filtered.map(p => {
    const isSel = p.ticker === state.selectedTicker;
    const isPos = p.gananciaPct >= 0;
    return `
      <button onclick="selectAssetPill('${p.ticker}')" class="flex-shrink-0 flex items-center gap-2 px-3.5 py-2 rounded-xl border text-xs font-mono-num transition ${
        isSel
          ? "bg-emerald-500/20 border-emerald-500 text-white shadow-md shadow-emerald-950/50"
          : "bg-slate-900/90 border-slate-800 text-slate-300 hover:border-slate-700"
      }">
        <span class="font-bold">${p.ticker.replace("CURRENCY:", "")}</span>
        <span class="${isPos ? "text-emerald-400" : "text-rose-400"} font-semibold">${formatPct(p.gananciaPct, true)}</span>
      </button>
    `;
  }).join("");

  renderSelectedAssetDetail();
  renderPortfolioTable(filtered);
}

function selectAssetPill(ticker) {
  state.selectedTicker = ticker;
  renderAssetViews();
}

function renderSelectedAssetDetail() {
  const panel = document.getElementById("selectedAssetPanel");
  const asset = state.portafolio.find(p => p.ticker === state.selectedTicker);
  if (!asset) {
    panel.innerHTML = `<p class="text-sm text-slate-400">Selecciona un activo para ver su rendimiento detallado.</p>`;
    return;
  }

  const assetMovs = state.movimientos
    .filter(m => m.ticker === asset.ticker)
    .sort((a, b) => (a.fecha || "").localeCompare(b.fecha || ""));

  const totalCedears = asset.ratio ? (asset.tenencia * asset.ratio) : null;
  const isGain = asset.gananciaUsd >= 0;

  panel.innerHTML = `
    <div class="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-4">
      <div class="flex items-center gap-3">
        <div class="w-12 h-12 rounded-2xl bg-gradient-to-br from-slate-800 to-slate-900 border border-slate-700 flex items-center justify-center font-mono-num font-bold text-emerald-400 text-sm">
          ${asset.ticker.replace("CURRENCY:", "").slice(0, 5)}
        </div>
        <div>
          <div class="flex items-center gap-2.5">
            <h3 class="text-xl font-bold text-white font-mono-num">${asset.ticker}</h3>
            <span class="text-xs px-2.5 py-0.5 rounded-full bg-slate-800 text-sky-400 border border-slate-700 font-medium">${asset.sector}</span>
            ${asset.ratio ? `<span class="text-xs px-2.5 py-0.5 rounded-full bg-indigo-500/10 text-indigo-300 border border-indigo-500/30 font-mono-num">Ratio CEDEAR ${asset.ratio}:1</span>` : ""}
          </div>
          <p class="text-xs text-slate-400 mt-1">
            Tenencia: <strong class="text-white font-mono-num">${asset.tenencia.toFixed(6)}</strong> unidades
            ${totalCedears !== null ? `(<strong class="text-emerald-400 font-mono-num">${Number(totalCedears.toFixed(2))} CEDEARs</strong>)` : ""}
            • Peso en cartera total: <strong class="text-sky-400 font-mono-num">${formatPct(asset.pesoCartera, false)}</strong>
          </p>
        </div>
      </div>

      <div class="flex flex-wrap items-center gap-2">
        <button onclick="openAddModal('${asset.ticker}')" class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600/20 hover:bg-emerald-600/30 text-emerald-300 border border-emerald-500/30 text-xs font-semibold transition">
          <i data-lucide="plus" class="w-3.5 h-3.5"></i>
          <span>Agregar Compra de ${asset.ticker.replace("CURRENCY:", "")}</span>
        </button>
        <button onclick="deleteEntireAsset('${asset.ticker}')" class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-rose-500/15 hover:bg-rose-500/25 text-rose-300 border border-rose-500/30 text-xs font-semibold transition">
          <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>
          <span>Quitar Activo</span>
        </button>
      </div>
    </div>

    <div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
      <div class="bg-slate-950/70 border border-slate-800/80 rounded-xl p-3">
        <span class="text-[11px] uppercase text-slate-400 block">PPC Promedio</span>
        <span class="text-base font-bold font-mono-num text-white mt-1 block">${formatUsd(asset.ppc)}</span>
        <span class="text-[11px] text-slate-500">${assetMovs.length} compras</span>
      </div>

      <div class="bg-slate-950/70 border border-slate-800/80 rounded-xl p-3">
        <span class="text-[11px] uppercase text-slate-400 block">Precio Hoy (Editable)</span>
        <div class="flex items-center gap-1 mt-1">
          <span class="text-slate-400 font-mono-num text-sm">$</span>
          <input type="number" step="any" value="${Number(asset.precioHoy.toFixed(4))}" onchange="updateAssetPrice('${asset.ticker}', this.value)" class="w-full bg-slate-900 border border-slate-700 rounded px-2 py-0.5 text-sm font-bold font-mono-num text-amber-300 focus:outline-none focus:border-emerald-500" />
        </div>
        <span class="text-[11px] text-slate-500">Cotización actual USD</span>
      </div>

      <div class="bg-slate-950/70 border border-slate-800/80 rounded-xl p-3">
        <span class="text-[11px] uppercase text-slate-400 block">Total Invertido</span>
        <span class="text-base font-bold font-mono-num text-white mt-1 block">${formatUsd(asset.invertido)}</span>
        <span class="text-[11px] text-slate-500">Costo base total</span>
      </div>

      <div class="bg-slate-950/70 border border-slate-800/80 rounded-xl p-3">
        <span class="text-[11px] uppercase text-slate-400 block">Valor de Mercado</span>
        <span class="text-base font-bold font-mono-num text-sky-400 mt-1 block">${formatUsd(asset.valorMercado)}</span>
        <span class="text-[11px] text-slate-500">≈ $${Math.round(asset.valorMercado * state.precioMep).toLocaleString("es-AR")} ARS</span>
      </div>

      <div class="bg-slate-950/70 border border-slate-800/80 rounded-xl p-3">
        <span class="text-[11px] uppercase text-slate-400 block">Ganancia / Pérdida</span>
        <span class="text-base font-bold font-mono-num ${isGain ? "text-emerald-400" : "text-rose-400"} mt-1 block">
          ${(isGain ? "+" : "") + formatUsd(asset.gananciaUsd)}
        </span>
        <span class="text-xs font-mono-num font-semibold ${isGain ? "text-emerald-400" : "text-rose-400"}">${formatPct(asset.gananciaPct, true)}</span>
      </div>

      <div class="bg-slate-950/70 border border-slate-800/80 rounded-xl p-3">
        <span class="text-[11px] uppercase text-slate-400 block">TIR Anualizada (XIRR)</span>
        <span class="text-base font-bold font-mono-num ${asset.anualizado >= 0 ? "text-indigo-400" : "text-rose-400"} mt-1 block">
          ${formatPct(asset.anualizado, true)}
        </span>
        <span class="text-[11px] text-slate-500">Ponderado por fechas</span>
      </div>
    </div>

    <div class="grid grid-cols-1 lg:grid-cols-2 gap-5 pt-1">
      <div class="bg-slate-950/60 border border-slate-800/80 rounded-xl p-4">
        <h4 class="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-3">
          Historial de Precios de Compra vs. PPC (${formatUsd(asset.ppc)}) y Precio Hoy (${formatUsd(asset.precioHoy)})
        </h4>
        <div class="relative h-[210px]">
          <canvas id="chartSelectedAssetCanvas"></canvas>
        </div>
      </div>

      <div class="bg-slate-950/60 border border-slate-800/80 rounded-xl p-4 flex flex-col">
        <h4 class="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-3">
          Operaciones Registradas de ${asset.ticker} (${assetMovs.length})
        </h4>
        <div class="overflow-y-auto max-h-[210px] flex-1">
          <table class="w-full text-left text-xs font-mono-num">
            <thead>
              <tr class="border-b border-slate-800 text-slate-400">
                <th class="py-1.5 px-2">Fecha</th>
                <th class="py-1.5 px-2 text-right">CEDEARs</th>
                <th class="py-1.5 px-2 text-right">Cant. ADR</th>
                <th class="py-1.5 px-2 text-right">P. Compra</th>
                <th class="py-1.5 px-2 text-right">Invertido</th>
                <th class="py-1.5 px-2 text-right">Rend. Lote</th>
                <th class="py-1.5 px-2 text-center">Quitar</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-800/50">
              ${assetMovs.map(m => {
                const lotRet = m.precioCompra > 0 ? (asset.precioHoy - m.precioCompra) / m.precioCompra : 0;
                return `
                  <tr class="hover:bg-slate-900/60">
                    <td class="py-1.5 px-2 text-slate-300">${m.fecha}</td>
                    <td class="py-1.5 px-2 text-right text-slate-400">${m.cedears !== null ? m.cedears : "—"}</td>
                    <td class="py-1.5 px-2 text-right text-white">${Number(m.cantidad).toFixed(5)}</td>
                    <td class="py-1.5 px-2 text-right text-slate-300">${formatUsd(m.precioCompra)}</td>
                    <td class="py-1.5 px-2 text-right text-sky-400">${formatUsd(m.invertido)}</td>
                    <td class="py-1.5 px-2 text-right ${lotRet >= 0 ? "text-emerald-400" : "text-rose-400"}">${formatPct(lotRet, true)}</td>
                    <td class="py-1.5 px-2 text-center">
                      <button onclick="deleteMovement('${m.id}')" class="text-rose-400 hover:text-rose-300 px-1" title="Eliminar este movimiento">✕</button>
                    </td>
                  </tr>
                `;
              }).join("") || `<tr><td colspan="7" class="py-4 text-center text-slate-500">Sin compras individuales detalladas</td></tr>`}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `;

  lucide.createIcons();

  const ctxInd = document.getElementById("chartSelectedAssetCanvas")?.getContext("2d");
  if (!ctxInd) return;
  if (chartSelectedAsset) chartSelectedAsset.destroy();

  const labels = assetMovs.length > 0 ? [...assetMovs.map(m => m.fecha), "HOY"] : ["PPC", "HOY"];
  const prices = assetMovs.length > 0 ? [...assetMovs.map(m => m.precioCompra), asset.precioHoy] : [asset.ppc, asset.precioHoy];
  const ppcLine = labels.map(() => Number(asset.ppc.toFixed(2)));

  chartSelectedAsset = new Chart(ctxInd, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Precio Operación / Hoy (USD)",
          data: prices,
          borderColor: asset.gananciaPct >= 0 ? "#10b981" : "#f43f5e",
          backgroundColor: asset.gananciaPct >= 0 ? "rgba(16, 185, 129, 0.15)" : "rgba(244, 63, 94, 0.15)",
          pointRadius: 5,
          fill: true,
          tension: 0.2
        },
        {
          label: "PPC Promedio (USD)",
          data: ppcLine,
          borderColor: "#38bdf8",
          borderDash: [5, 5],
          pointRadius: 0
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { labels: { color: "#cbd5e1", font: { size: 11 } } }
      },
      scales: {
        x: { ticks: { color: "#94a3b8", font: { size: 10 } }, grid: { display: false } },
        y: { ticks: { color: "#94a3b8", font: { family: "JetBrains Mono", size: 10 }, callback: v => `$${v}` }, grid: { color: "rgba(51, 65, 85, 0.35)" } }
      }
    }
  });
}

function renderPortfolioTable(listOverride) {
  const list = listOverride ? [...listOverride] : [...state.portafolio];
  const sortMode = document.getElementById("sortPortfolioSelect")?.value || "valorMercado_desc";

  list.sort((a, b) => {
    if (sortMode === "valorMercado_desc") return b.valorMercado - a.valorMercado;
    if (sortMode === "gananciaPct_desc") return b.gananciaPct - a.gananciaPct;
    if (sortMode === "gananciaPct_asc") return a.gananciaPct - b.gananciaPct;
    if (sortMode === "gananciaUsd_desc") return b.gananciaUsd - a.gananciaUsd;
    if (sortMode === "anualizado_desc") return b.anualizado - a.anualizado;
    if (sortMode === "ticker_asc") return a.ticker.localeCompare(b.ticker);
    return 0;
  });

  const tbody = document.getElementById("portfolioTableBody");
  tbody.innerHTML = list.map(p => {
    const isPos = p.gananciaUsd >= 0;
    const isSel = p.ticker === state.selectedTicker;
    return `
      <tr onclick="selectAssetPill('${p.ticker}')" class="cursor-pointer transition ${isSel ? "bg-emerald-950/30" : "hover:bg-slate-800/50"}">
        <td class="py-2.5 px-3" onclick="event.stopPropagation()">
          <input type="checkbox" ${p.incluirEnReporte ? "checked" : ""} onchange="toggleAssetReport('${p.ticker}', this.checked)" class="rounded bg-slate-800 border-slate-600 text-emerald-500" title="Incluir o excluir del reporte general" />
        </td>
        <td class="py-2.5 px-3 font-bold text-white">${p.ticker}</td>
        <td class="py-2.5 px-3 font-sans text-slate-300">
          <span class="px-2 py-0.5 rounded-full bg-slate-800 border border-slate-700 text-[11px]">${p.sector}</span>
        </td>
        <td class="py-2.5 px-3 text-right text-slate-200">${p.tenencia.toFixed(4)}</td>
        <td class="py-2.5 px-3 text-right text-slate-300">${formatUsd(p.ppc)}</td>
        <td class="py-2.5 px-3 text-right" onclick="event.stopPropagation()">
          <input type="number" step="any" value="${Number(p.precioHoy.toFixed(4))}" onchange="updateAssetPrice('${p.ticker}', this.value)" class="w-24 text-right bg-slate-900 border border-slate-700 rounded px-1.5 py-0.5 text-amber-300 font-bold focus:outline-none focus:border-emerald-500" />
        </td>
        <td class="py-2.5 px-3 text-right text-slate-300">${formatUsd(p.invertido)}</td>
        <td class="py-2.5 px-3 text-right font-bold text-white">${formatUsd(p.valorMercado)}</td>
        <td class="py-2.5 px-3 text-right font-semibold ${isPos ? "text-emerald-400" : "text-rose-400"}">
          ${(isPos ? "+" : "") + formatUsd(p.gananciaUsd)}
        </td>
        <td class="py-2.5 px-3 text-right font-semibold ${isPos ? "text-emerald-400" : "text-rose-400"}">
          ${formatPct(p.gananciaPct, true)}
        </td>
        <td class="py-2.5 px-3 text-right ${p.anualizado >= 0 ? "text-indigo-400" : "text-rose-400"}">
          ${formatPct(p.anualizado, true)}
        </td>
        <td class="py-2.5 px-3 text-right text-sky-400">${formatPct(p.pesoCartera, false)}</td>
        <td class="py-2.5 px-3 text-center" onclick="event.stopPropagation()">
          <div class="flex items-center justify-center gap-1">
            <button onclick="openAddModal('${p.ticker}')" class="px-2 py-1 rounded bg-emerald-500/15 hover:bg-emerald-500/30 text-emerald-400 text-[11px]" title="Agregar compra">+</button>
            <button onclick="deleteEntireAsset('${p.ticker}')" class="px-2 py-1 rounded bg-rose-500/15 hover:bg-rose-500/30 text-rose-400 text-[11px]" title="Quitar activo">🗑</button>
          </div>
        </td>
      </tr>
    `;
  }).join("");
}

// ============================================================================
// 7. VIEW 3: MOVIMIENTOS TABLE
// ============================================================================
function renderMovimientosTable() {
  const q = (document.getElementById("movSearchInput")?.value || "").trim().toLowerCase();
  const filtered = [...state.movimientos]
    .filter(m => !q || m.ticker.toLowerCase().includes(q) || (m.sector || "").toLowerCase().includes(q))
    .sort((a, b) => (b.fecha || "").localeCompare(a.fecha || ""));

  const tbody = document.getElementById("movimientosTableBody");
  tbody.innerHTML = filtered.map(m => `
    <tr class="hover:bg-slate-800/50">
      <td class="py-2.5 px-3 text-slate-300">${m.fecha}</td>
      <td class="py-2.5 px-3 font-bold text-white">
        <button onclick="inspectAsset('${m.ticker}')" class="hover:text-emerald-400 underline decoration-dotted">${m.ticker}</button>
      </td>
      <td class="py-2.5 px-3 font-sans text-slate-300">${m.sector}</td>
      <td class="py-2.5 px-3 text-right text-slate-300">${m.cedears !== null && m.cedears !== undefined ? m.cedears : "—"}</td>
      <td class="py-2.5 px-3 text-right text-slate-400">${m.ratio !== null && m.ratio !== undefined ? m.ratio : "—"}</td>
      <td class="py-2.5 px-3 text-right text-white">${Number(m.cantidad).toFixed(6)}</td>
      <td class="py-2.5 px-3 text-right text-slate-300">${formatUsd(m.precioCompra)}</td>
      <td class="py-2.5 px-3 text-right font-semibold text-sky-400">${formatUsd(m.invertido)}</td>
      <td class="py-2.5 px-3 text-center">
        <button onclick="deleteMovement('${m.id}')" class="px-2 py-1 rounded bg-rose-500/15 hover:bg-rose-500/30 text-rose-400 text-xs" title="Eliminar movimiento">Eliminar</button>
      </td>
    </tr>
  `).join("");
}

// ============================================================================
// 8. USER INTERACTIONS: ADD / EDIT / DELETE ASSETS & OPERATIONS
// ============================================================================
function switchTab(tab) {
  state.activeTab = tab;
  ["total", "activos", "movimientos"].forEach(t => {
    const viewEl = document.getElementById(`view-${t}`);
    const tabBtn = document.getElementById(`tab-${t}`);
    if (t === tab) {
      viewEl.classList.remove("hidden");
      tabBtn.classList.add("tab-active");
    } else {
      viewEl.classList.add("hidden");
      tabBtn.classList.remove("tab-active");
    }
  });
  if (tab === "total") {
    renderCentralPerformanceChart();
    renderTotalViewCharts();
  }
  if (tab === "activos") renderAssetViews();
}

async function pushToGoogleSheet(payload) {
  const gasUrl = getAppsScriptUrl();
  if (!gasUrl) return false;
  try {
    await fetch(gasUrl, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(payload)
    });
    return true;
  } catch (err) {
    console.warn("Error enviando cambio a Google Sheet:", err);
    return false;
  }
}

function updateCloudBadgeUI() {
  const badge = document.getElementById("cloudStatusBadge");
  const btn = document.getElementById("btnCloudConfig");
  if (!badge || !btn) return;
  const gasUrl = getAppsScriptUrl();
  if (gasUrl) {
    badge.textContent = "Google Sheet Conectado ✓";
    btn.classList.add("border-emerald-500/50", "text-emerald-300", "bg-emerald-950/30");
  } else {
    badge.textContent = "Conectar Sheet";
    btn.classList.remove("border-emerald-500/50", "text-emerald-300", "bg-emerald-950/30");
  }
}

function openCloudConfigModal() {
  const modal = document.getElementById("modalCloudConfig");
  const inp = document.getElementById("inputAppsScriptUrl");
  if (inp) inp.value = getAppsScriptUrl();
  if (modal) modal.classList.remove("hidden");
}

function closeCloudConfigModal() {
  const modal = document.getElementById("modalCloudConfig");
  if (modal) modal.classList.add("hidden");
}

async function saveCloudConfigUrl() {
  const inp = document.getElementById("inputAppsScriptUrl");
  const url = String(inp?.value || "").trim();
  if (url && !url.startsWith("https://script.google.com/")) {
    showToast("La URL debe comenzar con https://script.google.com/macros/s/...", "error");
    return;
  }
  localStorage.setItem("seguimiento_apps_script_url", url);
  updateCloudBadgeUI();
  closeCloudConfigModal();
  if (url) {
    showToast("¡Google Sheet vinculado! Sincronizando datos en vivo...");
    await loadData();
    await loadHistorySeries();
  } else {
    showToast("Vínculo con Google Apps Script desconectado.");
  }
}

function toggleAssetReport(ticker, checked) {
  const item = state.portafolio.find(p => p.ticker === ticker);
  if (item) {
    item.incluirEnReporte = checked;
    saveData();
    pushToGoogleSheet({ action: "toggle_asset", ticker, incluir: checked });
    renderAll();
    showToast(`${ticker.replace("CURRENCY:", "")} ${checked ? "incluido en" : "excluido de"} el rendimiento total.`);
  }
}

function updateAssetPrice(ticker, newPriceVal) {
  const price = parseFloat(newPriceVal);
  if (!Number.isFinite(price) || price <= 0) return;
  const item = state.portafolio.find(p => p.ticker === ticker);
  if (item) {
    item.precioHoy = price;
    recalculatePortfolio();
    saveData();
    renderAll();
    showToast(`Precio de ${ticker} actualizado a ${formatUsd(price)}`);
  }
}

function openAddModal(prefillTicker = "") {
  const modal = document.getElementById("modalAddOperation");
  modal.classList.remove("hidden");
  const tickerInput = document.getElementById("formTicker");
  tickerInput.value = prefillTicker || "";
  if (prefillTicker) {
    onFormTickerChange(prefillTicker);
  } else {
    recalcFormQuantity();
  }
}

function closeAddModal() {
  document.getElementById("modalAddOperation").classList.add("hidden");
}

async function onFormTickerChange(val) {
  const t = String(val || "").trim().toUpperCase();
  const existing = state.portafolio.find(p => p.ticker === t);
  const meta = KNOWN_META[t];

  if (existing) {
    document.getElementById("formSector").value = existing.sector;
    document.getElementById("formPrecioHoy").value = existing.precioHoy;
    if (!document.getElementById("formPrecioCompra").value) {
      document.getElementById("formPrecioCompra").value = existing.precioHoy;
    }
  } else if (meta) {
    document.getElementById("formSector").value = meta.sector;
  }

  if (meta && meta.ratio) {
    document.getElementById("formModoCantidad").value = "cedear";
    document.getElementById("formRatio").value = meta.ratio;
    toggleQuantityMode();
  } else if (t.includes("BTC") || t === "XNAS" || t === "SPYL") {
    document.getElementById("formModoCantidad").value = "directo";
    toggleQuantityMode();
  }
  recalcFormQuantity();
}

function toggleQuantityMode() {
  const mode = document.getElementById("formModoCantidad").value;
  if (mode === "cedear") {
    document.getElementById("rowCedearCalc").classList.remove("hidden");
    document.getElementById("rowDirectQuantity").classList.add("hidden");
  } else {
    document.getElementById("rowCedearCalc").classList.add("hidden");
    document.getElementById("rowDirectQuantity").classList.remove("hidden");
  }
  recalcFormQuantity();
}

function recalcFormQuantity() {
  const cedears = parseFloat(document.getElementById("formCedears").value) || 0;
  const ratio = parseFloat(document.getElementById("formRatio").value) || 1;
  const cant = ratio > 0 ? cedears / ratio : 0;
  document.getElementById("formCantidadCalculada").value = cant.toFixed(6);
  recalcFormTotal();
}

function recalcFormTotal() {
  const mode = document.getElementById("formModoCantidad").value;
  const cant = mode === "cedear"
    ? (parseFloat(document.getElementById("formCantidadCalculada").value) || 0)
    : (parseFloat(document.getElementById("formCantidadDirecta").value) || 0);
  const precio = parseFloat(document.getElementById("formPrecioCompra").value) || 0;
  const total = cant * precio;
  document.getElementById("formTotalInvertidoPreview").textContent = `${formatUsd(total)} USD`;
}

async function submitAddOperation(e) {
  e.preventDefault();
  const ticker = document.getElementById("formTicker").value.trim().toUpperCase();
  const fecha = document.getElementById("formFecha").value;
  const sector = normalizeSectorName(document.getElementById("formSector").value);
  const mode = document.getElementById("formModoCantidad").value;

  const cedears = mode === "cedear" ? (parseFloat(document.getElementById("formCedears").value) || null) : null;
  const ratio = mode === "cedear" ? (parseFloat(document.getElementById("formRatio").value) || null) : null;
  const cantidad = mode === "cedear"
    ? (parseFloat(document.getElementById("formCantidadCalculada").value) || 0)
    : (parseFloat(document.getElementById("formCantidadDirecta").value) || 0);

  const precioCompra = parseFloat(document.getElementById("formPrecioCompra").value) || 0;
  const precioHoyInput = parseFloat(document.getElementById("formPrecioHoy").value);
  const invertido = cantidad * precioCompra;

  if (!ticker || cantidad <= 0 || precioCompra <= 0) {
    showToast("Completa Ticker, Cantidad y Precio de Compra válidos.", "error");
    return;
  }

  const newMov = {
    id: `mov-${Date.now()}`,
    fecha,
    ticker,
    sector,
    cedears,
    ratio,
    cantidad,
    precioCompra,
    invertido,
    incluir: true
  };
  state.movimientos.push(newMov);

  let existing = state.portafolio.find(p => p.ticker === ticker);
  if (!existing) {
    state.portafolio.push({
      ticker,
      sector,
      tenencia: cantidad,
      ppc: precioCompra,
      precioHoy: Number.isFinite(precioHoyInput) && precioHoyInput > 0 ? precioHoyInput : precioCompra,
      valorMercado: 0,
      gananciaUsd: 0,
      gananciaPct: 0,
      anualizado: 0,
      pesoCartera: 0,
      incluirEnReporte: true
    });
  } else if (Number.isFinite(precioHoyInput) && precioHoyInput > 0) {
    existing.precioHoy = precioHoyInput;
  }

  state.selectedTicker = ticker;
  recalculatePortfolio();
  saveData();
  pushToGoogleSheet({ action: "add_movement", movement: newMov });
  closeAddModal();
  renderAll();
  await loadHistorySeries([ticker]);
  const sheetMsg = getAppsScriptUrl() ? " y guardada en tu Google Sheet" : "";
  showToast(`Operación de ${ticker} (${formatUsd(invertido)}) agregada${sheetMsg}.`);
}

function deleteMovement(movId) {
  const mov = state.movimientos.find(m => m.id === movId);
  if (!mov) return;
  if (!confirm(`¿Seguro que deseas eliminar la compra de ${mov.ticker} del ${mov.fecha} por ${formatUsd(mov.invertido)}?`)) {
    return;
  }
  state.movimientos = state.movimientos.filter(m => m.id !== movId);
  recalculatePortfolio();
  saveData();
  pushToGoogleSheet({
    action: "delete_movement",
    fecha: mov.fecha,
    ticker: mov.ticker,
    precioCompra: mov.precioCompra
  });
  renderAll();
  showToast(`Movimiento de ${mov.ticker} eliminado.`);
}

function deleteEntireAsset(ticker) {
  if (!confirm(`¿Seguro que deseas quitar el activo ${ticker} y todas sus operaciones del portafolio?`)) {
    return;
  }
  state.portafolio = state.portafolio.filter(p => p.ticker !== ticker);
  state.movimientos = state.movimientos.filter(m => m.ticker !== ticker);
  if (state.selectedTicker === ticker) {
    state.selectedTicker = state.portafolio[0]?.ticker || "";
  }
  recalculatePortfolio();
  saveData();
  renderAll();
  showToast(`Activo ${ticker} eliminado de la cartera.`);
}

// ============================================================================
// 9. GOOGLE SHEETS SYNC, LIVE PRICES & EXCEL (.XLSX) IMPORT/EXPORT
// ============================================================================
async function syncWithGoogleSheet() {
  const btn = document.getElementById("btnSyncSheet");
  btn.disabled = true;
  showToast("Sincronizando con Seguimiento Inversiones.gsheet en tu Google Drive...");
  try {
    // 1. If Google Apps Script URL is configured, pull directly from Google Sheet
    const gasUrl = getAppsScriptUrl();
    if (gasUrl) {
      const res = await fetch(`${gasUrl}?action=data`);
      if (res.ok) {
        const freshData = await res.json();
        if (freshData && Array.isArray(freshData.portafolio)) {
          applyLoadedData(freshData);
          saveData();
          await loadHistorySeries([], true);
          showToast("¡Sincronizado en vivo con tu Google Sheet!");
          return;
        }
      }
    }

    // 2. Otherwise try local Python server
    const res = await fetch("/api/sync-google-sheet", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sheetId: state.sheetId })
    });
    if (res.ok) {
      const freshData = await res.json();
      applyLoadedData(freshData);
      await loadHistorySeries([], true);
      showToast("¡Sincronizado con éxito desde tu Google Sheet!");
    } else {
      const err = await res.json();
      showToast(err.error || "Error al sincronizar con Google Sheet", "error");
    }
  } catch (e) {
    showToast("Para sincronizar desde GitHub Pages, conecta tu Google Sheet en el botón 'Conectar Sheet'.", "error");
  } finally {
    btn.disabled = false;
  }
}

async function refreshLivePrices() {
  const icon = document.getElementById("iconRefreshPrices");
  icon.classList.add("animate-spin");
  showToast("Actualizando cotizaciones en vivo desde Google Finance / Yahoo Finance...");
  try {
    const tickers = state.portafolio.map(p => p.ticker);
    // 1. Try local server
    try {
      const res = await fetch("/api/refresh-prices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tickers })
      });
      if (res.ok) {
        const { prices, timestamp } = await res.json();
        let count = 0;
        state.portafolio.forEach(p => {
          if (prices[p.ticker] && prices[p.ticker] > 0) {
            p.precioHoy = prices[p.ticker];
            count++;
          }
        });
        recalculatePortfolio();
        saveData();
        renderAll();
        showToast(`${count} cotizaciones actualizadas (${timestamp}).`);
        return;
      }
    } catch (err) {}

    // 2. If on GitHub Pages with Google Apps Script connected, Google Finance updates prices automatically in the Sheet
    const gasUrl = getAppsScriptUrl();
    if (gasUrl) {
      const res = await fetch(`${gasUrl}?action=data`);
      if (res.ok) {
        const freshData = await res.json();
        if (freshData && Array.isArray(freshData.portafolio)) {
          applyLoadedData(freshData);
          saveData();
          showToast(`Cotizaciones actualizadas desde GOOGLEFINANCE en tu Sheet.`);
          return;
        }
      }
    }
    showToast("Conecta tu Google Sheet o ejecuta el servidor local para actualizar precios.", "error");
  } catch (e) {
    showToast("Error al actualizar precios en vivo.", "error");
  } finally {
    icon.classList.remove("animate-spin");
  }
}

function handleExcelUpload(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      const data = new Uint8Array(e.target.result);
      const wb = XLSX.read(data, { type: "array", cellDates: true });

      if (wb.Sheets["Movimientos"]) {
        const rows = XLSX.utils.sheet_to_json(wb.Sheets["Movimientos"], { header: 1 });
        const movs = [];
        for (let i = 1; i < rows.length; i++) {
          const r = rows[i];
          if (!r || !r[1]) continue;
          const dt = r[0] instanceof Date ? r[0].toISOString().slice(0, 10) : String(r[0] || "2026-01-01").slice(0, 10);
          movs.push({
            id: `mov-xlsx-${i}-${Date.now()}`,
            fecha: dt,
            ticker: String(r[1]).trim().toUpperCase(),
            sector: normalizeSectorName(r[2] || "Otro"),
            cedears: r[3] != null ? Number(r[3]) : null,
            ratio: r[4] != null ? Number(r[4]) : null,
            cantidad: Number(r[5] || 0),
            precioCompra: Number(r[6] || 0),
            invertido: Math.abs(Number(r[7] || 0)),
            incluir: r[8] !== false
          });
        }
        if (movs.length > 0) state.movimientos = movs;
      }

      if (wb.Sheets["Portafolio"]) {
        const rows = XLSX.utils.sheet_to_json(wb.Sheets["Portafolio"], { header: 1 });
        const port = [];
        for (let i = 1; i < rows.length; i++) {
          const r = rows[i];
          if (!r || !r[0]) continue;
          port.push({
            ticker: String(r[0]).trim().toUpperCase(),
            sector: normalizeSectorName(r[1] || "Otro"),
            tenencia: Number(r[2] || 0),
            ppc: Number(r[3] || 0),
            precioHoy: Number(r[4] || 0),
            valorMercado: Number(r[5] || 0),
            gananciaUsd: Number(r[6] || 0),
            gananciaPct: Number(r[7] || 0),
            anualizado: Number(r[8] || 0),
            pesoCartera: Number(r[9] || 0),
            incluirEnReporte: r[11] !== false
          });
        }
        if (port.length > 0) state.portafolio = port;
      }

      recalculatePortfolio();
      saveData();
      renderAll();
      await loadHistorySeries();
      showToast(`Archivo Excel "${file.name}" importado correctamente.`);
    } catch (err) {
      console.error(err);
      showToast("Error al leer el archivo Excel.", "error");
    }
  };
  reader.readAsArrayBuffer(file);
}

function exportToExcel() {
  const wb = XLSX.utils.book_new();

  const portHeader = [
    "Ticker", "Sector", "Tenencia", "PPC (USD)", "Precio Hoy",
    "Valor Mercado", "Ganancia $", "Ganancia %", "Anualizado", "% Cartera", "", "Incluir en reporte"
  ];
  const portRows = state.portafolio.map(p => [
    p.ticker, p.sector, p.tenencia, p.ppc, p.precioHoy,
    p.valorMercado, p.gananciaUsd, p.gananciaPct, p.anualizado, p.pesoCartera, "", p.incluirEnReporte
  ]);
  const wsPort = XLSX.utils.aoa_to_sheet([portHeader, ...portRows]);
  XLSX.utils.book_append_sheet(wb, wsPort, "Portafolio");

  const movHeader = [
    "FECHA", "TICKER", "SECTOR", "CEDEARS/ACCION", "RATIO",
    "CANTIDAD (ACCION EEUU/ADR)", "PRECIO COMPRA", "INVERTIDO", "Filtro reporte"
  ];
  const movRows = state.movimientos.map(m => [
    m.fecha, m.ticker, m.sector, m.cedears, m.ratio,
    m.cantidad, m.precioCompra, -Math.abs(m.invertido), m.incluir
  ]);
  const wsMov = XLSX.utils.aoa_to_sheet([movHeader, ...movRows]);
  XLSX.utils.book_append_sheet(wb, wsMov, "Movimientos");

  XLSX.writeFile(wb, `Seguimiento_Inversiones_${new Date().toISOString().slice(0, 10)}.xlsx`);
  showToast("Plantilla Excel (.xlsx) descargada.");
}

// ============================================================================
// 10. FORMATTING HELPERS & TOAST
// ============================================================================
function formatUsd(val) {
  const num = Number(val) || 0;
  const sign = num < 0 ? "-" : "";
  return `${sign}$${Math.abs(num).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatPct(val, showPlus = false) {
  const pct = (Number(val) || 0) * 100;
  const sign = pct > 0 && showPlus ? "+" : "";
  return `${sign}${pct.toFixed(2)}%`;
}

function showToast(msg, type = "success") {
  const container = document.getElementById("toastContainer");
  const el = document.createElement("div");
  el.className = `px-4 py-2.5 rounded-xl border text-xs font-medium shadow-xl transition flex items-center gap-2 ${
    type === "error"
      ? "bg-rose-950/90 border-rose-500/40 text-rose-200"
      : "bg-slate-900/95 border-emerald-500/40 text-emerald-300"
  }`;
  el.innerHTML = `<span>${msg}</span>`;
  container.appendChild(el);
  setTimeout(() => {
    el.remove();
  }, 3800);
}
