import { EquipmentPiece, PlayerEquipment } from '@/types/Player';
import { PlayerCombatStyle } from '@/types/PlayerCombatStyle';
import { Spell } from '@/types/Spell';
import { Prayer } from '@/enums/Prayer';

export type OptimizerStyle = 'melee' | 'ranged' | 'magic';

/**
 * Which combat skill the user wants to gain experience in, which limits the attack stances that can be used.
 * Attack, Strength and Shared only affect melee. Defence also applies to ranged (Longrange) and magic (Defensive
 * Autocast, or Longrange on powered staves).
 * @see https://oldschool.runescape.wiki/w/Combat_Options
 */
export type TrainingSkill = 'attack' | 'strength' | 'defence' | 'shared';

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
  /** The owned armour sets (without a weapon of their own), to try on the best refined weapons. */
  setSeeds: Partial<Record<keyof PlayerEquipment, EquipmentPiece>>[];
}

export type JobResults = {
  plan: PlanResult;
  refine: ScoredConfig | null;
  pairSwap: ScoredConfig;
  shortlist: Shortlist;
  exhaust: { best: ScoredConfig | null, tried: number };
  describe: FinishedLoadout;
};
export type OptimizerJobResult<J extends OptimizerJob> = JobResults[J['kind']];

/** The result of searching one style. */
export interface StyleSearchResult {
  loadouts: OptimizedLoadout[];
  /** Everything but the evaluations, which are counted by whatever runs the jobs. */
  summary: Omit<StyleSearchSummary, 'evaluations'>;
}

/** A job's result, and how many DPS calculations it took. */
export interface JobOutcome {
  result: unknown;
  evaluations: number;
}
