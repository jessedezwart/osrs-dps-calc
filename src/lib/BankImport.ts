import { EquipmentPiece } from '@/types/Player';
import {
  availableEquipment, equipmentAliases, getCanonicalItem, isSelectableEquipment,
} from '@/lib/Equipment';

export interface BankItem {
  id: number;
  name: string;
  quantity: number;
}

/**
 * Splits a single CSV line into its fields, honouring double-quoted fields (which may contain commas and "" escapes).
 */
const splitCsvLine = (line: string): string[] => {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"' && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else if (c === '"') {
        inQuotes = false;
      } else {
        current += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      fields.push(current);
      current = '';
    } else {
      current += c;
    }
  }
  fields.push(current);
  return fields;
};

/**
 * Parses a bank export CSV in the format `ID,Name,Quantity` (as produced by e.g. the RuneLite Bank Memory plugin).
 * A header row is optional. Unquoted names containing commas are supported, since the ID is always the first column
 * and the quantity is always the last.
 * @throws Error if no item rows could be parsed
 */
export const parseBankCsv = (text: string): BankItem[] => {
  const items: BankItem[] = [];

  for (const rawLine of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    if (!rawLine.trim()) continue;

    const fields = splitCsvLine(rawLine);
    const idField = fields[0].trim();
    if (fields.length < 2 || !/^\d+$/.test(idField)) {
      // Header row, or a row we don't understand
      continue;
    }

    const last = fields[fields.length - 1].trim();
    const hasQuantity = fields.length > 2 && /^\d+$/.test(last);
    items.push({
      id: parseInt(idField),
      name: fields.slice(1, hasQuantity ? -1 : undefined).join(',').trim(),
      quantity: hasQuantity ? parseInt(last) : 1,
    });
  }

  if (items.length === 0) {
    throw new Error('No items found. Expected a CSV with the columns ID,Name,Quantity.');
  }

  return items;
};

let equipmentById: Map<number, EquipmentPiece> | undefined;
let equipmentByName: Map<string, EquipmentPiece> | undefined;
let variantToBaseId: Map<number, number> | undefined;

const getLookups = () => {
  if (!equipmentById || !equipmentByName || !variantToBaseId) {
    equipmentById = new Map(availableEquipment.map((e) => [e.id, e]));
    equipmentByName = new Map();
    // prefer the first (usually un-versioned) entry for each name
    for (const e of availableEquipment) {
      const key = e.name.toLowerCase();
      if (!equipmentByName.has(key)) equipmentByName.set(key, e);
    }
    variantToBaseId = new Map();
    for (const [base, variants] of Object.entries(equipmentAliases)) {
      for (const v of variants) variantToBaseId.set(v, parseInt(base));
    }
  }
  return { equipmentById, equipmentByName, variantToBaseId };
};

/**
 * Resolves a single item ID (and optional name, as a fallback) to the canonical equipment piece it represents.
 * Returns undefined if the item is not equippable, or is not something worth considering (e.g. broken items).
 */
export const resolveEquipment = (id: number, name?: string): EquipmentPiece | undefined => {
  const { equipmentById: byId, equipmentByName: byName, variantToBaseId: toBase } = getLookups();

  let piece = byId.get(id);
  if (!piece) {
    const baseId = toBase.get(id);
    if (baseId !== undefined) piece = byId.get(baseId);
  }
  if (!piece && name) {
    piece = byName.get(name.toLowerCase());
  }
  if (!piece || !isSelectableEquipment(piece)) {
    return undefined;
  }

  const canonical = getCanonicalItem(piece);
  return isSelectableEquipment(canonical) ? canonical : piece;
};

/**
 * Converts a list of bank items into the unique set of equipment pieces they represent.
 * @param items the parsed bank items
 * @param extraIds additional item IDs to include, such as items that are currently worn (and therefore not in the bank)
 */
export const resolveOwnedEquipment = (items: BankItem[], extraIds: number[] = []): EquipmentPiece[] => {
  const owned = new Map<number, EquipmentPiece>();

  const add = (id: number, name?: string) => {
    const piece = resolveEquipment(id, name);
    if (piece && !owned.has(piece.id)) {
      // strip any per-loadout state (e.g. blowpipe darts) from the item
      const copy = { ...piece };
      delete copy.itemVars;
      owned.set(piece.id, copy);
    }
  };

  for (const item of items) add(item.id, item.name);
  for (const id of extraIds) add(id);

  return [...owned.values()];
};
