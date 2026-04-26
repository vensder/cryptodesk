'use strict';

import type * as LWC from 'lightweight-charts';
import type { OkxLoan, OkxRiskWarning, OkxResponse } from './types';

declare const LightweightCharts: typeof LWC;

declare global {
  interface Window {
    electronAPI: {
      windowMinimize: () => void;
      windowMaximize: () => void;
      windowClose:    () => void;
      getApiKey: (service: string) => Promise<string | null>;
      setApiKey: (service: string, key: string) => Promise<void>;
      okxRequest: (method: string, path: string, params?: Record<string, string>) => Promise<OkxResponse>;
    };
  }
}

// ---- Types ---------------------------------------------------------

type Interval = '1m' | '5m' | '15m' | '1h' | '4h' | '1d';

interface Candle {
  time:   number;
  open:   number;
  high:   number;
  low:    number;
  close:  number;
  volume: number;
}

interface Exchange {
  intervalMap: Record<string, string>;
  fetchKlines(symbol: string, interval: Interval, limit?: number): Promise<Candle[]>;
}

// ---- Constants -----------------------------------------------------

const REFRESH_INTERVAL_MS  = 15_000;
const MAX_ERRORS           = 3;
const CMC_REFRESH_MS       = 15 * 60 * 1000;
const LOANS_REFRESH_MS     = 60_000;

// ---- Exchange adapters ----------------------------------------

const exchanges: Record<string, Exchange> = {

  binance: {
    intervalMap: {
      '1m': '1m', '5m': '5m', '15m': '15m',
      '1h': '1h', '4h': '4h', '1d': '1d',
    },
    async fetchKlines(symbol, interval, limit = 500) {
      const mapped = this.intervalMap[interval] ?? interval;
      const url = `https://api.binance.com/api/v3/klines?symbol=${symbol.toUpperCase()}&interval=${mapped}&limit=${limit}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Binance ${res.status}: ${res.statusText}`);
      const raw = await res.json() as unknown[][];
      return raw.map(k => ({
        time:   Math.floor((k[0] as number) / 1000),
        open:   parseFloat(k[1] as string),
        high:   parseFloat(k[2] as string),
        low:    parseFloat(k[3] as string),
        close:  parseFloat(k[4] as string),
        volume: parseFloat(k[5] as string),
      }));
    },
  },

  okx: {
    intervalMap: {
      '1m': '1m', '5m': '5m', '15m': '15m',
      '1h': '1H', '4h': '4H', '1d': '1D',
    },
    async fetchKlines(symbol, interval, limit = 300) {
      const instId = normalizeOkxSymbol(symbol);
      const bar    = this.intervalMap[interval] ?? interval;
      const url    = `https://www.okx.com/api/v5/market/candles?instId=${instId}&bar=${bar}&limit=${limit}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`OKX ${res.status}: ${res.statusText}`);
      const json = await res.json() as { code: string; msg: string; data: string[][] };
      if (json.code !== '0') throw new Error(`OKX API error: ${json.msg}`);
      return json.data
        .map(k => ({
          time:   Math.floor(parseInt(k[0], 10) / 1000),
          open:   parseFloat(k[1]),
          high:   parseFloat(k[2]),
          low:    parseFloat(k[3]),
          close:  parseFloat(k[4]),
          volume: parseFloat(k[5]),
        }))
        .reverse();
    },
  },
};

function normalizeOkxSymbol(s: string): string {
  if (!s.includes('-')) {
    const stables = ['USDT', 'USDC', 'BTC', 'ETH', 'BNB'];
    for (const q of stables) {
      if (s.endsWith(q) && s.length > q.length) {
        return `${s.slice(0, s.length - q.length)}-${q}`;
      }
    }
  }
  return s.toUpperCase();
}

// ---- Chart state -----------------------------------------------

let chart:        LWC.IChartApi | null = null;
let candleSeries: LWC.ISeriesApi<'Candlestick'> | null = null;
let volumeSeries: LWC.ISeriesApi<'Histogram'> | null = null;

let pendingLiqLine: { price: number; label: string } | null = null;
let activeLiqLine:  LWC.IPriceLine | null = null;

let refreshTimer:     ReturnType<typeof setInterval> | null = null;
let consecutiveErrors = 0;
let statusBase        = '';
let liveDot:          HTMLSpanElement | null = null;

// ---- Loans state -----------------------------------------------

let loansRefreshTimer: ReturnType<typeof setInterval> | null = null;

// ---- Chart setup -----------------------------------------------

function initChart(): void {
  const container = document.getElementById('chart-container') as HTMLDivElement;

  chart = LightweightCharts.createChart(container, {
    width:  container.clientWidth,
    height: container.clientHeight,
    layout: {
      background: { type: LightweightCharts.ColorType.Solid, color: '#0d0f14' },
      textColor:  '#8892a4',
      fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
      fontSize:   11,
    },
    grid: {
      vertLines: { color: '#1a1e2a' },
      horzLines: { color: '#1a1e2a' },
    },
    crosshair: {
      mode:     LightweightCharts.CrosshairMode.Normal,
      vertLine: { color: '#3a7bd5', labelBackgroundColor: '#1a1e2a' },
      horzLine: { color: '#3a7bd5', labelBackgroundColor: '#1a1e2a' },
    },
    rightPriceScale: {
      borderColor: '#252a38',
    },
    timeScale: {
      borderColor:    '#252a38',
      timeVisible:    true,
      secondsVisible: false,
    },
  });

  candleSeries = chart.addCandlestickSeries({
    upColor:         '#26a69a',
    downColor:       '#ef5350',
    borderUpColor:   '#26a69a',
    borderDownColor: '#ef5350',
    wickUpColor:     '#26a69a',
    wickDownColor:   '#ef5350',
  });

  volumeSeries = chart.addHistogramSeries({
    color:        '#26a69a',
    priceFormat:  { type: 'volume' },
    priceScaleId: 'vol',
  });

  chart.priceScale('vol').applyOptions({
    scaleMargins: { top: 0.8, bottom: 0 },
  });

  const ro = new ResizeObserver(() => {
    chart!.resize(container.clientWidth, container.clientHeight);
  });
  ro.observe(container);
}

// ---- Status helper ---------------------------------------------

function setStatus(msg: string, type = ''): void {
  const el = document.getElementById('status-msg') as HTMLSpanElement;
  el.textContent = msg;
  el.className   = type;
}

// ---- Live indicator --------------------------------------------

function createLiveDot(): void {
  liveDot = document.createElement('span');
  liveDot.id = 'live-dot';
  liveDot.hidden = true;
  document.getElementById('status-msg')!.insertAdjacentElement('afterend', liveDot);
}

function setLiveIndicator(active: boolean): void {
  if (liveDot) liveDot.hidden = !active;
}

// ---- Auto-refresh ----------------------------------------------

function formatTime(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function stopRefresh(): void {
  if (refreshTimer !== null) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
  setLiveIndicator(false);
}

function startRefresh(exchange: string, symbol: string, interval: Interval): void {
  stopRefresh();
  consecutiveErrors = 0;
  setLiveIndicator(true);

  refreshTimer = setInterval(() => {
    void (async () => {
      const adapter = exchanges[exchange];
      if (!adapter) return;

      try {
        const latest = await adapter.fetchKlines(symbol, interval, 1);
        const c = latest[0];
        if (!c) return;
        candleSeries!.update({
          time:  c.time as LWC.UTCTimestamp,
          open:  c.open,
          high:  c.high,
          low:   c.low,
          close: c.close,
        });
        volumeSeries!.update({
          time:  c.time as LWC.UTCTimestamp,
          value: c.volume,
          color: c.close >= c.open ? '#26a69a55' : '#ef535055',
        });
        consecutiveErrors = 0;
        setStatus(`${statusBase} · ${formatTime(new Date())}`, 'ok');
      } catch (err) {
        consecutiveErrors++;
        console.error(`Auto-refresh error (${consecutiveErrors}/${MAX_ERRORS}):`, err);
        if (consecutiveErrors >= MAX_ERRORS) {
          stopRefresh();
          setStatus(`${statusBase} · refresh stopped`, 'error');
        }
      }
    })();
  }, REFRESH_INTERVAL_MS);
}

// ---- Load candles ----------------------------------------------

async function loadCandles(): Promise<void> {
  stopRefresh();

  if (activeLiqLine !== null) {
    candleSeries!.removePriceLine(activeLiqLine);
    activeLiqLine = null;
  }

  const exchange = (document.getElementById('sel-exchange') as HTMLSelectElement).value;
  const symbol   = (document.getElementById('inp-symbol')   as HTMLInputElement).value.trim();
  const interval = (document.getElementById('sel-interval') as HTMLSelectElement).value as Interval;
  const btn      = document.getElementById('btn-load') as HTMLButtonElement;

  if (!symbol) { setStatus('Enter a symbol.', 'error'); return; }

  btn.disabled = true;
  setStatus('Loading...');

  try {
    const adapter = exchanges[exchange];
    if (!adapter) throw new Error(`Unknown exchange: ${exchange}`);

    const candles = await adapter.fetchKlines(symbol, interval);
    candleSeries!.setData(candles.map(c => ({
      time:  c.time as LWC.UTCTimestamp,
      open:  c.open,
      high:  c.high,
      low:   c.low,
      close: c.close,
    })));

    volumeSeries!.setData(candles.map(c => ({
      time:  c.time as LWC.UTCTimestamp,
      value: c.volume,
      color: c.close >= c.open ? '#26a69a55' : '#ef535055',
    })));

    chart!.timeScale().fitContent();

    statusBase = `${candles.length} candles  -  ${exchange.toUpperCase()}  ${symbol.toUpperCase()}  ${interval}`;
    setStatus(statusBase, 'ok');
    startRefresh(exchange, symbol, interval);

    if (pendingLiqLine !== null) {
      activeLiqLine = candleSeries!.createPriceLine({
        price:            pendingLiqLine.price,
        color:            '#ef5350',
        lineWidth:        1,
        lineStyle:        LightweightCharts.LineStyle.Dashed,
        axisLabelVisible: true,
        title:            pendingLiqLine.label,
      });
      pendingLiqLine = null;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(err);
    setStatus(msg, 'error');
  } finally {
    btn.disabled = false;
  }
}

// ---- Liq line nav ----------------------------------------------

function openChartWithLiqLine(instId: string, liqPx: string): void {
  (document.getElementById('sel-exchange') as HTMLSelectElement).value = 'okx';
  (document.getElementById('inp-symbol')   as HTMLInputElement).value  = instId.replace('/', '-');
  pendingLiqLine = { price: parseFloat(liqPx), label: 'Liq ' + liqPx };
  document.querySelector<HTMLButtonElement>('.tab[data-tab="charts"]')!.click();
  void loadCandles();
}

// ---- Loans tab -------------------------------------------------

function setLoanMetrics(borrowed: string, collateral: string, count: string): void {
  (document.getElementById('val-total-borrowed')   as HTMLSpanElement).textContent = borrowed;
  (document.getElementById('val-total-collateral') as HTMLSpanElement).textContent = collateral;
  (document.getElementById('val-active-loans')     as HTMLSpanElement).textContent = count;
}

function formatUsd(v: number): string {
  return '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatPct(v: string): string {
  const n = parseFloat(v);
  return isNaN(n) ? '--' : `${(n * 100).toFixed(1)}%`;
}

function ltvColor(cur: string, liq: string): string {
  const c = parseFloat(cur);
  const l = parseFloat(liq);
  if (!l || !c) return 'var(--text-primary)';
  const ratio = c / l;
  if (ratio < 0.70) return 'var(--green)';
  if (ratio < 0.85) return 'var(--orange)';
  return 'var(--red)';
}

function makeCell(label: string): HTMLDivElement {
  const cell = document.createElement('div');
  cell.className = 'loan-cell';
  const lbl = document.createElement('span');
  lbl.className = 'cell-label';
  lbl.textContent = label;
  cell.appendChild(lbl);
  return cell;
}

function makeLoanListCell(
  label: string,
  items: Array<{ amt: string; ccy: string }>,
  usd: string,
): HTMLDivElement {
  const cell = makeCell(label);
  const list = document.createElement('div');
  list.className = 'cell-list';
  if (items.length === 0) {
    const s = document.createElement('span');
    s.textContent = '--';
    list.appendChild(s);
  } else {
    for (const item of items) {
      const s = document.createElement('span');
      s.textContent = `${item.amt} ${item.ccy}`;
      list.appendChild(s);
    }
  }
  cell.appendChild(list);
  const usdEl = document.createElement('span');
  usdEl.className = 'cell-usd';
  usdEl.textContent = `≈ ${formatUsd(parseFloat(usd) || 0)}`;
  cell.appendChild(usdEl);
  return cell;
}

function makeValueCell(label: string, value: string, color: string): HTMLDivElement {
  const cell = makeCell(label);
  const val = document.createElement('span');
  val.className = 'cell-value';
  val.textContent = value;
  val.style.color = color;
  cell.appendChild(val);
  return cell;
}

function makeLiqPriceCell(risk: OkxRiskWarning | undefined): HTMLDivElement {
  const cell = makeCell('Liq Price');
  if (risk?.liqPx) {
    const link = document.createElement('span');
    link.className = 'liq-link';
    link.textContent = `${risk.liqPx}${risk.instId ? ' ' + risk.instId : ''}`;
    link.addEventListener('click', () => openChartWithLiqLine(risk.instId, risk.liqPx));
    cell.appendChild(link);
  } else {
    const val = document.createElement('span');
    val.className = 'cell-value';
    val.textContent = '--';
    const sub = document.createElement('span');
    sub.className = 'cell-sub';
    sub.textContent = 'multi-collateral';
    cell.appendChild(val);
    cell.appendChild(sub);
  }
  return cell;
}

function buildLoanCard(loan: OkxLoan): HTMLDivElement {
  const card = document.createElement('div');
  card.className = 'loan-card';

  const header = document.createElement('div');
  header.className = 'loan-card-header';
  const idEl = document.createElement('span');
  idEl.className = 'loan-id';
  idEl.title = loan.ordId;
  idEl.textContent = `…${loan.ordId.slice(-8)}`;
  header.appendChild(idEl);
  card.appendChild(header);

  const grid = document.createElement('div');
  grid.className = 'loan-card-grid';
  grid.appendChild(makeLoanListCell('Borrowed',   loan.loanData,       loan.loanNotionalUsd));
  grid.appendChild(makeLoanListCell('Collateral', loan.collateralData, loan.collateralNotionalUsd));
  grid.appendChild(makeValueCell('Current LTV',  formatPct(loan.curLTV),        ltvColor(loan.curLTV, loan.liqLTV)));
  grid.appendChild(makeValueCell('Margin Call',  formatPct(loan.marginCallLTV), 'var(--text-muted)'));
  grid.appendChild(makeValueCell('Liq LTV',      formatPct(loan.liqLTV),        'var(--text-muted)'));
  grid.appendChild(makeLiqPriceCell(loan.riskWarningData));
  card.appendChild(grid);

  return card;
}

function renderLoanCards(loans: OkxLoan[]): void {
  const container = document.getElementById('loans-list') as HTMLDivElement;
  container.innerHTML = '';
  if (loans.length === 0) {
    container.textContent = 'No active loans';
    return;
  }
  for (const loan of loans) container.appendChild(buildLoanCard(loan));
}

function stopLoansRefresh(): void {
  if (loansRefreshTimer !== null) {
    clearInterval(loansRefreshTimer);
    loansRefreshTimer = null;
  }
}

function startLoansRefresh(): void {
  stopLoansRefresh();
  loansRefreshTimer = setInterval(() => { void fetchLoanSummary(); }, LOANS_REFRESH_MS);
}

async function fetchLoanSummary(): Promise<void> {
  let hasKeys = false;
  try {
    const [k, s, p] = await Promise.all([
      window.electronAPI.getApiKey('okx-key'),
      window.electronAPI.getApiKey('okx-secret'),
      window.electronAPI.getApiKey('okx-passphrase'),
    ]);
    hasKeys = !!(k && s && p);
  } catch { /* keytar unavailable */ }

  const noKeysEl = document.getElementById('loans-no-keys') as HTMLDivElement;
  const mainEl   = document.getElementById('loans-main')    as HTMLDivElement;

  if (!hasKeys) {
    noKeysEl.hidden = false;
    mainEl.hidden   = true;
    stopLoansRefresh();
    return;
  }

  noKeysEl.hidden = true;
  mainEl.hidden   = false;
  setLoanMetrics('--', '--', '--');

  try {
    const res = await window.electronAPI.okxRequest('GET', '/api/v5/finance/flexible-loan/loan-info');
    if (!res.ok) {
      console.error('OKX loans HTTP error:', res.msg);
      return;
    }
    const body = res.data as { code: string; msg: string; data: OkxLoan[] };
    if (body.code !== '0') {
      console.error('OKX loans API error:', body.msg);
      return;
    }
    const loans = body.data ?? [];
    const totalBorrowed   = loans.reduce((sum, l) => sum + (parseFloat(l.loanNotionalUsd)       || 0), 0);
    const totalCollateral = loans.reduce((sum, l) => sum + (parseFloat(l.collateralNotionalUsd) || 0), 0);
    setLoanMetrics(formatUsd(totalBorrowed), formatUsd(totalCollateral), String(loans.length));
    renderLoanCards(loans);
  } catch (err) {
    console.error('fetchLoanSummary error:', err);
  }
}

function initLoans(): void {
  document.querySelector<HTMLButtonElement>('.tab[data-tab="loans"]')!
    .addEventListener('click', () => {
      void fetchLoanSummary();
      startLoansRefresh();
    });

  document.querySelectorAll<HTMLButtonElement>('.tab:not([data-tab="loans"])').forEach(tab => {
    tab.addEventListener('click', () => stopLoansRefresh());
  });

  document.getElementById('btn-refresh-loans')!
    .addEventListener('click', () => { void fetchLoanSummary(); });

  document.getElementById('btn-goto-settings')!
    .addEventListener('click', () => {
      document.querySelector<HTMLButtonElement>('.tab[data-tab="settings"]')!.click();
    });
}

// ---- CMC market indicators -------------------------------------

function fgColor(v: number): string {
  if (v <= 25) return 'var(--red)';
  if (v <= 45) return 'var(--orange)';
  if (v <= 55) return 'var(--text-secondary)';
  if (v <= 75) return 'var(--green)';
  return 'var(--green-bright)';
}

async function refreshCmcData(): Promise<void> {
  let cmcKey: string | null = null;
  try {
    cmcKey = await window.electronAPI.getApiKey('cmc');
  } catch {
    return;
  }

  if (!cmcKey) return;

  const headers = { 'X-CMC_PRO_API_KEY': cmcKey };
  const [r1, r2] = await Promise.allSettled([
    fetch('https://pro-api.coinmarketcap.com/v1/global-metrics/quotes/latest', { headers }),
    fetch('https://pro-api.coinmarketcap.com/v3/fear-and-greed/latest', { headers }),
  ]);

  let anyOk = false;

  if (r1.status === 'fulfilled' && r1.value.ok) {
    const d = (await r1.value.json() as { data: { btc_dominance: number } }).data;
    (document.getElementById('val-btcd') as HTMLSpanElement).textContent = `${d.btc_dominance.toFixed(1)}%`;
    anyOk = true;
  }

  if (r2.status === 'fulfilled' && r2.value.ok) {
    const d = (await r2.value.json() as { data: { value: number; value_classification: string } }).data;
    const valEl = document.getElementById('val-fg') as HTMLSpanElement;
    valEl.textContent = String(d.value);
    valEl.style.color = fgColor(d.value);
    (document.getElementById('val-fg-word') as HTMLSpanElement).textContent = d.value_classification;
    anyOk = true;
  }

  (document.getElementById('market-live-dot') as HTMLSpanElement).hidden = !anyOk;
}

function initMarketIndicators(): void {
  void refreshCmcData();
  setInterval(() => { void refreshCmcData(); }, CMC_REFRESH_MS);
}

// ---- Settings tab ----------------------------------------------

function showSaveConfirm(id: string): void {
  const el = document.getElementById(id) as HTMLSpanElement;
  el.textContent = 'Saved';
  el.classList.add('visible');
  setTimeout(() => el.classList.remove('visible'), 2000);
}

async function loadSettingsKeys(): Promise<void> {
  try {
    const [cmcKey, okxKey, okxSecret, okxPassphrase] = await Promise.all([
      window.electronAPI.getApiKey('cmc'),
      window.electronAPI.getApiKey('okx-key'),
      window.electronAPI.getApiKey('okx-secret'),
      window.electronAPI.getApiKey('okx-passphrase'),
    ]);
    if (cmcKey)        (document.getElementById('inp-cmc-key')        as HTMLInputElement).value = cmcKey;
    if (okxKey)        (document.getElementById('inp-okx-key')        as HTMLInputElement).value = okxKey;
    if (okxSecret)     (document.getElementById('inp-okx-secret')     as HTMLInputElement).value = okxSecret;
    if (okxPassphrase) (document.getElementById('inp-okx-passphrase') as HTMLInputElement).value = okxPassphrase;
  } catch {
    // keytar unavailable
  }
}

async function saveCmcKey(): Promise<void> {
  const key = (document.getElementById('inp-cmc-key') as HTMLInputElement).value.trim();
  if (!key) return;
  try {
    await window.electronAPI.setApiKey('cmc', key);
    showSaveConfirm('conf-cmc');
    void refreshCmcData();
  } catch {
    // keytar unavailable
  }
}

async function saveOkxField(inputId: string, account: string, confirmId: string): Promise<void> {
  const val = (document.getElementById(inputId) as HTMLInputElement).value.trim();
  if (!val) return;
  try {
    await window.electronAPI.setApiKey(account, val);
    showSaveConfirm(confirmId);
  } catch {
    // keytar unavailable
  }
}

function initSettings(): void {
  document.querySelector<HTMLButtonElement>('.tab[data-tab="settings"]')!
    .addEventListener('click', () => { void loadSettingsKeys(); });

  document.getElementById('btn-save-cmc')!
    .addEventListener('click', () => { void saveCmcKey(); });

  document.getElementById('btn-save-okx-key')!
    .addEventListener('click', () => { void saveOkxField('inp-okx-key', 'okx-key', 'conf-okx-key'); });
  document.getElementById('btn-save-okx-secret')!
    .addEventListener('click', () => { void saveOkxField('inp-okx-secret', 'okx-secret', 'conf-okx-secret'); });
  document.getElementById('btn-save-okx-passphrase')!
    .addEventListener('click', () => { void saveOkxField('inp-okx-passphrase', 'okx-passphrase', 'conf-okx-passphrase'); });

  document.querySelectorAll<HTMLButtonElement>('.btn-show-hide').forEach(btn => {
    btn.addEventListener('click', () => {
      const targetId = btn.dataset['target'];
      if (!targetId) return;
      const inp = document.getElementById(targetId) as HTMLInputElement;
      inp.type = inp.type === 'password' ? 'text' : 'password';
      btn.textContent = inp.type === 'password' ? 'Show' : 'Hide';
    });
  });
}

// ---- Tabs ------------------------------------------------------

function initTabs(): void {
  document.querySelectorAll<HTMLButtonElement>('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById(`tab-${tab.dataset['tab']}`)?.classList.add('active');

      if (tab.dataset['tab'] === 'charts' && chart) {
        requestAnimationFrame(() => {
          const c = document.getElementById('chart-container') as HTMLDivElement;
          chart!.resize(c.clientWidth, c.clientHeight);
        });
      }
    });
  });
}

// ---- Window controls -------------------------------------------

function initWindowControls(): void {
  document.getElementById('btn-min')!.addEventListener('click',   () => window.electronAPI.windowMinimize());
  document.getElementById('btn-max')!.addEventListener('click',   () => window.electronAPI.windowMaximize());
  document.getElementById('btn-close')!.addEventListener('click', () => window.electronAPI.windowClose());
}

// ---- Bootstrap -------------------------------------------------

document.addEventListener('DOMContentLoaded', () => {
  initChart();
  initTabs();
  initWindowControls();
  createLiveDot();
  initMarketIndicators();
  initSettings();
  initLoans();

  document.getElementById('btn-load')!.addEventListener('click', () => { void loadCandles(); });
  (document.getElementById('inp-symbol') as HTMLInputElement).addEventListener('keydown', e => {
    if (e.key === 'Enter') void loadCandles();
  });

  void loadCandles();
});
