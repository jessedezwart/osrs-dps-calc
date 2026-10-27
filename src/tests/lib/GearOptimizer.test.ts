import { describe, expect, test } from '@jest/globals';
import {
  AMMO_STACK, equipmentWeight, GearOptimizer, getPrayers, keptItemsCount, optimizeGear, optimizeGearWith, OPTIMIZER_STYLES,
  OptimizedLoadout, OptimizerProgress, pruneDominated, riskOf, toggleSearchPrayer, TrainingSkill,
} from '@/lib/GearOptimizer';
import { Prayer } from '@/enums/Prayer';
import { CombatStyleStance } from '@/types/PlayerCombatStyle';
import { resolveOwnedEquipment } from '@/lib/BankImport';
import { CAST_STANCES } from '@/lib/constants';
import { EquipmentPiece } from '@/types/Player';
import { findEquipmentById, getTestMonster, getTestPlayer } from '@/tests/utils/TestUtils';

const owned = (ids: number[]): EquipmentPiece[] => resolveOwnedEquipment(ids.map((id) => ({ id, name: '', quantity: 1 })));

const monster = getTestMonster('Abyssal demon');
const player = getTestPlayer(monster);
const opts = { prayers: [Prayer.PIETY, Prayer.RIGOUR, Prayer.AUGURY] };

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

describe('search prayers', () => {
  test('each style gets the prayers for it, and the ones for every style', () => {
    const selected = [Prayer.EAGLE_EYE, Prayer.MYSTIC_MIGHT, Prayer.ULTIMATE_STRENGTH, Prayer.INCREDIBLE_REFLEXES, Prayer.STEEL_SKIN];
    expect(getPrayers('melee', selected)).toEqual([Prayer.ULTIMATE_STRENGTH, Prayer.INCREDIBLE_REFLEXES, Prayer.STEEL_SKIN]);
    expect(getPrayers('ranged', selected)).toEqual([Prayer.EAGLE_EYE, Prayer.STEEL_SKIN]);
    expect(getPrayers('magic', selected)).toEqual([Prayer.MYSTIC_MIGHT, Prayer.STEEL_SKIN]);
  });

  test('a prayer for each style can be selected at the same time', () => {
    let selected: Prayer[] = [];
    for (const p of [Prayer.PIETY, Prayer.RIGOUR, Prayer.AUGURY]) selected = toggleSearchPrayer(selected, p);
    expect(selected).toEqual([Prayer.PIETY, Prayer.RIGOUR, Prayer.AUGURY]);

    // ...but conflicting prayers for the same style replace each other
    expect(toggleSearchPrayer(selected, Prayer.CHIVALRY)).toEqual([Prayer.RIGOUR, Prayer.AUGURY, Prayer.CHIVALRY]);
    // and a defensive prayer conflicts with all of them
    expect(toggleSearchPrayer(selected, Prayer.STEEL_SKIN)).toEqual([Prayer.STEEL_SKIN]);
    // brain and arm prayers can be combined
    expect(toggleSearchPrayer([Prayer.ULTIMATE_STRENGTH], Prayer.INCREDIBLE_REFLEXES))
      .toEqual([Prayer.ULTIMATE_STRENGTH, Prayer.INCREDIBLE_REFLEXES]);
    // and toggling a selected prayer turns it off
    expect(toggleSearchPrayer(selected, Prayer.RIGOUR)).toEqual([Prayer.PIETY, Prayer.AUGURY]);
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

  test('includes the damage taken from the monster', () => {
    // Abyssal whip, Rune platebody
    const result = optimizeGear(owned([4151, 1127]), player, monster, opts);
    const best = result.melee[0];
    expect(best.npcDps).toBeGreaterThan(0);
    expect(best.avgDmgTaken).toBeGreaterThan(0);
    // the rune platebody only adds defence, so wearing it should mean taking less damage
    const withoutBody = optimizeGear(owned([4151]), player, monster, opts).melee[0];
    expect(best.equipment.body?.name).toBe('Rune platebody');
    expect(best.npcDps).toBeLessThan(withoutBody.npcDps);
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

  test('skips ammo that is never better than other ammo for the weapon', () => {
    // Rune crossbow, Adamant bolts, Runite bolts, Broad bolts, Amethyst broad bolts, Diamond bolts (e), Ruby bolts (e)
    const result = optimizeGear(owned([9185, 9143, 9144, 11875, 21316, 9243, 9242]), player, monster, opts);
    // adamant bolts are worse than runite bolts, and broad bolts worse than amethyst broad bolts (with the same effect),
    // but the enchanted bolts have different effects
    expect(result.summary.ranged!.candidatesPerSlot.ammo).toBe(4);
    expect(result.ranged[0].equipment.ammo?.name).toMatch(/bolts \(e\)$/);
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
    const withoutPrayers = optimizeGear(bank, player, monster, { ...opts, prayers: [] });
    for (const style of ['melee', 'ranged', 'magic'] as const) {
      expect(withoutPrayers[style][0].prayers).toEqual([]);
      expect(withoutPrayers[style][0].dps).toBeLessThan(withPrayers[style][0].dps);
    }
  });

  test('uses only the selected prayers for each style', () => {
    const bank = owned([4151, 9185, 9243, 1401]); // Abyssal whip, Rune crossbow, Diamond bolts (e), Mystic fire staff
    const result = optimizeGear(bank, player, monster, opts);
    expect(result.melee[0].prayers).toEqual([Prayer.PIETY]);
    expect(result.ranged[0].prayers).toEqual([Prayer.RIGOUR]);
    expect(result.magic[0].prayers).toEqual([Prayer.AUGURY]);
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

  test('only casts the chosen spell', () => {
    // Mystic fire staff, Ancient staff, Trident of the seas, Mystic robe top, Mystic robe bottom
    const bank = owned([1401, 4675, 11905, 4091, 4093]);
    const result = optimizeGear(bank, player, monster, { ...opts, spell: 'Fire Bolt', excludedSpells: ['Fire Bolt'] });
    expect(result.magic.length).toBeGreaterThan(0);
    for (const l of result.magic) {
      expect(l.spell?.name).toBe('Fire Bolt');
      // the trident's built-in spell isn't used, but it can still manually cast
      expect(CAST_STANCES).toContain(l.style.stance);
    }
  });

  test('only searches the chosen styles', () => {
    const bank = owned([4151, 9185, 9243, 1401]); // Abyssal whip, Rune crossbow, Diamond bolts (e), Mystic fire staff
    const progress: OptimizerProgress[] = [];
    const result = optimizeGear(bank, player, monster, { ...opts, styles: ['ranged'] }, (p) => progress.push(p));
    expect(result.ranged.length).toBeGreaterThan(0);
    expect(result.melee).toEqual([]);
    expect(result.magic).toEqual([]);
    expect(Object.keys(result.summary)).toEqual(['ranged']);
    expect(progress[progress.length - 1].stylesDone).toBe(1);
  });

  describe('minimum weight', () => {
    // Abyssal whip, Dragon defender, Rune kiteshield, Rune full helm, Rune platebody, Rune platelegs, Leather gloves
    const bank = owned([4151, 12954, 1201, 1163, 1127, 1079, 1059]);

    test('only returns setups that are heavy enough', () => {
      const unweighted = optimizeGear(bank, player, monster, opts);
      expect(unweighted.melee[0].equipment.shield?.name).toBe('Dragon defender');

      // the (heavier, weaker) kiteshield is needed to reach the weight
      const minWeight = unweighted.melee[0].weight + 3;
      const result = optimizeGear(bank, player, monster, { ...opts, minWeight });
      expect(result.melee[0].equipment.shield?.name).toBe('Rune kiteshield');
      expect(result.melee[0].dps).toBeLessThan(unweighted.melee[0].dps);
      for (const style of ['melee', 'ranged', 'magic'] as const) {
        for (const l of result[style]) {
          expect(l.weight).toBeGreaterThanOrEqual(minWeight - 1e-6);
          expect(l.weight).toBeCloseTo(equipmentWeight(l.equipment));
        }
      }
    });

    test('returns nothing if the weight cannot be reached', () => {
      const result = optimizeGear(bank, player, monster, { ...opts, minWeight: 1000 });
      expect(result.melee).toHaveLength(0);
    });
  });

  describe('wilderness', () => {
    // Abyssal whip, Dragon defender, Amulet of fury, Berserker ring, Dragon boots, Climbing boots, Rune full helm,
    // Rune platebody, Rune platelegs
    const bank = owned([4151, 12954, 6585, 6737, 11840, 3105, 1163, 1127, 1079]);
    // the dragon defender and climbing boots have no value, so are untradeable
    const values: Record<number, number> = {
      4151: 1_500_000, 6585: 2_000_000, 6737: 3_000_000, 11840: 200_000, 1163: 10_000, 1127: 10_000, 1079: 10_000,
    };
    const wildernessOpts = (maxRisk: number, keptItems = 3, skipUntradeables = false) => ({
      ...opts,
      styles: ['melee' as const],
      wilderness: {
        maxRisk, keptItems, values, skipUntradeables,
      },
    });

    test('keptItemsCount', () => {
      expect(keptItemsCount({ protectItem: false, skulled: false })).toBe(3);
      expect(keptItemsCount({ protectItem: true, skulled: false })).toBe(4);
      expect(keptItemsCount({ protectItem: false, skulled: true })).toBe(0);
      expect(keptItemsCount({ protectItem: true, skulled: true })).toBe(1);
    });

    test('riskOf keeps the most valuable items, and counts ammo as a never-kept stack', () => {
      const equipment = {
        ...player.equipment,
        weapon: findEquipmentById(4151),
        neck: findEquipmentById(6585),
        ring: findEquipmentById(6737),
        feet: findEquipmentById(11840),
        shield: findEquipmentById(12954),
        ammo: findEquipmentById(892), // Rune arrow
      };
      const w = { maxRisk: 0, keptItems: 3, values: { ...values, 892: 100 } };
      const risk = riskOf(equipment, w);
      expect(risk.keptSlots.sort()).toEqual(['neck', 'ring', 'weapon']);
      expect(risk.risk).toBe(200_000 + 100 * AMMO_STACK);
      expect(risk.untradeableSlots).toEqual(['shield']);
      expect(risk.total).toBe(6_700_000 + 100 * AMMO_STACK);

      expect(riskOf(equipment, { ...w, keptItems: 0 }).risk).toBe(6_700_000 + 100 * AMMO_STACK);
    });

    test('stays within the risk limit', () => {
      const unlimited = optimizeGear(bank, player, monster, { ...opts, styles: ['melee'] }).melee[0];
      expect(unlimited.equipment.feet?.name).toBe('Dragon boots');
      expect(unlimited.equipment.neck?.name).toBe('Amulet of fury');
      expect(unlimited.risk).toBeUndefined();

      // only 3 of the 4 expensive items can be kept, so one of them has to go
      const expensiveItems = (l: OptimizedLoadout) => Object.values(l.equipment)
        .filter((i) => i && (values[i.id] || 0) > 100_000).length;
      expect(expensiveItems(unlimited)).toBe(4);
      const result = optimizeGear(bank, player, monster, wildernessOpts(100_000));
      const best = result.melee[0];
      expect(expensiveItems(best)).toBe(3);
      expect(best.dps).toBeLessThan(unlimited.dps);
      for (const l of result.melee) {
        expect(l.risk!.risk).toBeLessThanOrEqual(100_000);
        expect(l.risk!.keptSlots.length).toBeLessThanOrEqual(3);
      }
      // the dragon defender is untradeable, so it's free
      expect(best.equipment.shield?.name).toBe('Dragon defender');
      expect(best.risk!.untradeableSlots).toContain('shield');

      // with Protect Item, all 4 are kept
      const protectItem = optimizeGear(bank, player, monster, wildernessOpts(100_000, 4)).melee[0];
      expect(expensiveItems(protectItem)).toBe(4);
      expect(protectItem.dps).toBeCloseTo(unlimited.dps);
    });

    test('a higher risk limit never gives less DPS', () => {
      let previous = 0;
      for (const maxRisk of [0, 30_000, 250_000, 2_000_000, 10_000_000]) {
        const best = optimizeGear(bank, player, monster, wildernessOpts(maxRisk, 0)).melee[0];
        expect(best.risk!.risk).toBeLessThanOrEqual(maxRisk);
        expect(best.dps).toBeGreaterThanOrEqual(previous - 1e-9);
        previous = best.dps;
      }
    });

    test('can skip untradeables', () => {
      const best = optimizeGear(bank, player, monster, wildernessOpts(100_000, 3, true)).melee[0];
      expect(best.equipment.shield?.name).not.toBe('Dragon defender');
      expect(best.equipment.feet?.name).not.toBe('Climbing boots');
      expect(best.risk!.untradeableSlots).toEqual([]);
    });
  });

  test('lists equal-DPS items with more offensive stats as alternatives', () => {
    // Abyssal whip, Dragon defender, Obsidian platelegs, Torag's platelegs
    const bank = owned([4151, 20463, 21304, 4751]);
    const boosted = getTestPlayer(monster, { boosts: { atk: 10, str: 10 } });
    const best = optimizeGear(bank, boosted, monster, opts).melee[0];

    // the +1 strength doesn't change the max hit, so the legs with more defence are picked...
    expect(best.equipment.legs?.name).toBe("Torag's platelegs");
    // ...but the +1 strength matters once the boost has drained a little
    const alt = best.alternatives.find((a) => a.item.name === 'Obsidian platelegs');
    expect(alt?.slot).toBe('legs');
    expect(alt?.betterAfterDrain?.levels).toBeGreaterThan(0);
    expect(alt?.betterAfterDrain?.dpsGain).toBeGreaterThan(0);
  });

  describe('ammo with weapons that do not use it', () => {
    // Rune knife, Rune javelin, Mithril javelin, Holy blessing, Iron arrow, Rune arrow
    const bank = owned([876, 836, 834, 20220, 885, 893]);

    test('picks ammo by its stats that still apply, and lists no alternatives for it', () => {
      const best = optimizeGear(bank, player, monster, opts).ranged[0];
      expect(best.equipment.weapon?.name).toBe('Rune knife');
      // the javelins' ranged strength does nothing for a knife, so the prayer bonus wins
      expect(best.equipment.ammo?.name).toBe('Holy blessing');
      expect(best.alternatives.filter((a) => a.slot === 'ammo')).toEqual([]);
    });

    test('still tries an arrow, for monsters that need one', () => {
      // Fareed is immune to ranged attacks without arrows
      const fareed = getTestMonster('Fareed');
      const best = optimizeGear(bank, getTestPlayer(fareed), fareed, opts).ranged[0];
      expect(best.dps).toBeGreaterThan(0);
      expect(best.equipment.ammo?.name).toMatch(/arrow$/);
    });

    test('never loads ignored ammo, but still uses the weapon that fired it', () => {
      // Magic shortbow, Adamant arrow, Rune arrow
      const result = optimizeGear(owned([861, 890, 892]), player, monster, { ...opts, ignoredAmmo: ['Rune arrow'] });
      const bow = result.ranged.find((l) => l.equipment.weapon?.name === 'Magic shortbow')!;
      expect(bow.equipment.ammo?.name).toBe('Adamant arrow');
    });

    test('never loads ignored darts into a blowpipe, but can still throw them', () => {
      // Toxic blowpipe, Mithril dart, Rune dart
      const result = optimizeGear(owned([12926, 809, 811]), player, monster, { ...opts, ignoredAmmo: ['Rune dart'] });
      const loads = result.ranged
        .filter((l) => l.equipment.weapon?.itemVars?.blowpipeDartName)
        .map((l) => l.equipment.weapon!.itemVars!.blowpipeDartName);
      expect(loads).toEqual(['Mithril dart']);
      expect(result.ranged.some((l) => l.equipment.weapon?.name === 'Rune dart')).toBe(true);
    });

    test('leaves the slot empty if the arrow does nothing', () => {
      // Rune knife, Magic shortbow, Rune arrow
      const result = optimizeGear(owned([876, 861, 892]), player, monster, opts);
      const knife = result.ranged.find((l) => l.equipment.weapon?.name === 'Rune knife')!;
      expect(knife.equipment.ammo).toBeNull();
      // the bow still fires them
      const bow = result.ranged.find((l) => l.equipment.weapon?.name === 'Magic shortbow')!;
      expect(bow.equipment.ammo?.name).toBe('Rune arrow');
      for (const l of [...result.melee, ...result.magic]) {
        expect(l.equipment.ammo).toBeNull();
      }
    });
  });

  test('gives the same results when the jobs are spread over separate optimizers', async () => {
    const bank = owned([4151, 1303, 12954, 11665, 13072, 13073, 8842, 1163, 1127, 9185, 9243, 9242, 876, 20220, 1401, 4091, 4093]);
    const expected = optimizeGear(bank, player, monster, opts);

    // round-robin over a few optimizers, like a pool of workers would
    const optimizers = [0, 1, 2].map(() => new GearOptimizer(bank, player, monster, opts));
    let next = 0;
    const done: string[] = [];
    const result = await optimizeGearWith(
      opts,
      async (job) => {
        next += 1;
        const optimizer = optimizers[next % optimizers.length];
        const before = optimizer.evaluations;
        // round-trip through JSON, as messages between workers do
        const r = JSON.parse(JSON.stringify(optimizer.runJob(JSON.parse(JSON.stringify(job)))));
        return { result: r, evaluations: optimizer.evaluations - before };
      },
      (style) => done.push(style),
    );

    expect(done.sort()).toEqual([...OPTIMIZER_STYLES].sort());
    for (const style of OPTIMIZER_STYLES) {
      expect(JSON.parse(JSON.stringify(result[style]))).toEqual(JSON.parse(JSON.stringify(expected[style])));
      // the separate caches mean more evaluations, but the rest of the summary is the same
      const { evaluations, ...summary } = result.summary[style]!;
      const { evaluations: expectedEvaluations, ...expectedSummary } = expected.summary[style]!;
      expect(summary).toEqual(expectedSummary);
      expect(Object.keys(evaluations).sort()).toEqual(Object.keys(expectedEvaluations).sort());
    }
  });

  test('summarises the search', () => {
    // Abyssal whip, Rune longsword, Dragon defender, Rune full helm, Fire cape
    const result = optimizeGear(owned([4151, 1303, 12954, 1163, 6570]), player, monster, opts);
    const melee = result.summary.melee!;
    // the two swords and unarmed
    expect(melee.weaponsScreened).toBe(3);
    expect(melee.weaponsRefined).toBe(3);
    expect(melee.candidatesPerSlot.shield).toBe(1);
    expect(melee.candidatesPerSlot.ring).toBe(0);
    expect(melee.pairSwapped).toBe(3);
    // the evaluations per step add up to the total
    const total = OPTIMIZER_STYLES
      .flatMap((s) => Object.values(result.summary[s]!.evaluations))
      .reduce((a, b) => a + b, 0);
    expect(total).toBe(result.evaluations);
  });

  test('reports progress', () => {
    const bank = owned([4151, 9185, 9243, 1401]); // Abyssal whip, Rune crossbow, Diamond bolts (e), Mystic fire staff
    const progress: OptimizerProgress[] = [];
    const result = optimizeGear(bank, player, monster, opts, (p) => progress.push(p));
    expect(progress.map((p) => p.stylesDone)).toEqual(expect.arrayContaining([1, 2, 3]));
    expect(progress[progress.length - 1]).toEqual({ evaluations: result.evaluations, stylesDone: 3 });
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
    // the full exhaustive search takes minutes on a single thread, so it gets a small budget here
    const budget = 20_000;
    const withoutExhaustive = optimizeGear(bank, player, monster, { ...opts, exhaustiveBudget: 0 });
    const start = performance.now();
    const result = optimizeGear(bank, player, monster, { ...opts, exhaustiveBudget: budget });
    const elapsed = performance.now() - start;
    console.log(`Optimized ${bank.length} items in ${elapsed.toFixed(0)}ms with ${result.evaluations} evaluations`, {
      melee: result.melee[0]?.dps,
      ranged: result.ranged[0]?.dps,
      magic: result.magic[0]?.dps,
    });

    for (const style of OPTIMIZER_STYLES) {
      expect(result[style][0].dps).toBeGreaterThan(0);
      // the exhaustive search only ever improves the results
      expect(result[style][0].dps).toBeGreaterThanOrEqual(withoutExhaustive[style][0].dps);
    }
    expect(withoutExhaustive.evaluations).toBeLessThan(30000);
    // the best result per style gets the budget, and the other 4 a quarter each
    expect(result.evaluations).toBeLessThanOrEqual(withoutExhaustive.evaluations + OPTIMIZER_STYLES.length * 2 * budget);
  }, 120000);
});
