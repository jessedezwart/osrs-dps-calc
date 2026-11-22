#!/usr/bin/env node
/* eslint-disable no-console */
// Local MCP server (stdio, newline-delimited JSON-RPC) that lets Claude artifact pages refresh boss guides live.
// Register it in the Claude app's MCP config as "osrs" (pages call it as `host:osrs`):
//   claude mcp add -s user osrs -- node <repo>/src/server/mcp.js
// Env: OSRS_SYNC_DIR, OSRS_PLAYER (as the optimizer server), OSRS_DRYNESS (path to dryness.py), PYTHON, PORT.
// stdout carries the protocol, so log to stderr only.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const readline = require('node:readline');
const { execFile, spawn } = require('node:child_process');

const PROTOCOL_VERSION = '2025-06-18';
const ROOT = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 3124);
const SYNC_DIR = process.env.OSRS_SYNC_DIR || path.join(os.homedir(), '.runelite', 'plugin-data', 'osrsdatasync');
const PLAYER = process.env.OSRS_PLAYER || undefined;
const DRYNESS = process.env.OSRS_DRYNESS || path.join(os.homedir(), 'osrs-tools', 'dryness.py');
const PYTHON = process.env.PYTHON || 'python';

// --- account files ----------------------------------------------------------------------------------------------

const norm = (s) => s.toLowerCase().replace(/[\s_-]+/g, '_');

const accountDir = () => {
  const dirs = fs.readdirSync(SYNC_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  if (PLAYER) {
    const match = dirs.find((d) => norm(d) === norm(PLAYER));
    if (!match) throw new Error(`No sync folder for ${PLAYER} in ${SYNC_DIR}`);
    return path.join(SYNC_DIR, match);
  }
  if (dirs.length !== 1) throw new Error(`Expected one account folder in ${SYNC_DIR}, found ${dirs.length}; set OSRS_PLAYER`);
  return path.join(SYNC_DIR, dirs[0]);
};

const readJson = (dir, file) => {
  const p = path.join(dir, file);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
};

const STALE_MS = 24 * 60 * 60 * 1000;

// --- dryness.py -------------------------------------------------------------------------------------------------

const runDryness = (args) => new Promise((resolve, reject) => {
  execFile(PYTHON, ['-X', 'utf8', DRYNESS, ...args], { timeout: 120000, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
    if (err) reject(new Error(`dryness.py failed: ${stderr || err.message}`));
    else resolve(stdout);
  });
});

// Lines look like:
//    85  Cow slippers: missing at 0.16x the drop rate, 85.2% chance to be this dry  [Brutus 24 kc @ 1/150]
//    50  Earth emerald: x1 in log, 1 tracked vs 1.14 expected, 68.0% chance to be this lucky  [Molanisk 73 kc @ 1/64]
const LINE = /^\s*(\d+)\s+(.+?):\s+(.*?),?\s*([\d.]+)% chance to be this (dry|lucky)(?: or (?:drier|luckier))?\s*(?:\[(.*)\])?\s*$/;

const parseDryness = (text) => {
  const items = [];
  for (const line of text.split(/\r?\n/)) {
    const m = LINE.exec(line);
    if (!m) continue;
    const [, score, name, detail, pct, kind, sources] = m;
    const kcs = [...(sources || '').matchAll(/([^,[\]]+?) (\d[\d,]*) kc @ (1\/[\d,.]+)/g)]
      .map(([, source, kc, rate]) => ({ source: source.trim(), kc: Number(kc.replace(/,/g, '')), rate }));
    items.push({
      name: name.trim(),
      missing: detail.startsWith('missing'),
      score: Number(score),
      chance: Number(pct),
      kind,
      detail: detail.trim(),
      sources: kcs,
    });
  }
  const data = /^Data: (.*)$/m.exec(text);
  return { items, dataNote: data ? data[1] : null };
};

// --- optimizer server -------------------------------------------------------------------------------------------

const request = (method, urlPath, body, timeout) => new Promise((resolve, reject) => {
  const payload = body ? JSON.stringify(body) : null;
  const req = http.request({
    host: '127.0.0.1',
    port: PORT,
    path: urlPath,
    method,
    timeout,
    headers: payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {},
  }, (res) => {
    let data = '';
    res.on('data', (c) => { data += c; });
    res.on('end', () => {
      try {
        const json = JSON.parse(data);
        if (res.statusCode >= 400) reject(new Error(json.error || `HTTP ${res.statusCode}`));
        else resolve(json);
      } catch {
        reject(new Error(`Bad response from the optimizer server (HTTP ${res.statusCode})`));
      }
    });
  });
  req.on('timeout', () => req.destroy(new Error('timeout')));
  req.on('error', reject);
  if (payload) req.write(payload);
  req.end();
});

const ensureOptimizer = async () => {
  try {
    await request('GET', '/health', null, 2000);
    return false;
  } catch {
    const child = spawn(process.execPath, [path.join(__dirname, 'start.js')], {
      cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true,
    });
    child.unref();
    const until = Date.now() + 60000;
    while (Date.now() < until) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => { setTimeout(r, 1000); });
      try {
        // eslint-disable-next-line no-await-in-loop
        await request('GET', '/health', null, 2000);
        return true;
      } catch { /* still starting */ }
    }
    throw new Error('The optimizer server did not start within 60 seconds');
  }
};

// --- tools ------------------------------------------------------------------------------------------------------

const intList = { type: 'array', items: { type: 'integer' } };

const tools = {
  ping: {
    description: 'Health check. Returns pong and the server time.',
    inputSchema: { type: 'object', properties: {} },
    run: async () => ({ pong: true, time: new Date().toISOString() }),
  },

  boss_status: {
    description: 'Kill count and drops (RuneLite loot tracker), collection log counts and completed combat achievements for one boss, '
      + 'from the OSRS Data Sync files. Also returns when each file was exported.',
    inputSchema: {
      type: 'object',
      properties: {
        npc: { type: 'string', description: 'Loot tracker source name, e.g. "Brutus"' },
        items: { ...intList, description: 'Collection log item ids to report counts for' },
        caIds: { ...intList, description: 'Combat achievement task ids to report as done or not' },
      },
      required: ['npc'],
    },
    run: async ({ npc, items = [], caIds = [] }) => {
      const dir = accountDir();
      const progress = readJson(dir, 'progress.json');
      const clog = readJson(dir, 'clog.json');
      const kc = readJson(dir, 'killcounts.json');
      const sources = kc?.lootTracker?.NPC || {};
      const key = Object.keys(sources).find((k) => norm(k) === norm(npc));
      const src = key ? sources[key] : null;
      const doneCa = new Set(progress?.ca || []);
      const updated = { progress: progress?.updated || null, clog: clog?.updated || null, killcounts: kc?.updated || null };
      const stale = Object.entries(updated)
        .filter(([, t]) => t && Date.now() - Date.parse(t) > STALE_MS)
        .map(([f]) => f);
      return {
        npc: key || npc,
        kills: src?.kills ?? 0,
        lastKill: src?.last ? new Date(src.last).toISOString() : null,
        clog: Object.fromEntries(items.map((id) => [id, clog?.items?.[id] ?? 0])),
        // drops seen by the loot tracker; clog.json only updates when the collection log is opened in game
        drops: Object.fromEntries(items.map((id) => [id, src?.drops?.[id] ?? 0])),
        ca: Object.fromEntries(caIds.map((id) => [id, doneCa.has(id)])),
        updated,
        stale,
      };
    },
  },

  dryness: {
    description: 'Runs dryness.py with a filter (part of an item or source name) and returns each item: missing or not, '
      + 'the % chance to be this dry (missing) or this lucky (obtained), and the kill counts used.',
    inputSchema: {
      type: 'object',
      properties: {
        filter: { type: 'string', description: 'e.g. "brutus", "vorkath", "whip"' },
        missingOnly: { type: 'boolean' },
      },
      required: ['filter'],
    },
    run: async ({ filter, missingOnly }) => {
      const args = [String(filter)];
      if (missingOnly) args.push('--missing');
      const text = await runDryness(args);
      return { filter, ...parseDryness(text), ranAt: new Date().toISOString() };
    },
  },

  optimize: {
    description: 'Best gear per combat style for a monster, from the local gear optimizer (starts it if needed). '
      + 'Same body as POST /optimize: monster, version, onSlayerTask, potions, prayers, styles, locked, excludeItems.',
    inputSchema: {
      type: 'object',
      properties: {
        monster: { type: 'string' },
        version: { type: 'string' },
        onSlayerTask: { type: 'boolean' },
        potions: { type: 'array', items: { type: 'string' } },
        prayers: { type: 'array', items: { type: 'string' } },
        styles: { type: 'array', items: { type: 'string', enum: ['melee', 'ranged', 'magic'] } },
        top: { type: 'integer', description: 'Setups to return per style (default 1)' },
      },
      required: ['monster'],
    },
    run: async ({ top = 1, ...body }) => {
      const started = await ensureOptimizer();
      const res = await request('POST', '/optimize', body, 300000);
      const results = Object.fromEntries(Object.entries(res.results || {}).map(([style, list]) => [
        style,
        (list || []).slice(0, top).map((r) => ({
          dps: r.dps,
          secondsPerKill: r.secondsPerKill,
          maxHit: r.maxHit,
          accuracy: r.accuracy,
          style: r.style,
          spell: r.spell,
          prayers: r.prayers,
          equipment: r.equipment,
          calcUrl: r.calcUrl,
        })),
      ]));
      return {
        monster: res.monster, warnings: res.warnings || [], results, startedServer: started, ranAt: new Date().toISOString(),
      };
    },
  },
};

// --- JSON-RPC over stdio ----------------------------------------------------------------------------------------

const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

const handle = async ({ id, method, params }) => {
  if (id === undefined) return; // a notification
  switch (method) {
    case 'initialize':
      reply(id, {
        protocolVersion: params?.protocolVersion || PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'osrs', version: '0.2.0' },
      });
      return;
    case 'ping':
      reply(id, {});
      return;
    case 'tools/list':
      reply(id, {
        tools: Object.entries(tools).map(([name, t]) => ({
          name,
          description: t.description,
          inputSchema: t.inputSchema,
          annotations: { readOnlyHint: true, openWorldHint: false },
        })),
      });
      return;
    case 'tools/call': {
      const tool = tools[params?.name];
      if (!tool) {
        fail(id, -32602, `Unknown tool: ${params?.name}`);
        return;
      }
      try {
        const data = await tool.run(params.arguments || {});
        reply(id, { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data });
      } catch (e) {
        reply(id, { isError: true, content: [{ type: 'text', text: String(e?.message || e) }] });
      }
      return;
    }
    default:
      fail(id, -32601, `Method not found: ${method}`);
  }
};

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  handle(msg).catch((e) => console.error(e));
});
