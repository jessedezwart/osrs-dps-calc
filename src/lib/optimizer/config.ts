import { EquipmentPiece, PlayerEquipment } from '@/types/Player';
import { PlayerCombatStyle } from '@/types/PlayerCombatStyle';
import { EPSILON, SLOTS } from './constants';
import { Config, Score } from './types';

export const styleKey = (s: PlayerCombatStyle) => `${s.name}/${s.type}/${s.stance}`;

export const configKey = (c: Config) => {
  const eq = SLOTS.map((s) => {
    const p = c.equipment[s];
    if (!p) return '';
    return p.itemVars?.blowpipeDartId ? `${p.id}:${p.itemVars.blowpipeDartId}` : `${p.id}`;
  }).join(',');
  return `${eq}|${styleKey(c.style)}|${c.spell?.name || ''}`;
};

export const withSlot = (c: Config, slot: keyof PlayerEquipment, item: EquipmentPiece | null): Config => ({
  ...c,
  equipment: { ...c.equipment, [slot]: item },
});

export const isBetter = (a: Score, b: Score) => a.dps > b.dps + EPSILON
  || (Math.abs(a.dps - b.dps) <= EPSILON && a.tiebreak > b.tiebreak);

export const compareScores = (a: Score, b: Score) => {
  if (isBetter(a, b)) return -1;
  if (isBetter(b, a)) return 1;
  return 0;
};

export const EMPTY_SCORE: Score = {
  dps: 0, maxHit: 0, accuracy: 0, tiebreak: -Infinity,
};
