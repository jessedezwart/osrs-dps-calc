import { makeAutoObservable, reaction, toJS } from 'mobx';
import * as localforage from 'localforage';
import { PartialDeep } from 'type-fest';
import {
  EquipmentPiece, Player, PlayerEquipment, PlayerSkills,
} from '@/types/Player';
import { DEFENSIVE_PRAYERS, OFFENSIVE_PRAYERS, Prayer } from '@/enums/Prayer';
import { availableEquipment } from '@/lib/Equipment';
import { BankItem } from '@/lib/BankImport';
import { fetchPrices, idsToFetch, PriceCache } from '@/lib/ItemPrices';
import {
  OPTIMIZER_STYLES, OptimizedLoadout, OptimizerStyle, toggleSearchPrayer, TrainingSkill,
} from '@/lib/optimizer';
import RootStore, { useStore } from '@/state/RootStore';
import { createEmptyPlayer, PlayerStore } from '@/state/PlayerStore';

/**
 * The state of the gear optimizer ("Find Best Gear") and the imported bank. It's kept out of the upstream stores (in
 * src/state/), so that this fork changes as little of the upstream code as possible. Get it with useOptimizer().
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
 * The inputs of the gear optimizer. These are separate from the loadouts, which are for comparing gear sets, and are
 * saved in the browser.
 */
export interface OptimizerSettings {
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

/**
 * The settings as saved in the browser, which also include the levels, boosts and buffs of the optimizer's player.
 */
type StoredOptimizerSettings = Partial<OptimizerSettings> & {
  skills?: Partial<PlayerSkills>;
  /** The potion boosts, plus the difference between the current and base HP. */
  boosts?: Partial<PlayerSkills>;
  /** The potions and the extra options (on slayer task etc.) */
  buffs?: Partial<Player['buffs']>;
};

const generateOptimizerSettings = (): OptimizerSettings => ({
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
});

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
  private readonly root: RootStore;

  /**
   * The levels, potions and extra options the search uses, separate from the loadouts. It's a PlayerStore so that the
   * upstream skill, potion and extra option components can edit it (see PlayerSettings).
   */
  readonly player: PlayerStore;

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

  constructor(root: RootStore) {
    this.root = root;
    this.player = new PlayerStore(root.monster, root.preferences, 'Gear optimizer');
    makeAutoObservable<OptimizerState, 'root' | 'player' | 'loaded'>(this, {
      root: false, player: false, loaded: false,
    }, { autoBind: true });
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
    load<StoredOptimizerSettings>(OPTIMIZER_SETTINGS_STORAGE_KEY, ({
      locked, wilderness, skills, boosts, buffs, ...settings
    }) => {
      this.player.update({ skills, buffs, boosts });
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

    reaction(() => this.storedSettings, (v) => save(OPTIMIZER_SETTINGS_STORAGE_KEY, v));
  }

  private get storedSettings(): StoredOptimizerSettings {
    const { skills, boosts, buffs } = this.player.snapshot;
    return {
      ...this.settings, skills, boosts, buffs,
    };
  }

  /** Changes the gear optimizer's settings. They (and the optimizer's player) are saved once load() has run. */
  updateSettings(update: Partial<OptimizerSettings>) {
    this.settings = { ...this.settings, ...update };
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
    const { skills, boosts, buffs } = this.player.snapshot;
    return {
      ...createEmptyPlayer(),
      skills,
      boosts,
      // wilderness weapons (Craw's bow etc.) only get their bonus in the Wilderness
      buffs: { ...buffs, inWilderness: buffs.inWilderness || this.settings.wilderness.enabled },
    };
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
    const { loadouts } = this.root;
    if (asNewLoadout && loadouts.canCreate) {
      loadouts.create({ select: true, cloneFrom: loadouts.selectedUuid });
    }
    const loadout = loadouts.currentLoadout;

    // Piety, Rigour and Augury are also defensive prayers, so clear both groups to avoid conflicts
    const prayers = loadout.prayers.filter((p) => !OFFENSIVE_PRAYERS.includes(p) && !DEFENSIVE_PRAYERS.includes(p));

    // Clear the equipment first, so that no properties (such as blowpipe darts) are kept from the old items
    loadout.update({ equipment: createEmptyPlayer().equipment });
    loadout.update({
      equipment: result.equipment,
      style: result.style,
      spell: result.spell,
      prayers: [...prayers, ...result.prayers],
      skills: base.skills,
      buffs: base.buffs,
    });
    // after the levels and potions, as the boosts include the current HP (which the potions don't set)
    loadout.update({ boosts: base.boosts });
  }
}

const optimizerStates = new WeakMap<RootStore, OptimizerState>();

/** The gear optimizer state that belongs to this root store. */
export const getOptimizerState = (root: RootStore): OptimizerState => {
  let state = optimizerStates.get(root);
  if (!state) {
    state = new OptimizerState(root);
    optimizerStates.set(root, state);
  }
  return state;
};

/** The gear optimizer state, for the store of the current context. */
export const useOptimizer = (): OptimizerState => getOptimizerState(useStore());
