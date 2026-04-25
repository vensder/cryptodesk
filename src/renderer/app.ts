'use strict';

import type * as LWC from 'lightweight-charts';

declare const LightweightCharts: typeof LWC;

declare global {
  interface Window {
    electronAPI: {
      windowMinimize: () => void;
      windowMaximize: () => void;
      windowClose:    () => void;
    };
  }
}

// ---- Types ---------------------------------------------------------

type Interval = '1m' | '5m' | '15m' | '1h' | '4h' | '1d';

interface Candle {
  time:  number;
  open:  number;
  high:  number;
  low:   number;
  close: number;
}

interface Exchange {
  intervalMap: Record<string, string>;
  fetchKlines(symbol: string, interval: Interval, limit?: number): Promise<Candle[]>;
}

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
        time:  Math.floor((k[0] as number) / 1000),
        open:  parseFloat(k[1] as string),
        high:  parseFloat(k[2] as string),
        low:   parseFloat(k[3] as string),
        close: parseFloat(k[4] as string),
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
          time:  Math.floor(parseInt(k[0], 10) / 1000),
          open:  parseFloat(k[1]),
          high:  parseFloat(k[2]),
          low:   parseFloat(k[3]),
          close: parseFloat(k[4]),
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

// ---- Chart setup -----------------------------------------------

let chart:        LWC.IChartApi | null = null;
let candleSeries: LWC.ISeriesApi<'Candlestick'> | null = null;

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

// ---- Load candles ----------------------------------------------

async function loadCandles(): Promise<void> {
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
    candleSeries!.setData(candles as LWC.CandlestickData[]);
    chart!.timeScale().fitContent();
    setStatus(`${candles.length} candles  -  ${exchange.toUpperCase()}  ${symbol.toUpperCase()}  ${interval}`, 'ok');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(err);
    setStatus(msg, 'error');
  } finally {
    btn.disabled = false;
  }
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

  document.getElementById('btn-load')!.addEventListener('click', () => { void loadCandles(); });
  (document.getElementById('inp-symbol') as HTMLInputElement).addEventListener('keydown', e => {
    if (e.key === 'Enter') void loadCandles();
  });

  void loadCandles();
});
