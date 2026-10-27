import { EquipmentPiece, Player, PlayerEquipment } from '@/types/Player';
import { Monster } from '@/types/Monster';
import GearOptimizer from './GearOptimizer';
import {
  EXHAUSTIVE_BUDGET, EXHAUSTIVE_OTHERS_FRACTION, PAIR_SWAP_RESULTS, RESULTS_PER_WEAPON, WEAPONS_FOR_SET_SEEDS,
} from './constants';
import { compareScores, isBetter, withSlot } from './config';
import { splitShortlist } from './exhaustive';
import { searchedStyles } from './styles';
import {
  Config, FinishedLoadout, JobOutcome, JobResults, OptimizerJob, OptimizerOpts, OptimizerProgressCallback, OptimizerResult,
  OptimizerStyle, PlanResult, ScoredConfig, Shortlist, StyleSearchResult, StyleSearchSummary,
} from './types';

const weaponKey = (c: Config) => {
  const w = c.equipment.weapon;
  return w ? `${w.name}:${w.itemVars?.blowpipeDartName || ''}` : '';
};

const sameEquipment = (a: Config, b: Config) => (Object.keys(a.equipment) as (keyof PlayerEquipment)[])
  .every((slot) => (a.equipment[slot]?.id ?? null) === (b.equipment[slot]?.id ?? null));

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
  const { starts, setSeeds, ...planSummary } = plan;

  // 3. refine the best few weapons...
  const refined = ((yield starts.map((start): OptimizerJob => ({ kind: 'refine', family, start }))) as (ScoredConfig | null)[])
    .filter((x): x is ScoredConfig => !!x)
    .sort(([, a], [, b]) => compareScores(a, b));

  // ...and then try the set seeds on the best of them, in their refined armour
  const seedWeapons = new Map<string, Config>();
  for (const [c] of refined) {
    if (seedWeapons.size >= WEAPONS_FOR_SET_SEEDS) break;
    if (!seedWeapons.has(weaponKey(c))) seedWeapons.set(weaponKey(c), c);
  }
  const seeded = [...seedWeapons.values()].flatMap((c) => setSeeds.map((seed) => {
    let s = c;
    for (const [slot, item] of Object.entries(seed)) s = withSlot(s, slot as keyof PlayerEquipment, item ?? null);
    return s;
  }));
  const refinedSeeded = seeded.length === 0 ? []
    : ((yield seeded.map((start): OptimizerJob => ({ kind: 'refine', family, start }))) as (ScoredConfig | null)[])
      .filter((x): x is ScoredConfig => !!x);
  planSummary.setStarts += seeded.length;

  // keep the best two results per weapon (by name, as e.g. poisoned variants are functionally identical), as the
  // second best may be in different armour (e.g. without a set seed's void) that the swaps can still improve more
  const perWeapon = new Map<string, ScoredConfig[]>();
  for (const r of [...refined, ...refinedSeeded].sort(([, a], [, b]) => compareScores(a, b))) {
    const key = weaponKey(r[0]);
    const kept = perWeapon.get(key) ?? [];
    if (kept.length < RESULTS_PER_WEAPON && !kept.some(([c]) => sameEquipment(c, r[0]))) kept.push(r);
    perWeapon.set(key, kept);
  }
  const ranked = [...perWeapon.values()].sort(([[, a]], [[, b]]) => compareScores(a, b));

  // 4. try two-slot swaps on the best results, to escape set-ups where no single swap helps. These only ever improve a
  // result, so the shown results are always among these.
  const resultsPerStyle = opts.resultsPerStyle ?? 5;
  const swappedAll = (yield ranked
    .slice(0, Math.max(resultsPerStyle, PAIR_SWAP_RESULTS))
    .flat()
    .map(([start]): OptimizerJob => ({ kind: 'pairSwap', family, start }))) as ScoredConfig[];
  const swappedPerWeapon = new Map<string, ScoredConfig>();
  for (const r of swappedAll) {
    const key = weaponKey(r[0]);
    const existing = swappedPerWeapon.get(key);
    if (!existing || isBetter(r[1], existing[1])) swappedPerWeapon.set(key, r);
  }
  const swapped = [...swappedPerWeapon.values()];
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
