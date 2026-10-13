import { describe, expect, test } from '@jest/globals';
import { optimizeGear, pruneDominated, TrainingSkill } from '@/lib/GearOptimizer';
import { CombatStyleStance } from '@/types/PlayerCombatStyle';
import { resolveOwnedEquipment } from '@/lib/BankImport';
import { EquipmentPiece } from '@/types/Player';
import { findEquipmentById, getTestMonster, getTestPlayer } from '@/tests/utils/TestUtils';

const owned = (ids: number[]): EquipmentPiece[] => resolveOwnedEquipment(ids.map((id) => ({ id, name: '', quantity: 1 })));

const monster = getTestMonster('Abyssal demon');
const player = getTestPlayer(monster);
const opts = { prayerUnlocks: true };

describe('pruneDominated', () => {
  test('removes items with strictly worse stats', () => {
    const items = [findEquipmentById(1163), findEquipmentById(1153)]; // Rune full helm, Iron full helm
    expect(pruneDominated(items, 'melee').map((i) => i.name)).toEqual(['Rune full helm']);
  });

  test('keeps items with special effects', () => {
    const items = [findEquipmentById(1163), findEquipmentById(11665)]; // Rune full helm, Void melee helm
    expect(pruneDominated(items, 'melee')).toHaveLength(2);
  });
});

describe('optimizeGear', () => {
  test('picks the strongest weapon and offhand', () => {
    // Abyssal whip, Rune longsword, Dragon defender
    const result = optimizeGear(owned([4151, 1303, 12954]), player, monster, opts);
    const best = result.melee[0];
    expect(best.equipment.weapon?.name).toBe('Abyssal whip');
    expect(best.equipment.shield?.name).toBe('Dragon defender');
    expect(best.dps).toBeGreaterThan(0);
  });

  test('finds multi-piece set bonuses such as void', () => {
    const bank = owned([
      4151, // Abyssal whip
      11665, 13072, 13073, 8842, // Void melee helm, Elite void top, Elite void robe, Void knight gloves
      1163, 1127, 1079, 1059, // Rune full helm, Rune platebody, Rune platelegs, Leather gloves
    ]);
    const result = optimizeGear(bank, player, monster, opts);
    const best = result.melee[0];
    expect(best.equipment.head?.name).toBe('Void melee helm');
    expect(best.equipment.body?.name).toBe('Elite void top');
    expect(best.equipment.legs?.name).toBe('Elite void robe');
    expect(best.equipment.hands?.name).toBe('Void knight gloves');
  });

  test('only uses ammo that works with the ranged weapon', () => {
    // Rune crossbow, Diamond bolts (e), Ruby bolts (e), Rune arrow
    const result = optimizeGear(owned([9185, 9243, 9242, 892]), player, monster, opts);
    const best = result.ranged[0];
    expect(best.equipment.weapon?.name).toBe('Rune crossbow');
    expect(best.equipment.ammo?.name).toMatch(/bolts \(e\)$/);
  });

  test('never pairs a two-handed weapon with a shield', () => {
    // Dragon 2h sword, Dragon defender
    const result = optimizeGear(owned([7158, 12954]), player, monster, opts);
    const twoHanded = result.melee.filter((l) => l.equipment.weapon?.isTwoHanded);
    expect(twoHanded.length).toBeGreaterThan(0);
    for (const l of twoHanded) {
      expect(l.equipment.shield).toBeNull();
    }
  });

  test('picks a spell for magic weapons', () => {
    // Mystic fire staff, Mystic robe top, Mystic robe bottom
    const result = optimizeGear(owned([1401, 4091, 4093]), player, monster, opts);
    const best = result.magic[0];
    expect(best.equipment.weapon?.name).toBe('Mystic fire staff');
    expect(best.spell).not.toBeNull();
    expect(best.prayers.length).toBe(1);
  });

  test('thorough mode is at least as good as the normal search', () => {
    const bank = owned([4151, 1303, 12954, 11665, 13072, 13073, 8842, 1163, 1127, 1079, 1059, 6570, 6585, 7462, 11840]);
    const normal = optimizeGear(bank, player, monster, opts);
    const thorough = optimizeGear(bank, player, monster, { ...opts, thorough: true });
    expect(thorough.melee[0].dps).toBeGreaterThanOrEqual(normal.melee[0].dps);
    expect(thorough.evaluations).toBeGreaterThanOrEqual(normal.evaluations);
  });

  describe('locked slots', () => {
    // Abyssal whip, Rune longsword, Dragon 2h sword, Dragon defender, Rune kiteshield, Rune full helm, Fire cape
    const bank = owned([4151, 1303, 7158, 12954, 1201, 1163, 6570]);

    test('keeps a locked weapon and searches the rest around it', () => {
      const result = optimizeGear(bank, player, monster, { ...opts, locked: { weapon: findEquipmentById(1303) } });
      expect(result.melee.length).toBeGreaterThan(0);
      for (const l of result.melee) {
        expect(l.equipment.weapon?.name).toBe('Rune longsword');
      }
      expect(result.melee[0].equipment.shield?.name).toBe('Dragon defender');
      expect(result.melee[0].equipment.cape?.name).toBe('Fire cape');
    });

    test('a locked item does not need to be owned', () => {
      // Dragon scimitar is not in the bank
      const result = optimizeGear(bank, player, monster, { ...opts, locked: { weapon: findEquipmentById(4587) } });
      expect(result.melee[0].equipment.weapon?.name).toBe('Dragon scimitar');
    });

    test('keeps a slot locked to empty', () => {
      const result = optimizeGear(bank, player, monster, { ...opts, locked: { cape: null } });
      for (const l of result.melee) {
        expect(l.equipment.cape).toBeNull();
      }
    });

    test('excludes two-handed weapons when a shield is locked', () => {
      const result = optimizeGear(bank, player, monster, { ...opts, locked: { shield: findEquipmentById(1201) } });
      for (const l of result.melee) {
        expect(l.equipment.weapon?.isTwoHanded).toBeFalsy();
        expect(l.equipment.shield?.name).toBe('Rune kiteshield');
      }
    });

    test('returns nothing for styles the locked weapon cannot use', () => {
      const result = optimizeGear(bank, player, monster, { ...opts, locked: { weapon: findEquipmentById(4151) } });
      expect(result.ranged).toHaveLength(0);
    });

    test('does not use set seeds that conflict with a locked slot', () => {
      const voidBank = owned([4151, 11665, 13072, 13073, 8842, 1163]);
      const result = optimizeGear(voidBank, player, monster, { ...opts, locked: { head: findEquipmentById(1163) } });
      expect(result.melee[0].equipment.head?.name).toBe('Rune full helm');
    });
  });

  test('can omit prayers', () => {
    const bank = owned([4151, 9185, 9243, 1401]); // Abyssal whip, Rune crossbow, Diamond bolts (e), Mystic fire staff
    const withPrayers = optimizeGear(bank, player, monster, opts);
    const withoutPrayers = optimizeGear(bank, player, monster, { ...opts, noPrayers: true });
    for (const style of ['melee', 'ranged', 'magic'] as const) {
      expect(withoutPrayers[style][0].prayers).toEqual([]);
      expect(withoutPrayers[style][0].dps).toBeLessThan(withPrayers[style][0].dps);
    }
  });

  test('never casts excluded spells', () => {
    const bank = owned([1401, 4675, 4091, 4093]); // Mystic fire staff, Ancient staff, Mystic robe top, Mystic robe bottom
    const before = optimizeGear(bank, player, monster, opts);
    const firstChoice = before.magic[0].spell!.name;

    const after = optimizeGear(bank, player, monster, { ...opts, excludedSpells: [firstChoice] });
    expect(after.magic.length).toBeGreaterThan(0);
    for (const l of after.magic) {
      expect(l.spell?.name).not.toBe(firstChoice);
    }
  });

  describe('training filter', () => {
    // Abyssal whip, Rune longsword, Dragon scimitar, Rune crossbow, Diamond bolts (e), Mystic fire staff
    const bank = owned([4151, 1303, 4587, 9185, 9243, 1401]);

    const cases: [TrainingSkill, CombatStyleStance][] = [
      ['attack', 'Accurate'],
      ['strength', 'Aggressive'],
      ['defence', 'Defensive'],
      ['shared', 'Controlled'],
    ];
    test.each(cases)('only uses melee stances that train %s', (training, stance) => {
      const result = optimizeGear(bank, player, monster, { ...opts, training });
      expect(result.melee.length).toBeGreaterThan(0);
      for (const l of result.melee) {
        expect(l.style.stance).toBe(stance);
      }
    });

    test('a weapon without a matching stance is skipped', () => {
      // the whip has no Aggressive stance
      const result = optimizeGear(bank, player, monster, { ...opts, training: 'strength' });
      expect(result.melee.map((l) => l.equipment.weapon?.name)).not.toContain('Abyssal whip');
    });

    test('defence training also restricts ranged and magic', () => {
      const result = optimizeGear(bank, player, monster, { ...opts, training: 'defence' });
      for (const l of result.ranged) expect(l.style.stance).toBe('Longrange');
      for (const l of result.magic) expect(['Defensive Autocast', 'Longrange']).toContain(l.style.stance);
      expect(result.ranged.length).toBeGreaterThan(0);
      expect(result.magic.length).toBeGreaterThan(0);
    });

    test('attack training does not restrict ranged', () => {
      const result = optimizeGear(bank, player, monster, { ...opts, training: 'attack' });
      expect(result.ranged[0].style.stance).toBe('Rapid');
    });
  });

  test('handles a large bank in reasonable time', () => {
    const bank = owned([
      // melee
      4151, 12954, 1303, 4587, 1249, 1434, 1377, 3204, 7158, 4153, 19675, 27021, 30955, 28792, 10887, 25979,
      24699, 11037, 4726, 4755, 4747, 4888, 4716, 4894, 4900, 4724, 4728, 4730, 4745, 4749, 4753, 4757,
      11665, 11664, 11663, 13072, 13073, 8842, 6570, 6585, 26782, 26675, 7462, 11840, 26770, 26768,
      21301, 21304, 6524, 6522, 1163, 1127, 1079, 1201, 4131, 24271, 3122, 29043, 12486, 1187, 4087, 4585,
      // ranged
      9185, 9243, 9242, 9245, 9144, 23983, 4734, 4740, 4940, 12851, 859, 861, 892, 4160, 31583, 811, 810,
      2503, 2497, 2491, 22109, 19930, 2577, 10368, 28869, 28872, 29031, 805, 868, 830,
      // magic
      4675, 1401, 4710, 4714, 12658, 2415, 28585, 30634, 4089, 4091, 4093, 4095, 4097, 26914, 26850,
      21791, 12612, 29889, 30957, 29084, 28988, 9097, 26969, 34428, 30638,
    ]);
    const start = performance.now();
    const result = optimizeGear(bank, player, monster, opts);
    const elapsed = performance.now() - start;
    console.log(`Optimized ${bank.length} items in ${elapsed.toFixed(0)}ms with ${result.evaluations} evaluations`, {
      melee: result.melee[0]?.dps,
      ranged: result.ranged[0]?.dps,
      magic: result.magic[0]?.dps,
    });

    expect(result.melee[0].dps).toBeGreaterThan(0);
    expect(result.ranged[0].dps).toBeGreaterThan(0);
    expect(result.magic[0].dps).toBeGreaterThan(0);
    expect(result.evaluations).toBeLessThan(30000);
  }, 120000);
});
