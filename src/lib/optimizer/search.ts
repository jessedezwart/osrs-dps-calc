import { EquipmentPiece, Player } from '@/types/Player';
import { Monster } from '@/types/Monster';
import GearOptimizer from './GearOptimizer';
import { EXHAUSTIVE_BUDGET, EXHAUSTIVE_OTHERS_FRACTION, PAIR_SWAP_RESULTS } from './constants';
import { compareScores, isBetter } from './config';
import { splitShortlist } from './exhaustive';
import { searchedStyles } from './styles';
import {
  FinishedLoadout, JobOutcome, JobResults, OptimizerJob, OptimizerOpts, OptimizerProgressCallback, OptimizerResult,
  OptimizerStyle, PlanResult, ScoredConfig, Shortlist, StyleSearchResult, StyleSearchSummary,
} from './types';

/**
 * The search for a single style, as a generator that yields each batch of jobs that can run in parallel, and receives
 * their results (in the same order). Returns the final loadouts.
 */
export function* searchStyle(
  family: OptimizerStyle,
  opts: OptimizerOpts,
): Generator<OptimizerJob[], StyleSearchResult, unknown[]> {
  // steps 1 and 2
  const [plan] = (yield [{ kind: 'plan', family }]) as [PlanResult];
  const { starts, ...planSummary } = plan;

  // 3. refine the best few weapons, and try the set seeds
  const refined = (yield starts.map((start): OptimizerJob => ({ kind: 'refine', family, start }))) as (ScoredConfig | null)[];

  // keep the best result per weapon (by name, as e.g. poisoned variants are functionally identical)
  const bestPerWeapon = new Map<string, ScoredConfig>();
  for (const r of refined) {
    if (!r) continue;
    const w = r[0].equipment.weapon;
    const key = w ? `${w.name}:${w.itemVars?.blowpipeDartName || ''}` : '';
    const existing = bestPerWeapon.get(key);
    if (!existing || isBetter(r[1], existing[1])) {
      bestPerWeapon.set(key, r);
    }
  }
  const ranked = [...bestPerWeapon.values()].sort(([, a], [, b]) => compareScores(a, b));

  // 4. try two-slot swaps on the best results, to escape set-ups where no single swap helps. These only ever improve a
  // result, so the shown results are always among these.
  const resultsPerStyle = opts.resultsPerStyle ?? 5;
  const swapped = (yield ranked
    .slice(0, Math.max(resultsPerStyle, PAIR_SWAP_RESULTS))
    .map(([start]): OptimizerJob => ({ kind: 'pairSwap', family, start }))) as ScoredConfig[];
  const shown = [...swapped].sort(([, a], [, b]) => compareScores(a, b)).slice(0, resultsPerStyle);

  // 5. try every combination of a shortlist of items per slot around each shown result, which finds improvements that
  // need many slots to change at once. The best result gets the most of the budget.
  const budget = opts.exhaustiveBudget ?? EXHAUSTIVE_BUDGET;
  const shortlists = (yield shown.map(([start], i): OptimizerJob => ({
    kind: 'shortlist', family, start, budget: i === 0 ? budget : Math.round(budget * EXHAUSTIVE_OTHERS_FRACTION),
  }))) as Shortlist[];
  const exhaustJobs: OptimizerJob[] = [];
  const exhaustJobResult: number[] = [];
  for (const [i, shortlist] of shortlists.entries()) {
    for (const prefix of splitShortlist(shortlist)) {
      exhaustJobs.push({
        kind: 'exhaust', family, shortlist, prefix,
      });
      exhaustJobResult.push(i);
    }
  }
  const exhausted = (yield exhaustJobs) as JobResults['exhaust'][];
  const improved = [...shown];
  let exhaustiveCombinations = 0;
  for (const [j, { best, tried }] of exhausted.entries()) {
    exhaustiveCombinations += tried;
    const i = exhaustJobResult[j];
    if (best && isBetter(best[1], improved[i][1])) improved[i] = best;
  }

  // 6. a final pass of single swaps, and the alternatives
  const finished = (yield improved.map(([start]): OptimizerJob => ({ kind: 'describe', family, start }))) as FinishedLoadout[];

  return {
    loadouts: finished
      .sort((a, b) => compareScores(a.score, b.score))
      .slice(0, resultsPerStyle)
      .map((f) => f.loadout),
    summary: {
      ...planSummary,
      pairSwapped: swapped.length,
      exhaustiveCombinations,
      exhaustiveImprovements: improved.filter((r, i) => r !== shown[i]).length,
    },
  };
}

const addEvaluations = (counts: StyleSearchSummary['evaluations'], job: OptimizerJob, evaluations: number) => {
  counts[job.kind] = (counts[job.kind] ?? 0) + evaluations;
};

/**
 * Finds the highest-DPS loadouts for each combat style, using only the provided (owned) equipment, on this thread.
 * @see GearOptimizer
 */
export const optimizeGear = (
  owned: EquipmentPiece[],
  basePlayer: Player,
  monster: Monster,
  opts: OptimizerOpts,
  onProgress?: OptimizerProgressCallback,
): OptimizerResult => {
  let stylesDone = 0;
  const optimizer = new GearOptimizer(owned, basePlayer, monster, opts, (evaluations) => onProgress?.({ evaluations, stylesDone }));

  const result = {
    melee: [], ranged: [], magic: [], evaluations: 0, summary: {},
  } as OptimizerResult;
  for (const style of searchedStyles(opts)) {
    const evaluations: StyleSearchSummary['evaluations'] = {};
    const search = searchStyle(style, opts);
    let step = search.next();
    while (!step.done) {
      step = search.next(step.value.map((job) => {
        const before = optimizer.evaluations;
        const r = optimizer.runJob(job);
        addEvaluations(evaluations, job, optimizer.evaluations - before);
        return r;
      }));
    }
    result[style] = step.value.loadouts;
    result.summary[style] = { ...step.value.summary, evaluations };
    stylesDone += 1;
    onProgress?.({ evaluations: optimizer.evaluations, stylesDone });
  }
  result.evaluations = optimizer.evaluations;
  return result;
};

/**
 * Finds the highest-DPS loadouts for each combat style, like optimizeGear, but runs the jobs with the given function,
 * which may run them in parallel (e.g. on a pool of workers each with their own GearOptimizer). All styles are
 * searched at the same time.
 * @param runJob - runs the job on a GearOptimizer created with the same inputs, and returns its result
 * @param onStyleDone - called as each style finishes
 */
export const optimizeGearWith = async (
  opts: OptimizerOpts,
  runJob: (job: OptimizerJob) => Promise<JobOutcome>,
  onStyleDone?: (style: OptimizerStyle) => void,
): Promise<Omit<OptimizerResult, 'evaluations'>> => {
  const result: Omit<OptimizerResult, 'evaluations'> = {
    melee: [], ranged: [], magic: [], summary: {},
  };
  await Promise.all(searchedStyles(opts).map(async (style) => {
    const evaluations: StyleSearchSummary['evaluations'] = {};
    const search = searchStyle(style, opts);
    let step = search.next();
    while (!step.done) {
      // eslint-disable-next-line no-await-in-loop
      const outcomes = await Promise.all(step.value.map(async (job) => {
        const outcome = await runJob(job);
        addEvaluations(evaluations, job, outcome.evaluations);
        return outcome.result;
      }));
      step = search.next(outcomes);
    }
    result[style] = step.value.loadouts;
    result.summary[style] = { ...step.value.summary, evaluations };
    onStyleDone?.(style);
  }));
  return result;
};
