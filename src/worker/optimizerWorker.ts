/* eslint-disable no-restricted-globals */
import { OptimizerWorkerRequest, OptimizerWorkerResponse } from '@/worker/CalcWorkerTypes';
import { GearOptimizer } from '@/lib/GearOptimizer';
import { WORKER_JSON_REPLACER, WORKER_JSON_REVIVER } from '@/utils';

/**
 * Runs gear optimizer jobs for the OptimizerPool. Each search starts with an init message, and every job after it runs
 * on the same GearOptimizer, so that its cache is shared between the jobs this worker runs.
 */
let optimizer: GearOptimizer | undefined;

const post = (msg: OptimizerWorkerResponse) => self.postMessage(JSON.stringify(msg, WORKER_JSON_REPLACER));

self.onmessage = (evt: MessageEvent<string>) => {
  const msg = JSON.parse(evt.data, WORKER_JSON_REVIVER) as OptimizerWorkerRequest;

  if (msg.type === 'init') {
    const {
      owned, player, monster, opts,
    } = msg.data;
    optimizer = new GearOptimizer(owned, player, monster, opts, (evaluations) => post({ type: 'progress', evaluations }));
    return;
  }

  try {
    if (!optimizer) {
      throw new Error('The optimizer worker received a job before it was initialised');
    }
    const result = optimizer.runJob(msg.job);
    post({
      type: 'result', id: msg.id, result, evaluations: optimizer.evaluations,
    });
  } catch (e: unknown) {
    console.error(e);
    post({ type: 'error', id: msg.id, error: e instanceof Error ? e.message : `${e}` });
  }
};

export {};
