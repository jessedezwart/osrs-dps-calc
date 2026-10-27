import { PlayerEquipment } from '@/types/Player';
import { OptimizerStyle } from './types';

/** How often (in ms) progress is reported while searching. */
export const PROGRESS_INTERVAL_MS = 200;

export const SLOTS: (keyof PlayerEquipment)[] = [
  'weapon', 'head', 'cape', 'neck', 'ammo', 'body', 'shield', 'legs', 'hands', 'feet', 'ring',
];
export const ARMOUR_SLOTS = SLOTS.filter((s) => s !== 'weapon');

export const MELEE_TYPES = ['stab', 'slash', 'crush'];

/** Weapons whose ranking is decided by a full armour search (rather than just the screening armour). */
export const WEAPONS_TO_REFINE = 40;
/** Weapons that also get tried with each owned armour set (void etc.) */
export const WEAPONS_FOR_SET_SEEDS = 15;
/**
 * How many of the best refined results get the (expensive) two-slot swap search. This is more than are shown, as the
 * swaps can move a result up into the shown ones.
 */
export const PAIR_SWAP_RESULTS = 15;
/**
 * In the two-slot swap search, how many of the best items in each slot are paired up with each other. With a minimum
 * weight, the heaviest items in each slot are paired up too, as single swaps get stuck more easily (e.g. a heavy item
 * can only be dropped if another slot gets heavier at the same time).
 */
export const PAIR_CANDIDATES_PER_SLOT = 6;
export const MAX_PAIR_ROUNDS = 6;
export const MAX_DESCENT_PASSES = 8;
/** How many swaps can be made to bring a setup up to the minimum weight before giving up on it. */
export const MAX_WEIGHT_REPAIR_STEPS = 20;
/**
 * With a minimum weight, each start is also refined with weight valued at these fractions of the start's DPS (spread
 * over the minimum weight), i.e. how much DPS it's worth giving up to reach the weight. Different values spread the
 * weight over the slots differently.
 */
export const WEIGHT_TRADE_FRACTIONS = [0.02, 0.05, 0.1, 0.2, 0.4, 0.8];
export const WEIGHT_EPSILON = 1e-6;
/** How many swaps can be made to bring a setup down to the risk limit before giving up on it. */
export const MAX_RISK_REPAIR_STEPS = 20;
/**
 * With a risk limit, the trade fractions (see WEIGHT_TRADE_FRACTIONS) are of DPS per this much gp over the limit, or per
 * the limit itself if that's larger.
 */
export const MIN_RISK_SCALE = 1_000_000;
/**
 * The final step tries every combination of a shortlist of items per slot around each shown result, which finds
 * improvements that need many slots to change at once. This is how many combinations may be tried for the best result
 * in each style; the other shown results get EXHAUSTIVE_OTHERS_FRACTION of it.
 */
export const EXHAUSTIVE_BUDGET = 60_000;
export const EXHAUSTIVE_OTHERS_FRACTION = 0.25;
/** Each result's combinations are split into up to this many jobs (so that they can run in parallel)... */
export const EXHAUSTIVE_CHUNKS_PER_RESULT = 32;
/** ...but no smaller than this many combinations each, as each job has some overhead. */
export const EXHAUSTIVE_MIN_CHUNK_SIZE = 5_000;
/**
 * With a minimum weight, shortlisted items are ranked as if each kg gained were worth this fraction of the result's DPS
 * (spread over the minimum weight), so that heavy items that make room for better items elsewhere are shortlisted too.
 */
export const SHORTLIST_WEIGHT_FRACTION = 0.2;
/**
 * With a risk limit, shortlisted items that take the result over the limit (when swapped in alone) are ranked as if
 * each risk scale (see MIN_RISK_SCALE) over it cost this fraction of the result's DPS, so cheaper items are shortlisted too.
 */
export const SHORTLIST_RISK_FRACTION = 0.2;
/** The most equal-DPS alternatives shown per result. */
export const MAX_ALTERNATIVES = 6;
export const SPELLS_TO_CONSIDER = 6;
export const EPSILON = 1e-9;

/** Spells that only work with specific weapons, so are always worth trying. */
export const WEAPON_SPECIFIC_SPELLS = ['Iban Blast', 'Saradomin Strike', 'Claws of Guthix', 'Flames of Zamorak', 'Magic Dart'];

/**
 * Items with effects that are not reflected in their visible stats (set effects, slayer/undead/demon bonuses, etc).
 * These are never pruned from the search, even if another item has better stats in the same slot.
 */
export const SPECIAL_EFFECT_ITEMS: RegExp[] = [
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
export const AMMO_EFFECT_ITEMS: RegExp[] = [
  /^(opal|pearl|ruby|diamond|dragonstone|onyx) (?:dragon )?bolts \(e\)/i, /broad (?:arrows|bolts)/i, /^silver bolts/i, / brutal/i, /^ice arrows/i, /^dragon arrow/i,
];

/**
 * Multi-piece sets whose bonus can't be found by swapping one item at a time. If the user owns a whole set, the search
 * is also started from that set. Each slot lists acceptable item names in order of preference.
 */
export const SET_SEEDS: { styles: OptimizerStyle[], pieces: Partial<Record<keyof PlayerEquipment, string[]>> }[] = [
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
