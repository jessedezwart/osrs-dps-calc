/**
 * Links that open the calculator with a gear setup loaded, e.g. one found by the optimizer server:
 * `<calc url>?setup=<base64url JSON>`. The JSON holds only IDs and plain values, so it stays short, and the calculator
 * resolves the items, spell and monster itself (see applySetupLink.ts).
 */
import { PartialDeep } from 'type-fest';
import {
  EquipmentPiece, Player, PlayerEquipment, PlayerSkills,
} from '@/types/Player';
import { PlayerCombatStyle } from '@/types/PlayerCombatStyle';
import { Monster } from '@/types/Monster';
import { Spell } from '@/types/Spell';
import { Prayer } from '@/enums/Prayer';

/** The URL parameter that holds the setup. */
export const SETUP_PARAM = 'setup';

export interface SetupLinkItem {
  id: number;
  itemVars?: EquipmentPiece['itemVars'];
}

export interface SetupLink {
  v: 1;
  monster: {
    id: number;
    /** Only the inputs that differ from the defaults. */
    inputs?: PartialDeep<Monster['inputs']>;
  };
  equipment: Partial<Record<keyof PlayerEquipment, SetupLinkItem | null>>;
  style: PlayerCombatStyle;
  spell: string | null;
  prayers: Prayer[];
  skills: PlayerSkills;
  boosts: PlayerSkills;
  buffs: Player['buffs'];
}

export interface SetupLinkSource {
  monsterId: number;
  monsterInputs?: PartialDeep<Monster['inputs']>;
  equipment: PlayerEquipment;
  style: PlayerCombatStyle;
  spell: Spell | null;
  prayers: Prayer[];
  player: Pick<Player, 'skills' | 'boosts' | 'buffs'>;
}

export const createSetupLink = (s: SetupLinkSource): SetupLink => ({
  v: 1,
  monster: { id: s.monsterId, ...(s.monsterInputs && Object.keys(s.monsterInputs).length ? { inputs: s.monsterInputs } : {}) },
  equipment: Object.fromEntries(Object.entries(s.equipment)
    .filter(([, i]) => i)
    .map(([slot, i]) => {
      const piece = i as EquipmentPiece;
      return [slot, piece.itemVars ? { id: piece.id, itemVars: piece.itemVars } : { id: piece.id }];
    })),
  style: s.style,
  spell: s.spell?.name ?? null,
  prayers: s.prayers,
  skills: s.player.skills,
  boosts: s.player.boosts,
  buffs: s.player.buffs,
});

export const encodeSetupLink = (setup: SetupLink): string => {
  // escape non-ASCII characters, so that btoa can encode the JSON
  const json = JSON.stringify(setup).replace(/[\u0080-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  return btoa(json).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

export const decodeSetupLink = (encoded: string): SetupLink => {
  const setup = JSON.parse(atob(encoded.replace(/-/g, '+').replace(/_/g, '/')));
  if (setup?.v !== 1 || typeof setup.monster?.id !== 'number' || typeof setup.equipment !== 'object') {
    throw new Error('Not a valid setup link');
  }
  return setup as SetupLink;
};

/** The calculator URL (ending in `/`, e.g. `http://localhost:3124/osrs-dps/`) with the setup in it. */
export const setupLinkUrl = (calcUrl: string, setup: SetupLink): string => {
  const url = new URL(calcUrl);
  url.searchParams.set(SETUP_PARAM, encodeSetupLink(setup));
  return url.toString();
};
