import { makeAutoObservable, toJS } from 'mobx';
import * as localforage from 'localforage';
import { PartialDeep } from 'type-fest';
import { toast } from 'react-toastify';
import {
  EquipmentPiece, Player, PlayerEquipment, PlayerSkills,
} from '@/types/Player';
import { DEFENSIVE_PRAYERS, OFFENSIVE_PRAYERS, Prayer } from '@/enums/Prayer';
import Potion from '@/enums/Potion';
import { availableEquipment } from '@/lib/Equipment';
import { BankItem } from '@/lib/BankImport';
import { fetchPrices, idsToFetch, PriceCache } from '@/lib/ItemPrices';
import {
  OPTIMIZER_STYLES, OptimizedLoadout, OptimizerStyle, toggleSearchPrayer, TrainingSkill,
} from '@/lib/optimizer';
import { fetchPlayerSkills, PotionMap } from '@/utils';
import { generateEmptyPlayer, GlobalState, useStore } from '@/state';

/**
 * The state of the gear optimizer ("Find Best Gear") and the imported bank. It's kept out of the global state (in
 * state.tsx), so that this fork changes as little of the upstream code as possible. Get it with useOptimizer().
 */

export interface BankData {
  items: BankItem[];
  fileName: string;
  importedAt: number;
}

const BANK_STORAGE_KEY = 'dps-calc-bank';
const EXCLUDED_ITEMS_STORAGE_KEY = 'dps-calc-excluded-items';
const EXCLUDED_SPELLS_STORAGE_KEY = 'dps-calc-excluded-spells';
const IGNORED_AMMO_STORAGE_KEY = 'dps-calc-ignored-ammo';
const OPTIMIZER_SETTINGS_STORAGE_KEY = 'dps-calc-optimizer-settings';
const ITEM_PRICES_STORAGE_KEY = 'dps-calc-item-prices';

/**
 * The boosts the potions give, using the highest boost of any of them for each skill. Hitpoints are never boosted, as
 * the current HP is set by hand.
 */
export const calculatePotionBoosts = (skills: PlayerSkills, potions: Potion[]): Partial<PlayerSkills> => {
  const boosts: Partial<PlayerSkills> = {
    atk: 0, def: 0, magic: 0, prayer: 0, ranged: 0, str: 0, mining: 0, herblore: 0, farming: 0,
  };

  for (const p of potions) {
    const result = PotionMap[p].calculateFn(skills);
    for (const k of Object.keys(result)) {
      const r = result[k as keyof typeof result] as number;
      if (r > boosts[k as keyof typeof boosts]!) {
        boosts[k as keyof typeof boosts] = r;
      }
    }
  }

  return boosts;
};

/**
 * The inputs of the gear optimizer. These are separate from the loadouts, which are for comparing gear sets, and are
 * saved in the browser.
 */
export interface OptimizerSettings {
  skills: PlayerSkills;
  /** The potion boosts, plus the difference between the current and base HP. */
  boosts: PlayerSkills;
  /** The potions and the extra options (on slayer task etc.) */
  buffs: Player['buffs'];
  /** The prayers to use. Each style uses the ones for it, and the ones that aren't for a specific style. */
  prayers: Prayer[];
  /** Slots that are fixed to an item (or to being empty, if null). */
  locked: Partial<PlayerEquipment>;
  styles: OptimizerStyle[];
  training?: TrainingSkill;
  /** The only spell to cast with magic. */
  spell?: string;
  minWeight: number;
  wilderness: WildernessSettings;
}

/** Wilderness mode limits how much the gear optimizer's setups risk losing on death. */
export interface WildernessSettings {
  enabled: boolean;
  /** The most a setup may lose on death, in gp. */
  maxRisk: number;
  /** Whether Protect Item is used, which keeps one more item. */
  protectItem: boolean;
  /** Whether the player is skulled, which keeps 3 fewer items. */
  skulled: boolean;
  /** Never use untradeable items (which count as free, but may be lost or need repairing), unless they're locked. */
  skipUntradeables: boolean;
}

/** A change to the gear optimizer's settings. The skills, boosts and buffs are merged in, the rest is replaced. */
export type OptimizerSettingsUpdate = Partial<Omit<OptimizerSettings, 'skills' | 'boosts' | 'buffs'>> & {
  skills?: Partial<PlayerSkills>;
  boosts?: Partial<PlayerSkills>;
  buffs?: Partial<Player['buffs']>;
};

const generateOptimizerSettings = (): OptimizerSettings => {
  const { skills, boosts, buffs } = generateEmptyPlayer();
  return {
    skills,
    boosts,
    buffs,
    prayers: [],
    locked: {},
    styles: OPTIMIZER_STYLES,
    minWeight: 0,
    wilderness: {
      enabled: false,
      maxRisk: 100_000,
      protectItem: false,
      skulled: false,
      skipUntradeables: false,
    },
  };
};

/**
 * Reloads the most current data for a stored item using its ID, to ensure we're not using stale data. Returns null if
 * the item seems to no longer exist.
 */
const refreshEquipmentPiece = (v: PartialDeep<EquipmentPiece>): EquipmentPiece | null => {
  const item = availableEquipment.find((eq) => eq.id === v.id);
  if (!item) return null;
  // include the hidden itemVars inputs that are not present on the availableEquipment store
  return Object.hasOwn(v, 'itemVars') ? { ...item, itemVars: v.itemVars as EquipmentPiece['itemVars'] } : item;
};

/** Saves a value in the browser, logging (rather than throwing) any error. */
const save = (key: string, value: unknown) => {
  localforage.setItem(key, toJS(value)).catch((e) => {
    console.error(e);
  });
};

/** Loads a value saved in the browser, if there is one. */
const load = <T>(key: string, apply: (value: T) => void, isValid: (value: unknown) => boolean = Boolean) => {
  localforage.getItem(key).then((v) => {
    if (isValid(v)) apply(v as T);
  }).catch((e) => {
    console.error(e);
  });
};

export class OptimizerState {
  private readonly root: GlobalState;

  /**
   * The user's imported bank, used by the gear optimizer. Stored separately from the importable data so that it is
   * never included in share links.
   */
  bank: BankData | null = null;

  /**
   * Item IDs (canonical) that the gear optimizer should never use. Kept separately from the bank, so that the list
   * survives re-importing an updated bank.
   */
  excludedItemIds: number[] = [];

  /**
   * Names of spells that the gear optimizer should never use, e.g. because their runes are too expensive.
   */
  excludedSpells: string[] = [];

  /**
   * Names of ammo (and blowpipe darts) that the gear optimizer should never load, e.g. because they're too expensive to
   * burn. Unlike excluded items, ignored darts can still be thrown.
   */
  ignoredAmmo: string[] = [];

  /** The inputs of the gear optimizer, separate from the loadouts. */
  settings: OptimizerSettings = generateOptimizerSettings();

  /** Cached GE prices by item ID, for the gear optimizer's wilderness mode. */
  itemPrices: PriceCache = {};

  private loaded = false;

  constructor(root: GlobalState) {
    this.root = root;
    makeAutoObservable<OptimizerState, 'root' | 'loaded'>(this, { root: false, loaded: false }, { autoBind: true });
  }

  /** Loads everything saved in the browser. Only the first call does anything. */
  load() {
    if (this.loaded) return;
    this.loaded = true;

    load<BankData>(BANK_STORAGE_KEY, (v) => { this.bank = v; });
    load<number[]>(EXCLUDED_ITEMS_STORAGE_KEY, (v) => { this.excludedItemIds = v; }, Array.isArray);
    load<string[]>(EXCLUDED_SPELLS_STORAGE_KEY, (v) => { this.excludedSpells = v; }, Array.isArray);
    load<string[]>(IGNORED_AMMO_STORAGE_KEY, (v) => { this.ignoredAmmo = v; }, Array.isArray);
    load<PriceCache>(ITEM_PRICES_STORAGE_KEY, (v) => { this.itemPrices = v; });
    load<OptimizerSettingsUpdate>(OPTIMIZER_SETTINGS_STORAGE_KEY, ({ locked, wilderness, ...settings }) => {
      // reload the locked items' data, and drop the locks of items that no longer exist
      const refreshedLocks: Partial<PlayerEquipment> = {};
      for (const [slot, item] of Object.entries(locked || {})) {
        const refreshed = item && refreshEquipmentPiece(item);
        if (!item || refreshed) refreshedLocks[slot as keyof PlayerEquipment] = refreshed;
      }
      // start from the defaults, so that settings added since they were saved get their default value
      this.settings = generateOptimizerSettings();
      this.updateSettings({
        ...settings,
        locked: refreshedLocks,
        wilderness: { ...this.settings.wilderness, ...wilderness },
      });
    });
  }

  /**
   * Changes the gear optimizer's settings, and saves them. The potion boosts are recomputed if the levels or potions
   * change.
   */
  updateSettings(update: OptimizerSettingsUpdate) {
    const current = this.settings;
    const next: OptimizerSettings = {
      ...current,
      ...update,
      skills: { ...current.skills, ...update.skills },
      boosts: { ...current.boosts, ...update.boosts },
      buffs: { ...current.buffs, ...update.buffs },
    };
    if (update.skills || update.buffs?.potions) {
      next.boosts = { ...next.boosts, ...calculatePotionBoosts(next.skills, next.buffs.potions) };
    }
    this.settings = next;
    save(OPTIMIZER_SETTINGS_STORAGE_KEY, this.settings);
  }

  togglePotion(potion: Potion) {
    const { potions } = this.settings.buffs;
    this.updateSettings({
      buffs: { potions: potions.includes(potion) ? potions.filter((p) => p !== potion) : [...potions, potion] },
    });
  }

  togglePrayer(prayer: Prayer) {
    this.updateSettings({ prayers: toggleSearchPrayer(this.settings.prayers, prayer) });
  }

  /**
   * Locks a slot of the gear optimizer to an item (or to being empty, if null), or unlocks it if undefined.
   */
  setLock(slot: keyof PlayerEquipment, item: EquipmentPiece | null | undefined) {
    const locked = { ...this.settings.locked };
    if (item === undefined) {
      delete locked[slot];
    } else {
      locked[slot] = item;
    }
    // a two-handed weapon can't be worn with a shield, so locking one unlocks the other
    if (slot === 'weapon' && item?.isTwoHanded && locked.shield) delete locked.shield;
    if (slot === 'shield' && item && locked.weapon?.isTwoHanded) delete locked.weapon;
    this.updateSettings({ locked });
  }

  /**
   * The player that the gear optimizer searches with: the optimizer's levels, boosts and extra options, with no gear.
   */
  get basePlayer(): Player {
    const {
      skills, boosts, buffs, wilderness,
    } = this.settings;
    return {
      ...generateEmptyPlayer(),
      skills: toJS(skills),
      boosts: toJS(boosts),
      // wilderness weapons (Craw's bow etc.) only get their bonus in the Wilderness
      buffs: { ...toJS(buffs), inWilderness: buffs.inWilderness || wilderness.enabled },
    };
  }

  /**
   * Looks up the levels of the username entered in the calculator, for the gear optimizer.
   */
  async fetchSkills() {
    const { username } = this.root.ui;

    try {
      const res = await toast.promise(
        fetchPlayerSkills(username),
        {
          pending: 'Fetching player skills...',
          success: `Successfully fetched player skills for ${username}!`,
          error: 'Error fetching player skills',
        },
        {
          toastId: 'skills-fetch',
        },
      );

      if (res) this.updateSettings({ skills: res });
    } catch (e) {
      console.error(e);
    }
  }

  /**
   * Makes sure the prices of these items are cached, requesting the ones that aren't (or that have expired).
   * @param refresh - request all of them, even if they're cached
   * @throws Error if a request fails
   */
  async loadItemPrices(ids: number[], refresh = false) {
    const missing = refresh ? ids : idsToFetch(ids, this.itemPrices);
    if (missing.length === 0) return;
    this.addItemPrices(await fetchPrices(missing));
  }

  addItemPrices(prices: PriceCache) {
    this.itemPrices = { ...this.itemPrices, ...prices };
    save(ITEM_PRICES_STORAGE_KEY, this.itemPrices);
  }

  setIgnoredAmmo(names: string[]) {
    this.ignoredAmmo = [...new Set(names)];
    save(IGNORED_AMMO_STORAGE_KEY, this.ignoredAmmo);
  }

  toggleIgnoredAmmo(name: string) {
    this.setIgnoredAmmo(this.ignoredAmmo.includes(name)
      ? this.ignoredAmmo.filter((n) => n !== name)
      : [...this.ignoredAmmo, name]);
  }

  setExcludedSpells(names: string[]) {
    this.excludedSpells = [...new Set(names)];
    save(EXCLUDED_SPELLS_STORAGE_KEY, this.excludedSpells);
  }

  toggleExcludedSpell(name: string) {
    this.setExcludedSpells(this.excludedSpells.includes(name)
      ? this.excludedSpells.filter((s) => s !== name)
      : [...this.excludedSpells, name]);
  }

  setExcludedItemIds(ids: number[]) {
    this.excludedItemIds = [...new Set(ids)];
    save(EXCLUDED_ITEMS_STORAGE_KEY, this.excludedItemIds);
  }

  toggleExcludedItem(id: number) {
    this.setExcludedItemIds(this.excludedItemIds.includes(id)
      ? this.excludedItemIds.filter((i) => i !== id)
      : [...this.excludedItemIds, id]);
  }

  setBank(items: BankItem[], fileName: string) {
    this.bank = { items, fileName, importedAt: Date.now() };
    save(BANK_STORAGE_KEY, this.bank);
  }

  clearBank() {
    this.bank = null;
    localforage.removeItem(BANK_STORAGE_KEY).catch((e) => {
      console.error(e);
    });
  }

  /**
   * Applies a loadout found by the gear optimizer, replacing all equipment, the combat style, spell and prayers, and
   * the levels, potions and extra options it was found with, so that the loadout gets the same DPS.
   * @param result the optimizer result
   * @param asNewLoadout whether to create a new loadout for it (if possible), rather than overwriting the current one
   * @param base the levels, boosts and buffs the optimizer searched with
   */
  applyLoadout(result: OptimizedLoadout, asNewLoadout: boolean, base: Pick<Player, 'skills' | 'boosts' | 'buffs'>) {
    const { root } = this;
    if (asNewLoadout && root.canCreateLoadout) {
      root.createLoadout(true, root.selectedLoadout);
    }

    // Clear everything first, so that no properties (such as blowpipe darts) are merged in from the old items
    root.updatePlayer({ equipment: generateEmptyPlayer().equipment });
    root.updatePlayer({
      equipment: result.equipment,
      style: result.style,
      spell: result.spell,
      skills: base.skills,
      buffs: base.buffs,
    });
    // the potions are replaced rather than merged by index, and the boosts include the current HP (which the potions
    // don't set)
    root.player.buffs.potions = [...base.buffs.potions];
    root.updatePlayer({ boosts: base.boosts });

    // Piety, Rigour and Augury are also defensive prayers, so clear both groups to avoid conflicts
    const prayers = root.player.prayers.filter((p) => !OFFENSIVE_PRAYERS.includes(p) && !DEFENSIVE_PRAYERS.includes(p));
    root.player.prayers = [...prayers, ...result.prayers];
  }
}

const optimizerStates = new WeakMap<GlobalState, OptimizerState>();

/** The gear optimizer state that belongs to this global state. */
export const getOptimizerState = (root: GlobalState): OptimizerState => {
  let state = optimizerStates.get(root);
  if (!state) {
    state = new OptimizerState(root);
    optimizerStates.set(root, state);
  }
  return state;
};

/** The gear optimizer state, for the store of the current context. */
export const useOptimizer = (): OptimizerState => getOptimizerState(useStore());
