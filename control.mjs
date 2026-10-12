#!/usr/bin/env node
/**
 * ============================================================================
 *  PocketQuant — control panel (GitHub Actions edition)
 * ============================================================================
 *  Run from the "PocketQuant Controls" workflow (Actions tab). You pick an
 *  action from a dropdown, press "Run workflow", and it is applied — usually
 *  within a minute. The result is committed to data/state.json and shows up
 *  on your dashboard page.
 *
 *  Actions: start, pause, stop, emergency, reset, enable-real-money,
 *           disable-real-money, broker-check
 *
 *  REAL MONEY stays impossible unless ALL of these are true:
 *    1. The secret BROKER_KEY is set (Trading 212 key, orders + read ONLY)
 *    2. The secret REAL_MONEY_CONFIRM contains exactly: ENABLE REAL MONEY
 *    3. You run the "enable-real-money" action
 * ============================================================================
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultState } from './engine.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(ROOT, 'data', 'state.json');

const RISK_LEVELS = ['conservative', 'balanced', 'growth'];

function readJson(file, dflt) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return dflt; }
}
function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

/**
 * Applies one control action to the state object (mutates it).
 * Returns { ok, message }. Mirrors the tested worker control API.
 */
export function applyControl(s, o) {
  switch (o.action) {
    case 'start':
    case 'resume':
      s.settings.state = 'running';
      s.settings.emergency = false;
      s.meta.haltReason = null;
      return { ok: true, message: 'Engine RUNNING — it will trade on the next scheduled run (weekdays ~17:23 UTC) or when you press "Run engine now".' };
    case 'pause':
      s.settings.state = 'paused';
      return { ok: true, message: 'Engine PAUSED — no new buys; existing position stays until the next exit signal.' };
    case 'stop':
      s.settings.state = 'stopped';
      return { ok: true, message: 'Engine STOPPED — no automatic trading until you press Start again.' };
    case 'emergency':
      s.settings.state = 'stopped';
      s.settings.emergency = true;
      s.settings.realMoney = false; // real money always off on emergency stop
      return { ok: true, message: 'EMERGENCY STOP — engine halted, real money forced OFF.' };
    case 'reset': {
      if (o.confirm !== 'RESET') {
        return { ok: false, message: 'Reset aborted: type RESET in the confirm_reset field.' };
      }
      const cap = s.settings.maxCapital;
      const risk = s.settings.riskLevel;
      const fresh = defaultState(cap);
      fresh.settings.riskLevel = risk;
      fresh.settings.realMoney = false;
      for (const k of Object.keys(s)) delete s[k];
      Object.assign(s, fresh);
      return { ok: true, message: 'Paper account reset to £' + cap + '.' };
    }
    case 'set-risk':
      if (RISK_LEVELS.indexOf(o.risk) === -1) {
        return { ok: false, message: 'Unknown risk level: ' + o.risk };
      }
      s.settings.riskLevel = o.risk;
      return { ok: true, message: 'Risk level set to ' + o.risk + '.' };
    case 'set-capital': {
      const cap = Number(o.capital);
      if (!(cap > 0)) return { ok: false, message: 'maxCapital must be a number > 0' };
      s.settings.maxCapital = cap;
      return { ok: true, message: 'Max capital set to £' + cap + '.' };
    }
    case 'enable-real-money':
      if (!o.brokerKey) {
        return { ok: false, message: 'Real money stays OFF: the BROKER_KEY secret is not set. Add your Trading 212 API key (orders + read permissions ONLY) under Settings → Secrets and variables → Actions.' };
      }
      if (o.confirmRealMoney !== 'ENABLE REAL MONEY') {
        return { ok: false, message: 'Real money stays OFF: set the secret REAL_MONEY_CONFIRM to the exact text: ENABLE REAL MONEY' };
      }
      s.settings.realMoney = true;
      return { ok: true, message: 'REAL MONEY ENABLED — the engine will mirror its paper orders to Trading 212. Start small and monitor closely.' };
    case 'disable-real-money':
      s.settings.realMoney = false;
      return { ok: true, message: 'Real money DISABLED — paper trading only.' };
    default:
      return { ok: false, message: 'Unknown action: ' + o.action };
  }
}

async function brokerCheck() {
  if (!process.env.BROKER_KEY) {
    return { ok: false, message: 'BROKER_KEY secret is not set. Paper trading is unaffected.' };
  }
  try {
    const res = await fetch('https://live.trading212.com/api/v0/equity/account/info', {
      headers: { 'Authorization': process.env.BROKER_KEY, 'Content-Type': 'application/json' },
    });
    const text = await res.text();
    if (!res.ok) {
      // Do not print the response body: workflow logs on a public repo are public.
      return { ok: false, message: 'Broker check FAILED (HTTP ' + res.status + '). Check the key and its permissions.' };
    }
    return { ok: true, message: 'Broker check OK — Trading 212 responded (account details kept private).' };
  } catch (e) {
    return { ok: false, message: 'Broker check failed: ' + String(e && e.message ? e.message : e).slice(0, 120) };
  }
}

async function main() {
  const action = String(process.env.ACTION || '').trim();

  let s = readJson(STATE_FILE, null);
  if (!s) s = defaultState();
  if (process.env.GITHUB_REPOSITORY) s.meta.repo = process.env.GITHUB_REPOSITORY;

  if (action === 'broker-check') {
    const r = await brokerCheck();
    s.meta.brokerCheck = { ok: r.ok, message: r.message, at: new Date().toISOString() };
    writeJson(STATE_FILE, s);
    console.log(r.message);
    if (!r.ok) process.exitCode = 1; // still commit state so the dashboard shows the check
    return;
  }

  const o = {
    action,
    risk: String(process.env.RISK || '').trim(),
    capital: String(process.env.CAPITAL || '').trim(),
    confirm: String(process.env.CONFIRM || '').trim(),
    brokerKey: process.env.BROKER_KEY || '',
    confirmRealMoney: process.env.REAL_MONEY_CONFIRM || '',
  };

  const messages = [];
  if (o.risk && o.risk !== 'keep') {
    const r = applyControl(s, { action: 'set-risk', risk: o.risk });
    messages.push(r.message);
    if (!r.ok) { for (const m of messages) console.log(m); process.exit(1); }
  }
  if (o.capital) {
    const r = applyControl(s, { action: 'set-capital', capital: o.capital });
    messages.push(r.message);
    if (!r.ok) { for (const m of messages) console.log(m); process.exit(1); }
  }
  const r = applyControl(s, o);
  messages.push(r.message);
  for (const m of messages) console.log(m);

  if (r.ok) writeJson(STATE_FILE, s);
  else process.exitCode = 1; // failure: nothing to commit (state unchanged)
}

const invokedDirectly = process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((e) => {
    console.error('FATAL: ' + (e && e.stack ? e.stack : e));
    process.exit(1);
  });
}

export { main };
