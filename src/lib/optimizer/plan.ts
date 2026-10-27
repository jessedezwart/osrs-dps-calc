import { PlayerEquipment } from '@/types/Player';
import { EquipmentCategory } from '@/enums/EquipmentCategory';
import { getCombatStylesForCategory } from '@/utils';
import type GearOptimizer from './GearOptimizer';
import { ARMOUR_SLOTS, WEAPONS_FOR_SET_SEEDS, WEAPONS_TO_REFINE } from './constants';
import {
  compareScores, EMPTY_SCORE, isBetter, withSlot,
} from './config';
import { descend } from './descent';
import { Config, PlanResult } from './types';

/**
 * Steps 1 and 2: finds the screening armour, ranks the weapons with it, and returns the configs to refine.
 */
const plan = (o: GearOptimizer): PlanResult => {
  const weapons = o.getWeaponCandidates();
  const ret: PlanResult = {
    starts: [],
    weaponsScreened: weapons.length,
    candidatesPerSlot: {
      ...Object.fromEntries(ARMOUR_SLOTS.map((slot) => [slot, o.state.slotCandidates[slot]?.length ?? 0])),
      // which ammo is tried depends on the weapon, so this is the most tried with any one weapon
      ammo: Math.max(0, ...weapons.map((w) => o.getSlotOptions('ammo', w).filter((i) => i !== null).length)),
    },
    spells: o.state.spellCandidates.length,
    weaponsRefined: 0,
    setStarts: 0,
  };
  if (weapons.length === 0) return ret;

  const empty: Config = {
    equipment: {
      head: null,
      cape: null,
      neck: null,
      ammo: null,
      weapon: null,
      body: null,
      shield: null,
      legs: null,
      hands: null,
      feet: null,
      ring: null,
      ...o.locked,
    },
    style: getCombatStylesForCategory(EquipmentCategory.NONE)[0],
    spell: null,
  };

  // 1. find the best weapon with no armour, and build an armour set around it
  let screeningBest: Config | undefined;
  let screeningBestScore = EMPTY_SCORE;
  for (const weapon of weapons) {
    const [c, s] = o.equipWeapon(empty, weapon);
    if (isBetter(s, screeningBestScore)) {
      screeningBest = c;
      screeningBestScore = s;
    }
  }
  if (!screeningBest) return ret;
  const screeningArmour = descend(o, screeningBest)[0];

  // 2. rank every weapon using the screening armour
  const ranked = weapons
    .map((w) => o.equipWeapon(screeningArmour, w))
    .filter(([, s]) => s.dps > 0)
    .sort(([, a], [, b]) => compareScores(a, b));

  // the best weapons are refined, both as they are and with the set seeds
  const starts: Config[] = [];
  for (const [i, [c]] of ranked.slice(0, WEAPONS_TO_REFINE).entries()) {
    starts.push(c);

    if (i < WEAPONS_FOR_SET_SEEDS) {
      for (const seed of o.getSetSeeds()) {
        if (seed.weapon) continue;
        let seeded = c;
        for (const [slot, item] of Object.entries(seed)) {
          seeded = withSlot(seeded, slot as keyof PlayerEquipment, item ?? null);
        }
        starts.push(seeded);
      }
    }
  }
  // seeds that include their own weapon (e.g. barrows sets)
  for (const seed of o.getSetSeeds()) {
    if (!seed.weapon) continue;
    let seeded = screeningArmour;
    for (const [slot, item] of Object.entries(seed)) {
      if (slot === 'weapon') continue;
      seeded = withSlot(seeded, slot as keyof PlayerEquipment, item ?? null);
    }
    starts.push(o.equipWeapon(seeded, seed.weapon)[0]);
  }

  const weaponsRefined = Math.min(ranked.length, WEAPONS_TO_REFINE);
  return {
    ...ret, starts, weaponsRefined, setStarts: starts.length - weaponsRefined,
  };
};

export default plan;
