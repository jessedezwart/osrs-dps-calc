import type GearOptimizer from './GearOptimizer';
import {
  ARMOUR_SLOTS, EPSILON, MAX_DESCENT_PASSES, MAX_RISK_REPAIR_STEPS, MAX_WEIGHT_REPAIR_STEPS, WEIGHT_EPSILON,
  WEIGHT_TRADE_FRACTIONS,
} from './constants';
import { isBetter, withSlot } from './config';
import { equipmentWeight } from './constraints';
import { Config, Score } from './types';

/**
 * Brings the setup down to the risk limit by swapping one armour slot at a time. If a single swap is enough, the
 * highest scoring one is used. Otherwise, the swap that loses the least DPS per gp of risk removed is made, and it
 * tries again.
 */
const reduceRisk = (o: GearOptimizer, start: Config, startScore: Score): [Config, Score] => {
  let current = start;
  let currentScore = startScore;

  for (let step = 0; step < MAX_RISK_REPAIR_STEPS && !o.withinRisk(current); step++) {
    const weapon = current.equipment.weapon;
    const currentRisk = o.risk(current);
    let finished: [Config, Score] | null = null;
    let partial: { c: Config, s: Score, cost: number, gain: number } | null = null;

    for (const slot of ARMOUR_SLOTS) {
      if (slot === 'shield' && weapon?.isTwoHanded) continue;

      for (const item of o.getSlotOptions(slot, weapon)) {
        if ((current.equipment[slot]?.id ?? null) === (item?.id ?? null)) continue;
        const candidate = withSlot(current, slot, item);
        const gain = currentRisk - o.risk(candidate);
        if (gain <= 0) continue;

        const s = o.score(candidate);
        if (o.withinRisk(candidate)) {
          if (!finished || isBetter(s, finished[1])) finished = [candidate, s];
        } else if (!finished) {
          const cost = (currentScore.dps - s.dps) / gain;
          const cheaper = !partial || cost < partial.cost - EPSILON
            || (Math.abs(cost - partial.cost) <= EPSILON && gain > partial.gain);
          if (cheaper) {
            partial = {
              c: candidate, s, cost, gain,
            };
          }
        }
      }
    }

    if (finished) return finished;
    if (!partial) break;
    current = partial.c;
    currentScore = partial.s;
  }

  return [current, currentScore];
};

/**
 * Brings the setup up to the minimum weight by swapping one armour slot at a time (staying within the risk limit). If
 * a single swap is enough, the highest scoring one is used. Otherwise, the swap that loses the least DPS per kg gained
 * is made, and it tries again.
 */
const addWeight = (o: GearOptimizer, start: Config, startScore: Score): [Config, Score] => {
  let current = start;
  let currentScore = startScore;

  for (let step = 0; step < MAX_WEIGHT_REPAIR_STEPS && !o.meetsMinWeight(current); step++) {
    const weapon = current.equipment.weapon;
    const currentWeight = equipmentWeight(current.equipment);
    let finished: [Config, Score] | null = null;
    let partial: { c: Config, s: Score, cost: number, gain: number } | null = null;

    for (const slot of ARMOUR_SLOTS) {
      if (slot === 'shield' && weapon?.isTwoHanded) continue;

      for (const item of o.getSlotOptions(slot, weapon)) {
        if ((current.equipment[slot]?.id ?? null) === (item?.id ?? null)) continue;
        const candidate = withSlot(current, slot, item);
        const gain = equipmentWeight(candidate.equipment) - currentWeight;
        if (gain <= WEIGHT_EPSILON || !o.withinRisk(candidate)) continue;

        const s = o.score(candidate);
        if (o.meetsMinWeight(candidate)) {
          if (!finished || isBetter(s, finished[1])) finished = [candidate, s];
        } else if (!finished) {
          const cost = (currentScore.dps - s.dps) / gain;
          const cheaper = !partial || cost < partial.cost - EPSILON
            || (Math.abs(cost - partial.cost) <= EPSILON && gain > partial.gain);
          if (cheaper) {
            partial = {
              c: candidate, s, cost, gain,
            };
          }
        }
      }
    }

    if (finished) return finished;
    if (!partial) break;
    current = partial.c;
    currentScore = partial.s;
  }

  return [current, currentScore];
};

/**
 * Greedy coordinate descent: repeatedly try every candidate in every armour slot, keeping any swap that improves
 * the score (and keeps the setup at the minimum weight and within the risk limit), until a full pass makes no
 * improvement. If the start is over the risk limit or under the minimum weight, it is first brought within them.
 */
export const descend = (o: GearOptimizer, start: Config): [Config, Score] => {
  let [best, bestScore] = o.pickWeaponSettings(start);
  if (!o.withinRisk(best)) {
    [best, bestScore] = reduceRisk(o, best, bestScore);
    // the setup can't get under the risk limit with this weapon, so it'll be dropped
    if (!o.withinRisk(best)) return [best, bestScore];
  }
  if (!o.meetsMinWeight(best)) {
    [best, bestScore] = addWeight(o, best, bestScore);
    // the setup can't reach the minimum weight with this weapon, so it'll be dropped
    if (!o.isFeasible(best)) return [best, bestScore];
  }

  for (let pass = 0; pass < MAX_DESCENT_PASSES; pass++) {
    let improved = false;
    const weapon = best.equipment.weapon;

    for (const slot of ARMOUR_SLOTS) {
      if (slot === 'shield' && weapon?.isTwoHanded) continue;

      for (const item of o.getSlotOptions(slot, weapon)) {
        if ((best.equipment[slot]?.id ?? null) === (item?.id ?? null)) continue;
        const candidate = withSlot(best, slot, item);
        if (!o.isFeasible(candidate)) continue;
        const s = o.score(candidate);
        if (isBetter(s, bestScore)) {
          best = candidate;
          bestScore = s;
          improved = true;
        }
      }
    }

    // the best style or spell may have changed with the new gear
    const repicked = o.pickWeaponSettings(best);
    if (isBetter(repicked[1], bestScore)) {
      [best, bestScore] = repicked;
      improved = true;
    }

    if (!improved) break;
  }

  return [best, bestScore];
};

/**
 * Coordinate descent on DPS plus a bonus of `weightLambda` DPS per kg (up to the minimum weight), minus
 * `riskLambda` DPS per gp over the risk limit, ignoring the constraints themselves (a Lagrangian relaxation of them).
 * This spreads the weight over the slots where it costs the least DPS, and drops the risk where that costs the least
 * DPS, so the result is a good place to start the constrained descent from.
 */
const descendRelaxed = (o: GearOptimizer, start: Config, weightLambda: number, riskLambda: number): Config => {
  const value = (c: Config, s: Score) => s.dps
    + (weightLambda > 0 ? weightLambda * Math.min(equipmentWeight(c.equipment), o.opts.minWeight!) : 0)
    - riskLambda * o.excessRisk(c);

  let [best, bestScore] = o.pickWeaponSettings(start);
  let bestValue = value(best, bestScore);
  for (let pass = 0; pass < MAX_DESCENT_PASSES; pass++) {
    let improved = false;
    const weapon = best.equipment.weapon;

    for (const slot of ARMOUR_SLOTS) {
      if (slot === 'shield' && weapon?.isTwoHanded) continue;

      for (const item of o.getSlotOptions(slot, weapon)) {
        if ((best.equipment[slot]?.id ?? null) === (item?.id ?? null)) continue;
        const candidate = withSlot(best, slot, item);
        const s = o.score(candidate);
        const v = value(candidate, s);
        if (v > bestValue + EPSILON || (Math.abs(v - bestValue) <= EPSILON && s.tiebreak > bestScore.tiebreak)) {
          best = candidate;
          bestScore = s;
          bestValue = v;
          improved = true;
        }
      }
    }

    // the style and spell don't change the weight or risk, so they can be compared on DPS alone
    const repicked = o.pickWeaponSettings(best);
    if (isBetter(repicked[1], bestScore)) {
      [best, bestScore] = repicked;
      bestValue = value(best, bestScore);
      improved = true;
    }

    if (!improved) break;
  }
  return best;
};

/**
 * Step 3 for a single start config. With a minimum weight or a risk limit, the descent is also started from a few
 * setups that meet them in different ways (see descendRelaxed), as e.g. reaching the weight with one very heavy item
 * gets stuck: no single or pair swap can get rid of it without going under the weight.
 */
export const refine = (o: GearOptimizer, start: Config): [Config, Score] => {
  let best = descend(o, start);
  if (!o.hasMinWeight && !o.hasRiskLimit) return best;

  const startDps = o.pickWeaponSettings(start)[1].dps;
  for (const fraction of WEIGHT_TRADE_FRACTIONS) {
    const weightLambda = o.hasMinWeight ? (fraction * startDps) / o.opts.minWeight! : 0;
    const riskLambda = o.hasRiskLimit ? (fraction * startDps) / o.riskScale : 0;
    const r = descend(o, descendRelaxed(o, start, weightLambda, riskLambda));
    if (o.isFeasible(r[0]) && (!o.isFeasible(best[0]) || isBetter(r[1], best[1]))) {
      best = r;
    }
  }
  return best;
};
