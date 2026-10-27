import {
  EquipmentPiece, Player, PlayerEquipment,
} from '@/types/Player';
import { Monster } from '@/types/Monster';
import { Spell, spells } from '@/types/Spell';
import { Prayer } from '@/enums/Prayer';
import { EquipmentCategory } from '@/enums/EquipmentCategory';
import PlayerVsNPCCalc from '@/lib/PlayerVsNPCCalc';
import {
  calculateEquipmentBonusesFromGear, canBlowpipeUseDart, DART_TIER, getCanonicalItemId,
} from '@/lib/Equipment';
import { BLOWPIPE_IDS, CAST_STANCES } from '@/lib/constants';
import { getCombatStylesForCategory } from '@/utils';
import {
  ARMOUR_SLOTS, MIN_RISK_SCALE, PROGRESS_INTERVAL_MS, SET_SEEDS, SPELLS_TO_CONSIDER, WEAPON_SPECIFIC_SPELLS,
} from './constants';
import {
  configKey, EMPTY_SCORE, isBetter, withSlot,
} from './config';
import {
  isFeasible, meetsMinWeight, riskOf, withinRisk,
} from './constraints';
import {
  ammoWorksWith, firedAmmoEffectOf, pruneDominated, relevantStats, unusedAmmoStats, weaponRequiresAmmo,
} from './items';
import { getPrayers, getStyles } from './styles';
import plan from './plan';
import { refine } from './descent';
import descendWithPairSwaps from './pairSwap';
import { exhaust, pickShortlist } from './exhaustive';
import describe from './describe';
import {
  Config, OptimizerJob, OptimizerJobResult, OptimizerOpts, OptimizerStyle, Score,
} from './types';

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
 * run in parallel. searchStyle() decides which jobs to run. The steps themselves are in their own modules (plan.ts
 * etc.), which use the public members of this class.
 */
class GearOptimizer {
  readonly base: Player;

  readonly monster: Monster;

  readonly opts: OptimizerOpts;

  readonly owned: EquipmentPiece[];

  private readonly cache = new Map<string, Score>();

  /** Evaluations that bypass the cache (the exhaustive search, which would make it far too big). */
  private uncachedEvaluations = 0;

  /** The owned and locked items, for looking up the items in a shortlist. */
  readonly itemsById: Map<number, EquipmentPiece>;

  family: OptimizerStyle = 'melee';

  state!: StyleState;

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

  /** Counts an evaluation that bypasses the cache. */
  countUncachedEvaluation() {
    this.uncachedEvaluations += 1;
    this.reportProgress();
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

  get locked(): Partial<PlayerEquipment> {
    return this.opts.locked || {};
  }

  isLocked(slot: keyof PlayerEquipment): boolean {
    return Object.hasOwn(this.locked, slot);
  }

  private isIgnoredAmmo(item: EquipmentPiece): boolean {
    return (this.opts.ignoredAmmo || []).includes(item.name);
  }

  get hasMinWeight(): boolean {
    return (this.opts.minWeight || 0) > 0;
  }

  meetsMinWeight(c: Config): boolean {
    return meetsMinWeight(c, this.opts);
  }

  get hasRiskLimit(): boolean {
    return !!this.opts.wilderness;
  }

  risk(c: Config): number {
    return this.opts.wilderness ? riskOf(c.equipment, this.opts.wilderness).risk : 0;
  }

  /** How far the setup is over the risk limit, in gp (0 if it's within it). */
  excessRisk(c: Config): number {
    return this.opts.wilderness ? Math.max(0, this.risk(c) - this.opts.wilderness.maxRisk) : 0;
  }

  /** The amount of gp over the risk limit that the trade fractions are relative to (see MIN_RISK_SCALE). */
  get riskScale(): number {
    return Math.max(this.opts.wilderness?.maxRisk || 0, MIN_RISK_SCALE);
  }

  withinRisk(c: Config): boolean {
    return withinRisk(c, this.opts);
  }

  isFeasible(c: Config): boolean {
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
        return plan(this) as OptimizerJobResult<J>;
      case 'refine': {
        const [c, s] = refine(this, job.start);
        const usable = s.dps > 0 && this.isFeasible(c);
        return (usable ? [c, s] : null) as OptimizerJobResult<J>;
      }
      case 'pairSwap':
        return descendWithPairSwaps(this, job.start) as OptimizerJobResult<J>;
      case 'shortlist':
        return pickShortlist(this, job.start, job.budget) as OptimizerJobResult<J>;
      case 'exhaust':
        return exhaust(this, job.shortlist, job.prefix) as OptimizerJobResult<J>;
      case 'describe':
      default:
        return describe(this, job.start) as OptimizerJobResult<J>;
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

  toPlayer(c: Config, base: Player = this.base): Player {
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

  score(c: Config): Score {
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
  evaluate(c: Config, base: Player = this.base): Score {
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
  getWeaponCandidates(): (EquipmentPiece | null)[] {
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
  equipWeapon(c: Config, weapon: EquipmentPiece | null): [Config, Score] {
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
  pickWeaponSettings(c: Config): [Config, Score] {
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
   * The items that can go in an armour slot (including leaving it empty, unless the weapon needs ammo).
   */
  getSlotOptions(slot: keyof PlayerEquipment, weapon: EquipmentPiece | null): (EquipmentPiece | null)[] {
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
   * Returns the owned multi-piece sets relevant to the current style, as slot -> item maps.
   */
  getSetSeeds(): Partial<Record<keyof PlayerEquipment, EquipmentPiece>>[] {
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

export default GearOptimizer;
