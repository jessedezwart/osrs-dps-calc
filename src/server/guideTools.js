// Guide tools: boss status, dryness and gear for the live boss guides. Used by the MCP server (mcp.js) and by the
// optimizer server's /tools and /guides routes. Env: OSRS_SYNC_DIR, OSRS_PLAYER, OSRS_DRYNESS, PYTHON, PORT.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFile, spawn } = require('node:child_process');

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

  guide_data: {
    description: 'Everything a guide needs in one call: kc, collection log (have/missing, rate, dryness %), combat achievements, '
      + 'other drops, owned items, missing requirements and (for bosses/slayer with a monster) the best gear per style. '
      + 'Pass guide (a saved guide in src/server/guides) or source plus optional kind, monster, version, items, quests, clog.',
    inputSchema: {
      type: 'object',
      properties: {
        guide: { type: 'string' },
        source: { type: 'string', description: 'Loot tracker / collection log name, e.g. "Brutus", "Tempoross"' },
        kind: { type: 'string', enum: ['boss', 'slayer', 'activity'] },
        monster: { type: 'string' },
        version: { type: 'string' },
        gear: { type: 'boolean' },
        items: { type: 'array', items: { type: 'string' } },
        quests: { type: 'array', items: { type: 'string' } },
        clog: { type: 'array', items: { type: 'string' } },
      },
    },
    run: async (args) => {
      await ensureOptimizer();
      return request('POST', '/guide-data', args, 300000);
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

module.exports = {
  tools, accountDir, readJson, runDryness, parseDryness, request, ensureOptimizer, STALE_MS,
};
