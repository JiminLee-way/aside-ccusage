#!/usr/bin/env node
// usage-window: token totals for an exact clock window across the raw logs on this Mac.
// ccusage itself only filters by calendar day, so this script re-reads the three sources
// that carry almost all usage here (Claude Code, Codex CLI, Aside Browser) and sums
// everything whose timestamp falls inside [from, to).
//
//   node usage-window.mjs --from "2026-10-31T09:00" --to "2026-10-31T17:00" [--tz Asia/Seoul] [--json]
//
// Sources
//   Claude Code : ~/.claude/projects/**/*.jsonl        type=assistant, message.usage, dedupe message.id+requestId
//   Codex CLI   : ~/.codex/sessions/**/*.jsonl[.zst]  event_msg/token_count, last_token_usage (or cumulative delta)
//   Aside       : ~/.aside/u/*/sessions/*/messages.jsonl  role=assistant, usage{input,output,cacheRead,cacheWrite,cost}
// Not covered: grok, opencode, antigravity (small on this machine; use `ccusage daily` for day totals).
// Codex compaction/subagent-replay corner cases are not reproduced, so Codex numbers can differ
// slightly from `ccusage codex daily`.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => a.startsWith('--') ? [a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : 'true'] : []).filter(Boolean));
const TZ = args.tz ?? 'Asia/Seoul';
if (!args.from || !args.to) { console.error('usage: usage-window.mjs --from YYYY-MM-DDTHH:MM --to YYYY-MM-DDTHH:MM [--tz Zone] [--json]'); process.exit(2); }

// Interpret a wall-clock time in TZ -> epoch ms (two-pass offset correction).
function wallToMs(s, tz) {
  const [d, t = '00:00'] = s.split('T'); const [Y, M, D] = d.split('-').map(Number); const [h, m] = t.split(':').map(Number);
  let guess = Date.UTC(Y, M - 1, D, h, m);
  for (let k = 0; k < 2; k++) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(guess)).map(p => [p.type, p.value]));
    const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
    guess += Date.UTC(Y, M - 1, D, h, m) - asUtc;
  }
  return guess;
}
const FROM = wallToMs(args.from, TZ), TO = wallToMs(args.to, TZ);
const inWin = (ms) => Number.isFinite(ms) && ms >= FROM && ms < TO;
const HOME = os.homedir();

function* walk(dir, exts) {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p, exts);
    else if (exts.some(x => e.name.endsWith(x))) yield p;
  }
}
const readText = (p) => p.endsWith('.zst') ? zlib.zstdDecompressSync(fs.readFileSync(p)).toString('utf8') : fs.readFileSync(p, 'utf8');

// Pricing (USD per 1M tokens) copied from ccusage's embedded models.dev snapshot (rust/crates/ccusage-pricing-snapshots).
// `long` = long-context tier applied to the whole request when total input (incl. cached) exceeds `threshold` (OpenAI: 272K).
// Pass --pricing <models-dev-pricing.json> to load the full snapshot instead.
let PRICING = {
  'claude-opus-5-5':  { input: 4,  output: 20, cache_read: 0.2,  cache_write: 5 },
  'claude-fable-5-1': { input: 10, output: 50, cache_read: 0.25, cache_write: 12.5 },
  'claude-opus-4-8':  { input: 5,  output: 25, cache_read: 0.5,  cache_write: 6.25 },
  'claude-sonnet-5-5':{ input: 2,  output: 10, cache_read: 0.1,  cache_write: 2.5 },
  'claude-opus-5':    { input: 5,  output: 25, cache_read: 0.5,  cache_write: 6.25 },
  'gpt-6-sol':   { input: 2,   output: 10,  cache_read: 0.2,  cache_write: 2.5,   threshold: 272000, long: { input: 4,  output: 15,  cache_read: 0.4,  cache_write: 5 } },
  'gpt-6-astra': { input: 10,  output: 50,  cache_read: 1,    cache_write: 12.5,  threshold: 272000, long: { input: 20, output: 75,  cache_read: 2,    cache_write: 25 } },
  'gpt-5.6-sol': { input: 4,   output: 20,  cache_read: 0.4,  cache_write: 5,     threshold: 272000, long: { input: 8,  output: 30,  cache_read: 0.8,  cache_write: 10 } },
  'gpt-6-luna':  { input: 0.1, output: 0.5, cache_read: 0.01, cache_write: 0.125, threshold: 272000, long: { input: 0.2, output: 0.75, cache_read: 0.02, cache_write: 0.25 } },
  'gpt-6.1-sol': { input: 2,   output: 10,  cache_read: 0.1,  cache_write: 2.5,   threshold: 272000, long: { input: 4,  output: 15,  cache_read: 0.2,  cache_write: 5 } },
  'gpt-6.1-terra':{ input: 1,  output: 5,   cache_read: 0.05, cache_write: 1.25,  threshold: 272000, long: { input: 2,  output: 7.5, cache_read: 0.1,  cache_write: 2.5 } },
};
if (args.pricing) {
  const snap = JSON.parse(fs.readFileSync(args.pricing, 'utf8'));
  for (const [k, v] of Object.entries(snap)) {
    if (!v?.cost || k.includes('/') || k.includes('.') && !/^gpt-|^claude-/.test(k)) continue;
    const t = (v.cost.tiers || []).find(t => t.tier?.type === 'context');
    PRICING[k] = { input: v.cost.input, output: v.cost.output, cache_read: v.cost.cache_read ?? v.cost.input, cache_write: v.cost.cache_write ?? v.cost.input * 1.25,
      ...(t ? { threshold: t.tier.size, long: { input: t.input, output: t.output, cache_read: t.cache_read, cache_write: t.cache_write } } : {}) };
  }
}
const stripDate = (m) => m.replace(/-\d{4}-\d{2}-\d{2}$|-\d{8}$/, '');
function price(model, u) {
  const p = PRICING[stripDate(model)]; if (!p) return undefined;
  const totalInput = (u.input || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0);
  const r = (p.long && p.threshold && totalInput > p.threshold) ? p.long : p;
  const cw1h = Math.min(u.cacheWrite1h || 0, u.cacheWrite || 0), cw5 = (u.cacheWrite || 0) - cw1h;
  return ((u.input || 0) * r.input + (u.output || 0) * r.output + (u.cacheRead || 0) * r.cache_read + cw5 * r.cache_write + cw1h * r.input * 2) / 1e6;
}
const totals = {}; // agent -> model -> {calls,input,output,cacheWrite,cacheRead,cost,costKnown}
function add(agent, model, u) {
  const a = totals[agent] ??= {}; const r = a[model] ??= { calls: 0, input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0, costKnown: 0 };
  r.calls++; r.input += u.input || 0; r.output += u.output || 0; r.cacheWrite += u.cacheWrite || 0; r.cacheRead += u.cacheRead || 0;
  let c = typeof u.cost === 'number' ? u.cost : price(model.replace(/ \(.*\)$/, ''), u);
  if (typeof c === 'number' && u.mult) c *= u.mult;
  if (typeof c === 'number') { r.cost += c; r.costKnown++; }
}

// --- Claude Code -----------------------------------------------------------
{
  const seen = new Set();
  for (const root of [path.join(HOME, '.claude', 'projects'), path.join(HOME, '.config', 'claude', 'projects')]) {
    for (const f of walk(root, ['.jsonl'])) {
      // cheap mtime prune: a file last written before the window cannot contain it
      if (fs.statSync(f).mtimeMs < FROM - 86400e3) continue;
      for (const line of readText(f).split('\n')) {
        if (!line.includes('"usage":{')) continue;
        let o; try { o = JSON.parse(line); } catch { continue; }
        if (o.type !== 'assistant' || !o.message?.usage) continue;
        const ms = Date.parse(o.timestamp); if (!inWin(ms)) continue;
        const key = (o.message.id ?? '') + ':' + (o.requestId ?? ''); if (key !== ':' && seen.has(key)) continue; seen.add(key);
        const u = o.message.usage; const model = o.message.model ?? 'unknown'; if (model === '<synthetic>') continue;
        const cw5 = u.cache_creation?.ephemeral_5m_input_tokens, cw1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
        add('claude', model, { input: u.input_tokens, output: u.output_tokens, cacheWrite: u.cache_creation_input_tokens ?? ((cw5 ?? 0) + cw1h), cacheWrite1h: cw1h, cacheRead: u.cache_read_input_tokens, cost: typeof o.costUSD === 'number' ? o.costUSD : undefined });
      }
    }
  }
}

// --- Codex CLI -------------------------------------------------------------
{
  const codexHome = process.env.CODEX_HOME ?? path.join(HOME, '.codex');
  let CODEX_DEFAULT_TIER = 'standard';
  try { const m = /^\s*service_tier\s*=\s*"([a-z]+)"/m.exec(fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8')); if (m) CODEX_DEFAULT_TIER = ({ priority: 'fast', fast: 'fast', flex: 'flex', ultrafast: 'ultrafast' })[m[1]] ?? 'standard'; } catch {}
  const seenRollout = new Set();
  for (const root of [path.join(codexHome, 'sessions'), path.join(codexHome, 'archived_sessions')]) {
    for (const f of walk(root, ['.jsonl', '.jsonl.zst'])) {
      const base = path.basename(f).replace(/\.zst$/, ''); if (seenRollout.has(base)) continue; seenRollout.add(base);
      if (fs.statSync(f).mtimeMs < FROM - 86400e3) continue;
      const text = readText(f); const lines = text.split('\n');
      // MultiAgent subagent rollouts replay the parent's history first; usage before `task_started` is inherited.
      const taskStartIdx = lines.findIndex(l => l.includes('"task_started"'));
      let model = 'gpt-5'; let prev = null; let tier = CODEX_DEFAULT_TIER;
      lines.forEach((line, idx) => {
        if (!line) return; let o; try { o = JSON.parse(line); } catch { return; }
        if (o.type === 'turn_context' && o.payload?.model) { model = o.payload.model; return; }
        if (o.type === 'event_msg' && o.payload?.type === 'thread_settings_applied') {
          const st = o.payload.thread_settings?.service_tier; if (st !== undefined) tier = ({ priority: 'fast', fast: 'fast', flex: 'flex', ultrafast: 'ultrafast', default: 'standard', standard: 'standard' })[st] ?? 'standard'; return;
        }
        if (o.type !== 'event_msg' || o.payload?.type !== 'token_count' || !o.payload.info) return;
        const info = o.payload.info; const tot = info.total_token_usage;
        if (tot && prev && tot.input_tokens === prev.input_tokens && tot.output_tokens === prev.output_tokens && tot.cached_input_tokens === prev.cached_input_tokens) return; // repeated snapshot, no new usage
        let d = info.last_token_usage;
        if (!d && tot) d = prev ? { input_tokens: tot.input_tokens - prev.input_tokens, cached_input_tokens: tot.cached_input_tokens - prev.cached_input_tokens, output_tokens: tot.output_tokens - prev.output_tokens } : tot;
        if (tot) prev = tot;
        if (!d) return;
        if (taskStartIdx >= 0 && idx < taskStartIdx) return;
        const ms = Date.parse(o.timestamp); if (!inWin(ms)) return;
        const mult = tier === 'fast' ? 2 : tier === 'flex' ? 0.5 : 1;
        // Codex counts cached prompt tokens inside input_tokens; ccusage reports input as the uncached remainder.
        add('codex', model, { input: Math.max(0, (d.input_tokens || 0) - (d.cached_input_tokens || 0)), output: d.output_tokens, cacheRead: d.cached_input_tokens, cacheWrite: d.cache_write_input_tokens ?? 0, mult });
      });
    }
  }
}

// --- Aside Browser ---------------------------------------------------------
{
  const asideHome = process.env.ASIDE_HOME ?? path.join(HOME, '.aside');
  for (const f of walk(path.join(asideHome, 'u'), ['messages.jsonl'])) {
    if (fs.statSync(f).mtimeMs < FROM - 86400e3) continue;
    for (const line of readText(f).split('\n')) {
      if (!line.includes('"usage"')) continue; let o; try { o = JSON.parse(line); } catch { continue; }
      if (o.role !== 'assistant' || !o.usage) continue;
      const ms = typeof o.timestamp === 'number' ? o.timestamp : Date.parse(o.timestamp); if (!inWin(ms)) continue;
      const u = o.usage;
      add('aside', `${o.model ?? 'unknown'} (${o.provider ?? '?'})`, { input: u.input, output: u.output, cacheWrite: u.cacheWrite, cacheWrite1h: u.cacheWrite1h, cacheRead: u.cacheRead, cost: u.cost?.total });
    }
  }
}

// --- report ---------------------------------------------------------------
const fmt = (n) => n.toLocaleString('en-US');
const sum = (rows) => rows.reduce((s, r) => ({ calls: s.calls + r.calls, input: s.input + r.input, output: s.output + r.output, cacheWrite: s.cacheWrite + r.cacheWrite, cacheRead: s.cacheRead + r.cacheRead, cost: s.cost + r.cost, costKnown: s.costKnown + r.costKnown }), { calls: 0, input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0, costKnown: 0 });
const out = { window: { from: args.from, to: args.to, tz: TZ, fromUtc: new Date(FROM).toISOString(), toUtc: new Date(TO).toISOString() }, agents: {} };
for (const [agent, models] of Object.entries(totals)) {
  const t = sum(Object.values(models)); out.agents[agent] = { ...t, totalTokens: t.input + t.output + t.cacheWrite + t.cacheRead, models };
}
const all = sum(Object.values(out.agents)); out.total = { ...all, totalTokens: all.input + all.output + all.cacheWrite + all.cacheRead };
if (args.json) { console.log(JSON.stringify(out, null, 2)); process.exit(0); }

console.log(`Window ${args.from} -> ${args.to} (${TZ})  = ${out.window.fromUtc} -> ${out.window.toUtc}\n`);
const line = (name, r) => console.log(`${name.padEnd(42)} ${fmt(r.calls).padStart(6)} ${fmt(r.input).padStart(12)} ${fmt(r.output).padStart(11)} ${fmt(r.cacheWrite).padStart(12)} ${fmt(r.cacheRead).padStart(15)} ${fmt(r.input + r.output + r.cacheWrite + r.cacheRead).padStart(15)} ${(r.costKnown ? '$' + r.cost.toFixed(2) + (r.costKnown < r.calls ? '*' : '') : '-').padStart(10)}`);
console.log(`${'agent / model'.padEnd(42)} ${'calls'.padStart(6)} ${'input'.padStart(12)} ${'output'.padStart(11)} ${'cache write'.padStart(12)} ${'cache read'.padStart(15)} ${'total tokens'.padStart(15)} ${'cost'.padStart(10)}`);
for (const [agent, a] of Object.entries(out.agents).sort((x, y) => y[1].totalTokens - x[1].totalTokens)) {
  line(agent, a);
  for (const [m, r] of Object.entries(a.models).sort((x, y) => (y[1].input + y[1].output + y[1].cacheRead) - (x[1].input + x[1].output + x[1].cacheRead))) line('   ' + m, r);
}
line('TOTAL', out.total);
console.log('\ncost: Aside = its own stored per-call estimate; Claude Code / Codex = token-priced with ccusage\'s models.dev rates incl. the OpenAI long-context tier. "*" = some calls had no pricing entry.');
