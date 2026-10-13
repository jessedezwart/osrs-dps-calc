import {
  EquipmentPiece, Player, PlayerEquipment,
} from '@/types/Player';
import { Monster } from '@/types/Monster';
import { CombatStyleStance, PlayerCombatStyle } from '@/types/PlayerCombatStyle';
import { Spell, spells } from '@/types/Spell';
import { Prayer } from '@/enums/Prayer';
import { EquipmentCategory } from '@/enums/EquipmentCategory';
import PlayerVsNPCCalc from '@/lib/PlayerVsNPCCalc';
import {
  AmmoApplicability,
  ammoApplicability,
  calculateEquipmentBonusesFromGear,
  canBlowpipeUseDart,
  DART_TIER,
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

export interface OptimizerOpts {
  /** Whether Rigour and Augury are unlocked. If not, Eagle Eye and Mystic Might are used instead. */
  prayerUnlocks: boolean;
  /** Don't use any offensive prayers. */
  noPrayers?: boolean;
  /** How many results (each with a different weapon) to return per style. */
  resultsPerStyle?: number;
  /**
   * Search much more of the space: refine more weapons, try owned sets on more weapons, and also try changing two
   * slots at once. Considerably slower.
   */
  thorough?: boolean;
  /**
   * Slots that are fixed to a specific item (or to being empty, if null). These items don't need to be owned, and the
   * rest of the gear is searched around them.
   */
  locked?: Partial<PlayerEquipment>;
  /** Only use attack stances that train this skill. If not set, any stance may be used. */
  training?: TrainingSkill;
}

export interface OptimizedLoadout {
  equipment: PlayerEquipment;
  style: PlayerCombatStyle;
  spell: Spell | null;
  prayers: Prayer[];
  dps: number;
  maxHit: number;
  accuracy: number;
}

export type OptimizerResult = { [k in OptimizerStyle]: OptimizedLoadout[] } & {
  /** The number of unique DPS calculations performed. */
  evaluations: number;
};

interface Config {
  equipment: PlayerEquipment;
  style: PlayerCombatStyle;
  spell: Spell | null;
}

interface Score {
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
const WEAPONS_TO_REFINE = 5;
const THOROUGH_WEAPONS_TO_REFINE = 15;
/** Weapons that also get tried with each owned armour set (void etc.) */
const WEAPONS_FOR_SET_SEEDS = 2;
const THOROUGH_WEAPONS_FOR_SET_SEEDS = 5;
/** In thorough mode, how many of the final results get the (expensive) two-slot swap search. */
const THOROUGH_PAIR_SWAP_RESULTS = 5;
/** In the two-slot swap search, how many of the best items in each slot are paired up with each other. */
const PAIR_CANDIDATES_PER_SLOT = 4;
const MAX_PAIR_ROUNDS = 3;
const MAX_DESCENT_PASSES = 4;
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

const getPrayers = (style: OptimizerStyle, prayerUnlocks: boolean): Prayer[] => {
  switch (style) {
    case 'melee':
      return [Prayer.PIETY];
    case 'ranged':
      return [prayerUnlocks ? Prayer.RIGOUR : Prayer.EAGLE_EYE];
    case 'magic':
    default:
      return [prayerUnlocks ? Prayer.AUGURY : Prayer.MYSTIC_MIGHT];
  }
};

const isSpecialEffectItem = (item: EquipmentPiece) => SPECIAL_EFFECT_ITEMS.some((r) => r.test(item.name));

const defensiveSum = (item: EquipmentPiece) => item.defensive.stab + item.defensive.slash + item.defensive.crush
  + item.defensive.magic + item.defensive.ranged;

/** The stats that matter for a given style, used to prune items that are strictly worse than another owned item. */
const relevantStats = (item: EquipmentPiece, style: OptimizerStyle): number[] => {
  switch (style) {
    case 'melee':
      return [item.offensive.stab, item.offensive.slash, item.offensive.crush, item.bonuses.str, defensiveSum(item)];
    case 'ranged':
      return [item.offensive.ranged, item.bonuses.ranged_str, defensiveSum(item)];
    case 'magic':
    default:
      return [item.offensive.magic, item.bonuses.magic_str, defensiveSum(item)];
  }
};

/**
 * Removes items that are no better than another item in the same list in every stat relevant to the style.
 * Items with special effects are always kept.
 */
export const pruneDominated = (items: EquipmentPiece[], style: OptimizerStyle): EquipmentPiece[] => {
  const stats = items.map((i) => relevantStats(i, style));
  return items.filter((item, i) => {
    if (isSpecialEffectItem(item)) return true;
    return !items.some((other, j) => {
      if (i === j) return false;
      const a = stats[i];
      const b = stats[j];
      const allAtLeast = b.every((v, k) => v >= a[k]);
      if (!allAtLeast) return false;
      const strictlyBetter = b.some((v, k) => v > a[k]);
      // for identical stats, keep only the first occurrence
      return strictlyBetter || j < i;
    });
  });
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
 * than another stance of the same type (e.g. Defensive vs Accurate) are dropped.
 */
const getStyles = (weapon: EquipmentPiece | null, family: OptimizerStyle, training?: TrainingSkill): PlayerCombatStyle[] => {
  const category = weapon?.category || EquipmentCategory.NONE;
  const seen = new Set<string>();
  return getCombatStylesForCategory(category).filter((s) => {
    if (!isStyleInFamily(s, family)) return false;
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

const weaponRequiresAmmo = (weapon: EquipmentPiece | null) => weapon !== null
  && ammoApplicability(weapon.id, undefined) === AmmoApplicability.INVALID;

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

/**
 * Finds the highest-DPS loadouts for each combat style, using only the provided (owned) equipment.
 *
 * The search space is far too large to brute force, so this uses a greedy approach:
 *   1. find a reasonable armour set around the strongest weapon (coordinate descent: swap one slot at a time while it
 *      improves DPS),
 *   2. rank every owned weapon (with its best stance, ammo, and spell) using that armour,
 *   3. for the best few weapons, run the coordinate descent again, both from the screening armour and from any owned
 *      multi-piece sets (void etc.) whose bonuses can't be found one swap at a time,
 *   4. in thorough mode, refine many more weapons, and finish the best results with two-slot swaps, which can escape
 *      set-ups where no single swap helps.
 */
export class GearOptimizer {
  private readonly base: Player;

  private readonly monster: Monster;

  private readonly opts: OptimizerOpts;

  private readonly owned: EquipmentPiece[];

  private readonly cache = new Map<string, Score>();

  private prayers: Prayer[] = [];

  private family: OptimizerStyle = 'melee';

  private slotCandidates: Partial<Record<keyof PlayerEquipment, EquipmentPiece[]>> = {};

  private spellCandidates: Spell[] = [];

  constructor(owned: EquipmentPiece[], basePlayer: Player, monster: Monster, opts: OptimizerOpts) {
    this.owned = owned;
    this.base = basePlayer;
    this.monster = monster;
    this.opts = opts;
  }

  get evaluations() {
    return this.cache.size;
  }

  private get locked(): Partial<PlayerEquipment> {
    return this.opts.locked || {};
  }

  private isLocked(slot: keyof PlayerEquipment): boolean {
    return Object.hasOwn(this.locked, slot);
  }

  public run(): OptimizerResult {
    const result = { evaluations: 0 } as OptimizerResult;
    for (const style of OPTIMIZER_STYLES) {
      result[style] = this.optimizeStyle(style);
    }
    result.evaluations = this.evaluations;
    return result;
  }

  public optimizeStyle(family: OptimizerStyle): OptimizedLoadout[] {
    this.family = family;
    this.prayers = this.opts.noPrayers ? [] : getPrayers(family, this.opts.prayerUnlocks);

    // build the per-slot candidate lists for this style
    this.slotCandidates = {};
    for (const slot of ARMOUR_SLOTS) {
      if (this.isLocked(slot)) {
        const lockedItem = this.locked[slot];
        this.slotCandidates[slot] = lockedItem ? [lockedItem] : [];
        continue;
      }
      const items = this.owned.filter((i) => i.slot === slot);
      // ammo is never pruned, as e.g. enchanted bolts have effects that aren't reflected in their stats
      this.slotCandidates[slot] = slot === 'ammo' ? items : pruneDominated(items, family);
    }
    this.spellCandidates = family === 'magic' ? this.rankSpells() : [];

    const weapons = this.getWeaponCandidates();
    if (weapons.length === 0) return [];

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
    if (!screeningBest) return [];
    const screeningArmour = this.descend(screeningBest)[0];

    // 2. rank every weapon using the screening armour
    const ranked = weapons
      .map((w) => this.equipWeapon(screeningArmour, w))
      .filter(([, s]) => s.dps > 0)
      .sort(([, a], [, b]) => compareScores(a, b));

    // 3. refine the best few weapons, and try the set seeds
    const { thorough } = this.opts;
    const weaponsToRefine = thorough ? THOROUGH_WEAPONS_TO_REFINE : WEAPONS_TO_REFINE;
    const weaponsForSetSeeds = thorough ? THOROUGH_WEAPONS_FOR_SET_SEEDS : WEAPONS_FOR_SET_SEEDS;
    const results: [Config, Score][] = [];
    for (const [i, [c]] of ranked.slice(0, weaponsToRefine).entries()) {
      results.push(this.descend(c));

      if (i < weaponsForSetSeeds) {
        for (const seed of this.getSetSeeds()) {
          if (seed.weapon) continue;
          let seeded = c;
          for (const [slot, item] of Object.entries(seed)) {
            seeded = withSlot(seeded, slot as keyof PlayerEquipment, item ?? null);
          }
          results.push(this.descend(seeded));
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
      const [c] = this.equipWeapon(seeded, seed.weapon);
      results.push(this.descend(c));
    }

    // keep the best result per weapon (by name, as e.g. poisoned variants are functionally identical)
    const bestPerWeapon = new Map<string, [Config, Score]>();
    for (const r of results) {
      const w = r[0].equipment.weapon;
      const key = w ? `${w.name}:${w.itemVars?.blowpipeDartName || ''}` : '';
      const existing = bestPerWeapon.get(key);
      if (r[1].dps > 0 && (!existing || isBetter(r[1], existing[1]))) {
        bestPerWeapon.set(key, r);
      }
    }

    let final = [...bestPerWeapon.values()].sort(([, a], [, b]) => compareScores(a, b));

    // 4. (thorough only) try two-slot swaps on the best results, to escape set-ups where no single swap helps
    if (thorough) {
      final = [
        ...final.slice(0, THOROUGH_PAIR_SWAP_RESULTS).map(([c]) => this.descendWithPairSwaps(c)),
        ...final.slice(THOROUGH_PAIR_SWAP_RESULTS),
      ].sort(([, a], [, b]) => compareScores(a, b));
    }

    return final
      .slice(0, this.opts.resultsPerStyle ?? 5)
      .map(([c, s]) => ({
        equipment: c.equipment,
        style: c.style,
        spell: c.spell,
        prayers: this.prayers,
        dps: s.dps,
        maxHit: s.maxHit,
        accuracy: s.accuracy,
      }));
  }

  private toPlayer(c: Config): Player {
    const player: Player = {
      ...this.base,
      equipment: c.equipment,
      style: c.style,
      spell: c.spell,
      prayers: this.prayers,
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

    let score: Score;
    try {
      const player = this.toPlayer(c);
      const calc = new PlayerVsNPCCalc(player, this.monster, {
        loadoutName: 'optimizer',
        disableMonsterScaling: this.monster.id === -1,
      });
      const dist = calc.getDistribution();
      const defensive = player.defensive.stab + player.defensive.slash + player.defensive.crush
        + player.defensive.magic + player.defensive.ranged;
      score = {
        dps: calc.getDps() || 0,
        maxHit: dist.getMax(),
        accuracy: calc.getDisplayHitChance(),
        tiebreak: defensive + player.bonuses.prayer,
      };
    } catch {
      score = EMPTY_SCORE;
    }

    this.cache.set(key, score);
    return score;
  }

  /**
   * The weapons (including blowpipe + dart combinations) that are usable with the current style.
   */
  private getWeaponCandidates(): (EquipmentPiece | null)[] {
    const family = this.family;

    if (this.isLocked('weapon')) {
      const weapon = this.locked.weapon ?? null;
      return getStyles(weapon, family, this.opts.training).length > 0 ? [weapon] : [];
    }
    const ownedWeapons = this.owned.filter((i) => i.slot === 'weapon');
    // poisoned darts share the same name as the regular ones, and only one of each is needed
    const darts = [...new Map(ownedWeapons
      .filter((i) => DART_TIER[i.name] !== undefined)
      .map((i) => [i.name, i])).values()];

    const ret: (EquipmentPiece | null)[] = [];
    for (const weapon of ownedWeapons) {
      const styles = getStyles(weapon, family, this.opts.training);
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
   * Ranks every spell using no gear, and returns the best few (plus any weapon-specific spells).
   */
  private rankSpells(): Spell[] {
    const manualCast = getCombatStylesForCategory(EquipmentCategory.NONE).find((s) => s.stance === 'Manual Cast')!;
    const empty: PlayerEquipment = {
      head: null, cape: null, neck: null, ammo: null, weapon: null, body: null, shield: null, legs: null, hands: null, feet: null, ring: null,
    };

    const seen = new Set<string>();
    const scored: [Spell, number][] = [];
    for (const spell of spells) {
      if (seen.has(spell.name)) continue;
      seen.add(spell.name);
      scored.push([spell, this.score({ equipment: empty, style: manualCast, spell }).dps]);
    }

    const best = scored
      .filter(([, dps]) => dps > 0)
      .sort(([, a], [, b]) => b - a)
      .slice(0, SPELLS_TO_CONSIDER)
      .map(([s]) => s);
    const specific = spells.filter((s) => WEAPON_SPECIFIC_SPELLS.includes(s.name) && !best.includes(s));
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
    const ammo = this.slotCandidates.ammo || [];
    if (!weaponRequiresAmmo(weapon)) return ammo;
    return ammo.filter((a) => ammoApplicability(weapon!.id, a.id) === AmmoApplicability.INCLUDED);
  }

  /**
   * Picks the best combat style (and spell, if casting) for the config's current weapon.
   */
  private pickWeaponSettings(c: Config): [Config, Score] {
    let best: [Config, Score] = [c, EMPTY_SCORE];
    for (const style of getStyles(c.equipment.weapon, this.family, this.opts.training)) {
      const spellOptions: (Spell | null)[] = CAST_STANCES.includes(style.stance) ? this.spellCandidates : [null];
      for (const spell of spellOptions) {
        const candidate: Config = { ...c, style, spell };
        const s = this.score(candidate);
        if (isBetter(s, best[1])) best = [candidate, s];
      }
    }
    return best;
  }

  /**
   * Greedy coordinate descent: repeatedly try every candidate in every armour slot, keeping any swap that improves
   * the score, until a full pass makes no improvement.
   */
  private descend(start: Config): [Config, Score] {
    let [best, bestScore] = this.pickWeaponSettings(start);

    for (let pass = 0; pass < MAX_DESCENT_PASSES; pass++) {
      let improved = false;
      const weapon = best.equipment.weapon;

      for (const slot of ARMOUR_SLOTS) {
        if (slot === 'shield' && weapon?.isTwoHanded) continue;

        for (const item of this.getSlotOptions(slot, weapon)) {
          if ((best.equipment[slot]?.id ?? null) === (item?.id ?? null)) continue;
          const candidate = withSlot(best, slot, item);
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
   * The items that can go in an armour slot (including leaving it empty, unless the weapon needs ammo).
   */
  private getSlotOptions(slot: keyof PlayerEquipment, weapon: EquipmentPiece | null): (EquipmentPiece | null)[] {
    if (slot === 'shield' && weapon?.isTwoHanded) return [null];
    if (slot === 'ammo' && this.isLocked('ammo')) {
      // if the weapon needs ammo, the locked ammo has to work with it
      return weaponRequiresAmmo(weapon) ? this.getAmmoCandidates(weapon) : [this.locked.ammo ?? null];
    }
    if (this.isLocked(slot)) return [this.locked[slot] ?? null];
    if (slot === 'ammo' && weaponRequiresAmmo(weapon)) return this.getAmmoCandidates(weapon);
    return [null, ...(this.slotCandidates[slot] || [])];
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
      const top = this.getSlotOptions(slot, weapon)
        .map((item): [EquipmentPiece | null, Score] => [item, this.score(withSlot(current, slot, item))])
        .sort(([, a], [, b]) => compareScores(a, b))
        .slice(0, PAIR_CANDIDATES_PER_SLOT)
        .map(([item]) => item);
      topPerSlot.set(slot, top);
    }

    let found: [Config, Score] | null = null;
    for (const [i, slotA] of slots.entries()) {
      for (const slotB of slots.slice(i + 1)) {
        for (const a of topPerSlot.get(slotA)!) {
          for (const b of topPerSlot.get(slotB)!) {
            const candidate = withSlot(withSlot(current, slotA, a), slotB, b);
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
 * Finds the highest-DPS loadouts for each combat style, using only the provided (owned) equipment.
 * @see GearOptimizer
 */
export const optimizeGear = (
  owned: EquipmentPiece[],
  basePlayer: Player,
  monster: Monster,
  opts: OptimizerOpts,
): OptimizerResult => new GearOptimizer(owned, basePlayer, monster, opts).run();
