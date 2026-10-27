import { EquipmentPiece, PlayerEquipment } from '@/types/Player';
import { SLOTS, WEIGHT_EPSILON } from './constants';
import { OptimizerOpts, Risk, WildernessOpts } from './types';

/** Ammo is lost as a whole stack, so it counts as this many of the item. */
export const AMMO_STACK = 100;

/**
 * How many items are kept on death in the Wilderness: 3 normally, or 0 when skulled, plus 1 with Protect Item.
 * @see https://oldschool.runescape.wiki/w/Items_Kept_on_Death
 */
export const keptItemsCount = ({ protectItem, skulled }: { protectItem: boolean, skulled: boolean }): number => (skulled ? 0 : 3)
  + (protectItem ? 1 : 0);

export const equipmentWeight = (equipment: PlayerEquipment): number => SLOTS
  .reduce((sum, s) => sum + (equipment[s]?.weight || 0), 0);

export const meetsMinWeight = (c: { equipment: PlayerEquipment }, opts: OptimizerOpts) => !opts.minWeight
  || equipmentWeight(c.equipment) >= opts.minWeight - WEIGHT_EPSILON;

/** The value an item counts for in its slot (ammo counts as a whole stack), or undefined if it's untradeable. */
export const slotValue = (item: EquipmentPiece, slot: keyof PlayerEquipment, wilderness: WildernessOpts): number | undefined => {
  const value = wilderness.values[item.id];
  if (value === undefined) return undefined;
  return slot === 'ammo' ? value * AMMO_STACK : value;
};

/**
 * How much the equipment risks on death in the Wilderness: the value of everything except the most valuable items,
 * which are kept. Ammo is never kept, as only one of a stack would be. Untradeables count as free.
 */
export const riskOf = (equipment: PlayerEquipment, wilderness: WildernessOpts): Risk => {
  const priced: [keyof PlayerEquipment, number][] = [];
  const untradeableSlots: (keyof PlayerEquipment)[] = [];
  for (const slot of SLOTS) {
    const item = equipment[slot];
    if (!item) continue;
    const value = slotValue(item, slot, wilderness);
    if (value === undefined) {
      untradeableSlots.push(slot);
    } else {
      priced.push([slot, value]);
    }
  }

  const keptSlots = priced
    .filter(([slot]) => slot !== 'ammo')
    .sort(([, a], [, b]) => b - a)
    .slice(0, wilderness.keptItems)
    .map(([slot]) => slot);
  const risk = priced.reduce((sum, [slot, value]) => (keptSlots.includes(slot) ? sum : sum + value), 0);
  const total = priced.reduce((sum, [, value]) => sum + value, 0);
  return {
    risk, total, keptSlots, untradeableSlots,
  };
};

export const withinRisk = (c: { equipment: PlayerEquipment }, opts: OptimizerOpts) => !opts.wilderness
  || riskOf(c.equipment, opts.wilderness).risk <= opts.wilderness.maxRisk;

/** Whether the setup meets the minimum weight and the risk limit. */
export const isFeasible = (c: { equipment: PlayerEquipment }, opts: OptimizerOpts) => meetsMinWeight(c, opts) && withinRisk(c, opts);
