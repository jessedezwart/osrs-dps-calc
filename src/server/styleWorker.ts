/**
 * A worker thread of the optimizer server, which searches one style at a time.
 */
import { parentPort } from 'node:worker_threads';
import { optimizeGear, OptimizerStyle } from '@/lib/optimizer';
import { AccountData } from './accountData';
import { describeLoadout, OptimizeRequest, prepare } from './optimize';

export interface StyleJob {
  id: number;
  req: OptimizeRequest;
  account: AccountData | null;
  style: OptimizerStyle;
}

parentPort!.on('message', ({
  id, req, account, style,
}: StyleJob) => {
  try {
    const p = prepare({ ...req, styles: [style] }, account);
    const result = optimizeGear(p.owned, p.player, p.monster, p.opts);
    parentPort!.postMessage({
      id,
      loadouts: result[style].map((l) => describeLoadout(l, p.monster.skills.hp)),
      evaluations: result.evaluations,
    });
  } catch (e) {
    parentPort!.postMessage({ id, error: e instanceof Error ? e.message : `${e}` });
  }
});
