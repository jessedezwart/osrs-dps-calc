import { EquipmentPiece, PlayerEquipment } from '@/types/Player';
import type GearOptimizer from './GearOptimizer';
import {
  ARMOUR_SLOTS, MAX_PAIR_ROUNDS, PAIR_CANDIDATES_PER_SLOT, STRENGTH_TRADE_FRACTIONS,
} from './constants';
import { compareScores, isBetter, withSlot } from './config';
import { slotValue } from './constraints';
import { descend, descendPastMaxHit } from './descent';
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
  // an item together with a different attack style, e.g. with +1 strength that only raises the max hit with another
  // stance. Not for magic, as trying every spell with every item is too slow (the descent tries the spells with items
  // that have an effect, e.g. an Elemental amulet that only helps with an elemental spell).
  for (const slot of o.family === 'magic' ? [] : slots) {
    for (const item of o.getSlotOptions(slot, weapon)) {
      if ((current.equipment[slot]?.id ?? null) === (item?.id ?? null)) continue;
      const candidate = withSlot(current, slot, item);
      if (!o.isFeasible(candidate)) continue;
      const repicked = o.pickWeaponSettings(candidate);
      if (isBetter(repicked[1], found ? found[1] : currentScore)) {
        found = repicked;
      }
    }
  }
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

/** The owned armour sets (see SET_SEEDS) that the config is wearing every piece of. */
const wornSets = (o: GearOptimizer, c: Config) => o.getSetSeeds().filter((seed) => !seed.weapon
  && Object.entries(seed).every(([slot, item]) => c.equipment[slot as keyof PlayerEquipment]?.id === item?.id));

/**
 * Takes off every piece of the set at once, putting the best other item (as measured by swapping it alone) in each of
 * its slots in turn.
 */
const withoutSet = (o: GearOptimizer, c: Config, set: Partial<Record<keyof PlayerEquipment, EquipmentPiece>>): Config => {
  const setIds = new Set(Object.values(set).map((item) => item?.id));
  let next = c;
  for (const slot of Object.keys(set) as (keyof PlayerEquipment)[]) {
    let best: [Config, Score] | null = null;
    for (const item of o.getSlotOptions(slot, c.equipment.weapon)) {
      if (item && setIds.has(item.id)) continue;
      const candidate = withSlot(next, slot, item);
      const s = o.score(candidate);
      if (!best || isBetter(s, best[1])) best = [candidate, s];
    }
    if (best) [next] = best;
  }
  return next;
};

/**
 * Coordinate descent, followed by rounds of two-slot swaps until neither finds an improvement.
 */
const descendAndPairSwap = (o: GearOptimizer, start: Config): [Config, Score] => {
  let [best, bestScore] = descend(o, start);

  for (let round = 0; round < MAX_PAIR_ROUNDS; round++) {
    const swapped = findBestPairSwap(o, best, bestScore);
    if (!swapped) break;
    [best, bestScore] = descend(o, swapped[0]);
  }

  return [best, bestScore];
};

/**
 * Step 4: descendAndPairSwap, and if the result is wearing a whole set (void etc), the same again without the set.
 * Leaving a set needs all of its pieces to change at once, as the bonus is lost with any one of them, so neither single
 * nor pair swaps can do it.
 */
const descendWithPairSwaps = (o: GearOptimizer, start: Config): [Config, Score] => {
  let best = descendAndPairSwap(o, start);
  for (const set of wornSets(o, best[0])) {
    const r = descendAndPairSwap(o, withoutSet(o, best[0], set));
    if (o.isFeasible(r[0]) && isBetter(r[1], best[1])) best = r;
  }
  const [found, foundScore] = best;
  for (const fraction of STRENGTH_TRADE_FRACTIONS) {
    const r = descendAndPairSwap(o, descendPastMaxHit(o, found, foundScore, fraction));
    if (o.isFeasible(r[0]) && isBetter(r[1], best[1])) best = r;
  }
  return best;
};

export default descendWithPairSwaps;
