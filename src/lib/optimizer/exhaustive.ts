import { EquipmentPiece, PlayerEquipment } from '@/types/Player';
import type GearOptimizer from './GearOptimizer';
import {
  ARMOUR_SLOTS, EXHAUSTIVE_CHUNKS_PER_RESULT, EXHAUSTIVE_MIN_CHUNK_SIZE, SHORTLIST_RISK_FRACTION, SHORTLIST_WEIGHT_FRACTION,
} from './constants';
import { isBetter, withSlot } from './config';
import { isFeasible } from './constraints';
import {
  Config, JobResults, Shortlist,
} from './types';

/**
 * Step 5: picks the items to try in each slot around a result, within the budget for the number of combinations.
 * Each slot starts with just its current item, and the next item added is always the one (in any slot) that comes
 * closest to the result's DPS when swapped in alone, so that close calls get more options than clear winners.
 */
export const pickShortlist = (o: GearOptimizer, start: Config, budget: number): Shortlist => {
  const startScore = o.score(start);
  const weapon = start.equipment.weapon;
  const lambda = o.hasMinWeight ? (SHORTLIST_WEIGHT_FRACTION * startScore.dps) / o.opts.minWeight! : 0;
  const riskLambda = o.hasRiskLimit ? (SHORTLIST_RISK_FRACTION * startScore.dps) / o.riskScale : 0;

  const queues: { slot: keyof PlayerEquipment, items: (EquipmentPiece | null)[], next: [EquipmentPiece | null, number][] }[] = [];
  for (const slot of ARMOUR_SLOTS) {
    const current = start.equipment[slot] ?? null;
    const next = o.getSlotOptions(slot, weapon)
      .filter((item) => (item?.id ?? null) !== (current?.id ?? null))
      .map((item): [EquipmentPiece | null, number] => {
        const swapped = withSlot(start, slot, item);
        const dpsLoss = startScore.dps - o.score(swapped).dps;
        const weightGain = (item?.weight || 0) - (current?.weight || 0);
        return [item, dpsLoss - lambda * weightGain + riskLambda * o.excessRisk(swapped)];
      })
      .sort(([, a], [, b]) => a - b);
    if (next.length > 0) queues.push({ slot, items: [current], next });
  }

  let combinations = 1;
  for (;;) {
    let pick: typeof queues[number] | undefined;
    for (const q of queues) {
      const fits = q.next.length > 0 && (combinations / q.items.length) * (q.items.length + 1) <= budget;
      if (fits && (!pick || q.next[0][1] < pick.next[0][1])) pick = q;
    }
    if (!pick) break;
    combinations = (combinations / pick.items.length) * (pick.items.length + 1);
    pick.items.push(pick.next.shift()![0]);
  }

  // the slots with the most options go first, so that the jobs can be split on as few slots as possible
  const used = queues.filter((q) => q.items.length > 1).sort((a, b) => b.items.length - a.items.length);
  return {
    start,
    slots: used.map((q) => q.slot),
    itemIds: used.map((q) => q.items.map((i) => i?.id ?? null)),
  };
};

/**
 * Step 5: tries every combination of the shortlist that starts with the given items (by index) in its first slots.
 * These evaluations aren't cached, as there are far too many of them and they are never repeated.
 */
export const exhaust = (o: GearOptimizer, shortlist: Shortlist, prefix: number[]): JobResults['exhaust'] => {
  const { start, slots } = shortlist;
  const options = shortlist.itemIds.map((ids) => ids.map((id) => (id === null ? null : o.itemsById.get(id) ?? null)));
  const equipment: PlayerEquipment = { ...start.equipment };
  for (const [i, choice] of prefix.entries()) {
    equipment[slots[i]] = options[i][choice];
  }

  const ret: JobResults['exhaust'] = { best: null, tried: 0 };
  const tryFrom = (i: number) => {
    if (i === slots.length) {
      if (!isFeasible({ equipment }, o.opts)) return;
      const c: Config = { ...start, equipment: { ...equipment } };
      const s = o.evaluate(c);
      ret.tried += 1;
      o.countUncachedEvaluation();
      if (s.dps > 0 && (!ret.best || isBetter(s, ret.best[1]))) ret.best = [c, s];
      return;
    }
    for (const item of options[i]) {
      equipment[slots[i]] = item;
      tryFrom(i + 1);
    }
  };
  tryFrom(prefix.length);
  return ret;
};

/**
 * Splits a shortlist's combinations into jobs, by fixing the items in its first few slots. Returns the item indices
 * for those slots, one list per job (none if there is nothing to try).
 */
export const splitShortlist = (shortlist: Shortlist): number[][] => {
  if (shortlist.slots.length === 0) return [];
  const combinations = shortlist.itemIds.reduce((n, ids) => n * ids.length, 1);
  const jobs = Math.min(EXHAUSTIVE_CHUNKS_PER_RESULT, Math.ceil(combinations / EXHAUSTIVE_MIN_CHUNK_SIZE));

  let prefixes: number[][] = [[]];
  for (let i = 0; i < shortlist.slots.length && prefixes.length < jobs; i++) {
    prefixes = prefixes.flatMap((p) => shortlist.itemIds[i].map((_, k) => [...p, k]));
  }
  return prefixes;
};
