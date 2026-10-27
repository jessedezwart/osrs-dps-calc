import { describe, expect, test } from '@jest/globals';
import {
  formatGp, idsToFetch, itemValue, parseGp, PRICE_CACHE_MS, PriceCache,
} from '@/lib/ItemPrices';
import { equipmentAliases } from '@/lib/Equipment';

describe('itemValue', () => {
  test('uses the item price, or else the cheapest priced variant', () => {
    const [base, variants] = Object.entries(equipmentAliases).find(([, v]) => v.length >= 2)!;
    const baseId = parseInt(base);
    const prices: PriceCache = {
      [baseId]: { price: null, fetchedAt: 0 },
      [variants[0]]: { price: 500, fetchedAt: 0 },
      [variants[1]]: { price: 200, fetchedAt: 0 },
    };
    expect(itemValue(baseId, prices)).toBe(200);
    expect(itemValue(variants[0], prices)).toBe(500);
    expect(itemValue(baseId, { ...prices, [baseId]: { price: 1000, fetchedAt: 0 } })).toBe(1000);
  });

  test('is undefined for untradeables', () => {
    expect(itemValue(6570, { 6570: { price: null, fetchedAt: 0 } })).toBeUndefined();
    expect(itemValue(6570, {})).toBeUndefined();
  });
});

test('idsToFetch only requests uncached and expired prices', () => {
  const now = PRICE_CACHE_MS * 2;
  const prices: PriceCache = {
    1: { price: 5, fetchedAt: now - 1000 },
    2: { price: null, fetchedAt: now - 1000 },
    3: { price: 5, fetchedAt: now - PRICE_CACHE_MS - 1 },
  };
  expect(idsToFetch([1, 2, 3, 4], prices, now)).toEqual([3, 4]);
});

test('formatGp and parseGp', () => {
  expect(formatGp(950)).toBe('950');
  expect(formatGp(480_000)).toBe('480k');
  expect(formatGp(1_250_000)).toBe('1.3m');
  expect(formatGp(3_000_000_000)).toBe('3b');
  expect(parseGp('500k')).toBe(500_000);
  expect(parseGp('1.2M')).toBe(1_200_000);
  expect(parseGp('1,000')).toBe(1000);
  expect(parseGp(' 2b ')).toBe(2_000_000_000);
  expect(parseGp('abc')).toBeNaN();
  expect(parseGp('')).toBeNaN();
});
