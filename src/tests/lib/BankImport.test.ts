import { describe, expect, test } from '@jest/globals';
import { parseBankCsv, resolveOwnedEquipment } from '@/lib/BankImport';

describe('parseBankCsv', () => {
  test('parses a bank export with a header row and CRLF line endings', () => {
    const items = parseBankCsv('ID,Name,Quantity\r\n4151,Abyssal whip,1\r\n995,Coins,2101667\r\n');
    expect(items).toEqual([
      { id: 4151, name: 'Abyssal whip', quantity: 1 },
      { id: 995, name: 'Coins', quantity: 2101667 },
    ]);
  });

  test('handles names containing commas, quoted or not', () => {
    const items = parseBankCsv('ID,Name,Quantity\n1,"Some, item",5\n2,Other, item,7\n3,"Say ""hi""",1');
    expect(items).toEqual([
      { id: 1, name: 'Some, item', quantity: 5 },
      { id: 2, name: 'Other, item', quantity: 7 },
      { id: 3, name: 'Say "hi"', quantity: 1 },
    ]);
  });

  test('works without a header or quantity column', () => {
    expect(parseBankCsv('4151,Abyssal whip')).toEqual([{ id: 4151, name: 'Abyssal whip', quantity: 1 }]);
  });

  test('throws if the file has no items', () => {
    expect(() => parseBankCsv('this is not a bank export')).toThrow();
    expect(() => parseBankCsv('')).toThrow();
  });
});

describe('resolveOwnedEquipment', () => {
  test('keeps only usable equipment', () => {
    const owned = resolveOwnedEquipment([
      { id: 4151, name: 'Abyssal whip', quantity: 1 },
      { id: 995, name: 'Coins', quantity: 1000 },
      { id: 561, name: 'Nature rune', quantity: 1000 },
    ]);
    expect(owned.map((o) => o.name)).toEqual(['Abyssal whip']);
  });

  test('canonicalizes degraded variants and de-duplicates them', () => {
    const owned = resolveOwnedEquipment([
      { id: 4882, name: "Dharok's helm 50", quantity: 1 },
      { id: 4716, name: "Dharok's helm", quantity: 1 },
    ]);
    expect(owned).toHaveLength(1);
    expect(owned[0].id).toBe(4716);
    expect(owned[0].name).toBe("Dharok's helm");
  });

  test('falls back to matching by name for unknown IDs', () => {
    const owned = resolveOwnedEquipment([{ id: 99999999, name: 'abyssal whip', quantity: 1 }]);
    expect(owned.map((o) => o.id)).toEqual([4151]);
  });

  test('includes extra (e.g. worn) item IDs', () => {
    const owned = resolveOwnedEquipment([{ id: 4151, name: 'Abyssal whip', quantity: 1 }], [12954, 4151]);
    expect(owned.map((o) => o.name).sort()).toEqual(['Abyssal whip', 'Dragon defender']);
  });
});
