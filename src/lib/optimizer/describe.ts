import NPCVsPlayerCalc from '@/lib/NPCVsPlayerCalc';
import type GearOptimizer from './GearOptimizer';
import { ARMOUR_SLOTS, EPSILON, MAX_ALTERNATIVES } from './constants';
import { withSlot } from './config';
import { equipmentWeight, riskOf } from './constraints';
import { offensiveStats, tiebreakStat, weaponRequiresAmmo } from './items';
import { descend } from './descent';
import {
  Config, FinishedLoadout, LoadoutAlternative, OptimizedLoadout, Score,
} from './types';

/**
 * The damage the monster deals to the player in this config. Only done for the finished loadouts, as the search
 * itself doesn't take it into account.
 */
const damageTaken = (o: GearOptimizer, c: Config): Pick<OptimizedLoadout, 'npcDps' | 'avgDmgTaken'> => {
  try {
    const calc = new NPCVsPlayerCalc(o.toPlayer(c), o.monster, {
      loadoutName: 'optimizer',
      disableMonsterScaling: o.monster.id === -1,
    });
    return { npcDps: calc.getDps() || 0, avgDmgTaken: calc.getAverageDamageTaken() };
  } catch {
    return { npcDps: 0 };
  }
};

/**
 * Empties the ammo slot if the weapon doesn't fire the ammo and it does nothing there, e.g. arrows left over from a
 * bow that was swapped for a blowpipe. It's only kept if it changes the DPS (e.g. Fareed needs an arrow), or has
 * defensive or prayer bonuses (e.g. a blessing).
 */
const dropUnusedAmmo = (o: GearOptimizer, c: Config, s: Score): [Config, Score] => {
  const ammo = c.equipment.ammo;
  if (!ammo || o.isLocked('ammo') || weaponRequiresAmmo(c.equipment.weapon) || tiebreakStat(ammo) > 0) return [c, s];

  const without = withSlot(c, 'ammo', null);
  if (!o.isFeasible(without)) return [c, s];
  const withoutScore = o.score(without);
  return withoutScore.dps < s.dps - EPSILON ? [c, s] : [without, withoutScore];
};

/**
 * Drains every boosted level one at a time (as happens over time in game), and returns the first point at which the
 * alternative config does more DPS than the chosen one.
 */
const findDrainAdvantage = (o: GearOptimizer, chosen: Config, alternative: Config): LoadoutAlternative['betterAfterDrain'] => {
  const maxBoost = Math.max(0, ...Object.values(o.base.boosts));
  for (let levels = 1; levels <= maxBoost; levels++) {
    const boosts = { ...o.base.boosts };
    for (const k of Object.keys(boosts) as (keyof typeof boosts)[]) {
      if (boosts[k] > 0) boosts[k] = Math.max(0, boosts[k] - levels);
    }
    const base = { ...o.base, boosts };
    const dpsGain = o.evaluate(alternative, base).dps - o.evaluate(chosen, base).dps;
    if (dpsGain > EPSILON) return { levels, dpsGain };
  }
  return undefined;
};

/**
 * Finds items that give the same DPS as the chosen item in a slot, but have more of an offensive stat. These lose to
 * the chosen item only on the defensive tiebreak, but may become better once boosts start to wear off.
 */
const findAlternatives = (o: GearOptimizer, c: Config, s: Score): LoadoutAlternative[] => {
  const weapon = c.equipment.weapon;
  const ret: LoadoutAlternative[] = [];

  for (const slot of ARMOUR_SLOTS) {
    if (o.isLocked(slot) || (slot === 'shield' && weapon?.isTwoHanded)) continue;
    // e.g. a javelin's ranged strength does nothing for a knife, so it would never become better
    const ignoreRangedStats = slot === 'ammo' && !weaponRequiresAmmo(weapon);
    const chosen = c.equipment[slot];
    const chosenStats = offensiveStats(chosen, o.family, ignoreRangedStats);

    for (const item of o.getSlotOptions(slot, weapon)) {
      if (!item || item.id === chosen?.id) continue;
      if (!offensiveStats(item, o.family, ignoreRangedStats).some((v, k) => v > chosenStats[k])) continue;

      const candidate = withSlot(c, slot, item);
      if (!o.isFeasible(candidate)) continue;
      if (Math.abs(o.score(candidate).dps - s.dps) > EPSILON) continue;

      ret.push({ slot, item, betterAfterDrain: findDrainAdvantage(o, c, candidate) });
    }
  }

  // the ones that soonest become better are the most interesting
  return ret
    .sort((a, b) => (a.betterAfterDrain?.levels ?? Infinity) - (b.betterAfterDrain?.levels ?? Infinity))
    .slice(0, MAX_ALTERNATIVES);
};

/**
 * Step 6: makes a final pass of single swaps (and style and spell changes), as the exhaustive search only tries the
 * shortlisted items, and turns the result into a loadout.
 */
const describe = (o: GearOptimizer, start: Config): FinishedLoadout => {
  const [c, s] = dropUnusedAmmo(o, ...descend(o, start));
  return {
    score: s,
    loadout: {
      equipment: c.equipment,
      style: c.style,
      spell: c.spell,
      prayers: o.state.prayers,
      dps: s.dps,
      maxHit: s.maxHit,
      accuracy: s.accuracy,
      weight: equipmentWeight(c.equipment),
      ...damageTaken(o, c),
      ...(o.opts.wilderness && { risk: riskOf(c.equipment, o.opts.wilderness) }),
      alternatives: findAlternatives(o, c, s),
    },
  };
};

export default describe;
