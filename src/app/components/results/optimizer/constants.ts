import headSlot from '@/public/img/slots/head.png';
import capeSlot from '@/public/img/slots/cape.png';
import neckSlot from '@/public/img/slots/neck.png';
import ammoSlot from '@/public/img/slots/ammo.png';
import weaponSlot from '@/public/img/slots/weapon.png';
import bodySlot from '@/public/img/slots/body.png';
import shieldSlot from '@/public/img/slots/shield.png';
import legsSlot from '@/public/img/slots/legs.png';
import handsSlot from '@/public/img/slots/hands.png';
import feetSlot from '@/public/img/slots/feet.png';
import ringSlot from '@/public/img/slots/ring.png';
import { OptimizerStyle } from '@/lib/optimizer';
import { PlayerEquipment } from '@/types/Player';
import { spells } from '@/types/Spell';

export const DISPLAY_SLOTS: (keyof PlayerEquipment)[] = [
  'head', 'cape', 'neck', 'ammo', 'weapon', 'body', 'shield', 'legs', 'hands', 'feet', 'ring',
];

export const SLOT_PLACEHOLDERS: { [k in keyof PlayerEquipment]: string } = {
  head: headSlot.src,
  cape: capeSlot.src,
  neck: neckSlot.src,
  ammo: ammoSlot.src,
  weapon: weaponSlot.src,
  body: bodySlot.src,
  shield: shieldSlot.src,
  legs: legsSlot.src,
  hands: handsSlot.src,
  feet: feetSlot.src,
  ring: ringSlot.src,
};

export const STYLE_LABELS: { [k in OptimizerStyle]: string } = {
  melee: 'Melee',
  ranged: 'Ranged',
  magic: 'Magic',
};

/** Every spell once (some are listed for multiple spellbooks), by name. */
export const ALL_SPELLS = [...new Map(spells.map((sp) => [sp.name, sp])).values()].sort((a, b) => a.name.localeCompare(b.name));
