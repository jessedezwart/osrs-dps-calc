// Builds a guide's page for publishing as a Claude artifact:
//
//   node src/server/buildGuide.js <slug>            fetch fresh data (gear included) and write guides/<slug>.html
//   node src/server/buildGuide.js <slug> --cached   re-render from the last snapshot (after editing <slug>.json)
//   node src/server/buildGuide.js <slug> --no-gear  fresh data, but keep the last gear
//
// It prints a short summary of the data (kc, missing collection log slots, open combat achievements, gear, owned
// items, warnings) for writing the rest of the guide. Starts the optimizer server if it isn't running.
const fs = require('node:fs');
const path = require('node:path');
const { request, ensureOptimizer } = require('./guideTools');
const {
  GUIDES_DIR, readContent, readSnapshot, renderPage,
} = require('./guidePage');

const clean = (s) => String(s || '').replace(/\s*\[[^\]]*\]/g, '').trim();

const summary = (content, d) => {
  const lines = [];
  const missing = d.clog.filter((c) => !c.have);
  lines.push(`${content.title}: ${d.kc.value} kc (loot tracker ${d.kc.lootTracker ?? '-'}, WOM ${d.kc.wiseOldMan ?? '-'}, dryness ${d.kc.dryness ?? '-'})`);
  lines.push(`Collection log ${d.clogHave}/${d.clog.length}${missing.length ? `; missing: ${missing.map((c) => `${c.name} (${c.rate || '?'}, ${c.dry != null ? `${c.dry}% this dry` : 'no dryness'})`).join('; ')}` : ''}`);
  const open = d.cas.filter((c) => !c.done);
  lines.push(`Open CAs (${open.length}/${d.cas.length}): ${open.map((c) => `[${c.id}] ${c.tier} ${c.name}: ${c.task}`).join(' | ') || 'none'}`);
  if (d.gear) {
    const res = Object.entries(d.gear.results).map(([k, r]) => `${k} ${r.dps} (${clean(r.equipment.weapon)}${r.spell ? `, ${r.spell}` : ''}, ${r.secondsPerKill}s)`);
    lines.push(`Gear (best ${d.gear.best}): ${res.join('; ')}`);
  }
  const owned = Object.entries(d.owned || {});
  if (owned.length) lines.push(`Owned: ${owned.map(([n, o]) => `${n} ${o.have ? `yes (${o.where.join(', ')})` : (o.known ? 'no' : 'UNKNOWN NAME')}`).join('; ')}`);
  if (d.missing.length) lines.push(`Missing requirements: ${d.missing.map((m) => m.name).join(', ')}`);
  if (d.drops.length) lines.push(`Rarest other drops: ${d.drops.filter((x) => x.rate).slice(0, 12).map((x) => `${x.item} ${x.quantity} ${x.rarity}`).join('; ')}`);
  if (d.stale.length) lines.push(`STALE sync files (tell Jesse to press Export): ${d.stale.join(', ')}`);
  if (d.wiseOldMan?.stale) lines.push(`Wise Old Man last updated ${d.wiseOldMan.updatedAt} (tell Jesse to update it)`);
  if (d.warnings.length) lines.push(`Warnings: ${d.warnings.join('; ')}`);
  lines.push(`Timings (s): ${JSON.stringify(d.timings)}`);
  return lines.join('\n');
};

const main = async () => {
  const slug = process.argv[2];
  if (!slug || slug.startsWith('-')) throw new Error('Usage: node src/server/buildGuide.js <slug> [--cached|--no-gear]');
  const content = readContent(slug);
  let data;
  if (process.argv.includes('--cached')) {
    data = readSnapshot(slug);
    if (!data) throw new Error(`No snapshot for ${slug} yet; run without --cached`);
  } else {
    await ensureOptimizer();
    const gear = !process.argv.includes('--no-gear');
    data = await request('GET', `/guide-data?guide=${encodeURIComponent(slug)}${gear ? '' : '&gear=0'}`, null, 300000);
  }
  const out = path.join(GUIDES_DIR, `${slug}.html`);
  fs.writeFileSync(out, renderPage(slug, content, data));
  console.log(summary(content, data));
  console.log(`\nWrote ${out}`);
};

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
