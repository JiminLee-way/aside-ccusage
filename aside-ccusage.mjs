#!/usr/bin/env node
// aside-ccusage: make Aside Browser (https://aside.com) usage visible in ccusage.
//
// Aside keeps one transcript per task at ~/.aside/u/<account>/sessions/<date>_<id>/messages.jsonl.
// Each assistant record carries {model, provider, usage:{input, output, cacheRead, cacheWrite,
// totalTokens, cost:{total}}}. ccusage cannot read that layout, but its pi adapter accepts
// "named stores" in the same token vocabulary, so this tool mirrors Aside transcripts into a
// pi-format store and registers it as agent "aside" in ccusage.json. After that, plain
// `ccusage daily` / `weekly` / `monthly` / `session` show an "aside" agent with models labelled
// "[aside] <model>", costs taken from Aside's own per-call estimate.
//
// Commands
//   aside-ccusage setup            write pi.stores entry into ~/.claude/ccusage.json (or XDG path)
//   aside-ccusage sync             mirror new/changed Aside transcripts into the store (incremental)
//   aside-ccusage <ccusage args>   sync, then run `ccusage <args>` (e.g. `aside-ccusage daily --last 7`)
//
// Options (env or flags)
//   --src <dir>        Aside home          (default $ASIDE_HOME or ~/.aside)
//   --store <dir>      pi-format store dir (default $ASIDE_CCUSAGE_STORE or ~/.aside-ccusage/sessions)
//   --name <agent>     agent name in reports (default "aside")
//   --provider <p>     only mirror records from one Aside provider (claude-code | openai-codex | aside)
//   --format claude    alternative: write Claude Code JSONL for CLAUDE_CONFIG_DIR instead of a pi store
//   --full             ignore mtimes and rewrite every session

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawnSync } from 'node:child_process';

const HOME = os.homedir();
const expand = (p) => path.resolve(p.replace(/^~(?=$|\/)/, HOME));

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const m = /^--(src|store|name|provider|format)(?:=(.*))?$/.exec(a);
    if (m) { opts[m[1]] = m[2] ?? argv[++i]; continue; }
    if (a === '--full') { opts.full = true; continue; }
    opts._.push(a);
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
const SRC = expand(opts.src ?? process.env.ASIDE_HOME ?? '~/.aside');
const FORMAT = opts.format ?? 'pi';
const STORE = expand(opts.store ?? process.env.ASIDE_CCUSAGE_STORE ?? (FORMAT === 'claude' ? '~/.aside-ccusage/claude' : '~/.aside-ccusage/sessions'));
const NAME = opts.name ?? 'aside';
const PROVIDER = opts.provider ?? null;

function* asideSessions() {
  const users = path.join(SRC, 'u');
  if (!fs.existsSync(users)) return;
  for (const acct of fs.readdirSync(users).sort()) {
    const sessions = path.join(users, acct, 'sessions');
    if (!fs.existsSync(sessions)) continue;
    for (const dir of fs.readdirSync(sessions).sort()) {
      const file = path.join(sessions, dir, 'messages.jsonl');
      if (fs.existsSync(file)) yield { acct, dir, file };
    }
  }
}

async function readAssistantRecords(file) {
  const out = [];
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.includes('"usage"')) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.role !== 'assistant' || !m.usage || typeof m.usage !== 'object') continue;
    if (PROVIDER && m.provider !== PROVIDER) continue;
    out.push(m);
  }
  return out;
}

const iso = (ms) => new Date(ms).toISOString();

function toPiLines({ acct, dir }, records) {
  const sessionId = dir.replace(/^\d{4}-\d{2}-\d{2}_/, '');
  const lines = [JSON.stringify({
    type: 'session', version: 1, id: sessionId,
    timestamp: iso(records[0].timestamp ?? Date.now()),
    cwd: `aside://u/${acct}/sessions/${dir}`,
  })];
  records.forEach((m, i) => {
    const u = m.usage;
    const usage = {
      input: u.input ?? 0, output: u.output ?? 0,
      cacheRead: u.cacheRead ?? 0, cacheWrite: u.cacheWrite ?? 0,
      totalTokens: u.totalTokens ?? ((u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0)),
    };
    if (u.cost && typeof u.cost.total === 'number') usage.cost = { total: u.cost.total };
    lines.push(JSON.stringify({
      type: 'message', id: m.responseId ?? `${sessionId}-${i + 1}`,
      timestamp: iso(m.timestamp ?? m.completedAt ?? Date.now()),
      message: { role: 'assistant', model: m.model ?? 'unknown', provider: m.provider, usage },
    }));
  });
  return lines;
}

function toClaudeLines({ acct, dir }, records) {
  const sessionId = dir.replace(/^\d{4}-\d{2}-\d{2}_/, '');
  return records.map((m, i) => {
    const u = m.usage; const id = m.responseId ?? `${sessionId}-${i + 1}`;
    const rec = {
      type: 'assistant', timestamp: iso(m.timestamp ?? m.completedAt ?? Date.now()),
      sessionId, uuid: `${sessionId}-${i + 1}`, requestId: id, cwd: `aside://u/${acct}/sessions/${dir}`,
      message: { id, type: 'message', role: 'assistant', model: m.model ?? 'unknown',
        usage: { input_tokens: u.input ?? 0, output_tokens: u.output ?? 0,
          cache_creation_input_tokens: u.cacheWrite ?? 0, cache_read_input_tokens: u.cacheRead ?? 0 } },
    };
    if (u.cost && typeof u.cost.total === 'number') rec.costUSD = u.cost.total;
    return JSON.stringify(rec);
  });
}

async function sync() {
  let files = 0, records = 0, skipped = 0;
  for (const s of asideSessions()) {
    const projectDir = path.join(STORE, FORMAT === 'claude' ? 'projects' : '', `aside-u${s.acct}`);
    const outFile = path.join(projectDir, `${s.dir}.jsonl`);
    if (!opts.full && fs.existsSync(outFile) && fs.statSync(outFile).mtimeMs >= fs.statSync(s.file).mtimeMs) { skipped++; continue; }
    const recs = await readAssistantRecords(s.file);
    if (!recs.length) continue;
    const lines = FORMAT === 'claude' ? toClaudeLines(s, recs) : toPiLines(s, recs);
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(outFile, lines.join('\n') + '\n');
    files++; records += recs.length;
  }
  console.error(`[aside-ccusage] synced ${records} records from ${files} sessions (${skipped} unchanged) -> ${STORE}`);
}

function configPath() {
  const xdg = process.env.XDG_CONFIG_HOME ? path.join(process.env.XDG_CONFIG_HOME, 'claude') : path.join(HOME, '.config', 'claude');
  for (const p of [path.join(HOME, '.claude', 'ccusage.json'), path.join(xdg, 'ccusage.json')]) if (fs.existsSync(p)) return p;
  return path.join(fs.existsSync(path.join(HOME, '.claude')) ? path.join(HOME, '.claude') : xdg, 'ccusage.json');
}

function setup() {
  if (FORMAT === 'claude') {
    console.log(`Claude-format store written to ${STORE}. Add it to CLAUDE_CONFIG_DIR, e.g.\n  export CLAUDE_CONFIG_DIR="$HOME/.claude,${STORE}"`);
    return;
  }
  const cfgPath = configPath();
  let cfg = {};
  if (fs.existsSync(cfgPath)) { try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch (e) { throw new Error(`cannot parse ${cfgPath}: ${e.message}`); } }
  cfg.$schema ??= 'https://ccusage.com/config-schema.json';
  cfg.pi ??= {};
  const stores = Array.isArray(cfg.pi.stores) ? cfg.pi.stores : [];
  const storePath = STORE.startsWith(HOME) ? '~' + STORE.slice(HOME.length) : STORE;
  const existing = stores.find((s) => s && s.name === NAME);
  if (existing) existing.path = storePath; else stores.push({ name: NAME, path: storePath });
  cfg.pi.stores = stores;
  fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, '\t') + '\n');
  console.log(`registered pi store "${NAME}" -> ${storePath} in ${cfgPath}`);
}

function runCcusage(args) {
  const local = spawnSync('ccusage', ['--version'], { stdio: 'ignore' });
  const cmd = local.status === 0 ? ['ccusage', args] : ['npx', ['-y', 'ccusage@latest', ...args]];
  const r = spawnSync(cmd[0], cmd[1], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}

const [cmd, ...rest] = opts._;
if (cmd === 'setup') { await sync(); setup(); }
else if (cmd === 'sync') { await sync(); }
else if (!cmd || cmd === 'help' || cmd === '--help') {
  console.log(fs.readFileSync(new URL(import.meta.url)).toString().split('\n').slice(1, 25).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
} else { await sync(); runCcusage(opts._); }
