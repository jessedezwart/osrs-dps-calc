/**
 * Reads the player's account from the files of the OSRS Data Sync RuneLite plugin (progress.json and containers.json),
 * for the optimizer server. Only these two files are read, and never written.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PlayerSkills } from '@/types/Player';

export const DEFAULT_SYNC_DIR = path.join(os.homedir(), '.runelite', 'plugin-data', 'osrsdatasync');

/** [itemId, quantity, ...] */
type ItemRow = number[];

interface ContainersFile {
  updated?: string;
  bank?: ItemRow[];
  bankAt?: number;
  inventory?: ItemRow[];
  equipment?: ItemRow[];
  storage?: Record<string, { name?: string, items?: ItemRow[] }>;
}

interface ProgressFile {
  updated?: string;
  player?: string;
  skills?: Record<string, [number, number]>;
  quests?: Record<string, number>;
  diaries?: Record<string, Record<string, boolean>>;
}

export interface AccountData {
  player: string | null;
  dir: string;
  skills: PlayerSkills | null;
  /** The IDs of every item in the bank, worn, in the inventory or in storage (non-equipment is filtered out later). */
  itemIds: number[];
  quests: Record<string, number>;
  diaries: Record<string, Record<string, boolean>>;
  /** When each file was last exported. */
  updated: { progress: string | null, containers: string | null, bank: string | null };
  warnings: string[];
}

const SKILL_NAMES: Record<keyof PlayerSkills, string> = {
  atk: 'Attack',
  def: 'Defence',
  hp: 'Hitpoints',
  magic: 'Magic',
  prayer: 'Prayer',
  ranged: 'Ranged',
  str: 'Strength',
  mining: 'Mining',
  herblore: 'Herblore',
  farming: 'Farming',
};

const readJson = <T>(file: string): T | null => {
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
};

/**
 * Finds the player's folder in the sync directory: the one named after the player (spaces as underscores, any case),
 * or the only folder if there is just one.
 */
export const findAccountDir = (syncDir: string, player?: string): string => {
  if (!fs.existsSync(syncDir)) throw new Error(`The sync folder ${syncDir} doesn't exist`);
  const dirs = fs.readdirSync(syncDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  if (player) {
    const wanted = player.toLowerCase().replace(/[\s_-]+/g, '_');
    const match = dirs.find((d) => d.toLowerCase().replace(/[\s_-]+/g, '_') === wanted);
    if (match) return path.join(syncDir, match);
    throw new Error(`No folder for ${player} in ${syncDir} (found: ${dirs.join(', ') || 'none'})`);
  }
  if (dirs.length === 1) return path.join(syncDir, dirs[0]);
  throw new Error(`Found ${dirs.length} accounts in ${syncDir}, pass "player" to pick one (found: ${dirs.join(', ')})`);
};

export const readAccount = (syncDir: string, player?: string): AccountData => {
  const dir = findAccountDir(syncDir, player);
  const progress = readJson<ProgressFile>(path.join(dir, 'progress.json'));
  const containers = readJson<ContainersFile>(path.join(dir, 'containers.json'));
  const warnings: string[] = [];

  let skills: PlayerSkills | null = null;
  if (progress?.skills) {
    skills = {} as PlayerSkills;
    for (const [key, name] of Object.entries(SKILL_NAMES) as [keyof PlayerSkills, string][]) {
      skills[key] = progress.skills[name]?.[0] ?? 1;
    }
  } else {
    warnings.push('progress.json is missing, so the levels must be given in the request');
  }

  const ids = new Set<number>();
  const addRows = (rows?: ItemRow[]) => rows?.forEach(([id]) => { if (id > 0) ids.add(id); });
  if (containers) {
    addRows(containers.bank);
    addRows(containers.inventory);
    addRows(containers.equipment);
    for (const s of Object.values(containers.storage || {})) addRows(s.items);
  } else {
    warnings.push('containers.json is missing, so the items must be given in the request');
  }

  const day = 24 * 60 * 60 * 1000;
  const old = (iso: string | null | undefined) => !!iso && Date.now() - Date.parse(iso) > day;
  if (old(progress?.updated)) warnings.push(`progress.json is more than a day old (${progress?.updated})`);
  if (old(containers?.updated)) warnings.push(`containers.json is more than a day old (${containers?.updated})`);
  const bankAt = containers?.bankAt ? new Date(containers.bankAt).toISOString() : null;
  if (old(bankAt)) warnings.push(`The bank was last opened more than a day ago (${bankAt})`);

  return {
    player: progress?.player ?? null,
    dir,
    skills,
    itemIds: [...ids],
    quests: progress?.quests ?? {},
    diaries: progress?.diaries ?? {},
    updated: { progress: progress?.updated ?? null, containers: containers?.updated ?? null, bank: bankAt },
    warnings,
  };
};
