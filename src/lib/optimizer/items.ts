import { EquipmentPiece } from '@/types/Player';
import { AmmoApplicability, ammoApplicability, getCanonicalItemId } from '@/lib/Equipment';
import { AMMO_EFFECT_ITEMS, SPECIAL_EFFECT_ITEMS } from './constants';
import { OptimizerStyle } from './types';

export const isSpecialEffectItem = (item: EquipmentPiece) => SPECIAL_EFFECT_ITEMS.some((r) => r.test(item.name));

/** Items with a special effect can only be pruned by items with the same effect, which is never the case by default. */
export const specialEffectOf = (item: EquipmentPiece): string | null => (isSpecialEffectItem(item) ? `item ${item.id}` : null);

/** The effect of ammo that's fired, e.g. 'diamond' for both diamond bolts (e) and diamond dragon bolts (e). */
export const firedAmmoEffectOf = (item: EquipmentPiece): string | null => {
  for (const r of AMMO_EFFECT_ITEMS) {
    const match = r.exec(item.name);
    if (match) return (match[1] ?? match[0]).toLowerCase();
  }
  return specialEffectOf(item);
};

export const defensiveSum = (item: EquipmentPiece) => item.defensive.stab + item.defensive.slash + item.defensive.crush
  + item.defensive.magic + item.defensive.ranged;

/** An item's contribution to the tiebreak between setups with equal DPS (see Score.tiebreak). */
export const tiebreakStat = (item: EquipmentPiece) => defensiveSum(item) + item.bonuses.prayer;

/**
 * The stats that matter for a given style, used to prune items that are strictly worse than another owned item. The
 * last one is the tiebreak.
 * @param ignoreRangedStats - for ammo with a weapon that doesn't use it, whose ranged stats don't apply
 */
export const relevantStats = (item: EquipmentPiece, style: OptimizerStyle, ignoreRangedStats = false): number[] => {
  switch (style) {
    case 'melee':
      return [item.offensive.stab, item.offensive.slash, item.offensive.crush, item.bonuses.str, tiebreakStat(item)];
    case 'ranged':
      return ignoreRangedStats
        ? [0, 0, tiebreakStat(item)]
        : [item.offensive.ranged, item.bonuses.ranged_str, tiebreakStat(item)];
    case 'magic':
    default:
      return [item.offensive.magic, item.bonuses.magic_str, tiebreakStat(item)];
  }
};

/** The offensive stats that matter for a given style (an empty slot has none). */
export const offensiveStats = (item: EquipmentPiece | null, style: OptimizerStyle, ignoreRangedStats = false): number[] => {
  if (!item) return style === 'melee' ? [0, 0, 0, 0] : [0, 0];
  return relevantStats(item, style, ignoreRangedStats).slice(0, -1);
};

/**
 * The stats of ammo for weapons that don't use it. Only its tiebreak stats and any effects matter, except that the
 * calc also checks for arrows in some places (e.g. Fareed is immune to ranged attacks without them), so the best arrow
 * is kept too.
 */
export const unusedAmmoStats = (item: EquipmentPiece, style: OptimizerStyle): number[] => [
  ...relevantStats(item, style, true),
  item.name.includes('arrow') ? 1 : 0,
];

/**
 * Removes items that are no better than another item in the same list in every stat relevant to the style.
 * Items with special effects are kept, unless another item with the same effect is better.
 */
export const pruneDominated = (
  items: EquipmentPiece[],
  style: OptimizerStyle,
  statsOf: (item: EquipmentPiece) => number[] = (item) => relevantStats(item, style),
  effectOf: (item: EquipmentPiece) => string | null = specialEffectOf,
): EquipmentPiece[] => {
  const stats = items.map(statsOf);
  const effects = items.map(effectOf);
  return items.filter((item, i) => !items.some((other, j) => {
    if (i === j) return false;
    if (effects[i] !== null && effects[j] !== effects[i]) return false;
    const a = stats[i];
    const b = stats[j];
    const allAtLeast = b.every((v, k) => v >= a[k]);
    if (!allAtLeast) return false;
    const strictlyBetter = b.some((v, k) => v > a[k]);
    // for identical stats, keep only the first occurrence
    return strictlyBetter || j < i;
  }));
};

// the calc canonicalizes items before checking ammo, so e.g. variants of a bow accept the same ammo
export const weaponRequiresAmmo = (weapon: EquipmentPiece | null) => weapon !== null
  && ammoApplicability(getCanonicalItemId(weapon.id), undefined) === AmmoApplicability.INVALID;

export const ammoWorksWith = (weapon: EquipmentPiece, ammo: EquipmentPiece) => ammoApplicability(
  getCanonicalItemId(weapon.id),
  getCanonicalItemId(ammo.id),
) === AmmoApplicability.INCLUDED;
