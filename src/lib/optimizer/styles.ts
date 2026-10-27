import { CombatStyleStance, PlayerCombatStyle } from '@/types/PlayerCombatStyle';
import { EquipmentPiece } from '@/types/Player';
import { Prayer, PrayerMap, prayersConflict } from '@/enums/Prayer';
import { EquipmentCategory } from '@/enums/EquipmentCategory';
import { CAST_STANCES } from '@/lib/constants';
import { getCombatStylesForCategory } from '@/utils';
import { MELEE_TYPES } from './constants';
import { OptimizerOpts, OptimizerStyle, TrainingSkill } from './types';

export const MELEE_STANCE_FOR_TRAINING: { [k in TrainingSkill]: CombatStyleStance } = {
  attack: 'Accurate',
  strength: 'Aggressive',
  defence: 'Defensive',
  shared: 'Controlled',
};
export const OPTIMIZER_STYLES: OptimizerStyle[] = ['melee', 'ranged', 'magic'];

/** The styles that the search with these options covers, in the order of OPTIMIZER_STYLES. */
export const searchedStyles = (opts: Pick<OptimizerOpts, 'styles'>): OptimizerStyle[] => (opts.styles
  ? OPTIMIZER_STYLES.filter((s) => opts.styles!.includes(s))
  : OPTIMIZER_STYLES);

/**
 * The prayers that a style uses out of the selected ones: those for that style, and those that aren't for a specific
 * style.
 */
export const getPrayers = (style: OptimizerStyle, selected: Prayer[]): Prayer[] => selected
  .filter((p) => !PrayerMap[p].combatStyle || PrayerMap[p].combatStyle === style);

/**
 * Toggles a prayer in the selection for the search. Turning one on only turns off the prayers that conflict with it in
 * a style that would use both, so e.g. Piety, Rigour and Augury can all be selected (one for each style), but Steel
 * Skin replaces all three.
 */
export const toggleSearchPrayer = (selected: Prayer[], prayer: Prayer): Prayer[] => {
  if (selected.includes(prayer)) return selected.filter((p) => p !== prayer);
  const style = PrayerMap[prayer].combatStyle;
  return [
    ...selected.filter((p) => {
      const otherStyle = PrayerMap[p].combatStyle;
      const sharesStyle = !style || !otherStyle || style === otherStyle;
      return !(sharesStyle && prayersConflict(p, prayer));
    }),
    prayer,
  ];
};

export const isStyleInFamily = (style: PlayerCombatStyle, family: OptimizerStyle): boolean => {
  switch (family) {
    case 'melee':
      return MELEE_TYPES.includes(style.type || '');
    case 'ranged':
      return style.type === 'ranged';
    case 'magic':
    default:
      return style.type === 'magic';
  }
};

/**
 * Whether the stance gives experience in the skill being trained.
 */
export const stanceTrains = (style: PlayerCombatStyle, family: OptimizerStyle, category: EquipmentCategory, training: TrainingSkill): boolean => {
  if (family === 'melee') {
    return style.stance === MELEE_STANCE_FOR_TRAINING[training];
  }
  // attack and strength can't be trained with ranged or magic, so they don't restrict those styles
  if (training !== 'defence') {
    return true;
  }
  if (family === 'ranged') {
    return style.stance === 'Longrange';
  }
  return style.stance === 'Defensive Autocast'
    || (style.stance === 'Longrange' && [EquipmentCategory.POWERED_STAFF, EquipmentCategory.POWERED_WAND].includes(category));
};

/**
 * The combat styles worth trying for the weapon. Without a training filter, stances that can never be better for DPS
 * than another stance of the same type (e.g. Defensive vs Accurate) are dropped. With a fixed spell, only stances that
 * cast it are kept.
 */
export const getStyles = (
  weapon: EquipmentPiece | null,
  family: OptimizerStyle,
  { training, spell }: Pick<OptimizerOpts, 'training' | 'spell'>,
): PlayerCombatStyle[] => {
  const category = weapon?.category || EquipmentCategory.NONE;
  const seen = new Set<string>();
  return getCombatStylesForCategory(category).filter((s) => {
    if (!isStyleInFamily(s, family)) return false;
    if (family === 'magic' && spell && !CAST_STANCES.includes(s.stance)) return false;
    if (training) {
      if (!stanceTrains(s, family, category, training)) return false;
    } else {
      if (family === 'melee' && s.stance === 'Defensive') return false;
      if (s.stance === 'Defensive Autocast') return false;
      if (family === 'ranged' && s.stance === 'Longrange' && category !== EquipmentCategory.CHINCHOMPA) return false;
    }
    const key = `${s.type}/${s.stance}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};
