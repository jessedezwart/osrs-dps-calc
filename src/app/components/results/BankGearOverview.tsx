import React, { useMemo, useState } from 'react';
import { observer } from 'mobx-react-lite';
import { IconChevronDown, IconChevronUp } from '@tabler/icons-react';
import { useOptimizer } from '@/optimizerState';
import SectionAccordion from '@/app/components/generic/SectionAccordion';
import LazyImage from '@/app/components/generic/LazyImage';
import equipmentStats from '@/public/img/Equipment Stats.png';
import { resolveOwnedEquipment } from '@/lib/BankImport';
import { EquipmentPiece, PlayerEquipment } from '@/types/Player';
import { getCdnImage } from '@/utils';

const SLOTS: (keyof PlayerEquipment)[] = [
  'weapon', 'head', 'cape', 'neck', 'ammo', 'body', 'shield', 'legs', 'hands', 'feet', 'ring',
];

const defenceSum = (i: EquipmentPiece) => i.defensive.stab + i.defensive.slash + i.defensive.crush + i.defensive.magic
  + i.defensive.ranged;

interface Column {
  key: string;
  label: string;
  title: string;
  get: (i: EquipmentPiece) => number;
  format?: (v: number) => string;
}

const COLUMNS: Column[] = [
  {
    key: 'stab', label: 'Stab', title: 'Stab attack bonus', get: (i) => i.offensive.stab,
  },
  {
    key: 'slash', label: 'Slash', title: 'Slash attack bonus', get: (i) => i.offensive.slash,
  },
  {
    key: 'crush', label: 'Crush', title: 'Crush attack bonus', get: (i) => i.offensive.crush,
  },
  {
    key: 'str', label: 'Str', title: 'Melee strength bonus', get: (i) => i.bonuses.str,
  },
  {
    key: 'ranged', label: 'Rng', title: 'Ranged attack bonus', get: (i) => i.offensive.ranged,
  },
  {
    key: 'ranged_str', label: 'R.Str', title: 'Ranged strength bonus', get: (i) => i.bonuses.ranged_str,
  },
  {
    key: 'magic', label: 'Mage', title: 'Magic attack bonus', get: (i) => i.offensive.magic,
  },
  {
    key: 'magic_str',
    label: 'M.Dmg',
    title: 'Magic damage bonus',
    get: (i) => i.bonuses.magic_str,
    format: (v) => `${Number((v / 10).toFixed(1))}%`,
  },
  {
    key: 'defence', label: 'Def', title: 'Sum of all defence bonuses', get: defenceSum,
  },
  {
    key: 'prayer', label: 'Pray', title: 'Prayer bonus', get: (i) => i.bonuses.prayer,
  },
  {
    key: 'weight', label: 'Kg', title: 'Weight', get: (i) => i.weight || 0, format: (v) => (v ? v.toFixed(1) : '0'),
  },
  {
    key: 'speed',
    label: 'Speed',
    title: 'Attack speed in ticks (weapons only, lower is faster)',
    get: (i) => (i.slot === 'weapon' ? i.speed : 0),
    format: (v) => (v ? `${v}` : ''),
  },
];

type SortKey = 'name' | 'slot' | Column['key'];

/** The highest of the item's attack bonuses, used to order items within a slot by default. */
const bestAttack = (i: EquipmentPiece) => Math.max(
  i.offensive.stab,
  i.offensive.slash,
  i.offensive.crush,
  i.offensive.ranged,
  i.offensive.magic,
);

/**
 * An overview of all the equipment in the imported bank, with its stats, filterable by slot and sortable by any stat.
 */
const BankGearOverview: React.FC = observer(() => {
  const optimizer = useOptimizer();
  const { bank, excludedItemIds } = optimizer;

  const [slot, setSlot] = useState<keyof PlayerEquipment | 'all'>('all');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<{ key: SortKey, desc: boolean }>({ key: 'slot', desc: false });

  const owned = useMemo(() => (bank ? resolveOwnedEquipment(bank.items, []) : []), [bank]);

  const countsPerSlot = useMemo(() => {
    const counts: Partial<Record<keyof PlayerEquipment, number>> = {};
    for (const item of owned) counts[item.slot] = (counts[item.slot] ?? 0) + 1;
    return counts;
  }, [owned]);

  const rows = useMemo(() => {
    const query = search.trim().toLowerCase();
    const filtered = owned.filter((i) => (slot === 'all' || i.slot === slot) && (!query || i.name.toLowerCase().includes(query)));

    const dir = sort.desc ? -1 : 1;
    const column = COLUMNS.find((c) => c.key === sort.key);
    return filtered.sort((a, b) => {
      if (column) {
        const diff = column.get(a) - column.get(b);
        if (diff !== 0) return diff * dir;
      } else if (sort.key === 'slot') {
        const diff = SLOTS.indexOf(a.slot) - SLOTS.indexOf(b.slot);
        if (diff !== 0) return diff * dir;
        // within a slot, the strongest items first
        const attack = bestAttack(b) - bestAttack(a);
        if (attack !== 0) return attack;
      }
      return a.name.localeCompare(b.name) * (sort.key === 'name' ? dir : 1);
    });
  }, [owned, slot, search, sort]);

  // the best value of each stat among the shown items is highlighted
  const best = useMemo(() => Object.fromEntries(COLUMNS.map((c) => {
    const values = rows.map(c.get).filter((v) => v !== 0);
    if (values.length === 0) return [c.key, undefined];
    // lower is better for attack speed
    return [c.key, c.key === 'speed' ? Math.min(...values) : Math.max(...values)];
  })), [rows]);

  if (!bank) return null;

  const toggleSort = (key: SortKey) => {
    // stats start with the highest first, names and slots in their natural order
    const startDesc = key !== 'name' && key !== 'slot' && key !== 'speed';
    setSort((s) => (s.key === key ? { key, desc: !s.desc } : { key, desc: startDesc }));
  };

  const header = (key: SortKey, label: string, title: string, className = '') => (
    <th className={`px-1.5 py-1 font-bold whitespace-nowrap ${className}`}>
      <button
        type="button"
        className="inline-flex items-center gap-0.5 hover:text-orange-500"
        onClick={() => toggleSort(key)}
        data-tooltip-id="tooltip"
        data-tooltip-content={`${title} (click to sort)`}
      >
        {label}
        {sort.key === key && (sort.desc ? <IconChevronDown size={12} /> : <IconChevronUp size={12} />)}
      </button>
    </th>
  );

  return (
    <SectionAccordion
      defaultIsOpen={false}
      title={(
        <div className="flex items-center gap-2">
          <div className="w-6 flex justify-center"><LazyImage src={equipmentStats.src} /></div>
          <h3 className="font-serif font-bold">
            Bank Gear
          </h3>
        </div>
      )}
    >
      <div className="px-6 py-4 text-sm text-black dark:text-white">
        <p className="text-xs text-gray-500 dark:text-gray-300 mb-2">
          {`All ${owned.length} pieces of equipment in ${bank.fileName}. Click a column to sort by it; the best value of each stat among the shown items is highlighted.`}
        </p>
        <div className="flex flex-wrap items-center gap-1 mb-2">
          {(['all', ...SLOTS] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setSlot(s)}
              className={`px-2 py-0.5 rounded text-xs capitalize ${slot === s
                ? 'bg-orange-400 text-white'
                : 'bg-body-100 dark:bg-dark-400 hover:bg-body-200 dark:hover:bg-dark-200'}`}
            >
              {s === 'all' ? `All (${owned.length})` : `${s} (${countsPerSlot[s] ?? 0})`}
            </button>
          ))}
          <input
            type="search"
            className="form-control text-xs ml-auto w-48"
            placeholder="Search items..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="overflow-auto max-h-[600px]">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-tile dark:bg-dark-300 z-10">
              <tr className="text-left">
                {header('name', 'Item', 'Item name')}
                {header('slot', 'Slot', 'Equipment slot')}
                {COLUMNS.map((c) => header(c.key, c.label, c.title, 'text-right'))}
              </tr>
            </thead>
            <tbody>
              {rows.map((item) => {
                const excluded = excludedItemIds.includes(item.id);
                return (
                  <tr
                    key={item.id}
                    className={`border-t border-body-300 dark:border-dark-200 ${excluded ? 'opacity-50' : ''}`}
                  >
                    <td className="px-1.5 py-0.5">
                      <div className="flex items-center gap-1.5">
                        <span className="w-5 h-5 flex items-center justify-center shrink-0">
                          {item.image && <LazyImage responsive src={getCdnImage(`equipment/${item.image}`)} alt="" />}
                        </span>
                        <span
                          className={excluded ? 'line-through' : ''}
                          data-tooltip-id={excluded ? 'tooltip' : undefined}
                          data-tooltip-content={excluded ? 'Excluded from the gear search' : undefined}
                        >
                          {item.name}
                          {item.version && <span className="text-gray-400 dark:text-gray-300">{` #${item.version}`}</span>}
                        </span>
                      </div>
                    </td>
                    <td className="px-1.5 py-0.5 capitalize text-gray-500 dark:text-gray-300">{item.slot}</td>
                    {COLUMNS.map((c) => {
                      const v = c.get(item);
                      const isBest = v !== 0 && v === best[c.key];
                      let colour = '';
                      if (isBest) colour = 'font-bold text-green-600 dark:text-green-400';
                      else if (v < 0) colour = 'text-red-500';
                      else if (v === 0) colour = 'text-gray-400 dark:text-gray-500';
                      return (
                        <td key={c.key} className={`px-1.5 py-0.5 text-right tabular-nums ${colour}`}>
                          {c.format ? c.format(v) : v}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
          {rows.length === 0 && <p className="text-xs text-gray-500 dark:text-gray-300 py-2">No matching items.</p>}
        </div>
      </div>
    </SectionAccordion>
  );
});

export default BankGearOverview;
