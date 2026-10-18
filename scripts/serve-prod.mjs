// Serves the static production build (`out/`, created by `next build`) locally.
// The build is exported with NEXT_PUBLIC_BASE_PATH (/osrs-dps), so requests under that prefix are mapped onto `out/`.
//
// Usage: node scripts/serve-prod.mjs   (env: PORT, default 3123)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'out');
const BASE_PATH = '/osrs-dps';
const PORT = parseInt(process.env.PORT || '3123', 10);

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
};

if (!fs.existsSync(path.join(ROOT, 'index.html'))) {
  console.error(`No production build found in ${ROOT}. Run "yarn build" first.`);
  process.exit(1);
}

const isFile = (p) => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};

/** Maps a URL path (without the base path) to a file in the build, or undefined if there is none. */
const resolveFile = (urlPath) => {
  const candidate = path.resolve(ROOT, `.${urlPath}`);
  // never serve anything outside of the build directory
  if (candidate !== ROOT && !candidate.startsWith(ROOT + path.sep)) return undefined;

  const options = [candidate, path.join(candidate, 'index.html'), `${candidate}.html`];
  return options.find(isFile);
};

const server = http.createServer((req, res) => {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400).end('Bad request');
    return;
  }

  if (urlPath === '/' || urlPath === BASE_PATH) {
    res.writeHead(302, { Location: `${BASE_PATH}/` }).end();
    return;
  }

  // assets that aren't under the base path (e.g. some icons) are still served from the build root
  const relative = urlPath.startsWith(`${BASE_PATH}/`) ? urlPath.slice(BASE_PATH.length) : urlPath;
  const file = resolveFile(relative);

  if (!file) {
    const notFound = path.join(ROOT, '404.html');
    res.writeHead(404, { 'Content-Type': MIME_TYPES['.html'] });
    if (isFile(notFound)) fs.createReadStream(notFound).pipe(res);
    else res.end('Not found');
    return;
  }

  res.writeHead(200, {
    'Content-Type': MIME_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
  });
  fs.createReadStream(file).pipe(res);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`OSRS DPS calculator running at http://localhost:${PORT}${BASE_PATH}/`);
  console.log('Close this window (or press Ctrl+C) to stop it.');
});
