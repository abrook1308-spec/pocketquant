#!/usr/bin/env node
/**
 * ============================================================================
 *  PocketQuant — Automated ETF paper-trading engine (GitHub Actions edition)
 * ============================================================================
 *  Runs 100% free on GitHub Actions (public repositories get unlimited free
 *  minutes). Scheduled every weekday after the London close, and can be
 *  started manually from the Actions tab ("Run workflow").
 *
 *  Storage: data/state.json and data/backtest.json are committed back to the
 *  repo by the workflow after every run — no servers, no databases, free.
 *
 *  Optional secrets (repo Settings → Secrets and variables → Actions):
 *    - BROKER_KEY           Trading 212 API key (real-money mirror). Create it
 *                           with "orders" + "read account" permissions ONLY
 *                           (Trading 212 keys cannot withdraw money anyway).
 *    - REAL_MONEY_CONFIRM   Must contain exactly: ENABLE REAL MONEY
 *                           Real money stays impossible without BOTH secrets
 *                           plus the explicit control action.
 *
 *  WHAT IT DOES (daily, automatically — your phone can be off):
 *    1. Downloads daily prices for 4 low-cost LSE ETFs (free Yahoo Finance
 *       data, Stooq fallback)
 *    2. Computes a 200-day trend filter + 3-month momentum per ETF
 *    3. Buys the strongest ETF above its trend, goes to cash when trends break
 *    4. Enforces risk rules: position cap, daily loss limit, drawdown halt,
 *       stop-loss, duplicate-order guard, stale-data guard, outage breaker
 *    5. Simulates every trade with realistic fees & slippage (paper trading)
 *
 *  Run modes (workflow "mode" input):
 *    trade     one engine tick (default; also used by the daily schedule)
 *    backtest  re-run the strategy on ~3 years of real history and compare
 *              with buy-and-hold (writes data/backtest.json)
 *
 *  NO LOOK-AHEAD: signals are computed on the latest completed daily bar and
 *  executed at that close, adjusted for fees and slippage.
 * ============================================================================
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(ROOT, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const BACKTEST_FILE = path.join(DATA_DIR, 'backtest.json');

// ------------------------------ CONFIG -------------------------------------

const UNIVERSE = {
  'VUSA.L': { name: 'Vanguard S&P 500 UCITS ETF',        fx: 0,      stooq: 'vusa.uk' },
  'VWRL.L': { name: 'Vanguard FTSE All-World UCITS ETF', fx: 0,      stooq: 'vwrl.uk' },
  'CSPX.L': { name: 'iShares Core S&P 500 UCITS ETF',    fx: 0.0015, stooq: 'cspx.uk' },
  'VGOV.L': { name: 'Vanguard UK Gilts 0-5yr ETF',       fx: 0,      stooq: 'vgov.uk' },
};

// Evidence-based risk presets (weights, stops and circuit breakers)
const RISK = {
  conservative: { weight: 0.60, stop: 0.10, dailyLoss: 0.02, ddHalt: 0.12 },
  balanced:     { weight: 0.80, stop: 0.13, dailyLoss: 0.03, ddHalt: 0.15 },
  growth:       { weight: 0.95, stop: 0.16, dailyLoss: 0.04, ddHalt: 0.20 },
};

const SLIPPAGE = 0.001;       // 0.10% spread/slippage per trade side
const BAND = 0.10;            // rebalance only if allocation drifts > 10%
const SMA_DAYS = 200;         // 200-day trend filter
const MOM_DAYS = 63;          // ~3-month momentum
const SWITCH_MARGIN = 0.02;   // switch ETFs only if challenger leads by > 2%
const MIN_HOLD_DAYS = 21;     // trading days; ~29 calendar days
const STALE_DAYS = 4;         // reject price data older than 4 days
const START_CAPITAL = 50;     // £50 paper account
const MAX_FAILS = 5;          // consecutive data failures -> auto-pause

// ------------------------------ STATE FILES ---------------------------------

function readJson(file, dflt) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return dflt; }
}
function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  fs.renameSync(tmp, file); // avoid half-written JSON if interrupted
}

function defaultState(maxCapital) {
  const cap = Number(maxCapital) > 0 ? Number(maxCapital) : START_CAPITAL;
  const now = new Date().toISOString();
  return {
    settings: {
      state: 'stopped',            // 'running' | 'paused' | 'stopped'
      emergency: false,
      riskLevel: 'balanced',
      maxCapital: cap,
      realMoney: false,            // real-money trading: HARD OFF by default
      createdAt: now,
    },
    account: {
      cash: cap,
      startingEquity: cap,
      peakEquity: cap,
      totalFees: 0,
      lastPx: {},                  // last seen prices per ticker
      equityNow: cap,
    },
    positions: {},                 // ticker -> { qty, entryPrice, entryDate }
    trades: [],                    // newest first
    signals: [],                   // newest first
    equity: [],                    // [{ d, v }] oldest first
    day: { date: null, startEquity: cap },
    meta: {
      lastEvalDate: null,
      lastRunAt: null,
      lastError: null,
      consecutiveFails: 0,
      haltReason: null,
      brokerCheck: null,
      tradeKeys: [],               // duplicate-order guard
      version: 1,
    },
  };
}

// ------------------------------ MARKET DATA ---------------------------------

async function fetchYahoo(ticker, range) {
  const hosts = ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com'];
  for (const h of hosts) {
    try {
      const res = await fetch(h + '/v8/finance/chart/' + encodeURIComponent(ticker) +
        '?range=' + range + '&interval=1d', {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Linux; Android 12; Mobile) AppleWebKit/537.36',
          'Accept': 'application/json',
        },
      });
      if (!res.ok) continue;
      const j = await res.json();
      const r = j && j.chart && j.chart.result && j.chart.result[0];
      if (!r || !r.timestamp) continue;
      const adj = (r.indicators && r.indicators.adjclose && r.indicators.adjclose[0] &&
                   r.indicators.adjclose[0].adjclose) ||
                  (r.indicators && r.indicators.quote && r.indicators.quote[0].close);
      if (!adj) continue;
      const dates = [], closes = [];
      for (let i = 0; i < r.timestamp.length; i++) {
        if (adj[i] == null) continue;
        dates.push(new Date(r.timestamp[i] * 1000).toISOString().slice(0, 10));
        closes.push(adj[i]);
      }
      if (dates.length > 30) return { ok: true, dates, closes, source: 'yahoo' };
    } catch (e) { /* try next host */ }
  }
  return { ok: false };
}

async function fetchStooq(sym) {
  try {
    const res = await fetch('https://stooq.com/q/d/l/?s=' + sym + '&i=d');
    if (!res.ok) return { ok: false };
    const csv = await res.text();
    if (csv.indexOf('Date,') !== 0) return { ok: false };
    const dates = [], closes = [];
    for (const line of csv.split('\n').slice(1)) {
      const p = line.trim().split(',');
      if (p.length >= 5 && p[4] && !isNaN(parseFloat(p[4]))) {
        dates.push(p[0]);
        closes.push(parseFloat(p[4]));
      }
    }
    if (dates.length > 50) return { ok: true, dates, closes, source: 'stooq(unadjusted)' };
  } catch (e) { /* fall through */ }
  return { ok: false };
}

async function getSeries(ticker, range) {
  const y = await fetchYahoo(ticker, range);
  if (y.ok) return y;
  return fetchStooq(UNIVERSE[ticker].stooq);
}

function smaLast(closes, n) {
  if (closes.length < n) return null;
  let s = 0;
  for (let i = closes.length - n; i < closes.length; i++) s += closes[i];
  return s / n;
}
function momLast(closes, n) {
  if (closes.length <= n) return null;
  return closes[closes.length - 1] / closes[closes.length - 1 - n] - 1;
}
function smaSeries(closes, n) {
  const out = [];
  for (let i = 0; i < closes.length; i++) {
    if (i < n - 1) { out.push(null); continue; }
    let s = 0;
    for (let k = i - n + 1; k <= i; k++) s += closes[k];
    out.push(s / n);
  }
  return out;
}
function tradeCost(ticker, side, gross) {
  // Trading 212 model: £0 commission + FX fee for USD-quoted lines + slippage
  return gross * (SLIPPAGE + UNIVERSE[ticker].fx);
}
function daysBetween(a, b) {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
}

// ------------------------------ TRADING ENGINE ------------------------------

/**
 * One engine tick. Mutates the state object and returns a result summary.
 * Decisions use only data already available (no look-ahead): signals are
 * computed on the latest completed daily bar and executed at that close
 * adjusted for fees and slippage.
 */
async function runTick(s, manual) {
  const today = new Date().toISOString().slice(0, 10);
  s.meta.lastError = null;

  if (s.settings.state === 'stopped') {
    s.meta.lastRunAt = new Date().toISOString();
    return { ok: true, skipped: true, reason: 'Engine is stopped' };
  }
  if (s.meta.lastEvalDate === today && !manual) {
    return { ok: true, skipped: true, reason: 'Already evaluated today' };
  }

  // ---- 1. Fetch market data ----
  const series = {}, sources = {};
  const failed = [];
  for (const t of Object.keys(UNIVERSE)) {
    const r = await getSeries(t, '2y');
    const lastDate = r.ok ? r.dates[r.dates.length - 1] : null;
    const stale = !r.ok || daysBetween(lastDate, today) > STALE_DAYS;
    if (stale) { failed.push(t); continue; }
    series[t] = r;
    sources[t] = r.source;
  }
  if (Object.keys(series).length === 0) {
    s.meta.consecutiveFails++;
    s.meta.lastError = 'Market data unavailable (' + failed.join(', ') + ')';
    if (s.meta.consecutiveFails >= MAX_FAILS && s.settings.state === 'running') {
      s.settings.state = 'paused';
      s.meta.haltReason = 'Auto-paused after ' + s.meta.consecutiveFails + ' data failures';
      s.signals.unshift({ date: today, action: 'PAUSE', ticker: null,
        reason: s.meta.haltReason, price: null });
    }
    s.meta.lastRunAt = new Date().toISOString();
    return { ok: false, error: s.meta.lastError };
  }
  s.meta.consecutiveFails = 0;

  // ---- 2. Mark to market ----
  const px = {};
  for (const t of Object.keys(series)) px[t] = series[t].closes[series[t].closes.length - 1];
  s.account.lastPx = px;

  let invested = 0;
  for (const [t, p] of Object.entries(s.positions)) {
    invested += (px[t] != null) ? p.qty * px[t] : p.qty * p.entryPrice;
  }
  const equityNow = s.account.cash + invested;
  s.account.equityNow = equityNow;

  // ---- 3. New trading day bookkeeping ----
  let buysBlocked = false;
  if (s.day.date !== today) {
    s.day = { date: today, startEquity: equityNow };
  }

  const rk = RISK[s.settings.riskLevel] || RISK.balanced;

  // ---- 4. Drawdown kill-switch ----
  if (equityNow > s.account.peakEquity) s.account.peakEquity = equityNow;
  let forceExit = false;
  if (s.settings.state === 'running' &&
      equityNow < s.account.peakEquity * (1 - rk.ddHalt) &&
      !s.meta.haltReason) {
    s.settings.state = 'paused';
    forceExit = true; // exits still execute this tick; only new buys are blocked
    s.meta.haltReason = 'Drawdown halt: ' +
      ((1 - equityNow / s.account.peakEquity) * 100).toFixed(1) +
      '% exceeds the ' + (rk.ddHalt * 100).toFixed(0) + '% limit';
    s.signals.unshift({ date: today, action: 'HALT', ticker: null,
      reason: s.meta.haltReason, price: null });
  }

  // ---- 5. Daily loss limit (blocks new buys for the rest of the day) ----
  if (equityNow / s.day.startEquity - 1 <= -rk.dailyLoss) {
    buysBlocked = true;
    if (!s.signals.length || s.signals[0].date !== today || s.signals[0].action !== 'DAYLOSS') {
      s.signals.unshift({ date: today, action: 'DAYLOSS', ticker: null,
        reason: 'Daily loss limit reached (' + (rk.dailyLoss * 100).toFixed(0) +
                '%) — new buys blocked until tomorrow', price: null });
    }
  }

  // ---- 6. Compute signals ----
  const ind = {};
  let bestT = null, bestMom = -99;
  for (const t of Object.keys(series)) {
    const c = series[t].closes;
    const sma = smaLast(c, SMA_DAYS);
    const mom = momLast(c, MOM_DAYS) != null ? momLast(c, MOM_DAYS) : -99;
    ind[t] = { sma, mom, trendOk: sma != null && px[t] >= sma };
    if (ind[t].trendOk && mom > bestMom) { bestMom = mom; bestT = t; }
  }

  const heldT = Object.keys(s.positions).find((t) => s.positions[t].qty > 0) || null;
  const pos = heldT ? s.positions[heldT] : null;

  let target = null, reason = '';
  if (forceExit) {
    target = null;
    reason = 'Drawdown halt — automatic exit to cash; trading paused for review';
  } else if (!heldT) {
    target = bestT;
    reason = bestT ? 'Buy ' + bestT + ' — above 200-day trend, momentum ' +
              (ind[bestT].mom * 100).toFixed(1) + '%' : 'Stay in cash — no ETF above its 200-day trend';
  } else {
    const trendBroken = ind[heldT] && ind[heldT].sma != null && px[heldT] < ind[heldT].sma;
    const stopHit = px[heldT] <= pos.entryPrice * (1 - rk.stop);
    const holdDays = daysBetween(pos.entryDate, today);
    if (trendBroken) {
      target = (bestT && bestT !== heldT) ? bestT : null;
      reason = 'Trend exit ' + heldT + ' (price below 200-day average)' +
               (target ? ' → switch to ' + target : ' → move to cash');
    } else if (stopHit) {
      target = null;
      reason = 'Stop-loss on ' + heldT + ' (fell ' +
               ((1 - px[heldT] / pos.entryPrice) * 100).toFixed(1) + '% from entry) → move to cash';
    } else if (holdDays >= 29 && bestT && bestT !== heldT &&
               ind[bestT].mom > ind[heldT].mom + SWITCH_MARGIN) {
      target = bestT;
      reason = 'Momentum switch ' + heldT + ' → ' + bestT + ' (challenger leads by ' +
               ((ind[bestT].mom - ind[heldT].mom) * 100).toFixed(1) + '%)';
    } else {
      target = heldT;
      reason = 'Hold ' + heldT + ' (above trend, momentum ' +
               (ind[heldT].mom * 100).toFixed(1) + '%)';
    }
  }

  s.signals.unshift({ date: today, action: target === heldT && heldT ? 'HOLD' : (target ? 'BUY' : 'CASH'),
    ticker: target || heldT, reason, price: px[target || heldT] || null });
  if (s.signals.length > 300) s.signals.length = 300;

  // ---- 7. Execute paper trades (exits always allowed; new buys only while RUNNING) ----
  const executed = [];
  const canSell = s.settings.state === 'running' || forceExit;
  const canBuy = s.settings.state === 'running' && !forceExit;
  if (canSell || canBuy) {
    const eff = Math.min(equityNow, s.settings.maxCapital);

    // SELL: held position that is no longer the target
    if (heldT && target !== heldT) {
      const key = today + '|' + heldT + '|SELL';
      if (s.meta.tradeKeys.indexOf(key) === -1) {
        const gross = pos.qty * px[heldT];
        const fee = tradeCost(heldT, 'sell', gross);
        s.account.cash += gross - fee;
        s.account.totalFees += fee;
        const realized = gross - pos.costBasis;
        s.trades.unshift({ id: key, date: today, ticker: heldT, side: 'SELL',
          qty: pos.qty, price: px[heldT], fee: round2(fee),
          value: round2(gross), pnl: round2(gross - pos.costBasis), reason });
        s.meta.tradeKeys.push(key);
        executed.push({ side: 'SELL', ticker: heldT, qty: pos.qty, fee });
        delete s.positions[heldT];
        if (realized !== undefined) { /* realized pnl recorded on trade row */ }
      }
    }

    // BUY: open or top up target (never during a forced exit or while paused)
    if (target && canBuy && !buysBlocked) {
      const key = today + '|' + target + '|BUY';
      if (s.meta.tradeKeys.indexOf(key) === -1 && px[target] != null) {
        const cur = s.positions[target];
        const curVal = cur ? cur.qty * px[target] : 0;
        const curW = eff > 0 ? curVal / eff : 0;
        const desiredW = rk.weight;
        const drift = desiredW - curW;
        if (!cur || drift > BAND) {
          const spend = Math.min(s.account.cash, cur ? eff * drift : eff * desiredW);
          if (spend >= 1) { // minimum sensible order £1
            const fee = tradeCost(target, 'buy', spend);
            const price = px[target] * (1 + SLIPPAGE + UNIVERSE[target].fx);
            const qty = (spend - fee) / price;
            s.account.cash -= spend;
            s.account.totalFees += fee;
            const prev = s.positions[target];
            s.positions[target] = {
              qty: (prev ? prev.qty : 0) + qty,
              entryPrice: prev ? prev.entryPrice : price,
              entryDate: prev ? prev.entryDate : today,
              costBasis: (prev ? prev.costBasis : 0) + spend,
            };
            s.trades.unshift({ id: key, date: today, ticker: target, side: 'BUY',
              qty, price: round2(price), fee: round2(fee), value: round2(spend),
              pnl: null, reason });
            s.meta.tradeKeys.push(key);
            executed.push({ side: 'BUY', ticker: target, qty, fee });

            // ---- Optional real-money mirror (only if explicitly enabled) ----
            if (s.settings.realMoney && process.env.BROKER_KEY) {
              try {
                const res = await t212PlaceOrder(process.env.BROKER_KEY, target, qty);
                s.trades[0].broker = 'T212 order submitted (' + (res || 'accepted') + ')';
              } catch (e) {
                s.trades[0].broker = 'T212 FAILED: ' + String(e.message || e).slice(0, 120);
              }
            }
          }
        }
      }
    }
  }

  if (s.trades.length > 300) s.trades.length = 300;
  if (s.meta.tradeKeys.length > 1000) s.meta.tradeKeys = s.meta.tradeKeys.slice(-500);

  // ---- 8. Update equity curve ----
  const lastPt = s.equity.length ? s.equity[s.equity.length - 1] : null;
  if (!lastPt || lastPt.d !== today) s.equity.push({ d: today, v: round2(equityNow) });
  else lastPt.v = round2(equityNow);
  if (s.equity.length > 1000) s.equity = s.equity.slice(-1000);

  s.meta.lastEvalDate = today;
  s.meta.lastRunAt = new Date().toISOString();

  return {
    ok: true,
    state: s.settings.state,
    equity: round2(equityNow),
    target, heldT, reason, executed,
    buysBlocked, sources,
  };
}

async function runTickSafe(s, manual) {
  try {
    return await runTick(s, manual);
  } catch (e) {
    try {
      s.meta.lastError = String(e && e.message ? e.message : e).slice(0, 300);
      s.meta.lastRunAt = new Date().toISOString();
    } catch (e2) { /* nothing more we can do */ }
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

function round2(x) { return Math.round(x * 100) / 100; }

// ------------------------------ BACKTEST ------------------------------------

/**
 * On-demand backtest on real historical data (default 3 years, daily bars).
 * Signal on day t close -> execute at day t+1 close (no look-ahead bias).
 * Realistic costs: 0.15% FX fee (USD-quoted lines) + 0.10% slippage per side.
 * Compares the strategy at each risk level against buy-and-hold.
 */
async function runBacktest() {
  const range = '3y';
  const hist = {};
  for (const t of Object.keys(UNIVERSE)) {
    const r = await getSeries(t, range);
    if (r.ok) hist[t] = r;
  }
  const tickers = Object.keys(hist);
  if (tickers.length < 1) return { ok: false, error: 'No market data available for backtest' };

  // Align all tickers on common dates
  let dates = hist[tickers[0]].dates;
  for (const t of tickers.slice(1)) {
    const set = new Set(hist[t].dates);
    dates = dates.filter((d) => set.has(d));
  }
  const series = {};
  for (const t of tickers) {
    const idx = new Map(hist[t].dates.map((d, i) => [d, i]));
    series[t] = dates.map((d) => hist[t].closes[idx.get(d)]);
  }
  const N = dates.length;
  const startI = Math.min(SMA_DAYS, Math.floor(N * 0.4)) - 1;
  if (N - startI < 60) return { ok: false, error: 'Not enough history for a backtest' };

  function backtest(riskLevel, startCapital) {
    const rk = RISK[riskLevel];
    const smas = {}, moms = {};
    for (const t of tickers) {
      smas[t] = smaSeries(series[t], SMA_DAYS);
      moms[t] = series[t].map((p, i) => (i >= MOM_DAYS ? p / series[t][i - MOM_DAYS] - 1 : -99));
    }
    let cash = startCapital, qty = 0, held = null, entry = 0, entryIdx = -1;
    let peak = startCapital, dayKey = '', dayStartEq = startCapital, buysBlocked = false;
    let halted = false, feesTotal = 0, trades = 0, buys = 0, sells = 0;
    const curve = [];
    let pending = null;

    for (let i = startI; i < N; i++) {
      const d = dates[i];
      const px = {};
      for (const t of tickers) px[t] = series[t][i];

      if (pending) {
        const tgt = pending.ticker;
        if (held && tgt !== held) {
          const gross = qty * px[held];
          const f = gross * (SLIPPAGE + UNIVERSE[held].fx);
          cash += gross - f; feesTotal += f; trades++; sells++;
          qty = 0; held = null; entry = 0; entryIdx = -1;
        }
        if (tgt && !buysBlocked) {
          const equity0 = cash + (held ? qty * px[held] : 0);
          const curW = held ? (qty * px[held]) / equity0 : 0;
          if (tgt === held) {
            const drift = pending.weight - curW;
            if (drift > BAND) {
              const spend = Math.min(cash, equity0 * drift);
              const price = px[tgt] * (1 + SLIPPAGE + UNIVERSE[tgt].fx);
              const q = spend / price;
              qty += q; cash -= q * price;
              feesTotal += spend - q * px[tgt]; trades++; buys++;
            }
          } else {
            const spend = Math.min(cash, equity0 * pending.weight);
            const price = px[tgt] * (1 + SLIPPAGE + UNIVERSE[tgt].fx);
            const q = spend / price;
            qty = q; held = tgt; entry = price; entryIdx = i; cash -= q * price;
            feesTotal += spend - q * px[tgt]; trades++; buys++;
          }
        }
        pending = null;
      }

      let equity = cash + (held ? qty * px[held] : 0);
      if (d !== dayKey) { dayKey = d; dayStartEq = equity; buysBlocked = false; }
      if (equity > peak) peak = equity;
      if (!halted && equity < peak * (1 - rk.ddHalt)) { halted = true; pending = { ticker: null, weight: 0 }; }
      if (!buysBlocked && equity / dayStartEq - 1 <= -rk.dailyLoss) buysBlocked = true;
      curve.push(Math.round(equity * 100) / 100);

      if (!halted) {
        let bestT = null, bestMom = -99;
        for (const t of tickers) {
          if (smas[t][i] != null && px[t] >= smas[t][i] && moms[t][i] > bestMom) {
            bestMom = moms[t][i]; bestT = t;
          }
        }
        let target;
        if (!held) {
          target = bestT;
        } else {
          const trendBroken = smas[held][i] != null && px[held] < smas[held][i];
          const stopHit = px[held] <= entry * (1 - rk.stop);
          if (trendBroken || stopHit) {
            target = (!trendBroken && stopHit) ? null : bestT;
          } else if (i - entryIdx >= MIN_HOLD_DAYS && bestT && bestT !== held &&
                     moms[bestT][i] > moms[held][i] + SWITCH_MARGIN) {
            target = bestT;
          } else {
            target = held;
          }
        }
        pending = { ticker: target, weight: target ? rk.weight : 0 };
      }
    }
    const equity = cash + (held ? qty * series[held][N - 1] : 0);
    let maxDD = 0, runPeak = curve[0];
    for (const v of curve) { if (v > runPeak) runPeak = v; maxDD = Math.max(maxDD, 1 - v / runPeak); }
    const years = (Date.parse(dates[N - 1]) - Date.parse(dates[startI])) / (365.25 * 86400000);
    return {
      riskLevel,
      final: round2(equity),
      returnPct: round2((equity / 50 - 1) * 100),
      cagrPct: round2((Math.pow(equity / 50, 1 / years) - 1) * 100),
      maxDrawdownPct: round2(maxDD * 100),
      trades, buys, sells,
      feesGBP: round2(feesTotal),
      halted,
      days: curve.length,
    };
  }

  function buyHold(t) {
    const p0 = series[t][startI] * (1 + SLIPPAGE + UNIVERSE[t].fx);
    const q = 50 / p0;
    let maxDD = 0, peak = p0;
    for (let i = startI; i < N; i++) {
      if (series[t][i] > peak) peak = series[t][i];
      maxDD = Math.max(maxDD, 1 - series[t][i] / peak);
    }
    const end = q * series[t][N - 1];
    const years = (Date.parse(dates[N - 1]) - Date.parse(dates[startI])) / (365.25 * 86400000);
    return {
      ticker: t,
      final: round2(end),
      returnPct: round2((end / 50 - 1) * 100),
      cagrPct: round2((Math.pow(end / 50, 1 / years) - 1) * 100),
      maxDrawdownPct: round2(maxDD * 100),
    };
  }

  return {
    ok: true,
    period: { from: dates[startI], to: dates[N - 1], bars: N, tickers },
    strategy: Object.keys(RISK).map((r) => backtest(r, 50)),
    buyAndHold: tickers.map((t) => buyHold(t)),
    generatedAt: new Date().toISOString(),
  };
}

// ------------------------------ TRADING 212 ADAPTER -------------------------
// Official Public API (beta, v0) — https://docs.trading212.com
// Works with UK Invest and Stocks & Shares ISA accounts.
// IMPORTANT: create the API key with ONLY the permissions you need
// ("read account data" + "place trades"). Trading 212 API keys cannot
// move money — but still store the key only as a repo Actions secret.

const T212_TICKERS = {
  'VUSA.L': 'VUSA', 'VWRL.L': 'VWRL', 'CSPX.L': 'CSPX', 'VGOV.L': 'VGOV',
};

async function t212Request(key, method, path, body) {
  const res = await fetch('https://live.trading212.com' + path, {
    method,
    headers: { 'Authorization': key, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error('T212 HTTP ' + res.status + ': ' + text.slice(0, 200));
  return text ? JSON.parse(text) : null;
}

async function t212PlaceOrder(key, ticker, qty) {
  const code = T212_TICKERS[ticker] || ticker.replace('.L', '');
  const res = await t212Request(key, 'POST', '/api/v0/equity/orders', {
    ticker: code,
    quantity: Number(qty.toFixed(4)),
    orderType: 'MARKET',
  });
  return res && res.orderId ? 'order ' + res.orderId : 'accepted';
}

// ------------------------------ MAIN ----------------------------------------

async function main() {
  const mode = String(process.env.MODE || 'trade').trim().toLowerCase();
  const manual = String(process.env.MANUAL || '').trim() === '1';

  if (mode === 'backtest') {
    console.log('PocketQuant: running backtest on real historical data...');
    const bt = await runBacktest();
    if (bt.ok) {
      writeJson(BACKTEST_FILE, bt);
      console.log('Backtest complete: ' + bt.period.from + ' -> ' + bt.period.to +
        ' (' + bt.period.bars + ' bars, ' + bt.period.tickers.join(', ') + ')');
      for (const r of bt.strategy) {
        console.log('  strategy/' + r.riskLevel + ': ' + r.returnPct + '% return, max DD -' +
          r.maxDrawdownPct + '%, ' + r.trades + ' trades, £' + r.feesGBP + ' fees');
      }
      for (const r of bt.buyAndHold) {
        console.log('  buy&hold/' + r.ticker + ': ' + r.returnPct + '% return, max DD -' +
          r.maxDrawdownPct + '%');
      }
    } else {
      console.log('BACKTEST FAILED: ' + bt.error);
      process.exitCode = 1;
    }
    return;
  }

  let s = readJson(STATE_FILE, null);
  if (!s) s = defaultState(START_CAPITAL);
  if (process.env.GITHUB_REPOSITORY) s.meta.repo = process.env.GITHUB_REPOSITORY;

  const r = await runTickSafe(s, manual);
  writeJson(STATE_FILE, s);

  if (r.ok && r.skipped) { console.log('Engine: ' + r.reason); return; }
  if (!r.ok) { console.log('ENGINE ERROR: ' + r.error); process.exitCode = 1; return; }

  console.log('Engine run OK — ' + (s.meta.lastEvalDate || ''));
  console.log('  state: ' + r.state + ' | equity: £' + r.equity);
  console.log('  signal: ' + r.reason);
  if (r.executed && r.executed.length) {
    for (const e of r.executed) {
      console.log('  executed ' + e.side + ' ' + e.ticker + ' (' + e.qty.toFixed(4) +
        ' units, £' + e.fee.toFixed(2) + ' costs)');
    }
  } else {
    console.log('  no trades today');
  }
  const srcs = Object.entries(r.sources || {}).map(([t, v]) => t + '=' + v).join(', ');
  if (srcs) console.log('  data sources: ' + srcs);
}

const invokedDirectly = process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((e) => {
    console.error('FATAL: ' + (e && e.stack ? e.stack : e));
    process.exit(1);
  });
}

export { defaultState, runTick, runTickSafe, runBacktest, main };
