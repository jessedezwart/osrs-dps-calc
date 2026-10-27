import {
  EquipmentPiece, Player, PlayerEquipment,
} from '@/types/Player';
import { Monster } from '@/types/Monster';
import { CombatStyleStance, PlayerCombatStyle } from '@/types/PlayerCombatStyle';
import { Spell, spells } from '@/types/Spell';
import { Prayer, PrayerMap, prayersConflict } from '@/enums/Prayer';
import { EquipmentCategory } from '@/enums/EquipmentCategory';
import PlayerVsNPCCalc from '@/lib/PlayerVsNPCCalc';
import NPCVsPlayerCalc from '@/lib/NPCVsPlayerCalc';
import {
  AmmoApplicability,
  ammoApplicability,
  calculateEquipmentBonusesFromGear,
  canBlowpipeUseDart,
  DART_TIER,
  getCanonicalItemId,
} from '@/lib/Equipment';
import { BLOWPIPE_IDS, CAST_STANCES } from '@/lib/constants';
import { getCombatStylesForCategory } from '@/utils';

export type OptimizerStyle = 'melee' | 'ranged' | 'magic';

/**
 * Which combat skill the user wants to gain experience in, which limits the attack stances that can be used.
 * Attack, Strength and Shared only affect melee. Defence also applies to ranged (Longrange) and magic (Defensive
 * Autocast, or Longrange on powered staves).
 * @see https://oldschool.runescape.wiki/w/Combat_Options
 */
export type TrainingSkill = 'attack' | 'strength' | 'defence' | 'shared';

const MELEE_STANCE_FOR_TRAINING: { [k in TrainingSkill]: CombatStyleStance } = {
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

export interface OptimizerOpts {
  /**
   * The prayers that may be used. Each style uses the ones for that style (e.g. Piety for melee), and the ones that
   * aren't for a specific style (e.g. Steel Skin). Defaults to none.
   */
  prayers?: Prayer[];
  /** How many results (each with a different weapon) to return per style. */
  resultsPerStyle?: number;
  /**
   * How many setups the final exhaustive search may try for the best result in each style (the other results get a
   * fraction of this). Defaults to EXHAUSTIVE_BUDGET.
   */
  exhaustiveBudget?: number;
  /**
   * Slots that are fixed to a specific item (or to being empty, if null). These items don't need to be owned, and the
   * rest of the gear is searched around them.
   */
  locked?: Partial<PlayerEquipment>;
  /** Only use attack stances that train this skill. If not set, any stance may be used. */
  training?: TrainingSkill;
  /** Names of spells that should never be used (e.g. because their runes are too expensive). */
  excludedSpells?: string[];
  /**
   * Names of ammo that should never go in the ammo slot, and of darts that should never be loaded into a blowpipe.
   * Unlike excluded items, ignored darts can still be thrown. A locked ammo slot still uses its item.
   */
  ignoredAmmo?: string[];
  /**
   * The name of the only spell to cast with magic. Powered staves can then only manually cast it (their built-in spell
   * isn't used), and excludedSpells is ignored.
   */
  spell?: string;
  /** The styles to search. Defaults to all of OPTIMIZER_STYLES. */
  styles?: OptimizerStyle[];
  /**
   * The minimum total weight (in kg) of the equipped gear, for content that needs it. Setups lighter than this are
   * never returned. Setting this also makes the search go deeper, as the constraint makes single swaps less effective.
   */
  minWeight?: number;
  /** Limits how much the setup risks losing on death in the Wilderness. */
  wilderness?: WildernessOpts;
}

export interface WildernessOpts {
  /** The most the setup may lose on death, in gp. */
  maxRisk: number;
  /** How many items are kept on death (see keptItemsCount). */
  keptItems: number;
  /** The GE value of each item, by ID. Items without one are untradeable, and count as free. */
  values: Record<number, number>;
  /** Never use untradeable items, unless they are locked. */
  skipUntradeables?: boolean;
}

/** Ammo is lost as a whole stack, so it counts as this many of the item. */
export const AMMO_STACK = 100;

/**
 * How many items are kept on death in the Wilderness: 3 normally, or 0 when skulled, plus 1 with Protect Item.
 * @see https://oldschool.runescape.wiki/w/Items_Kept_on_Death
 */
export const keptItemsCount = ({ protectItem, skulled }: { protectItem: boolean, skulled: boolean }): number => (skulled ? 0 : 3)
  + (protectItem ? 1 : 0);

export interface Risk {
  /** The value lost on death, in gp. */
  risk: number;
  /** The value of all the (tradeable) items, in gp. */
  total: number;
  /** The slots of the items that are kept on death. */
  keptSlots: (keyof PlayerEquipment)[];
  /** The slots of untradeable items, which count as free (but may be lost or need repairing). */
  untradeableSlots: (keyof PlayerEquipment)[];
}

export interface OptimizedLoadout {
  equipment: PlayerEquipment;
  style: PlayerCombatStyle;
  spell: Spell | null;
  prayers: Prayer[];
  dps: number;
  maxHit: number;
  accuracy: number;
  /** The total weight of the equipment, in kg. */
  weight: number;
  /** The average damage the monster deals to you per second (0 if it has no attack style). */
  npcDps: number;
  /** The average damage taken per kill, or undefined if the monster can't be killed. */
  avgDmgTaken?: number;
  /** The value lost on death in the Wilderness, and which items are kept. Only set in wilderness mode. */
  risk?: Risk;
  /**
   * Items that give exactly the same DPS in a slot, but trade the chosen item's defensive stats for more offensive
   * stats that don't currently make a difference (e.g. +1 strength that doesn't reach the next max hit).
   */
  alternatives: LoadoutAlternative[];
}

export interface LoadoutAlternative {
  slot: keyof PlayerEquipment;
  item: EquipmentPiece;
  /**
   * If the alternative becomes better than the chosen item as boosts wear off, how many levels of boost need to drain
   * before it does, and the DPS it then gains over the chosen item. Not set if it never becomes better.
   */
  betterAfterDrain?: { levels: number, dpsGain: number };
}

export interface OptimizerProgress {
  /** The number of DPS calculations performed so far. */
  evaluations: number;
  /** How many of the styles have finished searching (they may be searched at the same time). */
  stylesDone: number;
}

export type OptimizerProgressCallback = (progress: OptimizerProgress) => void;

/** How often (in ms) progress is reported while searching. */
const PROGRESS_INTERVAL_MS = 200;

/** What the search did for one style, for showing to the user. */
export interface StyleSearchSummary {
  /** Weapons tried with the screening armour (each blowpipe and dart pair counts separately, as does unarmed). */
  weaponsScreened: number;
  /** Items tried in each armour slot (after dropping items that are never better than another owned item). */
  candidatesPerSlot: Partial<Record<keyof PlayerEquipment, number>>;
  /** Spells tried with each casting weapon. */
  spells: number;
  /** Weapons whose armour was searched in full. */
  weaponsRefined: number;
  /** Extra searches started from owned armour sets (void etc.) */
  setStarts: number;
  /** Results that also got the two-slot swap search. */
  pairSwapped: number;
  /** Combinations tried by the exhaustive search, over all shown results. */
  exhaustiveCombinations: number;
  /** Shown results that the exhaustive search improved. */
  exhaustiveImprovements: number;
  /** DPS calculations per step of the search. */
  evaluations: Partial<Record<OptimizerJob['kind'], number>>;
}

export type OptimizerLoadouts = { [k in OptimizerStyle]: OptimizedLoadout[] };

/** The loadouts of the styles that weren't searched are empty, and they have no summary. */
export type OptimizerResult = OptimizerLoadouts & {
  /** The number of DPS calculations performed. */
  evaluations: number;
  summary: { [k in OptimizerStyle]?: StyleSearchSummary };
};

export interface Config {
  equipment: PlayerEquipment;
  style: PlayerCombatStyle;
  spell: Spell | null;
}

export interface Score {
  dps: number;
  maxHit: number;
  accuracy: number;
  /** Used to break ties when DPS is equal, so that otherwise-irrelevant slots are filled with defensive gear. */
  tiebreak: number;
}

const SLOTS: (keyof PlayerEquipment)[] = [
  'weapon', 'head', 'cape', 'neck', 'ammo', 'body', 'shield', 'legs', 'hands', 'feet', 'ring',
];
const ARMOUR_SLOTS = SLOTS.filter((s) => s !== 'weapon');

const MELEE_TYPES = ['stab', 'slash', 'crush'];

/** Weapons whose ranking is decided by a full armour search (rather than just the screening armour). */
const WEAPONS_TO_REFINE = 40;
/** Weapons that also get tried with each owned armour set (void etc.) */
const WEAPONS_FOR_SET_SEEDS = 15;
/**
 * How many of the best refined results get the (expensive) two-slot swap search. This is more than are shown, as the
 * swaps can move a result up into the shown ones.
 */
const PAIR_SWAP_RESULTS = 15;
/**
 * In the two-slot swap search, how many of the best items in each slot are paired up with each other. With a minimum
 * weight, the heaviest items in each slot are paired up too, as single swaps get stuck more easily (e.g. a heavy item
 * can only be dropped if another slot gets heavier at the same time).
 */
const PAIR_CANDIDATES_PER_SLOT = 6;
const MAX_PAIR_ROUNDS = 6;
const MAX_DESCENT_PASSES = 8;
/** How many swaps can be made to bring a setup up to the minimum weight before giving up on it. */
const MAX_WEIGHT_REPAIR_STEPS = 20;
/**
 * With a minimum weight, each start is also refined with weight valued at these fractions of the start's DPS (spread
 * over the minimum weight), i.e. how much DPS it's worth giving up to reach the weight. Different values spread the
 * weight over the slots differently.
 */
const WEIGHT_TRADE_FRACTIONS = [0.02, 0.05, 0.1, 0.2, 0.4, 0.8];
const WEIGHT_EPSILON = 1e-6;
/** How many swaps can be made to bring a setup down to the risk limit before giving up on it. */
const MAX_RISK_REPAIR_STEPS = 20;
/**
 * With a risk limit, the trade fractions (see WEIGHT_TRADE_FRACTIONS) are of DPS per this much gp over the limit, or per
 * the limit itself if that's larger.
 */
const MIN_RISK_SCALE = 1_000_000;
/**
 * The final step tries every combination of a shortlist of items per slot around each shown result, which finds
 * improvements that need many slots to change at once. This is how many combinations may be tried for the best result
 * in each style; the other shown results get EXHAUSTIVE_OTHERS_FRACTION of it.
 */
export const EXHAUSTIVE_BUDGET = 60_000;
const EXHAUSTIVE_OTHERS_FRACTION = 0.25;
/** Each result's combinations are split into up to this many jobs (so that they can run in parallel)... */
const EXHAUSTIVE_CHUNKS_PER_RESULT = 32;
/** ...but no smaller than this many combinations each, as each job has some overhead. */
const EXHAUSTIVE_MIN_CHUNK_SIZE = 5_000;
/**
 * With a minimum weight, shortlisted items are ranked as if each kg gained were worth this fraction of the result's DPS
 * (spread over the minimum weight), so that heavy items that make room for better items elsewhere are shortlisted too.
 */
const SHORTLIST_WEIGHT_FRACTION = 0.2;
/**
 * With a risk limit, shortlisted items that take the result over the limit (when swapped in alone) are ranked as if
 * each risk scale (see MIN_RISK_SCALE) over it cost this fraction of the result's DPS, so cheaper items are shortlisted too.
 */
const SHORTLIST_RISK_FRACTION = 0.2;
/** The most equal-DPS alternatives shown per result. */
const MAX_ALTERNATIVES = 6;
const SPELLS_TO_CONSIDER = 6;
const EPSILON = 1e-9;

/** Spells that only work with specific weapons, so are always worth trying. */
const WEAPON_SPECIFIC_SPELLS = ['Iban Blast', 'Saradomin Strike', 'Claws of Guthix', 'Flames of Zamorak', 'Magic Dart'];

/**
 * Items with effects that are not reflected in their visible stats (set effects, slayer/undead/demon bonuses, etc).
 * These are never pruned from the search, even if another item has better stats in the same slot.
 */
const SPECIAL_EFFECT_ITEMS: RegExp[] = [
  /void/i, /slayer helmet/i, /black mask/i, /^V's helm/, /salve amulet/i, /obsidian/i, /berserker necklace/i,
  /inquisitor/i, /^crystal (helm|body|legs)/i, /^(Dharok|Verac|Torag|Guthan|Karil|Ahrim)'s/i, /virtus/i,
  /amulet of the damned/i, /amulet of avarice/i, /(blood|eclipse|blue) moon/i, /^tome of/i, /elemental amulet/i,
  /brimstone ring/i, /chaos gauntlets/i, /confliction gauntlets/i, /echo boots/i, /efaritay/i, /lightbearer/i,
  /(guthix|saradomin|zamorak) (max )?cape/i, /justiciar/i, /dizana/i, /crystal blessing/i, /holy water/i,
];

/**
 * Ammo with effects that only apply when it's fired: the enchanted bolt procs the calc models, leaf-bladed (turoths and
 * kurasks), silver (vampyres), brutal arrows (ogres), ice arrows (Fire Warrior) and dragon arrows (dark bow spec).
 */
const AMMO_EFFECT_ITEMS: RegExp[] = [
  /^(opal|pearl|ruby|diamond|dragonstone|onyx) (?:dragon )?bolts \(e\)/i, /broad (?:arrows|bolts)/i, /^silver bolts/i, / brutal/i, /^ice arrows/i, /^dragon arrow/i,
];

/**
 * Multi-piece sets whose bonus can't be found by swapping one item at a time. If the user owns a whole set, the search
 * is also started from that set. Each slot lists acceptable item names in order of preference.
 */
const SET_SEEDS: { styles: OptimizerStyle[], pieces: Partial<Record<keyof PlayerEquipment, string[]>> }[] = [
  {
    styles: ['melee'],
    pieces: {
      head: ['Void melee helm', 'Void melee helm (or)'],
      body: ['Elite void top', 'Elite void top (or)', 'Void knight top', 'Void knight top (or)'],
      legs: ['Elite void robe', 'Elite void robe (or)', 'Void knight robe', 'Void knight robe (or)'],
      hands: ['Void knight gloves', 'Void knight gloves (or)'],
    },
  },
  {
    styles: ['ranged'],
    pieces: {
      head: ['Void ranger helm', 'Void ranger helm (or)'],
      body: ['Elite void top', 'Elite void top (or)', 'Void knight top', 'Void knight top (or)'],
      legs: ['Elite void robe', 'Elite void robe (or)', 'Void knight robe', 'Void knight robe (or)'],
      hands: ['Void knight gloves', 'Void knight gloves (or)'],
    },
  },
  {
    styles: ['magic'],
    pieces: {
      head: ['Void mage helm', 'Void mage helm (or)'],
      body: ['Elite void top', 'Elite void top (or)', 'Void knight top', 'Void knight top (or)'],
      legs: ['Elite void robe', 'Elite void robe (or)', 'Void knight robe', 'Void knight robe (or)'],
      hands: ['Void knight gloves', 'Void knight gloves (or)'],
    },
  },
  { styles: ['melee'], pieces: { head: ['Obsidian helmet'], body: ['Obsidian platebody'], legs: ['Obsidian platelegs'] } },
  { styles: ['melee'], pieces: { head: ["Inquisitor's great helm"], body: ["Inquisitor's hauberk"], legs: ["Inquisitor's plateskirt"] } },
  { styles: ['melee'], pieces: { head: ['Blood moon helm'], body: ['Blood moon chestplate'], legs: ['Blood moon tassets'] } },
  { styles: ['ranged'], pieces: { head: ['Crystal helm'], body: ['Crystal body'], legs: ['Crystal legs'] } },
  { styles: ['ranged'], pieces: { head: ['Eclipse moon helm'], body: ['Eclipse moon chestplate'], legs: ['Eclipse moon tassets'] } },
  { styles: ['magic'], pieces: { head: ['Blue moon helm'], body: ['Blue moon chestplate'], legs: ['Blue moon tassets'] } },
  { styles: ['magic'], pieces: { head: ['Virtus mask'], body: ['Virtus robe top'], legs: ['Virtus robe bottom'] } },
  {
    styles: ['melee'],
    pieces: {
      weapon: ["Dharok's greataxe"], head: ["Dharok's helm"], body: ["Dharok's platebody"], legs: ["Dharok's platelegs"],
    },
  },
  {
    styles: ['melee'],
    pieces: {
      weapon: ["Verac's flail"], head: ["Verac's helm"], body: ["Verac's brassard"], legs: ["Verac's plateskirt"],
    },
  },
  {
    styles: ['melee'],
    pieces: {
      weapon: ["Torag's hammers"], head: ["Torag's helm"], body: ["Torag's platebody"], legs: ["Torag's platelegs"], neck: ['Amulet of the damned'],
    },
  },
  {
    styles: ['ranged'],
    pieces: {
      weapon: ["Karil's crossbow"], head: ["Karil's coif"], body: ["Karil's leathertop"], legs: ["Karil's leatherskirt"], neck: ['Amulet of the damned'],
    },
  },
  {
    styles: ['magic'],
    pieces: {
      weapon: ["Ahrim's staff"], head: ["Ahrim's hood"], body: ["Ahrim's robetop"], legs: ["Ahrim's robeskirt"], neck: ['Amulet of the damned'],
    },
  },
];

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

export const equipmentWeight = (equipment: PlayerEquipment): number => SLOTS
  .reduce((sum, s) => sum + (equipment[s]?.weight || 0), 0);

const meetsMinWeight = (c: { equipment: PlayerEquipment }, opts: OptimizerOpts) => !opts.minWeight
  || equipmentWeight(c.equipment) >= opts.minWeight - WEIGHT_EPSILON;

/** The value an item counts for in its slot (ammo counts as a whole stack), or undefined if it's untradeable. */
const slotValue = (item: EquipmentPiece, slot: keyof PlayerEquipment, wilderness: WildernessOpts): number | undefined => {
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

const withinRisk = (c: { equipment: PlayerEquipment }, opts: OptimizerOpts) => !opts.wilderness
  || riskOf(c.equipment, opts.wilderness).risk <= opts.wilderness.maxRisk;

/** Whether the setup meets the minimum weight and the risk limit. */
const isFeasible = (c: { equipment: PlayerEquipment }, opts: OptimizerOpts) => meetsMinWeight(c, opts) && withinRisk(c, opts);

const isSpecialEffectItem = (item: EquipmentPiece) => SPECIAL_EFFECT_ITEMS.some((r) => r.test(item.name));

/** Items with a special effect can only be pruned by items with the same effect, which is never the case by default. */
const specialEffectOf = (item: EquipmentPiece): string | null => (isSpecialEffectItem(item) ? `item ${item.id}` : null);

/** The effect of ammo that's fired, e.g. 'diamond' for both diamond bolts (e) and diamond dragon bolts (e). */
const firedAmmoEffectOf = (item: EquipmentPiece): string | null => {
  for (const r of AMMO_EFFECT_ITEMS) {
    const match = r.exec(item.name);
    if (match) return (match[1] ?? match[0]).toLowerCase();
  }
  return specialEffectOf(item);
};

const defensiveSum = (item: EquipmentPiece) => item.defensive.stab + item.defensive.slash + item.defensive.crush
  + item.defensive.magic + item.defensive.ranged;

/** An item's contribution to the tiebreak between setups with equal DPS (see Score.tiebreak). */
const tiebreakStat = (item: EquipmentPiece) => defensiveSum(item) + item.bonuses.prayer;

/**
 * The stats that matter for a given style, used to prune items that are strictly worse than another owned item. The
 * last one is the tiebreak.
 * @param ignoreRangedStats - for ammo with a weapon that doesn't use it, whose ranged stats don't apply
 */
const relevantStats = (item: EquipmentPiece, style: OptimizerStyle, ignoreRangedStats = false): number[] => {
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
const offensiveStats = (item: EquipmentPiece | null, style: OptimizerStyle, ignoreRangedStats = false): number[] => {
  if (!item) return style === 'melee' ? [0, 0, 0, 0] : [0, 0];
  return relevantStats(item, style, ignoreRangedStats).slice(0, -1);
};

/**
 * The stats of ammo for weapons that don't use it. Only its tiebreak stats and any effects matter, except that the
 * calc also checks for arrows in some places (e.g. Fareed is immune to ranged attacks without them), so the best arrow
 * is kept too.
 */
const unusedAmmoStats = (item: EquipmentPiece, style: OptimizerStyle): number[] => [
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

const isStyleInFamily = (style: PlayerCombatStyle, family: OptimizerStyle): boolean => {
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
const stanceTrains = (style: PlayerCombatStyle, family: OptimizerStyle, category: EquipmentCategory, training: TrainingSkill): boolean => {
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
const getStyles = (
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

// the calc canonicalizes items before checking ammo, so e.g. variants of a bow accept the same ammo
const weaponRequiresAmmo = (weapon: EquipmentPiece | null) => weapon !== null
  && ammoApplicability(getCanonicalItemId(weapon.id), undefined) === AmmoApplicability.INVALID;

const ammoWorksWith = (weapon: EquipmentPiece, ammo: EquipmentPiece) => ammoApplicability(
  getCanonicalItemId(weapon.id),
  getCanonicalItemId(ammo.id),
) === AmmoApplicability.INCLUDED;

const styleKey = (s: PlayerCombatStyle) => `${s.name}/${s.type}/${s.stance}`;

const configKey = (c: Config) => {
  const eq = SLOTS.map((s) => {
    const p = c.equipment[s];
    if (!p) return '';
    return p.itemVars?.blowpipeDartId ? `${p.id}:${p.itemVars.blowpipeDartId}` : `${p.id}`;
  }).join(',');
  return `${eq}|${styleKey(c.style)}|${c.spell?.name || ''}`;
};

const withSlot = (c: Config, slot: keyof PlayerEquipment, item: EquipmentPiece | null): Config => ({
  ...c,
  equipment: { ...c.equipment, [slot]: item },
});

const isBetter = (a: Score, b: Score) => a.dps > b.dps + EPSILON
  || (Math.abs(a.dps - b.dps) <= EPSILON && a.tiebreak > b.tiebreak);

const compareScores = (a: Score, b: Score) => {
  if (isBetter(a, b)) return -1;
  if (isBetter(b, a)) return 1;
  return 0;
};

const EMPTY_SCORE: Score = {
  dps: 0, maxHit: 0, accuracy: 0, tiebreak: -Infinity,
};

export type ScoredConfig = [Config, Score];

/** A finished result, with the score it is ranked by. */
export interface FinishedLoadout {
  loadout: OptimizedLoadout;
  score: Score;
}

/**
 * The items to try in each slot around a result, for the exhaustive search. Items are referred to by ID (null for an
 * empty slot) to keep the jobs small. Slots that aren't listed keep the start's item.
 */
export interface Shortlist {
  start: Config;
  slots: (keyof PlayerEquipment)[];
  itemIds: (number | null)[][];
}

/**
 * A unit of work in the search. Jobs only depend on the inputs the GearOptimizer was created with (not on any earlier
 * jobs it ran), so they can be run on separate GearOptimizers, e.g. one per thread.
 *   - plan: screens and ranks the weapons, and returns the configs to start refining from
 *   - refine: runs the coordinate descent from a start config (null if the result is unusable)
 *   - pairSwap: runs the two-slot swap search on a refined result
 *   - shortlist: picks the items per slot for the exhaustive search around a result
 *   - exhaust: tries the shortlist's combinations that start with the given item indices in its first slots, and
 *     returns the best (null if none are usable)
 *   - describe: makes a final pass of single swaps, and turns the result into a loadout (with alternatives)
 */
export type OptimizerJob =
  | { kind: 'plan', family: OptimizerStyle }
  | { kind: 'refine', family: OptimizerStyle, start: Config }
  | { kind: 'pairSwap', family: OptimizerStyle, start: Config }
  | { kind: 'shortlist', family: OptimizerStyle, start: Config, budget: number }
  | { kind: 'exhaust', family: OptimizerStyle, shortlist: Shortlist, prefix: number[] }
  | { kind: 'describe', family: OptimizerStyle, start: Config };

export interface PlanResult extends Pick<StyleSearchSummary, 'weaponsScreened' | 'candidatesPerSlot' | 'spells' | 'weaponsRefined' | 'setStarts'> {
  starts: Config[];
}

type JobResults = {
  plan: PlanResult;
  refine: ScoredConfig | null;
  pairSwap: ScoredConfig;
  shortlist: Shortlist;
  exhaust: { best: ScoredConfig | null, tried: number };
  describe: FinishedLoadout;
};
export type OptimizerJobResult<J extends OptimizerJob> = JobResults[J['kind']];

/** The parts of the search that depend on the style being searched. */
interface StyleState {
  prayers: Prayer[];
  /** The (pruned) items to try in each armour slot. */
  slotCandidates: Partial<Record<keyof PlayerEquipment, EquipmentPiece[]>>;
  /** The ammo to try with weapons that don't use ammo, pruned by the stats that still apply. */
  unusedAmmoCandidates: EquipmentPiece[];
  /** The (pruned) ammo to try with each weapon that needs ammo, by canonical weapon id. Filled lazily. */
  ammoCandidatesByWeapon: Map<number, EquipmentPiece[]>;
  spellCandidates: Spell[];
}

/**
 * Finds the highest-DPS loadouts for each combat style, using only the provided (owned) equipment.
 *
 * The search space is far too large to brute force, so this uses a greedy approach:
 *   1. find a reasonable armour set around the strongest weapon (coordinate descent: swap one slot at a time while it
 *      improves DPS),
 *   2. rank every owned weapon (with its best stance, ammo, and spell) using that armour,
 *   3. for the best weapons, run the coordinate descent again, both from the screening armour and from any owned
 *      multi-piece sets (void etc.) whose bonuses can't be found one swap at a time,
 *   4. finish the best results with two-slot swaps, which can escape set-ups where no single swap helps,
 *   5. around each shown result, try every combination of a shortlist of the most promising items per slot, which
 *      finds improvements that need many slots to change at once,
 *   6. make a final pass of single swaps, and find the equal-DPS alternatives.
 *
 * The steps are split into jobs (see OptimizerJob), so that the independent ones (e.g. refining each weapon) can be
 * run in parallel. searchStyle() decides which jobs to run.
 */
export class GearOptimizer {
  private readonly base: Player;

  private readonly monster: Monster;

  private readonly opts: OptimizerOpts;

  private readonly owned: EquipmentPiece[];

  private readonly cache = new Map<string, Score>();

  /** Evaluations that bypass the cache (the exhaustive search, which would make it far too big). */
  private uncachedEvaluations = 0;

  /** The owned and locked items, for looking up the items in a shortlist. */
  private readonly itemsById: Map<number, EquipmentPiece>;

  private family: OptimizerStyle = 'melee';

  private state!: StyleState;

  private readonly states = new Map<OptimizerStyle, StyleState>();

  private readonly onEvaluations?: (evaluations: number) => void;

  private lastProgressAt = 0;

  /**
   * @param onEvaluations - called every so often with the number of DPS calculations performed so far
   */
  constructor(
    owned: EquipmentPiece[],
    basePlayer: Player,
    monster: Monster,
    opts: OptimizerOpts,
    onEvaluations?: (evaluations: number) => void,
  ) {
    this.owned = owned;
    this.base = basePlayer;
    this.monster = monster;
    this.opts = opts;
    this.onEvaluations = onEvaluations;
    const lockedItems = Object.values(opts.locked || {}).filter((i): i is EquipmentPiece => !!i);
    this.itemsById = new Map([...owned, ...lockedItems].map((i) => [i.id, i]));
  }

  private reportProgress() {
    if (!this.onEvaluations) return;
    const now = Date.now();
    if (now - this.lastProgressAt < PROGRESS_INTERVAL_MS) return;
    this.lastProgressAt = now;
    this.onEvaluations(this.evaluations);
  }

  get evaluations() {
    return this.cache.size + this.uncachedEvaluations;
  }

  private get locked(): Partial<PlayerEquipment> {
    return this.opts.locked || {};
  }

  private isLocked(slot: keyof PlayerEquipment): boolean {
    return Object.hasOwn(this.locked, slot);
  }

  private isIgnoredAmmo(item: EquipmentPiece): boolean {
    return (this.opts.ignoredAmmo || []).includes(item.name);
  }

  private get hasMinWeight(): boolean {
    return (this.opts.minWeight || 0) > 0;
  }

  private meetsMinWeight(c: Config): boolean {
    return meetsMinWeight(c, this.opts);
  }

  private get hasRiskLimit(): boolean {
    return !!this.opts.wilderness;
  }

  private risk(c: Config): number {
    return this.opts.wilderness ? riskOf(c.equipment, this.opts.wilderness).risk : 0;
  }

  /** How far the setup is over the risk limit, in gp (0 if it's within it). */
  private excessRisk(c: Config): number {
    return this.opts.wilderness ? Math.max(0, this.risk(c) - this.opts.wilderness.maxRisk) : 0;
  }

  /** The amount of gp over the risk limit that the trade fractions are relative to (see MIN_RISK_SCALE). */
  private get riskScale(): number {
    return Math.max(this.opts.wilderness?.maxRisk || 0, MIN_RISK_SCALE);
  }

  private withinRisk(c: Config): boolean {
    return withinRisk(c, this.opts);
  }

  private isFeasible(c: Config): boolean {
    return isFeasible(c, this.opts);
  }

  /** The item's value (0 if untradeable), for keeping cheaper items when pruning. */
  private itemValue(item: EquipmentPiece): number {
    return this.opts.wilderness?.values[item.id] ?? 0;
  }

  /** Whether the item can't be used because it's untradeable and the user doesn't want to risk those. */
  private isSkippedUntradeable(item: EquipmentPiece): boolean {
    return !!this.opts.wilderness?.skipUntradeables && this.opts.wilderness.values[item.id] === undefined;
  }

  /**
   * The stats to prune items by, plus the ones that the constraints make worth keeping: weight (heavier is better) with a
   * minimum weight, and value (cheaper is better) with a risk limit. Risk only goes up with an item's value, so a cheaper
   * item can never be worse for it.
   */
  private withConstraintStats(stats: number[], item: EquipmentPiece): number[] {
    return [
      ...stats,
      ...(this.hasMinWeight ? [item.weight || 0] : []),
      ...(this.hasRiskLimit ? [-this.itemValue(item)] : []),
    ];
  }

  public runJob<J extends OptimizerJob>(job: J): OptimizerJobResult<J> {
    this.useFamily(job.family);
    switch (job.kind) {
      case 'plan':
        return this.plan() as OptimizerJobResult<J>;
      case 'refine': {
        const [c, s] = this.refine(job.start);
        const usable = s.dps > 0 && this.isFeasible(c);
        return (usable ? [c, s] : null) as OptimizerJobResult<J>;
      }
      case 'pairSwap':
        return this.descendWithPairSwaps(job.start) as OptimizerJobResult<J>;
      case 'shortlist':
        return this.shortlist(job.start, job.budget) as OptimizerJobResult<J>;
      case 'exhaust':
        return this.exhaust(job.shortlist, job.prefix) as OptimizerJobResult<J>;
      case 'describe':
      default:
        return this.describe(job.start) as OptimizerJobResult<J>;
    }
  }

  /**
   * Switches to searching the given style, building its candidate lists the first time.
   */
  private useFamily(family: OptimizerStyle) {
    this.family = family;
    const existing = this.states.get(family);
    if (existing) {
      this.state = existing;
      return;
    }

    // a heavier or cheaper item can be worth keeping even if its stats are worse
    const withConstraints = (stats: number[], item: EquipmentPiece) => this.withConstraintStats(stats, item);

    const slotCandidates: StyleState['slotCandidates'] = {};
    for (const slot of ARMOUR_SLOTS) {
      if (this.isLocked(slot)) {
        const lockedItem = this.locked[slot];
        slotCandidates[slot] = lockedItem ? [lockedItem] : [];
        continue;
      }
      const items = this.owned.filter((i) => i.slot === slot
        && !(slot === 'ammo' && this.isIgnoredAmmo(i))
        && !this.isSkippedUntradeable(i));
      // ammo is pruned per weapon (see getAmmoCandidates), as which ammo is comparable depends on the weapon
      slotCandidates[slot] = slot === 'ammo'
        ? items
        : pruneDominated(items, family, (i) => withConstraints(relevantStats(i, family), i));
    }

    this.state = {
      prayers: getPrayers(family, this.opts.prayers || []),
      slotCandidates,
      // if the weapon doesn't use ammo, its ranged stats and bolt effects don't apply, so most of it can go
      unusedAmmoCandidates: pruneDominated(
        slotCandidates.ammo || [],
        family,
        (i) => withConstraints(unusedAmmoStats(i, family), i),
      ),
      ammoCandidatesByWeapon: new Map(),
      spellCandidates: [],
    };
    this.states.set(family, this.state);
    // ranking the spells needs the rest of the state to be set up
    this.state.spellCandidates = family === 'magic' ? this.rankSpells() : [];
  }

  /**
   * Steps 1 and 2: finds the screening armour, ranks the weapons with it, and returns the configs to refine.
   */
  private plan(): PlanResult {
    const weapons = this.getWeaponCandidates();
    const ret: PlanResult = {
      starts: [],
      weaponsScreened: weapons.length,
      candidatesPerSlot: {
        ...Object.fromEntries(ARMOUR_SLOTS.map((slot) => [slot, this.state.slotCandidates[slot]?.length ?? 0])),
        // which ammo is tried depends on the weapon, so this is the most tried with any one weapon
        ammo: Math.max(0, ...weapons.map((w) => this.getSlotOptions('ammo', w).filter((i) => i !== null).length)),
      },
      spells: this.state.spellCandidates.length,
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
        ...this.locked,
      },
      style: getCombatStylesForCategory(EquipmentCategory.NONE)[0],
      spell: null,
    };

    // 1. find the best weapon with no armour, and build an armour set around it
    let screeningBest: Config | undefined;
    let screeningBestScore = EMPTY_SCORE;
    for (const weapon of weapons) {
      const [c, s] = this.equipWeapon(empty, weapon);
      if (isBetter(s, screeningBestScore)) {
        screeningBest = c;
        screeningBestScore = s;
      }
    }
    if (!screeningBest) return ret;
    const screeningArmour = this.descend(screeningBest)[0];

    // 2. rank every weapon using the screening armour
    const ranked = weapons
      .map((w) => this.equipWeapon(screeningArmour, w))
      .filter(([, s]) => s.dps > 0)
      .sort(([, a], [, b]) => compareScores(a, b));

    // the best weapons are refined, both as they are and with the set seeds
    const starts: Config[] = [];
    for (const [i, [c]] of ranked.slice(0, WEAPONS_TO_REFINE).entries()) {
      starts.push(c);

      if (i < WEAPONS_FOR_SET_SEEDS) {
        for (const seed of this.getSetSeeds()) {
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
    for (const seed of this.getSetSeeds()) {
      if (!seed.weapon) continue;
      let seeded = screeningArmour;
      for (const [slot, item] of Object.entries(seed)) {
        if (slot === 'weapon') continue;
        seeded = withSlot(seeded, slot as keyof PlayerEquipment, item ?? null);
      }
      starts.push(this.equipWeapon(seeded, seed.weapon)[0]);
    }

    const weaponsRefined = Math.min(ranked.length, WEAPONS_TO_REFINE);
    return {
      ...ret, starts, weaponsRefined, setStarts: starts.length - weaponsRefined,
    };
  }

  /**
   * Step 5: picks the items to try in each slot around a result, within the budget for the number of combinations.
   * Each slot starts with just its current item, and the next item added is always the one (in any slot) that comes
   * closest to the result's DPS when swapped in alone, so that close calls get more options than clear winners.
   */
  private shortlist(start: Config, budget: number): Shortlist {
    const startScore = this.score(start);
    const weapon = start.equipment.weapon;
    const lambda = this.hasMinWeight ? (SHORTLIST_WEIGHT_FRACTION * startScore.dps) / this.opts.minWeight! : 0;
    const riskLambda = this.hasRiskLimit ? (SHORTLIST_RISK_FRACTION * startScore.dps) / this.riskScale : 0;

    const queues: { slot: keyof PlayerEquipment, items: (EquipmentPiece | null)[], next: [EquipmentPiece | null, number][] }[] = [];
    for (const slot of ARMOUR_SLOTS) {
      const current = start.equipment[slot] ?? null;
      const next = this.getSlotOptions(slot, weapon)
        .filter((item) => (item?.id ?? null) !== (current?.id ?? null))
        .map((item): [EquipmentPiece | null, number] => {
          const swapped = withSlot(start, slot, item);
          const dpsLoss = startScore.dps - this.score(swapped).dps;
          const weightGain = (item?.weight || 0) - (current?.weight || 0);
          return [item, dpsLoss - lambda * weightGain + riskLambda * this.excessRisk(swapped)];
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
  }

  /**
   * Step 5: tries every combination of the shortlist that starts with the given items (by index) in its first slots.
   * These evaluations aren't cached, as there are far too many of them and they are never repeated.
   */
  private exhaust(shortlist: Shortlist, prefix: number[]): JobResults['exhaust'] {
    const { start, slots } = shortlist;
    const options = shortlist.itemIds.map((ids) => ids.map((id) => (id === null ? null : this.itemsById.get(id) ?? null)));
    const equipment: PlayerEquipment = { ...start.equipment };
    for (const [i, choice] of prefix.entries()) {
      equipment[slots[i]] = options[i][choice];
    }

    const ret: JobResults['exhaust'] = { best: null, tried: 0 };
    const tryFrom = (i: number) => {
      if (i === slots.length) {
        if (!isFeasible({ equipment }, this.opts)) return;
        const c: Config = { ...start, equipment: { ...equipment } };
        const s = this.evaluate(c);
        ret.tried += 1;
        this.uncachedEvaluations += 1;
        this.reportProgress();
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
  }

  /**
   * Step 6: makes a final pass of single swaps (and style and spell changes), as the exhaustive search only tries the
   * shortlisted items, and turns the result into a loadout.
   */
  private describe(start: Config): FinishedLoadout {
    const [c, s] = this.dropUnusedAmmo(...this.descend(start));
    return {
      score: s,
      loadout: {
        equipment: c.equipment,
        style: c.style,
        spell: c.spell,
        prayers: this.state.prayers,
        dps: s.dps,
        maxHit: s.maxHit,
        accuracy: s.accuracy,
        weight: equipmentWeight(c.equipment),
        ...this.damageTaken(c),
        ...(this.opts.wilderness && { risk: riskOf(c.equipment, this.opts.wilderness) }),
        alternatives: this.findAlternatives(c, s),
      },
    };
  }

  /**
   * The damage the monster deals to the player in this config. Only done for the finished loadouts, as the search
   * itself doesn't take it into account.
   */
  private damageTaken(c: Config): Pick<OptimizedLoadout, 'npcDps' | 'avgDmgTaken'> {
    try {
      const calc = new NPCVsPlayerCalc(this.toPlayer(c), this.monster, {
        loadoutName: 'optimizer',
        disableMonsterScaling: this.monster.id === -1,
      });
      return { npcDps: calc.getDps() || 0, avgDmgTaken: calc.getAverageDamageTaken() };
    } catch {
      return { npcDps: 0 };
    }
  }

  /**
   * Empties the ammo slot if the weapon doesn't fire the ammo and it does nothing there, e.g. arrows left over from a
   * bow that was swapped for a blowpipe. It's only kept if it changes the DPS (e.g. Fareed needs an arrow), or has
   * defensive or prayer bonuses (e.g. a blessing).
   */
  private dropUnusedAmmo(c: Config, s: Score): [Config, Score] {
    const ammo = c.equipment.ammo;
    if (!ammo || this.isLocked('ammo') || weaponRequiresAmmo(c.equipment.weapon) || tiebreakStat(ammo) > 0) return [c, s];

    const without = withSlot(c, 'ammo', null);
    if (!this.isFeasible(without)) return [c, s];
    const withoutScore = this.score(without);
    return withoutScore.dps < s.dps - EPSILON ? [c, s] : [without, withoutScore];
  }

  /**
   * Finds items that give the same DPS as the chosen item in a slot, but have more of an offensive stat. These lose to
   * the chosen item only on the defensive tiebreak, but may become better once boosts start to wear off.
   */
  private findAlternatives(c: Config, s: Score): LoadoutAlternative[] {
    const weapon = c.equipment.weapon;
    const ret: LoadoutAlternative[] = [];

    for (const slot of ARMOUR_SLOTS) {
      if (this.isLocked(slot) || (slot === 'shield' && weapon?.isTwoHanded)) continue;
      // e.g. a javelin's ranged strength does nothing for a knife, so it would never become better
      const ignoreRangedStats = slot === 'ammo' && !weaponRequiresAmmo(weapon);
      const chosen = c.equipment[slot];
      const chosenStats = offensiveStats(chosen, this.family, ignoreRangedStats);

      for (const item of this.getSlotOptions(slot, weapon)) {
        if (!item || item.id === chosen?.id) continue;
        if (!offensiveStats(item, this.family, ignoreRangedStats).some((v, k) => v > chosenStats[k])) continue;

        const candidate = withSlot(c, slot, item);
        if (!this.isFeasible(candidate)) continue;
        if (Math.abs(this.score(candidate).dps - s.dps) > EPSILON) continue;

        ret.push({ slot, item, betterAfterDrain: this.findDrainAdvantage(c, candidate) });
      }
    }

    // the ones that soonest become better are the most interesting
    return ret
      .sort((a, b) => (a.betterAfterDrain?.levels ?? Infinity) - (b.betterAfterDrain?.levels ?? Infinity))
      .slice(0, MAX_ALTERNATIVES);
  }

  /**
   * Drains every boosted level one at a time (as happens over time in game), and returns the first point at which the
   * alternative config does more DPS than the chosen one.
   */
  private findDrainAdvantage(chosen: Config, alternative: Config): LoadoutAlternative['betterAfterDrain'] {
    const maxBoost = Math.max(0, ...Object.values(this.base.boosts));
    for (let levels = 1; levels <= maxBoost; levels++) {
      const boosts = { ...this.base.boosts };
      for (const k of Object.keys(boosts) as (keyof typeof boosts)[]) {
        if (boosts[k] > 0) boosts[k] = Math.max(0, boosts[k] - levels);
      }
      const base = { ...this.base, boosts };
      const dpsGain = this.evaluate(alternative, base).dps - this.evaluate(chosen, base).dps;
      if (dpsGain > EPSILON) return { levels, dpsGain };
    }
    return undefined;
  }

  private toPlayer(c: Config, base: Player = this.base): Player {
    const player: Player = {
      ...base,
      equipment: c.equipment,
      style: c.style,
      spell: c.spell,
      prayers: this.state.prayers,
    };
    return {
      ...player,
      ...calculateEquipmentBonusesFromGear(player, this.monster),
    };
  }

  private score(c: Config): Score {
    const key = `${this.family}|${configKey(c)}`;
    const cached = this.cache.get(key);
    if (cached) return cached;

    const score = this.evaluate(c);
    this.cache.set(key, score);
    this.reportProgress();
    return score;
  }

  /**
   * Runs the DPS calculation for the config (uncached), optionally with different levels and boosts.
   */
  private evaluate(c: Config, base: Player = this.base): Score {
    try {
      const player = this.toPlayer(c, base);
      const calc = new PlayerVsNPCCalc(player, this.monster, {
        loadoutName: 'optimizer',
        disableMonsterScaling: this.monster.id === -1,
      });
      const dist = calc.getDistribution();
      const defensive = player.defensive.stab + player.defensive.slash + player.defensive.crush
        + player.defensive.magic + player.defensive.ranged;
      return {
        dps: calc.getDps() || 0,
        maxHit: dist.getMax(),
        accuracy: calc.getDisplayHitChance(),
        tiebreak: defensive + player.bonuses.prayer,
      };
    } catch {
      return EMPTY_SCORE;
    }
  }

  /**
   * The weapons (including blowpipe + dart combinations) that are usable with the current style.
   */
  private getWeaponCandidates(): (EquipmentPiece | null)[] {
    const family = this.family;

    if (this.isLocked('weapon')) {
      const weapon = this.locked.weapon ?? null;
      return getStyles(weapon, family, this.opts).length > 0 ? [weapon] : [];
    }
    const ownedWeapons = this.owned.filter((i) => i.slot === 'weapon' && !this.isSkippedUntradeable(i));
    // poisoned darts share the same name as the regular ones, and only one of each is needed
    const darts = [...new Map(ownedWeapons
      .filter((i) => DART_TIER[i.name] !== undefined && !this.isIgnoredAmmo(i))
      .map((i) => [i.name, i])).values()];

    const ret: (EquipmentPiece | null)[] = [];
    for (const weapon of ownedWeapons) {
      const styles = getStyles(weapon, family, this.opts);
      if (styles.length === 0) continue;
      // a two-handed weapon can't be used if a shield is locked in
      if (weapon.isTwoHanded && this.locked.shield) continue;

      if (family === 'magic') {
        // every weapon can manually cast, but only bother with ones that can autocast, are powered, or have magic bonuses
        const hasNonManual = styles.some((s) => s.stance !== 'Manual Cast');
        if (!hasNonManual && weapon.offensive.magic <= 0 && weapon.bonuses.magic_str <= 0) continue;
      }

      if (BLOWPIPE_IDS.includes(weapon.id)) {
        for (const dart of darts) {
          if (!canBlowpipeUseDart(weapon.name, dart.name)) continue;
          ret.push({
            ...weapon,
            itemVars: { blowpipeDartName: dart.name, blowpipeDartId: dart.id },
          });
        }
        continue;
      }

      ret.push(weapon);
    }

    // unarmed, in case nothing else is owned (or for manual casting)
    ret.push(null);
    return ret;
  }

  /**
   * Ranks every spell using no gear, and returns the best few (plus any weapon-specific spells). With a fixed spell,
   * returns just that spell.
   */
  private rankSpells(): Spell[] {
    if (this.opts.spell) {
      const spell = spells.find((s) => s.name === this.opts.spell);
      return spell ? [spell] : [];
    }

    const manualCast = getCombatStylesForCategory(EquipmentCategory.NONE).find((s) => s.stance === 'Manual Cast')!;
    const empty: PlayerEquipment = {
      head: null, cape: null, neck: null, ammo: null, weapon: null, body: null, shield: null, legs: null, hands: null, feet: null, ring: null,
    };

    const excluded = this.opts.excludedSpells || [];
    const allowed = spells.filter((s) => !excluded.includes(s.name));

    const seen = new Set<string>();
    const scored: [Spell, number][] = [];
    for (const spell of allowed) {
      if (seen.has(spell.name)) continue;
      seen.add(spell.name);
      scored.push([spell, this.score({ equipment: empty, style: manualCast, spell }).dps]);
    }

    const best = scored
      .filter(([, dps]) => dps > 0)
      .sort(([, a], [, b]) => b - a)
      .slice(0, SPELLS_TO_CONSIDER)
      .map(([s]) => s);
    const specific = allowed.filter((s) => WEAPON_SPECIFIC_SPELLS.includes(s.name) && !best.includes(s));
    return [...best, ...specific];
  }

  /**
   * Equips the weapon onto the config, along with the best ammo for it (if it needs ammo), and picks the best
   * style and spell.
   */
  private equipWeapon(c: Config, weapon: EquipmentPiece | null): [Config, Score] {
    let next = withSlot(c, 'weapon', weapon);
    if (weapon?.isTwoHanded) {
      next = withSlot(next, 'shield', null);
    }

    if (weaponRequiresAmmo(weapon)) {
      const ammo = this.getAmmoCandidates(weapon);
      if (ammo.length === 0) return [next, EMPTY_SCORE];

      let best: [Config, Score] = [next, EMPTY_SCORE];
      for (const a of ammo) {
        const res = this.pickWeaponSettings(withSlot(next, 'ammo', a));
        if (isBetter(res[1], best[1])) best = res;
      }
      return best;
    }

    // if the existing ammo was only there for the previous weapon, it might now be useless, but that's harmless
    return this.pickWeaponSettings(next);
  }

  private getAmmoCandidates(weapon: EquipmentPiece | null): EquipmentPiece[] {
    const ammo = this.state.slotCandidates.ammo || [];
    if (!weaponRequiresAmmo(weapon)) return ammo;
    const key = getCanonicalItemId(weapon!.id);
    let candidates = this.state.ammoCandidatesByWeapon.get(key);
    if (!candidates) {
      // e.g. rune arrows are never better than amethyst arrows, but ammo with effects (enchanted bolts etc) is kept
      candidates = pruneDominated(
        ammo.filter((a) => ammoWorksWith(weapon!, a)),
        this.family,
        (i) => this.withConstraintStats(relevantStats(i, this.family), i),
        firedAmmoEffectOf,
      );
      this.state.ammoCandidatesByWeapon.set(key, candidates);
    }
    return candidates;
  }

  /**
   * Picks the best combat style (and spell, if casting) for the config's current weapon.
   */
  private pickWeaponSettings(c: Config): [Config, Score] {
    let best: [Config, Score] = [c, EMPTY_SCORE];
    for (const style of getStyles(c.equipment.weapon, this.family, this.opts)) {
      const spellOptions: (Spell | null)[] = CAST_STANCES.includes(style.stance) ? this.state.spellCandidates : [null];
      for (const spell of spellOptions) {
        const candidate: Config = { ...c, style, spell };
        const s = this.score(candidate);
        if (isBetter(s, best[1])) best = [candidate, s];
      }
    }
    return best;
  }

  /**
   * Step 3 for a single start config. With a minimum weight or a risk limit, the descent is also started from a few
   * setups that meet them in different ways (see descendRelaxed), as e.g. reaching the weight with one very heavy item
   * gets stuck: no single or pair swap can get rid of it without going under the weight.
   */
  private refine(start: Config): [Config, Score] {
    let best = this.descend(start);
    if (!this.hasMinWeight && !this.hasRiskLimit) return best;

    const startDps = this.pickWeaponSettings(start)[1].dps;
    for (const fraction of WEIGHT_TRADE_FRACTIONS) {
      const weightLambda = this.hasMinWeight ? (fraction * startDps) / this.opts.minWeight! : 0;
      const riskLambda = this.hasRiskLimit ? (fraction * startDps) / this.riskScale : 0;
      const r = this.descend(this.descendRelaxed(start, weightLambda, riskLambda));
      if (this.isFeasible(r[0]) && (!this.isFeasible(best[0]) || isBetter(r[1], best[1]))) {
        best = r;
      }
    }
    return best;
  }

  /**
   * Coordinate descent on DPS plus a bonus of `weightLambda` DPS per kg (up to the minimum weight), minus
   * `riskLambda` DPS per gp over the risk limit, ignoring the constraints themselves (a Lagrangian relaxation of them).
   * This spreads the weight over the slots where it costs the least DPS, and drops the risk where that costs the least
   * DPS, so the result is a good place to start the constrained descent from.
   */
  private descendRelaxed(start: Config, weightLambda: number, riskLambda: number): Config {
    const value = (c: Config, s: Score) => s.dps
      + (weightLambda > 0 ? weightLambda * Math.min(equipmentWeight(c.equipment), this.opts.minWeight!) : 0)
      - riskLambda * this.excessRisk(c);

    let [best, bestScore] = this.pickWeaponSettings(start);
    let bestValue = value(best, bestScore);
    for (let pass = 0; pass < MAX_DESCENT_PASSES; pass++) {
      let improved = false;
      const weapon = best.equipment.weapon;

      for (const slot of ARMOUR_SLOTS) {
        if (slot === 'shield' && weapon?.isTwoHanded) continue;

        for (const item of this.getSlotOptions(slot, weapon)) {
          if ((best.equipment[slot]?.id ?? null) === (item?.id ?? null)) continue;
          const candidate = withSlot(best, slot, item);
          const s = this.score(candidate);
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
      const repicked = this.pickWeaponSettings(best);
      if (isBetter(repicked[1], bestScore)) {
        [best, bestScore] = repicked;
        bestValue = value(best, bestScore);
        improved = true;
      }

      if (!improved) break;
    }
    return best;
  }

  /**
   * Greedy coordinate descent: repeatedly try every candidate in every armour slot, keeping any swap that improves
   * the score (and keeps the setup at the minimum weight and within the risk limit), until a full pass makes no
   * improvement. If the start is over the risk limit or under the minimum weight, it is first brought within them.
   */
  private descend(start: Config): [Config, Score] {
    let [best, bestScore] = this.pickWeaponSettings(start);
    if (!this.withinRisk(best)) {
      [best, bestScore] = this.reduceRisk(best, bestScore);
      // the setup can't get under the risk limit with this weapon, so it'll be dropped
      if (!this.withinRisk(best)) return [best, bestScore];
    }
    if (!this.meetsMinWeight(best)) {
      [best, bestScore] = this.addWeight(best, bestScore);
      // the setup can't reach the minimum weight with this weapon, so it'll be dropped
      if (!this.isFeasible(best)) return [best, bestScore];
    }

    for (let pass = 0; pass < MAX_DESCENT_PASSES; pass++) {
      let improved = false;
      const weapon = best.equipment.weapon;

      for (const slot of ARMOUR_SLOTS) {
        if (slot === 'shield' && weapon?.isTwoHanded) continue;

        for (const item of this.getSlotOptions(slot, weapon)) {
          if ((best.equipment[slot]?.id ?? null) === (item?.id ?? null)) continue;
          const candidate = withSlot(best, slot, item);
          if (!this.isFeasible(candidate)) continue;
          const s = this.score(candidate);
          if (isBetter(s, bestScore)) {
            best = candidate;
            bestScore = s;
            improved = true;
          }
        }
      }

      // the best style or spell may have changed with the new gear
      const repicked = this.pickWeaponSettings(best);
      if (isBetter(repicked[1], bestScore)) {
        [best, bestScore] = repicked;
        improved = true;
      }

      if (!improved) break;
    }

    return [best, bestScore];
  }

  /**
   * Brings the setup down to the risk limit by swapping one armour slot at a time. If a single swap is enough, the
   * highest scoring one is used. Otherwise, the swap that loses the least DPS per gp of risk removed is made, and it
   * tries again.
   */
  private reduceRisk(start: Config, startScore: Score): [Config, Score] {
    let current = start;
    let currentScore = startScore;

    for (let step = 0; step < MAX_RISK_REPAIR_STEPS && !this.withinRisk(current); step++) {
      const weapon = current.equipment.weapon;
      const currentRisk = this.risk(current);
      let finished: [Config, Score] | null = null;
      let partial: { c: Config, s: Score, cost: number, gain: number } | null = null;

      for (const slot of ARMOUR_SLOTS) {
        if (slot === 'shield' && weapon?.isTwoHanded) continue;

        for (const item of this.getSlotOptions(slot, weapon)) {
          if ((current.equipment[slot]?.id ?? null) === (item?.id ?? null)) continue;
          const candidate = withSlot(current, slot, item);
          const gain = currentRisk - this.risk(candidate);
          if (gain <= 0) continue;

          const s = this.score(candidate);
          if (this.withinRisk(candidate)) {
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
  }

  /**
   * Brings the setup up to the minimum weight by swapping one armour slot at a time (staying within the risk limit). If
   * a single swap is enough, the highest scoring one is used. Otherwise, the swap that loses the least DPS per kg gained
   * is made, and it tries again.
   */
  private addWeight(start: Config, startScore: Score): [Config, Score] {
    let current = start;
    let currentScore = startScore;

    for (let step = 0; step < MAX_WEIGHT_REPAIR_STEPS && !this.meetsMinWeight(current); step++) {
      const weapon = current.equipment.weapon;
      const currentWeight = equipmentWeight(current.equipment);
      let finished: [Config, Score] | null = null;
      let partial: { c: Config, s: Score, cost: number, gain: number } | null = null;

      for (const slot of ARMOUR_SLOTS) {
        if (slot === 'shield' && weapon?.isTwoHanded) continue;

        for (const item of this.getSlotOptions(slot, weapon)) {
          if ((current.equipment[slot]?.id ?? null) === (item?.id ?? null)) continue;
          const candidate = withSlot(current, slot, item);
          const gain = equipmentWeight(candidate.equipment) - currentWeight;
          if (gain <= WEIGHT_EPSILON || !this.withinRisk(candidate)) continue;

          const s = this.score(candidate);
          if (this.meetsMinWeight(candidate)) {
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
  }

  /**
   * The items that can go in an armour slot (including leaving it empty, unless the weapon needs ammo).
   */
  private getSlotOptions(slot: keyof PlayerEquipment, weapon: EquipmentPiece | null): (EquipmentPiece | null)[] {
    if (slot === 'shield' && weapon?.isTwoHanded) return [null];
    if (slot === 'ammo' && this.isLocked('ammo')) {
      // if the weapon needs ammo, the locked ammo has to work with it
      return weaponRequiresAmmo(weapon) ? this.getAmmoCandidates(weapon) : [this.locked.ammo ?? null];
    }
    if (this.isLocked(slot)) return [this.locked[slot] ?? null];
    if (slot === 'ammo') {
      return weaponRequiresAmmo(weapon) ? this.getAmmoCandidates(weapon) : [null, ...this.state.unusedAmmoCandidates];
    }
    return [null, ...(this.state.slotCandidates[slot] || [])];
  }

  /**
   * Coordinate descent, followed by rounds of two-slot swaps until neither finds an improvement.
   */
  private descendWithPairSwaps(start: Config): [Config, Score] {
    let [best, bestScore] = this.descend(start);

    for (let round = 0; round < MAX_PAIR_ROUNDS; round++) {
      const swapped = this.findBestPairSwap(best, bestScore);
      if (!swapped) break;
      [best, bestScore] = this.descend(swapped[0]);
    }

    return [best, bestScore];
  }

  /**
   * Tries changing every pair of armour slots at once, using the few best items for each slot (as measured by swapping
   * that slot alone). Returns the best improvement found, if any.
   */
  private findBestPairSwap(current: Config, currentScore: Score): [Config, Score] | null {
    const weapon = current.equipment.weapon;
    const slots = ARMOUR_SLOTS.filter((s) => !(s === 'shield' && weapon?.isTwoHanded) && !this.isLocked(s));

    const topPerSlot = new Map<keyof PlayerEquipment, Array<EquipmentPiece | null>>();
    for (const slot of slots) {
      const options = this.getSlotOptions(slot, weapon);
      const ranked = options
        .map((item): [EquipmentPiece | null, Score] => [item, this.score(withSlot(current, slot, item))])
        .sort(([, a], [, b]) => compareScores(a, b));
      const top = ranked
        .slice(0, PAIR_CANDIDATES_PER_SLOT)
        .map(([item]) => item);
      if (this.hasRiskLimit) {
        // items cheap enough to not be kept make room for an expensive item in the other slot to be kept instead
        const affordable = ranked
          .filter(([item]) => !item || (slotValue(item, slot, this.opts.wilderness!) ?? 0) <= this.opts.wilderness!.maxRisk)
          .slice(0, PAIR_CANDIDATES_PER_SLOT)
          .map(([item]) => item);
        top.push(...affordable.filter((i) => !top.includes(i)));
      }
      if (this.hasMinWeight) {
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
            if (!this.isFeasible(candidate)) continue;
            const s = this.score(candidate);
            if (isBetter(s, found ? found[1] : currentScore)) {
              found = [candidate, s];
            }
          }
        }
      }
    }
    return found;
  }

  /**
   * Returns the owned multi-piece sets relevant to the current style, as slot -> item maps.
   */
  private getSetSeeds(): Partial<Record<keyof PlayerEquipment, EquipmentPiece>>[] {
    // case-insensitive, as e.g. the item is named "Amulet of the Damned". Locked items count as available too.
    const lockedItems = Object.values(this.locked).filter((i): i is EquipmentPiece => !!i);
    const byName = new Map([...this.owned, ...lockedItems].map((i) => [i.name.toLowerCase(), i]));
    const ret: Partial<Record<keyof PlayerEquipment, EquipmentPiece>>[] = [];

    for (const seed of SET_SEEDS) {
      if (!seed.styles.includes(this.family)) continue;

      const pieces: Partial<Record<keyof PlayerEquipment, EquipmentPiece>> = {};
      let complete = true;
      for (const [slot, names] of Object.entries(seed.pieces)) {
        const item = names.map((n) => byName.get(n.toLowerCase())).find((i) => i !== undefined);
        // the set can't be used if one of its slots is locked to something else
        const lockedItem = this.locked[slot as keyof PlayerEquipment];
        const conflictsWithLock = this.isLocked(slot as keyof PlayerEquipment) && lockedItem?.id !== item?.id;
        if (!item || conflictsWithLock) {
          complete = false;
          break;
        }
        pieces[slot as keyof PlayerEquipment] = item;
      }
      if (complete) ret.push(pieces);
    }
    return ret;
  }
}

/**
 * Splits a shortlist's combinations into jobs, by fixing the items in its first few slots. Returns the item indices
 * for those slots, one list per job (none if there is nothing to try).
 */
const splitShortlist = (shortlist: Shortlist): number[][] => {
  if (shortlist.slots.length === 0) return [];
  const combinations = shortlist.itemIds.reduce((n, ids) => n * ids.length, 1);
  const jobs = Math.min(EXHAUSTIVE_CHUNKS_PER_RESULT, Math.ceil(combinations / EXHAUSTIVE_MIN_CHUNK_SIZE));

  let prefixes: number[][] = [[]];
  for (let i = 0; i < shortlist.slots.length && prefixes.length < jobs; i++) {
    prefixes = prefixes.flatMap((p) => shortlist.itemIds[i].map((_, k) => [...p, k]));
  }
  return prefixes;
};

/** The result of searching one style. */
export interface StyleSearchResult {
  loadouts: OptimizedLoadout[];
  /** Everything but the evaluations, which are counted by whatever runs the jobs. */
  summary: Omit<StyleSearchSummary, 'evaluations'>;
}

/**
 * The search for a single style, as a generator that yields each batch of jobs that can run in parallel, and receives
 * their results (in the same order). Returns the final loadouts.
 */
export function* searchStyle(
  family: OptimizerStyle,
  opts: OptimizerOpts,
): Generator<OptimizerJob[], StyleSearchResult, unknown[]> {
  // steps 1 and 2
  const [plan] = (yield [{ kind: 'plan', family }]) as [PlanResult];
  const { starts, ...planSummary } = plan;

  // 3. refine the best few weapons, and try the set seeds
  const refined = (yield starts.map((start): OptimizerJob => ({ kind: 'refine', family, start }))) as (ScoredConfig | null)[];

  // keep the best result per weapon (by name, as e.g. poisoned variants are functionally identical)
  const bestPerWeapon = new Map<string, ScoredConfig>();
  for (const r of refined) {
    if (!r) continue;
    const w = r[0].equipment.weapon;
    const key = w ? `${w.name}:${w.itemVars?.blowpipeDartName || ''}` : '';
    const existing = bestPerWeapon.get(key);
    if (!existing || isBetter(r[1], existing[1])) {
      bestPerWeapon.set(key, r);
    }
  }
  const ranked = [...bestPerWeapon.values()].sort(([, a], [, b]) => compareScores(a, b));

  // 4. try two-slot swaps on the best results, to escape set-ups where no single swap helps. These only ever improve a
  // result, so the shown results are always among these.
  const resultsPerStyle = opts.resultsPerStyle ?? 5;
  const swapped = (yield ranked
    .slice(0, Math.max(resultsPerStyle, PAIR_SWAP_RESULTS))
    .map(([start]): OptimizerJob => ({ kind: 'pairSwap', family, start }))) as ScoredConfig[];
  const shown = [...swapped].sort(([, a], [, b]) => compareScores(a, b)).slice(0, resultsPerStyle);

  // 5. try every combination of a shortlist of items per slot around each shown result, which finds improvements that
  // need many slots to change at once. The best result gets the most of the budget.
  const budget = opts.exhaustiveBudget ?? EXHAUSTIVE_BUDGET;
  const shortlists = (yield shown.map(([start], i): OptimizerJob => ({
    kind: 'shortlist', family, start, budget: i === 0 ? budget : Math.round(budget * EXHAUSTIVE_OTHERS_FRACTION),
  }))) as Shortlist[];
  const exhaustJobs: OptimizerJob[] = [];
  const exhaustJobResult: number[] = [];
  for (const [i, shortlist] of shortlists.entries()) {
    for (const prefix of splitShortlist(shortlist)) {
      exhaustJobs.push({
        kind: 'exhaust', family, shortlist, prefix,
      });
      exhaustJobResult.push(i);
    }
  }
  const exhausted = (yield exhaustJobs) as JobResults['exhaust'][];
  const improved = [...shown];
  let exhaustiveCombinations = 0;
  for (const [j, { best, tried }] of exhausted.entries()) {
    exhaustiveCombinations += tried;
    const i = exhaustJobResult[j];
    if (best && isBetter(best[1], improved[i][1])) improved[i] = best;
  }

  // 6. a final pass of single swaps, and the alternatives
  const finished = (yield improved.map(([start]): OptimizerJob => ({ kind: 'describe', family, start }))) as FinishedLoadout[];

  return {
    loadouts: finished
      .sort((a, b) => compareScores(a.score, b.score))
      .slice(0, resultsPerStyle)
      .map((f) => f.loadout),
    summary: {
      ...planSummary,
      pairSwapped: swapped.length,
      exhaustiveCombinations,
      exhaustiveImprovements: improved.filter((r, i) => r !== shown[i]).length,
    },
  };
}

/** A job's result, and how many DPS calculations it took. */
export interface JobOutcome {
  result: unknown;
  evaluations: number;
}

const addEvaluations = (counts: StyleSearchSummary['evaluations'], job: OptimizerJob, evaluations: number) => {
  counts[job.kind] = (counts[job.kind] ?? 0) + evaluations;
};

/**
 * Finds the highest-DPS loadouts for each combat style, using only the provided (owned) equipment, on this thread.
 * @see GearOptimizer
 */
export const optimizeGear = (
  owned: EquipmentPiece[],
  basePlayer: Player,
  monster: Monster,
  opts: OptimizerOpts,
  onProgress?: OptimizerProgressCallback,
): OptimizerResult => {
  let stylesDone = 0;
  const optimizer = new GearOptimizer(owned, basePlayer, monster, opts, (evaluations) => onProgress?.({ evaluations, stylesDone }));

  const result = {
    melee: [], ranged: [], magic: [], evaluations: 0, summary: {},
  } as OptimizerResult;
  for (const style of searchedStyles(opts)) {
    const evaluations: StyleSearchSummary['evaluations'] = {};
    const search = searchStyle(style, opts);
    let step = search.next();
    while (!step.done) {
      step = search.next(step.value.map((job) => {
        const before = optimizer.evaluations;
        const r = optimizer.runJob(job);
        addEvaluations(evaluations, job, optimizer.evaluations - before);
        return r;
      }));
    }
    result[style] = step.value.loadouts;
    result.summary[style] = { ...step.value.summary, evaluations };
    stylesDone += 1;
    onProgress?.({ evaluations: optimizer.evaluations, stylesDone });
  }
  result.evaluations = optimizer.evaluations;
  return result;
};

/**
 * Finds the highest-DPS loadouts for each combat style, like optimizeGear, but runs the jobs with the given function,
 * which may run them in parallel (e.g. on a pool of workers each with their own GearOptimizer). All styles are
 * searched at the same time.
 * @param runJob - runs the job on a GearOptimizer created with the same inputs, and returns its result
 * @param onStyleDone - called as each style finishes
 */
export const optimizeGearWith = async (
  opts: OptimizerOpts,
  runJob: (job: OptimizerJob) => Promise<JobOutcome>,
  onStyleDone?: (style: OptimizerStyle) => void,
): Promise<Omit<OptimizerResult, 'evaluations'>> => {
  const result: Omit<OptimizerResult, 'evaluations'> = {
    melee: [], ranged: [], magic: [], summary: {},
  };
  await Promise.all(searchedStyles(opts).map(async (style) => {
    const evaluations: StyleSearchSummary['evaluations'] = {};
    const search = searchStyle(style, opts);
    let step = search.next();
    while (!step.done) {
      // eslint-disable-next-line no-await-in-loop
      const outcomes = await Promise.all(step.value.map(async (job) => {
        const outcome = await runJob(job);
        addEvaluations(evaluations, job, outcome.evaluations);
        return outcome.result;
      }));
      step = search.next(outcomes);
    }
    result[style] = step.value.loadouts;
    result.summary[style] = { ...step.value.summary, evaluations };
    onStyleDone?.(style);
  }));
  return result;
};
