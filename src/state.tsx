// noinspection FallThroughInSwitchStatementJS

import {
  autorun, IReactionDisposer, IReactionPublic, makeAutoObservable, reaction, toJS,
} from 'mobx';
import React, { createContext, useContext } from 'react';
import { PartialDeep } from 'type-fest';
import * as localforage from 'localforage';
import merge from 'lodash.mergewith';
import { toast } from 'react-toastify';
import {
  CalculatedLoadout,
  Calculator,
  IMPORT_VERSION,
  ImportableData,
  PlayerVsNPCCalculatedLoadout,
  Preferences,
  State,
  UI,
  UserIssue,
} from '@/types/State';
import {
  EquipmentPiece, Player, PlayerEquipment, PlayerSkills,
} from '@/types/Player';
import { Monster } from '@/types/Monster';
import { MonsterAttribute } from '@/enums/MonsterAttribute';
import {
  fetchPlayerSkills, fetchShortlinkData, getCombatStylesForCategory, getDefaultCombatStyle, isDefined, PotionMap,
} from '@/utils';
import { ComputeBasicRequest, ComputeReverseRequest, WorkerRequestType } from '@/worker/CalcWorkerTypes';
import { getMonsters, INITIAL_MONSTER_INPUTS } from '@/lib/Monsters';
import { availableEquipment, calculateEquipmentBonusesFromGear } from '@/lib/Equipment';
import { CalcWorker } from '@/worker/CalcWorker';
import { spellByName } from '@/types/Spell';
import {
  DEFAULT_ATTACK_SPEED,
  INFINITE_HEALTH_MONSTERS,
  NUMBER_OF_LOADOUTS,
} from '@/lib/constants';
import { EquipmentCategory } from './enums/EquipmentCategory';
import {
  DEFENSIVE_PRAYERS,
  OFFENSIVE_PRAYERS,
  Prayer,
  prayersConflict,
} from './enums/Prayer';
import Potion from './enums/Potion';
import { BankItem } from './lib/BankImport';
import {
  OPTIMIZER_STYLES, OptimizedLoadout, OptimizerStyle, toggleSearchPrayer, TrainingSkill,
} from './lib/GearOptimizer';

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

const EMPTY_CALC_LOADOUT = {} as CalculatedLoadout;

const generateInitialEquipment = () => {
  const initialEquipment: PlayerEquipment = {
    ammo: null,
    body: null,
    cape: null,
    feet: null,
    hands: null,
    head: null,
    legs: null,
    neck: null,
    ring: null,
    shield: null,
    weapon: null,
  };
  return initialEquipment;
};

export const generateEmptyPlayer = (name?: string): Player => ({
  name: name ?? 'Loadout 1',
  style: getDefaultCombatStyle(EquipmentCategory.NONE),
  skills: {
    atk: 99,
    def: 99,
    hp: 99,
    magic: 99,
    prayer: 99,
    ranged: 99,
    str: 99,
    mining: 99,
    herblore: 99,
    farming: 99,
  },
  boosts: {
    atk: 0,
    def: 0,
    hp: 0,
    magic: 0,
    prayer: 0,
    ranged: 0,
    str: 0,
    mining: 0,
    herblore: 0,
    farming: 0,
  },
  equipment: generateInitialEquipment(),
  attackSpeed: DEFAULT_ATTACK_SPEED,
  prayers: [],
  bonuses: {
    str: 0,
    ranged_str: 0,
    magic_str: 0,
    prayer: 0,
  },
  defensive: {
    stab: 0,
    slash: 0,
    crush: 0,
    magic: 0,
    ranged: 0,
  },
  offensive: {
    stab: 0,
    slash: 0,
    crush: 0,
    magic: 0,
    ranged: 0,
  },
  buffs: {
    potions: [],
    onSlayerTask: true,
    inWilderness: false,
    kandarinDiary: true,
    chargeSpell: false,
    markOfDarknessSpell: false,
    forinthrySurge: false,
    soulreaperStacks: 5,
    baAttackerLevel: 0,
    chinchompaDistance: 4, // 4 tiles is the optimal range for "medium fuse" (rapid), which is the default selected stance
    usingSunfireRunes: false,
    fragmentOfWind: false,
    fragmentOfWater: false,
    fragmentOfEarth: false,
    fragmentOfFire: false,
  },
  spell: null,
});

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
        // If this skill's boost is higher than what it already is, then change it
        boosts[k as keyof typeof boosts] = r;
      }
    }
  }

  return boosts;
};

/**
 * The inputs of the gear optimizer ("Find Best Gear"). These are separate from the loadouts, which are for comparing
 * gear sets, and are saved in the browser.
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
  };
};

/**
 * Reloads the most current data for a stored item using its ID, to ensure we're not using stale data. Returns null if
 * the item seems to no longer exist.
 */
const refreshEquipmentPiece = (v: PartialDeep<EquipmentPiece>): EquipmentPiece | null => {
  let item: EquipmentPiece | undefined;
  if (Object.hasOwn(v, 'id')) {
    item = availableEquipment.find((eq) => eq.id === v.id);
    if (item) {
      // include the hidden itemVars inputs that are not present on the availableEquipment store
      if (Object.hasOwn(v, 'itemVars')) {
        item = { ...item, itemVars: v.itemVars as EquipmentPiece['itemVars'] };
      }
    } else {
      console.warn(`[refreshEquipmentPiece] No item found for item ID ${v.id}`);
    }
  }
  return item || null;
};

export const parseLoadoutsFromImportedData = (data: ImportableData) => data.loadouts.map((loadout, i) => {
  if (loadout.equipment) {
    for (const [k, v] of Object.entries(loadout.equipment)) {
      if (v === null) continue;
      // This will remove the item entirely if it seems to no longer exist.
      loadout.equipment[k as keyof typeof loadout.equipment] = refreshEquipmentPiece(v);
    }
  }

  // load the current spell, if applicable
  if (loadout.spell?.name) {
    loadout.spell = spellByName(loadout.spell.name);
  }

  return { name: `Loadout ${i + 1}`, ...loadout };
});

class GlobalState implements State {
  serializationVersion = IMPORT_VERSION;

  monster: Monster = {
    id: 415,
    name: 'Abyssal demon',
    version: 'Standard',
    image: 'Abyssal demon.png',
    size: 1,
    speed: 4,
    style: 'stab',
    skills: {
      atk: 97,
      def: 135,
      hp: 150,
      magic: 1,
      ranged: 1,
      str: 67,
    },
    offensive: {
      atk: 0,
      magic: 0,
      magic_str: 0,
      ranged: 0,
      ranged_str: 0,
      str: 0,
    },
    defensive: {
      flat_armour: 0,
      stab: 20,
      slash: 20,
      crush: 20,
      magic: 0,
      light: 20,
      standard: 20,
      heavy: 20,
    },
    attributes: [MonsterAttribute.DEMON],
    weakness: null,
    immunities: {
      burn: null,
    },
    is_slayer_monster: true,
    inputs: { ...INITIAL_MONSTER_INPUTS },
  };

  loadouts: Player[] = [
    generateEmptyPlayer(),
  ];

  selectedLoadout = 0;

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
  optimizerSettings: OptimizerSettings = generateOptimizerSettings();

  ui: UI = {
    showPreferencesModal: false,
    showShareModal: false,
    username: '',
    isDefensiveReductionsExpanded: false,
  };

  prefs: Preferences = {
    manualMode: false,
    rememberUsername: true,
    showHitDistribution: false,
    showLoadoutComparison: false,
    showTtkComparison: false,
    showNPCVersusPlayerResults: false,
    hitDistsHideZeros: false,
    hitDistShowSpec: false,
    resultsExpanded: false,
  };

  calc: Calculator = {
    loadouts: [
      {
        npcDefRoll: 0,
        maxHit: 0,
        maxAttackRoll: 0,
        npcMaxHit: 0,
        npcMaxAttackRoll: 0,
        npcDps: 0,
        npcAccuracy: 0,
        playerDefRoll: 0,
        accuracy: 0,
        dps: 0,
        ttk: 0,
        hitDist: [],
        ttkDist: undefined,
      },
    ],
  };

  private calcWorker!: CalcWorker;

  availableMonsters = getMonsters();

  private _debug: boolean = false;

  private storageUpdater?: IReactionDisposer;

  constructor() {
    makeAutoObservable(this, {}, { autoBind: true });

    const recomputeBoosts = () => {
      // Re-compute the player's boost values.
      this.updatePlayer({ boosts: calculatePotionBoosts(this.player.skills, this.player.buffs.potions) });
    };

    const potionTriggers: ((r: IReactionPublic) => unknown)[] = [
      () => toJS(this.player.skills),
      () => toJS(this.player.buffs.potions),
    ];
    potionTriggers.map((t) => reaction(t, recomputeBoosts, { fireImmediately: false }));

    // for toa monster + shadow handling
    const equipmentTriggers: ((r: IReactionPublic) => unknown)[] = [
      () => toJS(this.monster),
    ];
    equipmentTriggers.map((t) => reaction(t, () => {
      if (!this.prefs.manualMode) {
        this.recalculateEquipmentBonusesFromGearAll();
      }
    }));
  }

  set debug(debug: boolean) {
    this._debug = debug;
  }

  get debug(): boolean {
    return this._debug;
  }

  /**
   * Get the importable version of the current UI state
   */
  get asImportableData(): ImportableData {
    return {
      serializationVersion: IMPORT_VERSION,
      loadouts: toJS(this.loadouts),
      monster: toJS(this.monster),
      selectedLoadout: this.selectedLoadout,
    };
  }

  /**
   * Get the currently selected player (loadout)
   */
  get player() {
    return this.loadouts[this.selectedLoadout];
  }

  /**
   * Returns the data for the currently equipped items
   */
  get equipmentData() {
    return this.player.equipment;
  }

  /**
   * Get the user's current issues based on their calculated loadouts
   */
  get userIssues() {
    let is: UserIssue[] = [];

    // Determine the current global/UI-related issues
    // ex. is.push({ type: UserIssueType.MONSTER_UNIQUE_EFFECTS, message: 'This monster has unique effects that are not yet accounted for. Results may be inaccurate.' });
    // Add in the issues returned from the calculator
    for (const l of Object.values(this.calc.loadouts)) {
      if (l.userIssues) is = [...is, ...l.userIssues];
    }
    return is;
  }

  /**
   * Get the available combat styles for the currently equipped weapon
   * @see https://oldschool.runescape.wiki/w/Combat_Options
   */
  get availableCombatStyles() {
    const cat = this.player.equipment.weapon?.category || EquipmentCategory.NONE;
    return getCombatStylesForCategory(cat);
  }

  /**
   * Whether the currently selected monster has non-standard mechanics or behaviour.
   * In this case, we should hide UI elements relating to reverse DPS/damage taken metrics.
   */
  get isNonStandardMonster() {
    return !['slash', 'crush', 'stab', 'magic', 'ranged'].includes(this.monster.style || '');
  }

  /**
   * Initialises the autorun function for updating dps-calc-state when something changes.
   * This should only ever be called once.
   */
  startStorageUpdater() {
    if (this.storageUpdater) {
      console.warn('[GlobalState] StorageUpdater is already set!');
      return;
    }
    this.storageUpdater = autorun(() => {
      // Save their application state to browser storage
      localforage.setItem('dps-calc-state', toJS(this.asImportableData)).catch(() => {
      });
    });
  }

  setCalcWorker(worker: CalcWorker) {
    if (this.calcWorker) {
      console.warn('[GlobalState] CalcWorker is already set!');
      this.calcWorker.shutdown();
    }
    worker.initWorker();
    this.calcWorker = worker;
  }

  updateEquipmentBonuses(loadoutIx?: number) {
    loadoutIx = loadoutIx !== undefined ? loadoutIx : this.selectedLoadout;

    this.loadouts[loadoutIx] = merge(
      this.loadouts[loadoutIx],
      calculateEquipmentBonusesFromGear(this.loadouts[loadoutIx], this.monster),
    );
  }

  recalculateEquipmentBonusesFromGearAll() {
    this.loadouts.forEach((_, i) => this.updateEquipmentBonuses(i));
  }

  updateUIState(ui: PartialDeep<UI>) {
    this.ui = Object.assign(this.ui, ui);
  }

  updateCalcResults(calc: PartialDeep<Calculator>) {
    this.calc = merge(this.calc, calc);
  }

  updateCalcTtkDist(loadoutIx: number, ttkDist: PlayerVsNPCCalculatedLoadout['ttkDist']) {
    this.calc.loadouts[loadoutIx].ttkDist = ttkDist;
  }

  async loadShortlink(linkId: string) {
    let data: ImportableData;

    await toast.promise(async () => {
      data = await fetchShortlinkData(linkId);

      /**
       * For future reference: if we ever change the schema of the loadouts or the monster object,
       * then some of the JSON data we store for shortlinks will be incorrect. We can handle those instances here, as
       * a sort of "on-demand migration".
       *
       * Also: the reason we're merging the objects below is that we're trying our hardest not to cause the app to
       * error if the JSON data is bad. To achieve that, we do a deep merge of the loadouts and monster objects so that
       * the existing data still remains.
       */

      this.updateImportedData(data);
    }, {
      pending: 'Loading data from shared link...',
      success: 'Loaded data from shared link!',
      error: 'Failed to load shared link data. Please try again.',
    }, {
      toastId: 'shortlink',
    });
  }

  updateImportedData(data: ImportableData) {
    /* eslint-disable no-fallthrough */
    /* eslint-disable @typescript-eslint/dot-notation */
    /* eslint-disable @typescript-eslint/no-explicit-any */
    switch (data.serializationVersion) {
      case 1:
        data.monster.inputs.phase = data.monster.inputs.tormentedDemonPhase;

      case 2: // reserved: used during leagues 5
      case 3: // reserved: used during leagues 5
      case 4: // reserved: used during leagues 5
      case 5:
        data.loadouts.forEach((l) => {
          if ((l as any)['leagues']) {
            delete (l as any)['leagues'];
          }
        });

      case 6:
        // partyAvgMiningLevel becomes partySumMiningLevel
        if (isDefined(data.monster.inputs.partyAvgMiningLevel)) {
          data.monster.inputs.partySumMiningLevel = data.monster.inputs.partyAvgMiningLevel * data.monster.inputs.partySize;
          delete data.monster.inputs.partyAvgMiningLevel;
        }

      case 7:
        if (!isDefined(data.monster.immunities)) {
          data.monster.immunities = {
            burn: null,
          };
        }

      case 8: // reserved: used during leagues 6

      case 9: // reserved: used during leagues 6

      case 10:
        data.loadouts.forEach((l) => {
          // leagues had prayers beyond 20, and now we need to reuse the ids
          l.prayers = l.prayers?.filter((p) => p <= 20);
        });

      default:
    }
    /* eslint-enable */
    console.debug('IMPORT | ', data);

    if (data.monster) {
      let newMonster: PartialDeep<Monster> = {};

      if (data.monster.id > -1) {
        const monstersById = getMonsters().filter((m) => m.id === data.monster.id);
        if ((monstersById?.length || 0) === 0) {
          throw new Error(`Failed to find monster by id '${data.monster.id}' from shortlink`);
        }

        if (monstersById.length === 1) {
          newMonster = monstersById[0];
        } else {
          const version = monstersById.find((m) => m.version === data.monster.version);
          if (version) {
            newMonster = version;
          } else {
            newMonster = monstersById[0];
          }
        }
      } else {
        newMonster = data.monster;
      }

      // If the passed monster def reductions are different to the defaults, expand the UI section.
      for (const [k, v] of Object.entries(data.monster.inputs?.defenceReductions)) {
        if (v !== undefined && v !== INITIAL_MONSTER_INPUTS.defenceReductions[k as keyof typeof INITIAL_MONSTER_INPUTS.defenceReductions]) {
          this.updateUIState({ isDefensiveReductionsExpanded: true });
          break;
        }
      }

      // only use the shortlink for user-input fields, trust cdn for others in case they change
      this.updateMonster({
        ...newMonster,
        inputs: data.monster.inputs,
      });
    }

    // Expand some minified fields with their full metadata
    const loadouts = parseLoadoutsFromImportedData(data);

    // manually recompute equipment in case their metadata has changed since the shortlink was created
    loadouts.forEach((p, ix) => {
      if (this.loadouts[ix] === undefined) this.loadouts.push(generateEmptyPlayer());
      this.updatePlayer(p, ix);
    });
    this.recalculateEquipmentBonusesFromGearAll();

    this.selectedLoadout = data.selectedLoadout || 0;
  }

  loadPreferences() {
    localforage.getItem('dps-calc-prefs').then((v) => {
      this.updatePreferences(v as PartialDeep<Preferences>);
    }).catch((e) => {
      console.error(e);
      // TODO maybe some handling here
    });
  }

  loadBank() {
    localforage.getItem(BANK_STORAGE_KEY).then((v) => {
      if (v) this.bank = v as BankData;
    }).catch((e) => {
      console.error(e);
    });
    localforage.getItem(EXCLUDED_ITEMS_STORAGE_KEY).then((v) => {
      if (Array.isArray(v)) this.excludedItemIds = v as number[];
    }).catch((e) => {
      console.error(e);
    });
    localforage.getItem(EXCLUDED_SPELLS_STORAGE_KEY).then((v) => {
      if (Array.isArray(v)) this.excludedSpells = v as string[];
    }).catch((e) => {
      console.error(e);
    });
    localforage.getItem(IGNORED_AMMO_STORAGE_KEY).then((v) => {
      if (Array.isArray(v)) this.ignoredAmmo = v as string[];
    }).catch((e) => {
      console.error(e);
    });
    localforage.getItem(OPTIMIZER_SETTINGS_STORAGE_KEY).then((v) => {
      if (!v) return;
      const { locked, ...settings } = v as OptimizerSettingsUpdate;
      // reload the locked items' data, and drop the locks of items that no longer exist
      const refreshedLocks: Partial<PlayerEquipment> = {};
      for (const [slot, item] of Object.entries(locked || {})) {
        const refreshed = item && refreshEquipmentPiece(item);
        if (!item || refreshed) refreshedLocks[slot as keyof PlayerEquipment] = refreshed;
      }
      // start from the defaults, so that settings added since they were saved get their default value
      this.optimizerSettings = generateOptimizerSettings();
      this.updateOptimizerSettings({ ...settings, locked: refreshedLocks });
    }).catch((e) => {
      console.error(e);
    });
  }

  /**
   * Changes the gear optimizer's settings, and saves them. The potion boosts are recomputed if the levels or potions
   * change.
   */
  updateOptimizerSettings(update: OptimizerSettingsUpdate) {
    const current = this.optimizerSettings;
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
    this.optimizerSettings = next;

    localforage.setItem(OPTIMIZER_SETTINGS_STORAGE_KEY, toJS(this.optimizerSettings)).catch((e) => {
      console.error(e);
    });
  }

  toggleOptimizerPotion(potion: Potion) {
    const { potions } = this.optimizerSettings.buffs;
    this.updateOptimizerSettings({
      buffs: { potions: potions.includes(potion) ? potions.filter((p) => p !== potion) : [...potions, potion] },
    });
  }

  toggleOptimizerPrayer(prayer: Prayer) {
    this.updateOptimizerSettings({ prayers: toggleSearchPrayer(this.optimizerSettings.prayers, prayer) });
  }

  /**
   * Locks a slot of the gear optimizer to an item (or to being empty, if null), or unlocks it if undefined.
   */
  setOptimizerLock(slot: keyof PlayerEquipment, item: EquipmentPiece | null | undefined) {
    const locked = { ...this.optimizerSettings.locked };
    if (item === undefined) {
      delete locked[slot];
    } else {
      locked[slot] = item;
    }
    // a two-handed weapon can't be worn with a shield, so locking one unlocks the other
    if (slot === 'weapon' && item?.isTwoHanded && locked.shield) delete locked.shield;
    if (slot === 'shield' && item && locked.weapon?.isTwoHanded) delete locked.weapon;
    this.updateOptimizerSettings({ locked });
  }

  /**
   * The player that the gear optimizer searches with: the optimizer's levels, boosts and extra options, with no gear.
   */
  get optimizerBasePlayer(): Player {
    const { skills, boosts, buffs } = this.optimizerSettings;
    return {
      ...generateEmptyPlayer(),
      skills: toJS(skills),
      boosts: toJS(boosts),
      buffs: toJS(buffs),
    };
  }

  setIgnoredAmmo(names: string[]) {
    this.ignoredAmmo = [...new Set(names)];
    localforage.setItem(IGNORED_AMMO_STORAGE_KEY, toJS(this.ignoredAmmo)).catch((e) => {
      console.error(e);
    });
  }

  toggleIgnoredAmmo(name: string) {
    this.setIgnoredAmmo(this.ignoredAmmo.includes(name)
      ? this.ignoredAmmo.filter((n) => n !== name)
      : [...this.ignoredAmmo, name]);
  }

  setExcludedSpells(names: string[]) {
    this.excludedSpells = [...new Set(names)];
    localforage.setItem(EXCLUDED_SPELLS_STORAGE_KEY, toJS(this.excludedSpells)).catch((e) => {
      console.error(e);
    });
  }

  toggleExcludedSpell(name: string) {
    this.setExcludedSpells(this.excludedSpells.includes(name)
      ? this.excludedSpells.filter((s) => s !== name)
      : [...this.excludedSpells, name]);
  }

  setExcludedItemIds(ids: number[]) {
    this.excludedItemIds = [...new Set(ids)];
    localforage.setItem(EXCLUDED_ITEMS_STORAGE_KEY, toJS(this.excludedItemIds)).catch((e) => {
      console.error(e);
    });
  }

  toggleExcludedItem(id: number) {
    this.setExcludedItemIds(this.excludedItemIds.includes(id)
      ? this.excludedItemIds.filter((i) => i !== id)
      : [...this.excludedItemIds, id]);
  }

  setBank(items: BankItem[], fileName: string) {
    this.bank = { items, fileName, importedAt: Date.now() };
    localforage.setItem(BANK_STORAGE_KEY, toJS(this.bank)).catch((e) => {
      console.error(e);
    });
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
  applyOptimizedLoadout(result: OptimizedLoadout, asNewLoadout: boolean, base: Pick<Player, 'skills' | 'boosts' | 'buffs'>) {
    if (asNewLoadout && this.canCreateLoadout) {
      this.createLoadout(true, this.selectedLoadout);
    }

    // Clear everything first, so that no properties (such as blowpipe darts) are merged in from the old items
    this.updatePlayer({ equipment: generateInitialEquipment() });
    this.updatePlayer({
      equipment: result.equipment,
      style: result.style,
      spell: result.spell,
      skills: base.skills,
      buffs: base.buffs,
    });
    // the potions are replaced rather than merged by index, and the boosts include the current HP (which the potions
    // don't set)
    this.player.buffs.potions = [...base.buffs.potions];
    this.updatePlayer({ boosts: base.boosts });

    // Piety, Rigour and Augury are also defensive prayers, so clear both groups to avoid conflicts
    const prayers = this.player.prayers.filter((p) => !OFFENSIVE_PRAYERS.includes(p) && !DEFENSIVE_PRAYERS.includes(p));
    this.player.prayers = [...prayers, ...result.prayers];
  }

  /**
   * Looks up the levels of the entered username, for the current loadout or the gear optimizer.
   */
  async fetchCurrentPlayerSkills(target: 'loadout' | 'optimizer' = 'loadout') {
    const { username } = this.ui;

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

      if (res && target === 'optimizer') {
        this.updateOptimizerSettings({ skills: res });
      } else if (res) {
        this.updatePlayer({ skills: res });
      }
    } catch (e) {
      console.error(e);
    }
  }

  updatePreferences(pref: PartialDeep<Preferences>) {
    // Update local state store
    this.prefs = Object.assign(this.prefs, pref);

    if (pref && Object.prototype.hasOwnProperty.call(pref, 'manualMode')) {
      // Reset player bonuses to their worn equipment
      this.recalculateEquipmentBonusesFromGearAll();
    }

    // Save to browser storage
    localforage.setItem('dps-calc-prefs', toJS(this.prefs)).catch((e) => {
      console.error(e);
      // TODO something that isn't this
      // eslint-disable-next-line no-alert
      alert('Could not persist preferences to browser. Make sure our site has permission to do this.');
    });
  }

  /**
   * Toggle a potion, with logic to remove from or add to the potions array depending on if it is already in there.
   * @param potion
   */
  togglePlayerPotion(potion: Potion) {
    const isToggled = this.player.buffs.potions.includes(potion);
    if (isToggled) {
      this.player.buffs.potions = this.player.buffs.potions.filter((p) => p !== potion);
    } else {
      this.player.buffs.potions = [...this.player.buffs.potions, potion];
    }
  }

  /**
   * Toggle a prayer, with logic to remove from or add to the prayers array depending on if it is already in there.
   * @param prayer
   */
  togglePlayerPrayer(prayer: Prayer) {
    const isToggled = this.player.prayers.includes(prayer);
    if (isToggled) {
      // If we're toggling off an existing prayer, just filter it out from the array
      this.player.prayers = this.player.prayers.filter((p) => p !== prayer);
    } else {
      // If we're toggling on a new prayer, disable the prayers that cannot be enabled alongside it
      this.player.prayers = [...this.player.prayers.filter((p) => !prayersConflict(p, prayer)), prayer];
    }
  }

  /**
   * Toggle a monster attribute.
   * @param attr
   */
  toggleMonsterAttribute(attr: MonsterAttribute) {
    const isToggled = this.monster.attributes.includes(attr);
    if (isToggled) {
      this.monster.attributes = this.monster.attributes.filter((a) => a !== attr);
    } else {
      this.monster.attributes = [...this.monster.attributes, attr];
    }
  }

  /**
   * Update the player state.
   * @param player
   * @param loadoutIx Which loadout to update. Defaults to the current selected loadout.
   */
  updatePlayer(player: PartialDeep<Player>, loadoutIx?: number) {
    loadoutIx = loadoutIx !== undefined ? loadoutIx : this.selectedLoadout;

    const currentShield = this.loadouts[loadoutIx].equipment.shield;
    const newShield = player.equipment?.shield;

    const currentWeapon = this.loadouts[loadoutIx].equipment.weapon;

    // Special handling for if a shield is equipped, and we're using a two-handed weapon
    if (player.equipment?.shield && newShield !== undefined && currentWeapon?.isTwoHanded) {
      player = { ...player, equipment: { ...player.equipment, weapon: null } };
    }
    // ...and vice-versa
    if (player.equipment?.weapon && player.equipment?.weapon.isTwoHanded && currentShield?.name !== '') {
      player = { ...player, equipment: { ...player.equipment, shield: null } };
    }

    const eq = player.equipment;
    if (eq && (Object.hasOwn(eq, 'weapon') || Object.hasOwn(eq, 'shield'))) {
      const newWeapon = player.equipment?.weapon;

      if (newWeapon !== undefined) {
        const oldWeaponCat = currentWeapon?.category || EquipmentCategory.NONE;
        const newWeaponCat = newWeapon?.category || EquipmentCategory.NONE;
        if ((newWeaponCat !== undefined) && (newWeaponCat !== oldWeaponCat) && !player.style) {
          player.style = getDefaultCombatStyle(newWeaponCat);
        }
      }
    }

    this.loadouts[loadoutIx] = merge(this.loadouts[loadoutIx], player);
    if (!this.prefs.manualMode) {
      this.updateEquipmentBonuses(loadoutIx);
    }
  }

  /**
   * Update the monster state.
   * @param monster
   */
  updateMonster(monster: PartialDeep<Monster>) {
    // If monster attributes were passed to this function, clear the existing ones
    if (monster.attributes !== undefined) this.monster.attributes = [];

    // If the monster ID was changed, reset all the inputs.
    if (
      monster.id !== undefined
      && monster.id !== this.monster.id
      && !Object.hasOwn(monster, 'inputs')
    ) {
      monster = {
        ...monster,
        inputs: INITIAL_MONSTER_INPUTS,
      };
    }

    this.monster = merge(this.monster, monster, (obj, src) => {
      // This check is to ensure that empty arrays always override existing arrays, even if they have values.
      if (Array.isArray(src) && src.length === 0) {
        return src;
      }
      return undefined;
    });
  }

  /**
   * Clear an equipment slot, removing the item that was inside of it.
   * @param slot
   */
  clearEquipmentSlot(slot: keyof PlayerEquipment) {
    this.updatePlayer({
      equipment: {
        [slot]: null,
      },
    });
  }

  setSelectedLoadout(ix: number) {
    this.selectedLoadout = ix;
  }

  deleteLoadout(ix: number) {
    if (this.loadouts.length === 1) {
      // If there is only one loadout, clear it instead of deleting it
      this.loadouts[0] = generateEmptyPlayer();
      return;
    }

    this.loadouts = this.loadouts.filter((p, i) => i !== ix);
    // If the selected loadout index is equal to or over the index we just remove, shift it down by one, else add one
    if ((this.selectedLoadout >= ix) && ix !== 0) {
      this.selectedLoadout -= 1;
    }
  }

  renameLoadout(ix: number, name: string) {
    const loadout = this.loadouts[ix];

    const trimmedName = name.trim();
    if (loadout) {
      if (trimmedName) {
        loadout.name = trimmedName;
      } else {
        loadout.name = `Loadout ${ix + 1}`;
      }
    }
  }

  get canCreateLoadout() {
    return this.loadouts.length < NUMBER_OF_LOADOUTS;
  }

  createLoadout(selected?: boolean, cloneIndex?: number) {
    // Do not allow creating a loadout if we're over the limit
    if (!this.canCreateLoadout) return;

    const newLoadout = (cloneIndex !== undefined) ? toJS(this.loadouts[cloneIndex]) : generateEmptyPlayer();
    newLoadout.name = `Loadout ${this.loadouts.length + 1}`;

    this.loadouts.push(newLoadout);
    if (selected) this.selectedLoadout = (this.loadouts.length - 1);
  }

  async doWorkerRecompute() {
    if (!this.calcWorker?.isReady()) {
      console.debug('[GlobalState] doWorkerRecompute called but worker is not ready, ignoring for now.');
      return;
    }

    // clear existing loadout data
    const calculatedLoadouts: CalculatedLoadout[] = [];
    this.loadouts.forEach(() => calculatedLoadouts.push(EMPTY_CALC_LOADOUT));
    this.calc.loadouts = calculatedLoadouts;

    const data: Extract<ComputeBasicRequest['data'], ComputeReverseRequest['data']> = {
      loadouts: toJS(this.loadouts),
      monster: toJS(this.monster),
      calcOpts: {
        hitDistHideMisses: this.prefs.hitDistsHideZeros,
        detailedOutput: this.debug,
        disableMonsterScaling: this.monster.id === -1,
      },
    };
    const request = async (type: WorkerRequestType.COMPUTE_BASIC | WorkerRequestType.COMPUTE_REVERSE) => {
      const resp = await this.calcWorker.do({
        type,
        data,
      });

      console.log(`[GlobalState] Calc response ${WorkerRequestType[type]}`, resp.payload);
      this.updateCalcResults({ loadouts: resp.payload });
    };

    const promises: Promise<void>[] = [];
    promises.push(
      request(WorkerRequestType.COMPUTE_BASIC),
      request(WorkerRequestType.COMPUTE_REVERSE),
    );

    if (this.prefs.showTtkComparison && !INFINITE_HEALTH_MONSTERS.includes(this.monster.id)) {
      promises.push(
        (async (): Promise<void> => {
          const parallel = process.env.NEXT_PUBLIC_SERIAL_TTK !== 'true';
          const resp = await this.calcWorker.do({
            type: parallel ? WorkerRequestType.COMPUTE_TTK_PARALLEL : WorkerRequestType.COMPUTE_TTK,
            data,
          });

          for (const [ix, loadout] of resp.payload.entries()) {
            this.updateCalcTtkDist(ix, loadout.ttkDist);
          }
        })(),
      );
    }

    await Promise.all(promises);
  }
}

const StoreContext = createContext<GlobalState>(new GlobalState());

const StoreProvider: React.FC<{ store: GlobalState, children: React.ReactNode }> = ({ store, children }) => (
  <StoreContext.Provider value={store}>{children}</StoreContext.Provider>
);

const useStore = () => useContext(StoreContext);

export { GlobalState, StoreProvider, useStore };
