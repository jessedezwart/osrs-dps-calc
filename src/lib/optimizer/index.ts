/**
 * The gear optimizer ("Find Best Gear"): finds the highest-DPS loadouts out of the user's owned equipment.
 *   - GearOptimizer.ts: the candidates, scoring and jobs of the search
 *   - search.ts: the order the jobs run in (searchStyle), and running them (optimizeGear, optimizeGearWith)
 *   - plan.ts, descent.ts, pairSwap.ts, exhaustive.ts, describe.ts: the steps of the search
 *   - constraints.ts: the minimum weight and the wilderness risk limit
 *   - items.ts, styles.ts, config.ts: item stats, combat styles and prayers, and comparing setups
 */
export * from './types';
export { EXHAUSTIVE_BUDGET } from './constants';
export {
  AMMO_STACK, equipmentWeight, keptItemsCount, riskOf,
} from './constraints';
export { pruneDominated } from './items';
export {
  getPrayers, OPTIMIZER_STYLES, searchedStyles, toggleSearchPrayer,
} from './styles';
export { default as GearOptimizer } from './GearOptimizer';
export { optimizeGear, optimizeGearWith, searchStyle } from './search';
