/**
 * A local HTTP server for the gear optimizer, so that scripts and AI assistants can ask for the best gear the player
 * owns against a monster. Reads the player's levels and items from the OSRS Data Sync RuneLite plugin's files.
 *
 *   GET  /health             - status, and the synced account it found
 *   GET  /monsters?name=...  - monsters whose name contains the text (with their versions)
 *   POST /optimize           - the best setups per style (see OptimizeRequest in optimize.ts)
 *
 * Start it with `node src/server/start.js` (env: PORT, default 3124; OSRS_SYNC_DIR; OSRS_PLAYER).
 */
import http from 'node:http';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { OPTIMIZER_STYLES, OptimizerStyle } from '@/lib/optimizer';
import { AccountData, DEFAULT_SYNC_DIR, readAccount } from './accountData';
import {
  OptimizeRequest, prepare, RequestError, searchMonsters,
} from './optimize';
import type { StyleJob } from './styleWorker';

const PORT = Number(process.env.PORT || 3124);
const SYNC_DIR = process.env.OSRS_SYNC_DIR || DEFAULT_SYNC_DIR;
const PLAYER = process.env.OSRS_PLAYER || undefined;

interface WorkerReply { id: number, loadouts?: unknown[], evaluations?: number, error?: string }

// one worker per style, so that the styles are searched at the same time
const workers = new Map<OptimizerStyle, Worker>();
type Resolver = (r: WorkerReply) => void;
const pending = new Map<number, Resolver>();
let nextId = 1;

const startWorker = (style: OptimizerStyle) => {
  const worker = new Worker(
    `require(${JSON.stringify(path.join(__dirname, 'register.js'))}); require(${JSON.stringify(path.join(__dirname, 'styleWorker.ts'))});`,
    { eval: true },
  );
  worker.on('message', (r: WorkerReply) => {
    pending.get(r.id)?.(r);
    pending.delete(r.id);
  });
  worker.on('error', (e) => console.error(`${style} worker failed:`, e));
  worker.on('exit', () => {
    workers.delete(style);
  });
  workers.set(style, worker);
  return worker;
};

const runStyle = (style: OptimizerStyle, req: OptimizeRequest, account: AccountData | null) => new Promise<WorkerReply>(
  (resolve) => {
    const worker = workers.get(style) ?? startWorker(style);
    const id = nextId;
    nextId += 1;
    pending.set(id, resolve);
    const job: StyleJob = {
      id, req, account, style,
    };
    worker.postMessage(job);
  },
);

// requests run one at a time, as each already uses a thread per style
let queue: Promise<unknown> = Promise.resolve();

const loadAccount = (player?: string): { account: AccountData | null, error?: string } => {
  try {
    return { account: readAccount(SYNC_DIR, player || PLAYER) };
  } catch (e) {
    return { account: null, error: e instanceof Error ? e.message : `${e}` };
  }
};

const optimize = async (req: OptimizeRequest & { player?: string }) => {
  const { account, error } = loadAccount(req.player);
  const warnings = [...(account?.warnings ?? [])];
  if (error) warnings.push(`Couldn't read the synced account: ${error}`);

  // check the request (and fail fast) before starting the workers
  const { info, opts } = prepare(req, account);
  const styles = opts.styles ?? OPTIMIZER_STYLES;
  const started = Date.now();
  const replies = await Promise.all(styles.map((s) => runStyle(s, req, account)));
  const failed = replies.find((r) => r.error);
  if (failed) throw new Error(failed.error);

  return {
    account: account && { player: account.player, updated: account.updated },
    warnings,
    ...info,
    results: Object.fromEntries(styles.map((s, i) => [s, replies[i].loadouts])),
    searchSeconds: Number(((Date.now() - started) / 1000).toFixed(1)),
    evaluations: replies.reduce((n, r) => n + (r.evaluations ?? 0), 0),
  };
};

const send = (res: http.ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body, null, 2));
};

const readBody = (req: http.IncomingMessage) => new Promise<string>((resolve, reject) => {
  let data = '';
  req.on('data', (chunk) => {
    data += chunk;
    if (data.length > 1_000_000) reject(new RequestError('Request body too large'));
  });
  req.on('end', () => resolve(data));
  req.on('error', reject);
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  try {
    if (req.method === 'GET' && url.pathname === '/health') {
      const { account, error } = loadAccount(url.searchParams.get('player') || undefined);
      send(res, 200, {
        ok: true,
        syncDir: SYNC_DIR,
        account: account && {
          player: account.player, updated: account.updated, items: account.itemIds.length, warnings: account.warnings,
        },
        accountError: error,
      });
    } else if (req.method === 'GET' && url.pathname === '/monsters') {
      send(res, 200, searchMonsters(url.searchParams.get('name') || ''));
    } else if (req.method === 'POST' && url.pathname === '/optimize') {
      let body: OptimizeRequest;
      try {
        body = JSON.parse(await readBody(req));
      } catch (e) {
        throw new RequestError(e instanceof RequestError ? e.message : 'The body must be JSON');
      }
      const run = queue.then(() => optimize(body));
      queue = run.catch(() => undefined);
      send(res, 200, await run);
    } else {
      send(res, 404, { error: 'Use GET /health, GET /monsters?name=..., or POST /optimize' });
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : `${e}`;
    send(res, e instanceof RequestError ? 400 : 500, { error: message });
    if (!(e instanceof RequestError)) console.error(e);
  }
});

OPTIMIZER_STYLES.forEach(startWorker);
server.listen(PORT, '127.0.0.1', () => {
  console.log(`Gear optimizer server running at http://localhost:${PORT} (sync folder: ${SYNC_DIR})`);
});
