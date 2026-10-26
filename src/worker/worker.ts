/* eslint-disable no-restricted-globals */
import {
  CalcRequestsUnion,
  CalcResponse,
  Handler,
  OptimizeGearProgressMessage,
  TtkRequest,
  TtkResponse,
  WorkerRequestType,
} from '@/worker/CalcWorkerTypes';
import { NPCVsPlayerCalculatedLoadout, PlayerVsNPCCalculatedLoadout } from '@/types/State';
import NPCVsPlayerCalc from '@/lib/NPCVsPlayerCalc';
import PlayerVsNPCCalc from '@/lib/PlayerVsNPCCalc';
import Comparator from '@/lib/Comparator';
import { ttkDist } from '@/worker/ttkWorker';
import { range } from 'd3-array';
import { DeferredPromise, WORKER_JSON_REPLACER, WORKER_JSON_REVIVER } from '@/utils';
import { NUMBER_OF_LOADOUTS } from '@/lib/constants';
import { optimizeGear, optimizeGearWith, OptimizerResult } from '@/lib/GearOptimizer';
import OptimizerPool from '@/worker/OptimizerPool';

const computePvMValues: Handler<WorkerRequestType.COMPUTE_BASIC> = async (data) => {
  const { loadouts, monster, calcOpts } = data;
  const res: PlayerVsNPCCalculatedLoadout[] = [];

  // eslint-disable-next-line no-restricted-syntax
  for (const [i, p] of loadouts.entries()) {
    const loadoutName = (i + 1).toString();
    const start = self.performance.now();

    const calc = new PlayerVsNPCCalc(p, monster, {
      loadoutName,
      detailedOutput: calcOpts.detailedOutput,
      disableMonsterScaling: calcOpts.disableMonsterScaling,
    });
    const specCalc = calc.getSpecCalc();

    res.push({
      npcDefRoll: calc.getNPCDefenceRoll(),
      maxHit: calc.getDistribution().getMax(),
      expectedHit: calc.getDistribution().getExpectedDamage(),
      maxAttackRoll: calc.getMaxAttackRoll(),
      accuracy: calc.getDisplayHitChance(),
      dps: calc.getDps(),
      ttk: calc.getTtk(),
      hitDist: calc.getDistribution().asHistogram(calcOpts.hitDistHideMisses),
      details: calc.details,
      userIssues: calc.userIssues,

      specAccuracy: specCalc?.getDisplayHitChance(),
      specMaxHit: specCalc?.getMax(),
      specExpected: specCalc?.getExpectedDamage(),
      specMomentDps: specCalc?.getDps(),
      specFullDps: specCalc?.getSpecDps(),
      specHitDist: specCalc?.getDistribution().asHistogram(calcOpts.hitDistHideMisses),
      specDetails: specCalc?.details,
    });

    const end = self.performance.now();
    console.debug(`Loadout ${i + 1} took ${end - start}ms to calculate`);
  }

  return res;
};

const computeMvPValues: Handler<WorkerRequestType.COMPUTE_REVERSE> = async (data) => {
  const { loadouts, monster, calcOpts } = data;
  const res: NPCVsPlayerCalculatedLoadout[] = [];

  for (const [i, p] of loadouts.entries()) {
    const loadoutName = (i + 1).toString();
    const start = self.performance.now();
    const calc = new NPCVsPlayerCalc(p, monster, {
      loadoutName: `${loadoutName}/reverse`,
      detailedOutput: calcOpts.detailedOutput,
      disableMonsterScaling: calcOpts.disableMonsterScaling,
    });
    res.push({
      npcMaxAttackRoll: calc.getNPCMaxAttackRoll(),
      npcMaxHit: calc.getDistribution().getMax(),
      npcDps: calc.getDps(),
      npcAccuracy: calc.getHitChance(),
      playerDefRoll: calc.getPlayerDefenceRoll(),
      avgDmgTaken: calc.getAverageDamageTaken(),
      npcDetails: calc.details,
    });

    const end = self.performance.now();
    console.debug(`Reverse loadout ${i + 1} took ${end - start}ms to calculate`);
  }

  return res;
};

const compare: Handler<WorkerRequestType.COMPARE> = async (data) => {
  const { axes, loadouts, monster } = data;
  const comparator = new Comparator(loadouts, monster, axes.x, axes.y);

  const [entries, domainMax] = comparator.getEntries();

  return {
    entries,
    annotations: {
      x: comparator.getAnnotationsX(),
      y: comparator.getAnnotationsY(),
    },
    domainMax,
  };
};

/** How often (in ms) gear optimizer progress is sent to the main thread. */
const OPTIMIZER_PROGRESS_INTERVAL_MS = 200;
/** One thread is left for the main thread (this worker mostly waits while the pool runs). */
const OPTIMIZER_POOL_SIZE = Math.max(1, Math.min((self.navigator?.hardwareConcurrency || 4) - 1, 16));

// created on the first search, and kept around so that later searches don't wait for the workers to start
let optimizerPool: OptimizerPool | undefined;
let optimizerPoolBusy = false;

const optimize: Handler<WorkerRequestType.OPTIMIZE_GEAR> = async (data, req) => {
  const {
    owned, player, monster, opts,
  } = data;

  let lastProgressAt = 0;
  let stylesDone = 0;
  const sendProgress = (evaluations: number, force = false) => {
    const now = self.performance.now();
    if (!force && now - lastProgressAt < OPTIMIZER_PROGRESS_INTERVAL_MS) return;
    lastProgressAt = now;
    const msg: OptimizeGearProgressMessage = {
      type: WorkerRequestType.OPTIMIZE_GEAR,
      sequenceId: req.sequenceId!,
      progress: { evaluations, stylesDone },
    };
    self.postMessage(JSON.stringify(msg, WORKER_JSON_REPLACER));
  };

  const start = self.performance.now();
  let result: OptimizerResult;
  if (typeof Worker === 'undefined') {
    // nested workers aren't supported, so search on this thread
    result = optimizeGear(owned, player, monster, opts, (p) => {
      stylesDone = p.stylesDone;
      sendProgress(p.evaluations);
    });
  } else {
    // a previous search is still running, but its results won't be used anymore
    if (optimizerPool && optimizerPoolBusy) {
      optimizerPool.terminate();
      optimizerPool = undefined;
    }
    const pool = optimizerPool ?? new OptimizerPool(OPTIMIZER_POOL_SIZE);
    optimizerPool = pool;
    optimizerPoolBusy = true;

    try {
      pool.init(data, (evaluations) => sendProgress(evaluations));
      const loadouts = await optimizeGearWith(opts, (job) => pool.run(job), () => {
        stylesDone += 1;
        sendProgress(pool.totalEvaluations, true);
      });
      result = { ...loadouts, evaluations: pool.totalEvaluations };
    } finally {
      if (optimizerPool === pool) optimizerPoolBusy = false;
    }
  }
  const end = self.performance.now();
  console.debug(`Gear optimization of ${owned.length} items took ${end - start}ms (${result.evaluations} evaluations, ${optimizerPool?.size ?? 1} threads)`);

  return result;
};

// workers that compute a single ttk dist and then terminate
type OneShotWorker<T> = { promise: DeferredPromise<T>, worker: Worker };
const createTtkWorker = (): OneShotWorker<TtkResponse> => {
  const promise = new DeferredPromise<TtkResponse>();
  const worker = new Worker(new URL('./ttkWorker.ts', import.meta.url));
  worker.onmessage = (evt: MessageEvent) => {
    const result = JSON.parse(evt.data, WORKER_JSON_REVIVER);
    worker.terminate();
    promise.resolve(result);
  };
  worker.onerror = (ev: ErrorEvent) => console.error(ev.message, ev);
  return { promise, worker };
};

const ttkWorkers: (OneShotWorker<TtkResponse> | undefined)[] = range(0, 10).map(
  // only seed first half, otherwise we waste the other half immediately
  (i) => (i < NUMBER_OF_LOADOUTS ? createTtkWorker() : undefined),
);
let ttkModulus: number = 1; // whether we use first set or second set
let lastSequenceId: number = -1;

/**
 * proxies two sets of downstream workers in order
 *   a) compute each ttk dist in parallel
 *   b) be cancellable via terminate()
 *   c) keep a "warm" pool of computers
 * the `i % {NUMBER_OF_LOADOUTS}`th ttkWorker corresponds to the `i`th loadout index
 * unfortunately we can't reuse CalcWorker due to cyclic imports
 */
const ttkDistParallel: Handler<WorkerRequestType.COMPUTE_TTK_PARALLEL> = async (data, rawRequest) => {
  const { sequenceId } = rawRequest;
  const { loadouts, monster, calcOpts } = data;
  lastSequenceId = sequenceId!;

  const prevBase = ttkModulus * NUMBER_OF_LOADOUTS;
  ttkModulus += 1;
  ttkModulus %= 2;
  const currBase = ttkModulus * NUMBER_OF_LOADOUTS;

  // kill in progress computes immediately
  for (let i = 0; i < NUMBER_OF_LOADOUTS; i++) {
    ttkWorkers[prevBase + i]?.worker?.terminate();
  }

  // fire off a ttk compute for each loadout
  const start = self.performance.now();
  const requests: Promise<TtkResponse>[] = [];
  for (let i = 0; i < loadouts.length; i++) {
    const loadout = loadouts[i];
    if (!loadout) {
      continue;
    }

    // ideally this never creates inline, but it's fine if it does
    const { promise, worker } = ttkWorkers[currBase + i] || (ttkWorkers[currBase + i] = createTtkWorker());
    worker.postMessage(JSON.stringify(<TtkRequest>{
      type: WorkerRequestType.COMPUTE_TTK,
      sequenceId: sequenceId!,
      data: {
        loadouts: [loadout], // we're just splitting up the payloads into one per worker
        monster,
        calcOpts,
      },
    }));
    requests.push(promise.promise);
  }

  // while we wait for the jobs to finish we can spin up the workers for the next request
  for (let i = 0; i < NUMBER_OF_LOADOUTS; i++) {
    ttkWorkers[prevBase + i] = createTtkWorker();
  }

  // this is where the "parallel" magic happens,
  // since await clears the call stack allowing other requests to come in and cancel the previous
  // todo it would be pretty nice if we could stream these back instead of batching
  const results = await Promise.all(requests);
  const end = self.performance.now();
  console.debug(`Aggregating ${requests.length} TTK dists took ${end - start}`);

  // only need to check first elt, since all reqs in requests array are guaranteed to match
  if (results[0].sequenceId !== lastSequenceId) {
    // this shouldn't really happen except in rare race conditions,
    // but it'll get dropped by CalcWorker on return so we can return empty
    console.debug(`Dropping ttk parallel ${results[0].sequenceId} as stale`);
    return [];
  }

  // unwrap
  const ret: TtkResponse['payload'] = [];
  for (const [ix, { payload, error }] of results.entries()) {
    if (error) {
      throw new Error(error);
    }

    ret[ix] = payload[0];
  }

  return ret;
};

self.onmessage = async (evt: MessageEvent<string>) => {
  const req = JSON.parse(evt.data, WORKER_JSON_REVIVER) as CalcRequestsUnion;
  const { type, sequenceId, data } = req;

  const res = {
    type,
    sequenceId: sequenceId!,
  } as CalcResponse<typeof type>;

  // Interpret the incoming request, and action it accordingly
  try {
    switch (type) {
      case WorkerRequestType.COMPUTE_BASIC: {
        res.payload = await computePvMValues(data, req);
        break;
      }

      case WorkerRequestType.COMPUTE_REVERSE: {
        res.payload = await computeMvPValues(data, req);
        break;
      }

      case WorkerRequestType.COMPARE: {
        res.payload = await compare(data, req);
        break;
      }

      // keep direct access here even though we normally proxy, for debugging if needed
      case WorkerRequestType.COMPUTE_TTK: {
        res.payload = await ttkDist(data, req);
        break;
      }

      case WorkerRequestType.COMPUTE_TTK_PARALLEL: {
        res.payload = await ttkDistParallel(data, req);
        break;
      }

      case WorkerRequestType.OPTIMIZE_GEAR: {
        res.payload = await optimize(data, req);
        break;
      }

      default:
        res.error = `Unsupported request type ${type}`;
    }
  } catch (e: unknown) {
    if (e instanceof Error) {
      console.error(e);
      res.error = e.message;
    } else {
      res.error = `Unknown error type: ${e}`;
    }
  }

  // Send message back to the master
  self.postMessage(JSON.stringify(res, WORKER_JSON_REPLACER));
};

export {};
