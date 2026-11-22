/**
 * Live boss guides, served by the optimizer server:
 *   GET  /guides/            - the list of guides
 *   GET  /guides/<name>      - src/server/guides/<name>.html, the same page that is published as a Claude artifact
 *   POST /tools/<name>       - runs a guide tool (see guideTools.js) with the JSON body as its arguments
 * The pages call /tools on load and from their Refresh button, so they always show the latest sync files.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

type Tool = { run: (args: Record<string, unknown>) => Promise<unknown> };
// eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
const { tools } = require('./guideTools') as { tools: Record<string, Tool> };

const GUIDES_DIR = path.join(__dirname, 'guides');

// the same document skeleton the artifact service wraps the page in
const SKELETON = '<!doctype html><html><head><meta charset=utf8><meta name=viewport content="width=device-width,initial-scale=1,'
  + 'viewport-fit=cover"><style>:root{color-scheme:light;box-sizing:border-box}body{margin:0;padding:0;font:14px -apple-system,'
  + 'BlinkMacSystemFont,sans-serif;background:#fff;color:#000}img{max-width:100%}[hidden]{display:none!important}</style></head><body>';

const json = (res: http.ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};

const readJson = (req: http.IncomingMessage) => new Promise<Record<string, unknown>>((resolve, reject) => {
  let data = '';
  req.on('data', (chunk) => {
    data += chunk;
    if (data.length > 100_000) reject(new Error('Request body too large'));
  });
  req.on('end', () => {
    try {
      resolve(data ? JSON.parse(data) : {});
    } catch {
      reject(new Error('The body must be JSON'));
    }
  });
  req.on('error', reject);
});

export const isGuideRoute = (pathname: string) => pathname === '/guides' || pathname.startsWith('/guides/')
  || pathname.startsWith('/tools/');

export const handleGuides = async (req: http.IncomingMessage, res: http.ServerResponse, url: URL) => {
  const { pathname } = url;

  if (req.method === 'POST' && pathname.startsWith('/tools/')) {
    // only same-origin pages may call the tools (browsers send Origin on cross-site POSTs)
    const { origin } = req.headers;
    if (origin && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
      json(res, 403, { error: 'Forbidden' });
      return;
    }
    const tool = tools[pathname.slice('/tools/'.length)];
    if (!tool) {
      json(res, 404, { error: `Unknown tool. Tools: ${Object.keys(tools).join(', ')}` });
      return;
    }
    try {
      json(res, 200, await tool.run(await readJson(req)));
    } catch (e) {
      json(res, 500, { error: e instanceof Error ? e.message : `${e}` });
    }
    return;
  }

  if (req.method === 'GET' && (pathname === '/guides' || pathname === '/guides/')) {
    const names = fs.existsSync(GUIDES_DIR)
      ? fs.readdirSync(GUIDES_DIR).filter((f) => f.endsWith('.html')).map((f) => f.slice(0, -5))
      : [];
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`${SKELETON}<title>Boss guides</title><ul style="font:16px system-ui;padding:24px 40px">${
      names.map((n) => `<li><a href="/guides/${n}">${n}</a></li>`).join('')}</ul></body></html>`);
    return;
  }

  if (req.method === 'GET' && pathname.startsWith('/guides/')) {
    const name = pathname.slice('/guides/'.length).replace(/\.html$/, '');
    const file = path.join(GUIDES_DIR, `${name}.html`);
    if (!/^[a-z0-9-]+$/.test(name) || !fs.existsSync(file)) {
      json(res, 404, { error: `No guide called ${name}` });
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(`${SKELETON}\n${fs.readFileSync(file, 'utf8')}\n</body></html>`);
    return;
  }

  json(res, 404, { error: 'Not found' });
};
