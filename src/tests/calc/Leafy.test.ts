import { describe, expect, test } from '@jest/globals';
import {
  calculatePlayerVsNpc, findEquipment, getTestMonster, getTestPlayer,
} from '@/tests/utils/TestUtils';

describe('Leafy monsters', () => {
  const monster = getTestMonster('Kurask');
  const style = { name: 'Rapid', type: 'ranged', stance: 'Rapid' } as const;

  test('Broad bolts fired from a crossbow can hit', () => {
    const player = getTestPlayer(monster, {
      style,
      equipment: { weapon: findEquipment('Rune crossbow'), ammo: findEquipment('Broad bolts') },
    });
    expect(calculatePlayerVsNpc(monster, player).dps).toBeGreaterThan(0);
  });

  test('Broad bolts that are not fired do not help', () => {
    const player = getTestPlayer(monster, {
      style,
      equipment: { weapon: findEquipment('Rune knife'), ammo: findEquipment('Broad bolts') },
    });
    expect(calculatePlayerVsNpc(monster, player).dps).toBe(0);
  });
});
