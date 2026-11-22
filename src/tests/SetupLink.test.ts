import { describe, expect, test } from '@jest/globals';
import {
  createSetupLink, decodeSetupLink, encodeSetupLink, setupLinkUrl,
} from '@/lib/SetupLink';
import { createEmptyPlayer } from '@/state/PlayerStore';
import { resolveEquipment } from '@/lib/BankImport';
import { Prayer } from '@/enums/Prayer';
import { EquipmentPiece } from '@/types/Player';

describe('SetupLink', () => {
  const player = createEmptyPlayer();
  const whip = resolveEquipment(4151)!;
  const blowpipe = { ...resolveEquipment(12926)!, itemVars: { blowpipeDartName: 'Rune dart', blowpipeDartId: 811 } } as EquipmentPiece;

  test('round-trips a setup through a URL', () => {
    const setup = createSetupLink({
      monsterId: 15626,
      monsterInputs: { isFromCoxCm: true },
      equipment: { ...player.equipment, weapon: whip, ammo: null },
      style: player.style,
      spell: null,
      prayers: [Prayer.PIETY],
      player,
    });
    const url = new URL(setupLinkUrl('http://localhost:3124/osrs-dps/', setup));
    expect(url.pathname).toBe('/osrs-dps/');
    expect(decodeSetupLink(url.searchParams.get('setup')!)).toEqual(setup);
    expect(setup.equipment).toEqual({ weapon: { id: 4151 } });
    expect(setup.monster).toEqual({ id: 15626, inputs: { isFromCoxCm: true } });
  });

  test('keeps item vars', () => {
    const setup = createSetupLink({
      monsterId: 1, equipment: { ...player.equipment, weapon: blowpipe }, style: player.style, spell: null, prayers: [], player,
    });
    expect(decodeSetupLink(encodeSetupLink(setup)).equipment.weapon).toEqual({ id: blowpipe.id, itemVars: blowpipe.itemVars });
  });

  test('rejects other data', () => {
    expect(() => decodeSetupLink(encodeSetupLink({ v: 2 } as never))).toThrow();
    expect(() => decodeSetupLink('not base64!')).toThrow();
  });
});
