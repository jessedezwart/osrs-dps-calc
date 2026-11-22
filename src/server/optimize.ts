/**
 * Turns an optimizer server request into the gear optimizer's inputs, runs it, and turns the result into plain JSON.
 */
import { PartialDeep } from 'type-fest';
import merge from 'lodash.mergewith';
import {
  EquipmentPiece, Player, PlayerEquipment, PlayerSkills,
} from '@/types/Player';
import { Monster } from '@/types/Monster';
import { Prayer, PrayerMap } from '@/enums/Prayer';
import Potion from '@/enums/Potion';
import { PotionMap } from '@/utils';
import { createEmptyPlayer } from '@/state/PlayerStore';
import { createMonsterInputs, getMonsters } from '@/lib/Monsters';
import { scaleMonster } from '@/lib/MonsterScaling';
import { availableEquipment } from '@/lib/Equipment';
import { resolveEquipment, resolveOwnedEquipment } from '@/lib/BankImport';
import {
  OPTIMIZER_STYLES, OptimizedLoadout, OptimizerOpts, OptimizerStyle, TrainingSkill,
} from '@/lib/optimizer';
import { createSetupLink, setupLinkUrl } from '@/lib/SetupLink';
import { AccountData } from './accountData';

/** Where the calculator is served, for the `calcUrl` links (by default this server, see optimizerServer.ts). */
export const CALC_URL = process.env.CALC_URL || `http://localhost:${process.env.PORT || 3124}/osrs-dps/`;

export interface OptimizeRequest {
  /** The monster's name (case-insensitive), or its ID. */
  monster: string | number;
  /** The monster's version, e.g. "Wilderness" (the first one is used if not given). */
  version?: string;
  /** Overrides for the monster's inputs, e.g. { toaInvocationLevel: 300 } or { phase: "..." }. */
  monsterInputs?: PartialDeep<Monster['inputs']>;
  onSlayerTask?: boolean;
  /** Prayer names (e.g. "piety", "rigour", "eagle_eye"). Defaults to the best ones the account has unlocked. */
  prayers?: string[];
  /** Potion names (e.g. "super_combat", "ranging", "saturated_heart"). Defaults to none. */
  potions?: string[];
  /** Overrides the levels from progress.json. */
  skills?: Partial<PlayerSkills>;
  /** Overrides the boosts that the potions give, per skill. */
  boosts?: Partial<PlayerSkills>;
  /** Other buffs of the calculator, e.g. { inWilderness: true, chargeSpell: true }. */
  buffs?: PartialDeep<Player['buffs']>;
  /** Item IDs or names to search instead of the synced items. */
  items?: (number | string)[];
  /** Item IDs or names to add to the synced items. */
  extraItems?: (number | string)[];
  /** Item IDs or names that should never be used. */
  excludeItems?: (number | string)[];
  /** Slots fixed to an item ID or name (or to empty, with null). */
  locked?: Partial<Record<keyof PlayerEquipment, number | string | null>>;
  styles?: OptimizerStyle[];
  minWeight?: number;
  training?: TrainingSkill;
  /** The only spell to use with magic, e.g. "Fire Surge". */
  spell?: string;
  excludedSpells?: string[];
  /** Results per style (default 3). */
  results?: number;
}

export class RequestError extends Error {}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

// --- monsters

const allMonsters = getMonsters();

export const searchMonsters = (query: string) => {
  const q = query.toLowerCase();
  return allMonsters
    .filter((m) => m.name.toLowerCase().includes(q))
    .slice(0, 50)
    .map((m) => ({
      id: m.id, name: m.name, version: m.version || null, hp: m.skills.hp, slayer: m.is_slayer_monster,
    }));
};

const findMonster = (req: OptimizeRequest): Monster => {
  const candidates = typeof req.monster === 'number' || /^\d+$/.test(`${req.monster}`)
    ? allMonsters.filter((m) => m.id === Number(req.monster))
    : allMonsters.filter((m) => m.name.toLowerCase() === `${req.monster}`.toLowerCase());
  if (candidates.length === 0) {
    const query = `${req.monster}`;
    const matches = searchMonsters(query);
    const similar = (matches.length ? matches : searchMonsters(query.slice(0, 3))).slice(0, 10).map((m) => `${m.name}${m.version ? ` (${m.version})` : ''}`);
    throw new RequestError(`Unknown monster "${req.monster}".${similar.length ? ` Did you mean: ${similar.join('; ')}?` : ''}`);
  }
  let def = candidates[0];
  if (req.version) {
    const v = candidates.find((m) => (m.version || '').toLowerCase() === req.version!.toLowerCase());
    if (!v) {
      throw new RequestError(`"${req.monster}" has no version "${req.version}" (versions: ${candidates.map((m) => m.version || '(none)').join(', ')})`);
    }
    def = v;
  }

  const inputs = merge(createMonsterInputs(def.id), req.monsterInputs || {});
  const prescaling = (hp: number): Monster => ({ ...def, inputs: { ...inputs, monsterCurrentHp: hp } } as Monster);
  const maxHp = scaleMonster(prescaling(Number.POSITIVE_INFINITY)).skills.hp;
  return scaleMonster(prescaling(req.monsterInputs?.monsterCurrentHp ?? maxHp));
};

const monsterVersions = (m: Monster) => allMonsters.filter((o) => o.name === m.name).map((o) => o.version || '');

// --- items

const equipmentByName = new Map<string, EquipmentPiece>();
for (const e of availableEquipment) {
  if (!equipmentByName.has(norm(e.name))) equipmentByName.set(norm(e.name), e);
}

const resolveItem = (ref: number | string): EquipmentPiece => {
  const piece = typeof ref === 'number' || /^\d+$/.test(ref)
    ? resolveEquipment(Number(ref))
    : equipmentByName.get(norm(ref)) && resolveEquipment(equipmentByName.get(norm(ref))!.id);
  if (!piece) throw new RequestError(`Unknown or unequippable item "${ref}"`);
  return piece;
};

// --- prayers and potions

const PRAYER_BY_NAME = new Map<string, Prayer>();
for (const [k, v] of Object.entries(PrayerMap)) PRAYER_BY_NAME.set(norm(v.name), Number(k) as Prayer);

const POTION_BY_NAME = new Map<string, Potion>();
for (const [k, v] of Object.entries(PotionMap)) {
  POTION_BY_NAME.set(norm(v.name), Number(k) as Potion);
  POTION_BY_NAME.set(norm(Potion[Number(k)]), Number(k) as Potion);
}

const parsePrayer = (name: string) => {
  const p = PRAYER_BY_NAME.get(norm(name));
  if (p === undefined) throw new RequestError(`Unknown prayer "${name}" (known: ${Object.values(PrayerMap).map((v) => v.name).join(', ')})`);
  return p;
};

const parsePotion = (name: string) => {
  const p = POTION_BY_NAME.get(norm(name));
  if (p === undefined) throw new RequestError(`Unknown potion "${name}" (known: ${Object.values(PotionMap).map((v) => v.name).join(', ')})`);
  return p;
};

/**
 * The best offensive prayers that the account is known to have. Rigour, Augury, Deadeye and Mystic Vigour need a
 * scroll or other unlock that isn't in the synced data, so they are only used when asked for.
 */
const defaultPrayers = (skills: PlayerSkills, account: AccountData | null): Prayer[] => {
  const prayers: Prayer[] = [];
  const kingsRansom = account?.quests["King's Ransom"] === 2;
  if (skills.prayer >= 70 && skills.def >= 70 && kingsRansom) prayers.push(Prayer.PIETY);
  else if (skills.prayer >= 60 && skills.def >= 65 && kingsRansom) prayers.push(Prayer.CHIVALRY);
  else if (skills.prayer >= 31) prayers.push(Prayer.ULTIMATE_STRENGTH, Prayer.INCREDIBLE_REFLEXES);
  if (skills.prayer >= 44) prayers.push(Prayer.EAGLE_EYE);
  if (skills.prayer >= 45) prayers.push(Prayer.MYSTIC_MIGHT);
  return prayers;
};

// --- running

const POTION_SKILLS: (keyof PlayerSkills)[] = ['atk', 'def', 'magic', 'prayer', 'ranged', 'str', 'mining', 'herblore', 'farming'];

export interface PreparedRequest {
  owned: EquipmentPiece[];
  player: Player;
  monster: Monster;
  opts: OptimizerOpts;
  info: Record<string, unknown>;
}

export const prepare = (req: OptimizeRequest, account: AccountData | null): PreparedRequest => {
  if (req.monster === undefined || req.monster === null || req.monster === '') throw new RequestError('"monster" is required');
  const monster = findMonster(req);

  const baseSkills = account?.skills;
  if (!baseSkills && !req.skills) throw new RequestError('No synced levels found, so "skills" is required');
  const skills = { ...createEmptyPlayer().skills, ...baseSkills, ...req.skills } as PlayerSkills;

  const potions = (req.potions || []).map(parsePotion);
  const boosts = Object.fromEntries(POTION_SKILLS.map((s) => [s, 0])) as unknown as PlayerSkills;
  boosts.hp = 0;
  for (const potion of potions) {
    const result = PotionMap[potion].calculateFn(skills);
    for (const s of POTION_SKILLS) boosts[s] = Math.max(boosts[s], result[s] ?? 0);
  }
  Object.assign(boosts, req.boosts);

  const base = createEmptyPlayer();
  const player: Player = {
    ...base,
    skills,
    boosts,
    buffs: {
      ...base.buffs,
      kandarinDiary: !!account?.diaries.Kandarin?.Hard,
      ...req.buffs,
      potions,
      onSlayerTask: !!req.onSlayerTask,
    } as Player['buffs'],
  };

  let owned: EquipmentPiece[];
  if (req.items) {
    owned = req.items.map(resolveItem);
  } else {
    if (!account) throw new RequestError('No synced items found, so "items" is required');
    owned = resolveOwnedEquipment([], account.itemIds);
  }
  if (req.extraItems) owned.push(...req.extraItems.map(resolveItem));
  const excluded = new Set((req.excludeItems || []).map((r) => resolveItem(r).id));
  owned = [...new Map(owned.filter((i) => !excluded.has(i.id)).map((i) => [i.id, i])).values()];
  if (owned.length === 0) throw new RequestError('No equippable items to search');

  const locked: Partial<PlayerEquipment> = {};
  for (const [slot, ref] of Object.entries(req.locked || {})) {
    locked[slot as keyof PlayerEquipment] = ref === null ? null : resolveItem(ref);
  }

  for (const s of req.styles || []) {
    if (!OPTIMIZER_STYLES.includes(s)) throw new RequestError(`Unknown style "${s}" (use melee, ranged or magic)`);
  }

  const prayers = req.prayers ? req.prayers.map(parsePrayer) : defaultPrayers(skills, account);
  const opts: OptimizerOpts = {
    prayers,
    resultsPerStyle: Math.max(1, Math.min(req.results ?? 3, 10)),
    locked,
    styles: req.styles,
    minWeight: req.minWeight,
    training: req.training,
    spell: req.spell,
    excludedSpells: req.excludedSpells,
  };

  return {
    owned,
    player,
    monster,
    opts,
    info: {
      monster: {
        id: monster.id,
        name: monster.name,
        version: monster.version || null,
        hp: monster.skills.hp,
        otherVersions: monsterVersions(monster).filter((v) => v !== (monster.version || '')),
      },
      skills,
      boosts,
      prayers: prayers.map((p) => PrayerMap[p].name),
      potions: potions.map((p) => PotionMap[p].name),
      onSlayerTask: player.buffs.onSlayerTask,
      kandarinHardDiary: player.buffs.kandarinDiary,
      ownedEquipment: owned.length,
    },
  };
};

const itemLabel = (i: EquipmentPiece) => {
  const dart = i.itemVars?.blowpipeDartName ? ` (${i.itemVars.blowpipeDartName})` : '';
  return `${i.name}${i.version ? ` [${i.version}]` : ''}${dart}`;
};

export const describeLoadout = (l: OptimizedLoadout, prepared: PreparedRequest, req: OptimizeRequest) => ({
  dps: Number(l.dps.toFixed(3)),
  /** Seconds per kill, ignoring overkill and time between kills. */
  secondsPerKill: l.dps > 0 ? Number((prepared.monster.skills.hp / l.dps).toFixed(1)) : null,
  maxHit: l.maxHit,
  accuracy: Number((l.accuracy * 100).toFixed(1)),
  style: `${l.style.name} (${l.style.type}, ${l.style.stance})`,
  spell: l.spell?.name ?? null,
  prayers: l.prayers.map((p) => PrayerMap[p].name),
  weight: Number(l.weight.toFixed(1)),
  npcDps: Number(l.npcDps.toFixed(3)),
  avgDmgTakenPerKill: l.avgDmgTaken === undefined ? null : Number(l.avgDmgTaken.toFixed(1)),
  equipment: Object.fromEntries(Object.entries(l.equipment)
    .filter(([, i]) => i)
    .map(([slot, i]) => [slot, itemLabel(i as EquipmentPiece)])),
  equalDpsAlternatives: l.alternatives.map((a) => `${a.slot}: ${itemLabel(a.item)}`),
  /** Opens the calculator with this setup in a new loadout. */
  calcUrl: setupLinkUrl(CALC_URL, createSetupLink({
    monsterId: prepared.monster.id,
    monsterInputs: req.monsterInputs,
    equipment: l.equipment,
    style: l.style,
    spell: l.spell,
    prayers: l.prayers,
    player: prepared.player,
  })),
});
