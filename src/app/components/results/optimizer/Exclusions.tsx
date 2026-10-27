import React, { useMemo } from 'react';
import { observer } from 'mobx-react-lite';
import { IconX } from '@tabler/icons-react';
import { useOptimizer } from '@/optimizerState';
import Combobox from '@/app/components/generic/Combobox';
import LazyImage from '@/app/components/generic/LazyImage';
import { resolveEquipment } from '@/lib/BankImport';
import { EquipmentPiece } from '@/types/Player';
import { getCdnImage, getWikiImage, isDefined } from '@/utils';
import { ALL_SPELLS } from './constants';

/**
 * Lets the user pick owned items that the search should never use.
 */
export const ExcludedItems: React.FC<{ owned: EquipmentPiece[] }> = observer(({ owned }) => {
  const optimizer = useOptimizer();
  const { excludedItemIds } = optimizer;

  const options = useMemo(() => owned
    .filter((i) => !excludedItemIds.includes(i.id))
    .map((i) => ({
      label: i.name, version: i.version, value: i.id, equipment: i,
    }))
    .sort((a, b) => a.label.localeCompare(b.label)), [owned, excludedItemIds]);

  const excluded = excludedItemIds
    .map((id) => owned.find((i) => i.id === id) || resolveEquipment(id))
    .filter(isDefined);

  return (
    <div className="my-3">
      <div className="font-bold mb-1">Excluded items</div>
      <p className="text-xs text-gray-500 dark:text-gray-300 mb-1.5">
        Items the search will never use, e.g. ones you don&apos;t want to risk or bring. You can also click any item in the
        results to exclude it. Locked slots still use their item, even if it is excluded.
      </p>
      <div className="max-w-sm">
        <Combobox
          id="gear-optimizer-exclude"
          items={options}
          placeholder="Search your items to exclude..."
          resetAfterSelect
          onSelectedItemChange={(i) => {
            if (i) optimizer.toggleExcludedItem(i.value);
          }}
          CustomItemComponent={({ item }) => (
            <div className="flex items-center gap-2">
              <div className="basis-4 flex justify-center h-[20px] w-auto">
                {item.equipment.image && <LazyImage responsive src={getCdnImage(`equipment/${item.equipment.image}`)} alt="" />}
              </div>
              <div>
                {item.label}
                {item.version && <span className="monster-version relative text-xs text-gray-400 dark:text-gray-300">{`#${item.version}`}</span>}
              </div>
            </div>
          )}
        />
      </div>
      {excluded.length > 0 && (
        <div className="flex flex-wrap items-center gap-1 mt-2">
          {excluded.map((item) => (
            <span
              key={item.id}
              className="flex items-center gap-1 pl-1 pr-0.5 py-0.5 rounded bg-body-100 dark:bg-dark-400 text-xs"
            >
              {item.image && (
                <span className="w-4 h-4 flex items-center justify-center">
                  <LazyImage responsive src={getCdnImage(`equipment/${item.image}`)} alt="" />
                </span>
              )}
              {item.name}
              <button
                type="button"
                className="text-gray-500 hover:text-red transition-colors"
                onClick={() => optimizer.toggleExcludedItem(item.id)}
                aria-label={`Stop excluding ${item.name}`}
                data-tooltip-id="tooltip"
                data-tooltip-content="Stop excluding this item"
              >
                <IconX size={14} />
              </button>
            </span>
          ))}
          <button
            type="button"
            className="form-control text-xs ml-1"
            onClick={() => optimizer.setExcludedItemIds([])}
          >
            Clear all
          </button>
        </div>
      )}
    </div>
  );
});

/**
 * The ammo (and blowpipe darts) that the search should never load.
 */
export const IgnoredAmmo: React.FC = observer(() => {
  const optimizer = useOptimizer();
  const { ignoredAmmo } = optimizer;

  return (
    <div className="my-3">
      <div className="font-bold mb-1">Ignored ammo</div>
      <p className="text-xs text-gray-500 dark:text-gray-300 mb-1.5">
        Ammo and blowpipe darts the search will never load, e.g. ones that are too expensive to burn. Click the × next to
        the ammo or dart of a result to ignore it. Unlike excluding an item, ignored darts can still be thrown, and the
        weapons that fired them still use other ammo.
      </p>
      {ignoredAmmo.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          {ignoredAmmo.map((name) => (
            <span
              key={name}
              className="flex items-center gap-1 pl-1 pr-0.5 py-0.5 rounded bg-body-100 dark:bg-dark-400 text-xs"
            >
              {name}
              <button
                type="button"
                className="text-gray-500 hover:text-red transition-colors"
                onClick={() => optimizer.toggleIgnoredAmmo(name)}
                aria-label={`Stop ignoring ${name}`}
                data-tooltip-id="tooltip"
                data-tooltip-content="Stop ignoring this ammo"
              >
                <IconX size={14} />
              </button>
            </span>
          ))}
          <button
            type="button"
            className="form-control text-xs ml-1"
            onClick={() => optimizer.setIgnoredAmmo([])}
          >
            Clear all
          </button>
        </div>
      )}
    </div>
  );
});

const elementalSpells = (spellClass: string) => (name: string) => new RegExp(`^(Wind|Water|Earth|Fire) ${spellClass}$`).test(name);
const ancientSpells = (spellClass: string) => (name: string) => new RegExp(`^(Smoke|Shadow|Blood|Ice) ${spellClass}$`).test(name);

/**
 * Groups of spells that can be excluded together. The spell data doesn't include rune costs, so they are grouped by
 * class instead (which mostly share their runes, e.g. surges all use wrath runes).
 */
const SPELL_CLASSES: { label: string, includes: (name: string) => boolean }[] = [
  { label: 'Strikes', includes: elementalSpells('Strike') },
  { label: 'Bolts', includes: elementalSpells('Bolt') },
  { label: 'Blasts', includes: elementalSpells('Blast') },
  { label: 'Waves', includes: elementalSpells('Wave') },
  { label: 'Surges', includes: elementalSpells('Surge') },
  { label: 'God spells', includes: (n) => ['Saradomin Strike', 'Claws of Guthix', 'Flames of Zamorak'].includes(n) },
  { label: 'Rushes', includes: ancientSpells('Rush') },
  { label: 'Bursts', includes: ancientSpells('Burst') },
  { label: 'Blitzes', includes: ancientSpells('Blitz') },
  { label: 'Barrages', includes: ancientSpells('Barrage') },
  { label: 'Demonbanes', includes: (n) => n.endsWith(' Demonbane') },
  { label: 'Grasps', includes: (n) => /^(Ghostly|Skeletal|Undead) Grasp$/.test(n) },
];

/**
 * Lets the user pick spells that the search should never use, e.g. because their runes are too expensive.
 */
export const ExcludedSpells: React.FC = observer(() => {
  const optimizer = useOptimizer();
  const { excludedSpells } = optimizer;

  const allSpells = ALL_SPELLS;
  const options = useMemo(() => allSpells
    .filter((sp) => !excludedSpells.includes(sp.name))
    .map((sp) => ({
      label: sp.name, version: sp.spellbook, value: sp.name, spell: sp,
    })), [allSpells, excludedSpells]);
  const excluded = excludedSpells.map((name) => allSpells.find((sp) => sp.name === name)).filter(isDefined);

  const classes = useMemo(() => SPELL_CLASSES.map((c) => ({
    ...c,
    names: allSpells.filter((sp) => c.includes(sp.name)).map((sp) => sp.name),
  })), [allSpells]);
  const toggleClass = (names: string[], isExcluded: boolean) => optimizer.setExcludedSpells(isExcluded
    ? excludedSpells.filter((n) => !names.includes(n))
    : [...excludedSpells, ...names]);

  return (
    <div className="my-3">
      <div className="font-bold mb-1">Excluded spells</div>
      <p className="text-xs text-gray-500 dark:text-gray-300 mb-1.5">
        Spells the search will never cast, e.g. ones whose runes are too expensive. You can also click the × next to a
        spell in the results. Powered staves (like the Warped sceptre) use their own built-in spell and aren&apos;t affected.
      </p>
      <div className="flex flex-wrap items-center gap-1 mb-2">
        <span className="text-xs text-gray-500 dark:text-gray-300 mr-1">Exclude a whole class:</span>
        {classes.map(({ label, names }) => {
          const isExcluded = names.length > 0 && names.every((n) => excludedSpells.includes(n));
          return (
            <button
              key={label}
              type="button"
              onClick={() => toggleClass(names, isExcluded)}
              className={`px-2 py-0.5 rounded text-xs ${isExcluded
                ? 'bg-red-400 text-white line-through'
                : 'bg-body-100 dark:bg-dark-400 hover:bg-body-200 dark:hover:bg-dark-200'}`}
              aria-pressed={isExcluded}
              data-tooltip-id="tooltip"
              data-tooltip-content={`${isExcluded ? 'Stop excluding' : 'Exclude'} ${names.join(', ')}`}
            >
              {label}
            </button>
          );
        })}
      </div>
      <div className="max-w-sm">
        <Combobox
          id="gear-optimizer-exclude-spell"
          items={options}
          placeholder="Search spells to exclude..."
          resetAfterSelect
          onSelectedItemChange={(i) => {
            if (i) optimizer.toggleExcludedSpell(i.value);
          }}
          CustomItemComponent={({ item }) => (
            <div className="flex items-center gap-2">
              <div className="basis-4 flex justify-center h-[20px] w-auto">
                {item.spell.image && <LazyImage responsive src={getWikiImage(item.spell.image)} alt="" />}
              </div>
              <div>
                {item.label}
                <span className="monster-version relative text-xs text-gray-400 dark:text-gray-300">{`#${item.version}`}</span>
              </div>
            </div>
          )}
        />
      </div>
      {excluded.length > 0 && (
        <div className="flex flex-wrap items-center gap-1 mt-2">
          {excluded.map((sp) => (
            <span
              key={sp.name}
              className="flex items-center gap-1 pl-1 pr-0.5 py-0.5 rounded bg-body-100 dark:bg-dark-400 text-xs"
            >
              {sp.image && (
                <span className="w-4 h-4 flex items-center justify-center">
                  <LazyImage responsive src={getWikiImage(sp.image)} alt="" />
                </span>
              )}
              {sp.name}
              <button
                type="button"
                className="text-gray-500 hover:text-red transition-colors"
                onClick={() => optimizer.toggleExcludedSpell(sp.name)}
                aria-label={`Stop excluding ${sp.name}`}
                data-tooltip-id="tooltip"
                data-tooltip-content="Stop excluding this spell"
              >
                <IconX size={14} />
              </button>
            </span>
          ))}
          <button
            type="button"
            className="form-control text-xs ml-1"
            onClick={() => optimizer.setExcludedSpells([])}
          >
            Clear all
          </button>
        </div>
      )}
    </div>
  );
});
