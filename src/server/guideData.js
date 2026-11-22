// Everything a boss, slayer or activity guide needs from the account and the wiki, in one call:
// kill count, collection log (have/missing, drop rate, dryness), combat achievements, other drops, owned items,
// missing requirements and the best gear per style. The slow parts (dryness.py, Wise Old Man, the gear optimizer)
// run at the same time. Served as GET/POST /guide-data by the optimizer server (see guides.ts).
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const wiki = require('./wikiCache');
const {
  accountDir, readJson, runDryness, parseDryness, request, ensureOptimizer, STALE_MS,
} = require('./guideTools');

const GUIDES_DIR = path.join(__dirname, 'guides');

// Jesse's standing choices (see the project instructions): no offensive prayers on slayer tasks, his unlocked
// prayers for bosses. Override per guide with "optimizer".
const OPTIMIZER_PRESETS = {
  boss: { onSlayerTask: false, prayers: ['piety', 'eagle eye', 'mystic might'], potions: ['Super combat', 'Super ranging'] },
  slayer: { onSlayerTask: true, prayers: [], potions: ['Super attack', 'Super strength'] },
};

const CA_POINTS = {
  Easy: 1, Medium: 2, Hard: 3, Elite: 4, Master: 5, Grandmaster: 6,
};

const lc = (s) => String(s || '').toLowerCase().trim();
// "Bottomless milk bucket (empty)" and "Bottomless milk bucket" are the same collection log slot
const base = (s) => lc(s).replace(/\s*\([^)]*\)\s*$/, '');
const wikiPage = (name) => String(name).replace(/ /g, '_');

const parseRate = (s) => {
  const m = /([\d.,]+)\s*\/\s*([\d.,]+)/.exec(s || '');
  if (!m) return null;
  const [a, b] = [m[1], m[2]].map((x) => Number(x.replace(/,/g, '')));
  return b ? a / b : null;
};

// "4/150" -> "1/37.5", so every rate reads as one in N
const oneIn = (rarity) => {
  const r = parseRate(rarity);
  if (!r || /^1\s*\//.test(rarity)) return rarity;
  const n = 1 / r;
  return `1/${n >= 100 ? Math.round(n).toLocaleString('en-US') : Number(n.toFixed(1))}`;
};

// --- Wise Old Man (kept for 10 minutes) -------------------------------------------------------------------------

let womCache = null;
const getJson = (url) => new Promise((resolve, reject) => {
  https.get(url, { headers: { 'User-Agent': 'osrs-guides (personal use)' }, timeout: 15000 }, (res) => {
    let data = '';
    res.on('data', (c) => { data += c; });
    res.on('end', () => {
      try {
        if (res.statusCode >= 400) throw new Error(`HTTP ${res.statusCode}`);
        resolve(JSON.parse(data));
      } catch (e) { reject(e); }
    });
  }).on('timeout', function onTimeout() { this.destroy(new Error('timed out')); }).on('error', reject);
});
const wiseOldMan = async (player) => {
  if (womCache && womCache.player === player && Date.now() - womCache.at < 10 * 60 * 1000) return womCache.data;
  const data = await getJson(`https://api.wiseoldman.net/v2/players/${encodeURIComponent(lc(player))}`);
  womCache = { player, at: Date.now(), data };
  return data;
};

// --- owned items ------------------------------------------------------------------------------------------------

const ownedItems = (containers) => {
  const where = new Map(); // id -> {count, where: Set}
  const add = (rows, label) => {
    for (const row of rows || []) {
      const [id, qty = 1] = Array.isArray(row) ? row : [row.id, row.quantity];
      if (!where.has(id)) where.set(id, { count: 0, where: new Set() });
      const w = where.get(id);
      w.count += qty;
      w.where.add(label);
    }
  };
  add(containers?.bank, 'bank');
  add(containers?.equipment, 'worn');
  add(containers?.inventory, 'inventory');
  add(containers?.runePouch, 'rune pouch');
  for (const s of Object.values(containers?.storage || {})) add(s?.items, lc(s?.name || 'storage'));
  return where;
};

const checkOwned = (names, owned, itemNames) => {
  const byName = new Map();
  for (const [id, name] of Object.entries(itemNames)) {
    const key = lc(name);
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(Number(id));
  }
  const out = {};
  for (const name of names) {
    const q = lc(name);
    // the item and its variants: "Toxic blowpipe" also matches "Toxic blowpipe (empty)"
    const ids = [...byName.entries()].filter(([n]) => n === q || n.startsWith(`${q} (`) || n.startsWith(`${q}(`)).flatMap(([, i]) => i);
    let count = 0;
    const where = new Set();
    for (const id of ids) {
      const w = owned.get(id);
      if (w) {
        count += w.count;
        w.where.forEach((x) => where.add(x));
      }
    }
    out[name] = { have: count > 0, count, where: [...where], known: ids.length > 0 };
  }
  return out;
};

// --- the guide's parameters -------------------------------------------------------------------------------------

const readGuide = (slug) => {
  if (!/^[a-z0-9-]+$/.test(slug || '')) throw new Error(`Bad guide name ${slug}`);
  const f = path.join(GUIDES_DIR, `${slug}.json`);
  if (!fs.existsSync(f)) throw new Error(`No guide called ${slug} (looked for ${f})`);
  return JSON.parse(fs.readFileSync(f, 'utf8'));
};

/** Fills in the defaults: everything is named after `source` unless given. */
const resolveParams = (input) => {
  let fromGuide = {};
  if (input.guide) {
    const content = readGuide(input.guide);
    // eslint-disable-next-line global-require
    const tokens = require('./guidePage').ownedTokens(content);
    fromGuide = { kind: content.kind, ...content.data };
    fromGuide.items = [...new Set([...(fromGuide.items || []), ...tokens])];
  }
  const p = { ...fromGuide, ...input };
  // query strings send "false" / "0"
  for (const k of ['dryness', 'caMonster', 'dropPage', 'gear']) if (p[k] === 'false' || p[k] === '0') p[k] = false;
  if (!p.source) throw new Error('"source" is required (the loot tracker / collection log name, e.g. "Brutus")');
  const kind = p.kind || 'boss';
  const opt = p.monster ? { monster: p.monster, version: p.version } : null;
  return {
    kind,
    source: p.source,
    clogTabs: [].concat(p.clog ?? p.source).filter(Boolean),
    dryness: p.dryness === false ? null : (p.dryness || lc(p.source)),
    caMonster: p.caMonster === false ? null : (p.caMonster || p.source),
    dropPage: p.dropPage === false ? null : (p.dropPage || p.source),
    items: p.items || [],
    quests: p.quests || [],
    levels: p.levels || {},
    womBoss: p.womBoss || lc(p.source).replace(/^the /, '').replace(/[^a-z0-9]+/g, '_'),
    gear: opt && kind !== 'activity' && p.gear !== false
      ? { ...opt, ...(OPTIMIZER_PRESETS[kind] || OPTIMIZER_PRESETS.boss), ...(p.optimizer || {}) }
      : null,
  };
};

// --- the call ---------------------------------------------------------------------------------------------------

const timed = async (timings, name, fn) => {
  const t = Date.now();
  try {
    return await fn();
  } finally {
    timings[name] = Number(((Date.now() - t) / 1000).toFixed(2));
  }
};

const compactGear = (res) => {
  const results = {};
  for (const [style, list] of Object.entries(res.results || {})) {
    const r = list?.[0];
    if (r) {
      results[style] = {
        dps: r.dps,
        secondsPerKill: r.secondsPerKill,
        maxHit: r.maxHit,
        accuracy: r.accuracy,
        style: r.style,
        spell: r.spell,
        equipment: r.equipment,
        weight: r.weight,
        calcUrl: r.calcUrl,
      };
    }
  }
  const best = Object.entries(results).sort((a, b) => b[1].dps - a[1].dps)[0]?.[0] || null;
  return {
    monster: res.monster, prayers: res.prayers, potions: res.potions, best, results, warnings: res.warnings || [],
  };
};

/**
 * @param input  {guide?, source, kind?, clog?, dryness?, caMonster?, dropPage?, items?, quests?, levels?,
 *                monster?, version?, gear?, optimizer?}
 * @param optimize  runs an optimizer request in this process; without it the optimizer server is called over HTTP
 */
const guideData = async (input, { optimize } = {}) => {
  const p = resolveParams(input);
  const timings = {};
  const warnings = [];
  const started = Date.now();

  const runGear = p.gear && timed(timings, 'gear', async () => {
    if (optimize) return optimize(p.gear);
    await ensureOptimizer();
    return request('POST', '/optimize', p.gear, 300000);
  });

  const dir = accountDir();
  const progress = readJson(dir, 'progress.json') || {};
  const clogFile = readJson(dir, 'clog.json') || {};
  const kcFile = readJson(dir, 'killcounts.json') || {};
  const containers = readJson(dir, 'containers.json') || {};

  const settle = (pr) => (pr ? pr.then((v) => ({ v }), (e) => ({ e })) : Promise.resolve({ v: null }));
  const [clogR, casR, itemsR, dropsR, dryR, womR, gearR] = await Promise.all([
    settle(timed(timings, 'wiki', () => wiki.getClog())),
    settle(p.caMonster && wiki.getCas()),
    settle(p.items.length && wiki.getItems()),
    settle(p.dropPage && wiki.getDrops(p.dropPage)),
    settle(p.dryness && timed(timings, 'dryness', async () => parseDryness(await runDryness([p.dryness])))),
    settle(timed(timings, 'wiseOldMan', () => wiseOldMan(progress.player || 'gim fasd'))),
    settle(runGear),
  ]);
  for (const [name, r] of Object.entries({
    'wiki collection log': clogR, 'wiki combat achievements': casR, 'wiki items': itemsR, 'wiki drops': dropsR, 'dryness.py': dryR, 'Wise Old Man': womR, optimizer: gearR,
  })) if (r.e) warnings.push(`${name}: ${r.e.message || r.e}`);

  // kill count: the highest of the loot tracker, Wise Old Man and what dryness.py used (Boss Kills screenshots)
  const trackerSrc = Object.values(kcFile.lootTracker || {}).flatMap((cat) => Object.entries(cat))
    .find(([name]) => lc(name) === lc(p.source))?.[1];
  const wom = womR.v;
  const womKills = wom?.latestSnapshot?.data?.bosses?.[p.womBoss]?.kills;
  const dryItems = dryR.v?.items || [];
  const dryKc = Math.max(0, ...dryItems.flatMap((i) => i.sources).filter((s) => lc(s.source) === lc(p.source)).map((s) => s.kc));
  const kc = {
    value: Math.max(trackerSrc?.kills || 0, womKills > 0 ? womKills : 0, dryKc),
    lootTracker: trackerSrc?.kills ?? null,
    wiseOldMan: womKills > 0 ? womKills : null,
    dryness: dryKc || null,
  };

  // drop table rows by item base name
  const dropRows = dropsR.v || [];
  const rateOf = (name) => {
    let rows = dropRows.filter((d) => lc(d.item) === lc(name) && parseRate(d.rarity));
    if (!rows.length) rows = dropRows.filter((d) => base(d.item) === base(name) && parseRate(d.rarity));
    rows.sort((a, b) => parseRate(b.rarity) - parseRate(a.rarity));
    return rows[0] ? oneIn(rows[0].rarity) : null;
  };

  // collection log
  const tabs = new Set(p.clogTabs.map(lc));
  const newByName = new Set(Object.keys(clogFile.newByName || {}).map(lc));
  const clog = (clogR.v || []).filter((c) => c.tabs.some((t) => tabs.has(lc(t)))).map((c) => {
    const count = Math.max(clogFile.items?.[c.id] || 0, trackerSrc?.drops?.[c.id] || 0, newByName.has(lc(c.name)) ? 1 : 0);
    const d = dryItems.find((i) => base(i.name) === base(c.name));
    return {
      id: c.id,
      name: c.name,
      wiki: wikiPage(c.name),
      have: count > 0,
      count,
      rate: rateOf(c.name),
      // % chance to be this dry (missing items) or this lucky (obtained ones), from dryness.py
      dry: d && d.missing && d.kind === 'dry' ? d.chance : null,
      lucky: d && !d.missing && d.kind === 'lucky' ? d.chance : null,
      pet: c.tabs.includes('All Pets'),
    };
  });
  if (clogR.v && tabs.size && !clog.length) warnings.push(`No collection log slots for ${p.clogTabs.join(', ')}; pass "clog" with the log's entry name`);

  // combat achievements
  const doneCa = new Set(progress.ca || []);
  const cas = (casR.v || []).filter((c) => lc(c.monster) === lc(p.caMonster)).map((c) => ({
    id: c.id, name: c.name, wiki: wikiPage(c.name), tier: c.tier, type: c.type, task: c.task, done: doneCa.has(c.id),
  })).sort((a, b) => (CA_POINTS[a.tier] || 0) - (CA_POINTS[b.tier] || 0));
  const open = cas.filter((c) => !c.done);

  // other drops (not in the collection log), rarest first
  const clogNames = new Set(clog.map((c) => base(c.name)));
  const seen = new Set();
  const drops = dropRows.filter((d) => !clogNames.has(base(d.item))).map((d) => ({
    item: d.item, wiki: wikiPage(d.item), rarity: oneIn(d.rarity), quantity: d.quantity, rate: parseRate(d.rarity),
  })).filter((d) => {
    const k = `${d.item}|${d.rarity}|${d.quantity}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).sort((a, b) => (a.rate ?? 2) - (b.rate ?? 2));

  // requirements the account is missing
  const missing = [];
  for (const q of p.quests) if ((progress.quests?.[q] ?? 0) !== 2) missing.push({ type: 'quest', name: q, state: progress.quests?.[q] ?? null });
  for (const [skill, lvl] of Object.entries(p.levels)) {
    const have = progress.skills?.[skill]?.[0] ?? null;
    if (have == null || have < lvl) missing.push({ type: 'level', name: skill, need: lvl, have });
  }

  // freshness
  const files = {
    progress: progress.updated || null,
    clog: clogFile.updated || null,
    killcounts: kcFile.updated || null,
    containers: containers.updated || null,
  };
  const stale = Object.entries(files).filter(([, t]) => t && Date.now() - Date.parse(t) > STALE_MS).map(([f]) => f);
  const womUpdated = wom?.updatedAt || null;
  const womStale = womUpdated ? Date.now() - Date.parse(womUpdated) > 3 * 24 * 60 * 60 * 1000 : null;

  const gear = gearR.v ? compactGear(gearR.v) : null;
  if (gear) warnings.push(...gear.warnings);

  return {
    source: p.source,
    kind: p.kind,
    player: progress.player || null,
    kc,
    clog,
    clogHave: clog.filter((c) => c.have).length,
    cas,
    casOpen: open.length,
    casOpenPoints: open.reduce((n, c) => n + (CA_POINTS[c.tier] || 0), 0),
    drops,
    owned: itemsR.v ? checkOwned(p.items, ownedItems(containers), itemsR.v) : {},
    missing,
    levels: Object.fromEntries(Object.entries(progress.skills || {}).map(([k, v]) => [k, v[0]])),
    gear,
    gearRequest: p.gear,
    files,
    stale,
    wiseOldMan: { updatedAt: womUpdated, stale: womStale },
    warnings,
    timings: { ...timings, total: Number(((Date.now() - started) / 1000).toFixed(2)) },
    at: new Date().toISOString(),
  };
};

module.exports = { guideData, readGuide, OPTIMIZER_PRESETS };
