// A local cache of OSRS Wiki data for the guides: collection log slots, combat achievements, item names and drop
// tables. Everything is kept in JSON files in OSRS_WIKI_CACHE (default ~/osrs-tools/cache/wiki) and refreshed when it
// is over a week old (in the background, so a guide never waits for the wiki unless the data was never fetched).
//
//   node src/server/wikiCache.js            - fetch what's missing or over a week old
//   node src/server/wikiCache.js --refresh  - fetch everything again (after a game update)
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');

const CACHE_DIR = process.env.OSRS_WIKI_CACHE || path.join(os.homedir(), 'osrs-tools', 'cache', 'wiki');
const API = 'https://oldschool.runescape.wiki/api.php';
const UA = 'osrs-guide-cache (personal use)';
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

const get = (url) => new Promise((resolve, reject) => {
  https.get(url, { headers: { 'User-Agent': UA }, timeout: 30000 }, (res) => {
    let data = '';
    res.setEncoding('utf8');
    res.on('data', (c) => { data += c; });
    res.on('end', () => {
      if (res.statusCode >= 400) reject(new Error(`Wiki HTTP ${res.statusCode} for ${url}`));
      else resolve(data);
    });
  }).on('timeout', function onTimeout() { this.destroy(new Error('Wiki request timed out')); }).on('error', reject);
});

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

const bucket = async (query) => {
  const res = JSON.parse(await get(`${API}?action=bucket&format=json&query=${encodeURIComponent(query)}`));
  if (res.error) throw new Error(`Wiki bucket query failed: ${res.error}`);
  await sleep(300); // be polite to the wiki
  return res.bucket || [];
};

const bucketAll = async (select) => {
  const rows = [];
  for (let offset = 0; ; offset += 5000) {
    // eslint-disable-next-line no-await-in-loop
    const page = await bucket(`${select}.limit(5000).offset(${offset}).run()`);
    rows.push(...page);
    if (page.length < 5000) return rows;
  }
};

const file = (name) => path.join(CACHE_DIR, `${name.replace(/[^\w.-]/g, '_')}.json`);
const readCache = (name) => {
  try {
    return JSON.parse(fs.readFileSync(file(name), 'utf8'));
  } catch {
    return null;
  }
};
const writeCache = (name, data, extra = {}) => {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const value = { fetchedAt: new Date().toISOString(), ...extra, data };
  fs.writeFileSync(file(name), JSON.stringify(value));
  return value;
};
const isOld = (entry) => !entry || Date.now() - Date.parse(entry.fetchedAt) > WEEK_MS;

// --- datasets ---------------------------------------------------------------------------------------------------

const DATASETS = {
  // [{id, name, tabs: [collection log entry names]}]
  clog: async () => JSON.parse(await get('https://oldschool.runescape.wiki/w/Module:Collection_log/data.json?action=raw')),
  // [{id, name, monster, task, tier, type}]
  cas: async () => (await bucketAll("bucket('combat_achievement').select('id','name','monster','task','tier','type')"))
    .map((r) => ({ ...r, id: Number(r.id) })),
  // {id: name} for every item id on the wiki
  items: async () => {
    const out = {};
    for (const r of await bucketAll("bucket('infobox_item').select('item_name','item_id')")) {
      for (const id of [].concat(r.item_id || [])) if (r.item_name && /^\d+$/.test(id)) out[id] = r.item_name;
    }
    return out;
  },
};

const fetching = new Map();
// Returns the cached value, fetching it first if there is none. Old values are returned at once and refreshed after.
const load = async (name, fetcher, force = false, extra = {}) => {
  const entry = readCache(name);
  const refresh = () => {
    if (!fetching.has(name)) {
      fetching.set(name, fetcher().then((d) => writeCache(name, d, extra)).finally(() => fetching.delete(name)));
    }
    return fetching.get(name);
  };
  if (!entry || force) return (await refresh()).data;
  if (isOld(entry)) refresh().catch((e) => console.error(`Wiki cache: couldn't refresh ${name}: ${e.message}`));
  return entry.data;
};

const getClog = () => load('clog', DATASETS.clog);
const getCas = () => load('cas', DATASETS.cas);
const getItems = () => load('items', DATASETS.items);

// [{item, rarity, rate (per kill, or null), quantity, rolls}] for a page's drop tables (e.g. "Brutus", "Reward pool")
const fetchDrops = async (page) => (await bucket(
  `bucket('dropsline').select('item_name','drop_json').where('page_name',${JSON.stringify(page)}).limit(1000).run()`,
)).map((r) => {
  const d = JSON.parse(r.drop_json);
  return {
    item: d['Dropped item'] || r.item_name,
    rarity: d.Rarity || '',
    quantity: d['Drop Quantity'] || '',
    rolls: Number(d.Rolls || 1),
    members: d['Drop type'] || '',
  };
});
const getDrops = (page) => load(`drops_${page}`, () => fetchDrops(page), false, { page });

// Fetches the datasets that are missing or over a week old (or all of them), plus every cached drop table.
const refreshAll = async (force = false) => {
  const done = [];
  for (const [name, fetcher] of Object.entries(DATASETS)) {
    if (force || isOld(readCache(name))) {
      // eslint-disable-next-line no-await-in-loop
      await load(name, fetcher, true);
      done.push(name);
    }
  }
  const drops = fs.existsSync(CACHE_DIR) ? fs.readdirSync(CACHE_DIR).filter((f) => f.startsWith('drops_')) : [];
  for (const f of drops) {
    const name = f.slice(0, -5);
    const entry = readCache(name);
    if (entry && (force || isOld(entry)) && entry.page) {
      // eslint-disable-next-line no-await-in-loop
      writeCache(name, await fetchDrops(entry.page), { page: entry.page });
      done.push(name);
    }
  }
  return done;
};

module.exports = {
  CACHE_DIR, getClog, getCas, getItems, getDrops, refreshAll,
};

// Starts a daily check that refreshes anything over a week old. Used by the optimizer server.
module.exports.startWeeklyRefresh = () => {
  const run = () => refreshAll().then((done) => {
    if (done.length) console.log(`Wiki cache: refreshed ${done.join(', ')}`);
  }).catch((e) => console.error(`Wiki cache: refresh failed: ${e.message}`));
  setTimeout(run, 5000).unref();
  setInterval(run, 24 * 60 * 60 * 1000).unref();
};

if (require.main === module) {
  const force = process.argv.includes('--refresh');
  refreshAll(force).then((done) => {
    console.log(done.length ? `Refreshed: ${done.join(', ')}` : 'Everything is less than a week old.');
    console.log(`Cache: ${CACHE_DIR}`);
  }).catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
