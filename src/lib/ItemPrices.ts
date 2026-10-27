import { equipmentAliases, getCanonicalItemId } from '@/lib/Equipment';

/**
 * Grand Exchange prices, for the gear optimizer's wilderness mode (how much a setup risks on death).
 * Prices come from the Weird Gloop exchange API, which has the official (daily) GE guide prices.
 * @see https://runescape.wiki/w/RuneScape:Grand_Exchange_Market_Watch/Usage_and_APIs
 */

const PRICE_API = 'https://api.weirdgloop.org/exchange/history/osrs/latest';
/** The API asks for a descriptive user agent. Chrome doesn't let pages set it, but other browsers send it. */
const USER_AGENT = 'osrs-dps-calc gear optimizer - https://github.com/jessedezwart/osrs-dps-calc';
/** The most ids the API accepts per request. */
const IDS_PER_REQUEST = 100;
/** How long a cached price is used before it's requested again. GE prices only change once a day. */
export const PRICE_CACHE_MS = 30 * 24 * 60 * 60 * 1000;

export interface CachedPrice {
  /** The GE price, or null if the item can't be traded on the GE (the API doesn't know it). */
  price: number | null;
  /** When the price was requested (ms since epoch). */
  fetchedAt: number;
}

export type PriceCache = Record<number, CachedPrice>;

/**
 * The ids to look up the price of an item with: the item itself, followed by its variants (e.g. the uncharged version
 * of a charged weapon, or the unlocked version of a locked item).
 */
export const priceIdsFor = (id: number): number[] => {
  const canonical = getCanonicalItemId(id);
  return [...new Set([id, canonical, ...(equipmentAliases[canonical] || [])])];
};

/**
 * The value of an item: its own price, or else the lowest price of its variants (e.g. the uncharged version of a
 * charged weapon, rather than an ornament kit recolour). Undefined if none of them are tradeable.
 */
export const itemValue = (id: number, prices: PriceCache): number | undefined => {
  const own = prices[id]?.price;
  if (own != null) return own;
  const canonical = prices[getCanonicalItemId(id)]?.price;
  if (canonical != null) return canonical;
  const variants = priceIdsFor(id)
    .map((v) => prices[v]?.price)
    .filter((p): p is number => p != null);
  return variants.length > 0 ? Math.min(...variants) : undefined;
};

/** The ids out of these that aren't cached, or whose cached price is older than PRICE_CACHE_MS. */
export const idsToFetch = (ids: number[], prices: PriceCache, now: number = Date.now()): number[] => ids
  .filter((id) => !prices[id] || now - prices[id].fetchedAt > PRICE_CACHE_MS);

/**
 * Requests the prices of the items, in as few requests as the API allows. Items the API doesn't return are untradeable,
 * and get a null price.
 * @throws Error if a request fails
 */
export const fetchPrices = async (ids: number[], now: number = Date.now()): Promise<PriceCache> => {
  const ret: PriceCache = {};
  for (let i = 0; i < ids.length; i += IDS_PER_REQUEST) {
    const batch = ids.slice(i, i + IDS_PER_REQUEST);
    // eslint-disable-next-line no-await-in-loop
    const res = await fetch(`${PRICE_API}?id=${batch.join('|')}`, { headers: { 'User-Agent': USER_AGENT } });
    if (!res.ok) throw new Error(`Price request failed with status ${res.status}`);
    // eslint-disable-next-line no-await-in-loop
    const json: Record<string, { price?: number }> & { success?: boolean } = await res.json();
    for (const id of batch) {
      const price = json[id]?.price;
      ret[id] = { price: typeof price === 'number' ? price : null, fetchedAt: now };
    }
  }
  return ret;
};

/** Formats an amount of gp the way the game does, e.g. 950, 480k, 1.2m or 3.5b. */
const GP_SUFFIXES: [string, number][] = [['b', 1e9], ['m', 1e6], ['k', 1e3]];

export const formatGp = (gp: number): string => {
  const [suffix, divisor] = GP_SUFFIXES.find(([, d]) => Math.abs(gp) >= d) ?? ['', 1];
  return `${parseFloat((gp / divisor).toFixed(divisor === 1 ? 0 : 1))}${suffix}`;
};

/** Parses an amount of gp such as 500000, 500k, 1.2m or 2b (case-insensitive, commas allowed). NaN if invalid. */
export const parseGp = (text: string): number => {
  const match = /^\s*(\d+(?:\.\d+)?)\s*([kmb]?)\s*$/i.exec(text.replace(/,/g, ''));
  if (!match) return NaN;
  const multiplier = GP_SUFFIXES.find(([s]) => s === match[2].toLowerCase())?.[1] ?? 1;
  return Math.round(parseFloat(match[1]) * multiplier);
};
