import { EquipmentPiece, PlayerEquipment } from '@/types/Player';
import type GearOptimizer from './GearOptimizer';
import { ARMOUR_SLOTS, MAX_PAIR_ROUNDS, PAIR_CANDIDATES_PER_SLOT } from './constants';
import { compareScores, isBetter, withSlot } from './config';
import { slotValue } from './constraints';
import { descend } from './descent';
import { Config, Score } from './types';

/**
 * Tries changing every pair of armour slots at once, using the few best items for each slot (as measured by swapping
 * that slot alone). Returns the best improvement found, if any.
 */
const findBestPairSwap = (o: GearOptimizer, current: Config, currentScore: Score): [Config, Score] | null => {
  const weapon = current.equipment.weapon;
  const slots = ARMOUR_SLOTS.filter((s) => !(s === 'shield' && weapon?.isTwoHanded) && !o.isLocked(s));

  const topPerSlot = new Map<keyof PlayerEquipment, Array<EquipmentPiece | null>>();
  for (const slot of slots) {
    const options = o.getSlotOptions(slot, weapon);
    const ranked = options
      .map((item): [EquipmentPiece | null, Score] => [item, o.score(withSlot(current, slot, item))])
      .sort(([, a], [, b]) => compareScores(a, b));
    const top = ranked
      .slice(0, PAIR_CANDIDATES_PER_SLOT)
      .map(([item]) => item);
    if (o.hasRiskLimit) {
      // items cheap enough to not be kept make room for an expensive item in the other slot to be kept instead
      const affordable = ranked
        .filter(([item]) => !item || (slotValue(item, slot, o.opts.wilderness!) ?? 0) <= o.opts.wilderness!.maxRisk)
        .slice(0, PAIR_CANDIDATES_PER_SLOT)
        .map(([item]) => item);
      top.push(...affordable.filter((i) => !top.includes(i)));
    }
    if (o.hasMinWeight) {
      // heavy items make room for a lighter but stronger item in the other slot
      const heaviest = [...options]
        .sort((a, b) => (b?.weight || 0) - (a?.weight || 0))
        .slice(0, PAIR_CANDIDATES_PER_SLOT);
      top.push(...heaviest.filter((i) => !top.includes(i)));
    }
    topPerSlot.set(slot, top);
  }

  let found: [Config, Score] | null = null;
  for (const [i, slotA] of slots.entries()) {
    for (const slotB of slots.slice(i + 1)) {
      for (const a of topPerSlot.get(slotA)!) {
        for (const b of topPerSlot.get(slotB)!) {
          const candidate = withSlot(withSlot(current, slotA, a), slotB, b);
          if (!o.isFeasible(candidate)) continue;
          const s = o.score(candidate);
          if (isBetter(s, found ? found[1] : currentScore)) {
            found = [candidate, s];
          }
        }
      }
    }
  }
  return found;
};

/**
 * Coordinate descent, followed by rounds of two-slot swaps until neither finds an improvement.
 */
const descendWithPairSwaps = (o: GearOptimizer, start: Config): [Config, Score] => {
  let [best, bestScore] = descend(o, start);

  for (let round = 0; round < MAX_PAIR_ROUNDS; round++) {
    const swapped = findBestPairSwap(o, best, bestScore);
    if (!swapped) break;
    [best, bestScore] = descend(o, swapped[0]);
  }

  return [best, bestScore];
};

export default descendWithPairSwaps;
