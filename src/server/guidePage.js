// Builds a guide page from the template (guides/_template.html), the guide's content (guides/<slug>.json) and a data
// snapshot from guideData.js. The same page is served live by the optimizer server and published as a Claude artifact.
const fs = require('node:fs');
const path = require('node:path');

const GUIDES_DIR = path.join(__dirname, 'guides');
const SNAPSHOT_DIR = path.join(GUIDES_DIR, 'snapshots');
const TEMPLATE = path.join(GUIDES_DIR, '_template.html');

const safeJson = (v) => JSON.stringify(v, null, 1).replace(/</g, '\\u003c');
const escHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
}[c]));

const guideSlugs = () => (fs.existsSync(GUIDES_DIR)
  ? fs.readdirSync(GUIDES_DIR).filter((f) => /^[a-z0-9-]+\.json$/.test(f)).map((f) => f.slice(0, -5))
  : []);

const readContent = (slug) => JSON.parse(fs.readFileSync(path.join(GUIDES_DIR, `${slug}.json`), 'utf8'));

const readSnapshot = (slug) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(SNAPSHOT_DIR, `${slug}.json`), 'utf8'));
  } catch {
    return null;
  }
};

const writeSnapshot = (slug, data) => {
  fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
  fs.writeFileSync(path.join(SNAPSHOT_DIR, `${slug}.json`), JSON.stringify(data, null, 1));
};

// Keeps the last gear when a refresh skipped the optimizer.
const mergeSnapshot = (slug, data) => {
  const prev = readSnapshot(slug);
  const merged = data.gear || !prev?.gear ? data : { ...data, gear: prev.gear, gearAt: prev.gearAt };
  if (data.gear) merged.gearAt = data.at;
  writeSnapshot(slug, merged);
  return merged;
};

/** The page's HTML (without the document skeleton, which the artifact service and the server add). */
const renderPage = (slug, content = readContent(slug), data = readSnapshot(slug)) => {
  const tpl = fs.readFileSync(TEMPLATE, 'utf8');
  const title = content.pageTitle || `${content.title} ${({ slayer: 'Slayer Guide', activity: 'Guide' })[content.kind] || 'Boss Guide'}`;
  return tpl
    .replace('__TITLE__', () => escHtml(title))
    .replace('/*SLUG*/""', () => JSON.stringify(slug))
    .replace('/*GUIDE*/null', () => safeJson(content))
    .replace('/*DATA*/null', () => safeJson(data));
};

/** Pulls the {have:Item} names out of a guide's text, so guideData checks them. */
const ownedTokens = (content) => [...JSON.stringify(content).matchAll(/\{have:([^}]+)\}/g)].map((m) => m[1].trim());

module.exports = {
  GUIDES_DIR, guideSlugs, readContent, readSnapshot, writeSnapshot, mergeSnapshot, renderPage, ownedTokens,
};
