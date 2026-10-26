import React, { useEffect, useMemo, useState } from 'react';
import { observer } from 'mobx-react-lite';
import { toJS } from 'mobx';
import { toast } from 'react-toastify';
import { IconLock, IconTrash, IconX } from '@tabler/icons-react';
import { useStore } from '@/state';
import { useCalc } from '@/worker/CalcWorker';
import { OptimizeGearRequest, WorkerRequestType } from '@/worker/CalcWorkerTypes';
import SectionAccordion from '@/app/components/generic/SectionAccordion';
import Toggle from '@/app/components/generic/Toggle';
import Select from '@/app/components/generic/Select';
import Combobox from '@/app/components/generic/Combobox';
import NumberInput from '@/app/components/generic/NumberInput';
import LazyImage from '@/app/components/generic/LazyImage';
import Spinner from '@/app/components/Spinner';
import equipmentStats from '@/public/img/Equipment Stats.png';
import headSlot from '@/public/img/slots/head.png';
import capeSlot from '@/public/img/slots/cape.png';
import neckSlot from '@/public/img/slots/neck.png';
import ammoSlot from '@/public/img/slots/ammo.png';
import weaponSlot from '@/public/img/slots/weapon.png';
import bodySlot from '@/public/img/slots/body.png';
import shieldSlot from '@/public/img/slots/shield.png';
import legsSlot from '@/public/img/slots/legs.png';
import handsSlot from '@/public/img/slots/hands.png';
import feetSlot from '@/public/img/slots/feet.png';
import ringSlot from '@/public/img/slots/ring.png';
import { resolveEquipment, resolveOwnedEquipment } from '@/lib/BankImport';
import {
  LoadoutAlternative, OPTIMIZER_STYLES, OptimizedLoadout, OptimizerJob, OptimizerProgress, OptimizerResult, OptimizerStyle,
  StyleSearchSummary, TrainingSkill, searchedStyles,
} from '@/lib/GearOptimizer';
import { EquipmentPiece, PlayerEquipment } from '@/types/Player';
import { getCdnImage, getWikiImage, isDefined } from '@/utils';
import { spells } from '@/types/Spell';

const DISPLAY_SLOTS: (keyof PlayerEquipment)[] = [
  'head', 'cape', 'neck', 'ammo', 'weapon', 'body', 'shield', 'legs', 'hands', 'feet', 'ring',
];

const SLOT_PLACEHOLDERS: { [k in keyof PlayerEquipment]: string } = {
  head: headSlot.src,
  cape: capeSlot.src,
  neck: neckSlot.src,
  ammo: ammoSlot.src,
  weapon: weaponSlot.src,
  body: bodySlot.src,
  shield: shieldSlot.src,
  legs: legsSlot.src,
  hands: handsSlot.src,
  feet: feetSlot.src,
  ring: ringSlot.src,
};

const TRAINING_OPTIONS: { label: string, value: TrainingSkill | undefined }[] = [
  { label: 'Any stance (highest DPS)', value: undefined },
  { label: 'Attack (Accurate)', value: 'attack' },
  { label: 'Strength (Aggressive)', value: 'strength' },
  { label: 'Defence (Defensive / Longrange)', value: 'defence' },
  { label: 'Shared (Controlled)', value: 'shared' },
];

const STYLE_LABELS: { [k in OptimizerStyle]: string } = {
  melee: 'Melee',
  ranged: 'Ranged',
  magic: 'Magic',
};

/** Every spell once (some are listed for multiple spellbooks), by name. */
const ALL_SPELLS = [...new Map(spells.map((sp) => [sp.name, sp])).values()].sort((a, b) => a.name.localeCompare(b.name));

const SPELL_OPTIONS: { label: string, value: string | undefined }[] = [
  { label: 'Any spell (highest DPS)', value: undefined },
  ...ALL_SPELLS.map((sp) => ({ label: sp.name, value: sp.name })),
];

const weaponLabel = (l: OptimizedLoadout) => {
  const w = l.equipment.weapon;
  if (!w) return 'Unarmed';
  const dart = w.itemVars?.blowpipeDartName;
  return dart ? `${w.name} (${dart})` : w.name;
};

const attackLabel = (l: OptimizedLoadout) => {
  const parts = [`${l.style.name} (${l.style.stance})`];
  if (l.style.type === 'ranged' && l.equipment.ammo) parts.push(l.equipment.ammo.name);
  return parts.join(' · ');
};

// magic damage is stored in tenths of a percent
const STAT_LABELS: [string, (i: EquipmentPiece) => number][] = [
  ['stab', (i) => i.offensive.stab],
  ['slash', (i) => i.offensive.slash],
  ['crush', (i) => i.offensive.crush],
  ['str', (i) => i.bonuses.str],
  ['ranged', (i) => i.offensive.ranged],
  ['ranged str', (i) => i.bonuses.ranged_str],
  ['magic', (i) => i.offensive.magic],
  ['% magic dmg', (i) => i.bonuses.magic_str / 10],
  ['def', (i) => i.defensive.stab + i.defensive.slash + i.defensive.crush + i.defensive.magic + i.defensive.ranged],
  ['prayer', (i) => i.bonuses.prayer],
];

/** e.g. "+1 str, -27 def" for the change from one item to another. */
const statDiff = (from: EquipmentPiece | null, to: EquipmentPiece): string => STAT_LABELS
  .map(([label, get]): [string, number] => [label, get(to) - (from ? get(from) : 0)])
  .filter(([, d]) => d !== 0)
  .map(([label, d]) => `${d > 0 ? '+' : ''}${Number(d.toFixed(1))} ${label}`)
  .join(', ');

const alternativeTooltip = (loadout: OptimizedLoadout, alt: LoadoutAlternative) => {
  const chosen = loadout.equipment[alt.slot];
  const parts = [
    `${alt.item.name} instead of ${chosen ? chosen.name : 'nothing'} (${alt.slot}): same DPS right now.`,
    `Stats: ${statDiff(chosen, alt.item)}.`,
    alt.betterAfterDrain
      ? `Better once your boosts drain by ${alt.betterAfterDrain.levels} level${alt.betterAfterDrain.levels === 1 ? '' : 's'} (+${alt.betterAfterDrain.dpsGain.toFixed(3)} DPS).`
      : 'Does not become better as your boosts drain.',
    'Click to apply the loadout with this item.',
  ];
  return parts.join(' ');
};

const LoadoutRow: React.FC<{ loadout: OptimizedLoadout, rank: number, canCreateLoadout: boolean }> = observer(({ loadout, rank, canCreateLoadout }) => {
  const store = useStore();

  return (
    <tr className="border-t border-body-300 dark:border-dark-200">
      <td className="px-2 py-1 text-gray-500 dark:text-gray-300">{rank}</td>
      <td className="px-2 py-1">
        <div className="font-bold flex items-center gap-1">
          {weaponLabel(loadout)}
          {loadout.equipment.weapon && (
            <button
              type="button"
              className="text-gray-500 dark:text-gray-300 hover:text-red transition-colors"
              onClick={() => store.toggleExcludedItem(loadout.equipment.weapon!.id)}
              aria-label={`Exclude ${loadout.equipment.weapon.name}`}
              data-tooltip-id="tooltip"
              data-tooltip-content={`Exclude ${loadout.equipment.weapon.name} from future searches`}
            >
              <IconX size={14} />
            </button>
          )}
        </div>
        <div className="text-xs text-gray-500 dark:text-gray-300 flex flex-wrap items-center gap-x-1">
          {attackLabel(loadout)}
          {loadout.spell && (
            <>
              {' · '}
              <span>{loadout.spell.name}</span>
              <button
                type="button"
                className="hover:text-red transition-colors"
                onClick={() => store.toggleExcludedSpell(loadout.spell!.name)}
                aria-label={`Exclude ${loadout.spell.name}`}
                data-tooltip-id="tooltip"
                data-tooltip-content={`Exclude ${loadout.spell.name} from future searches`}
              >
                <IconX size={12} />
              </button>
            </>
          )}
        </div>
      </td>
      <td className="px-2 py-1">
        <div className="flex flex-wrap gap-0.5">
          {DISPLAY_SLOTS.map((slot) => {
            const item = loadout.equipment[slot];
            if (!item) {
              return (
                <div
                  key={slot}
                  className="w-7 h-7 bg-body-100 dark:bg-dark-400 rounded"
                  data-tooltip-id="tooltip"
                  data-tooltip-content={`${slot}: (empty)`}
                />
              );
            }
            return (
              <button
                key={slot}
                type="button"
                className="w-7 h-7 flex items-center justify-center bg-body-100 dark:bg-dark-400 rounded hover:ring-2 hover:ring-red-400"
                data-tooltip-id="tooltip"
                data-tooltip-content={`${slot}: ${item.name} (click to exclude it from future searches)`}
                aria-label={`Exclude ${item.name}`}
                onClick={() => store.toggleExcludedItem(item.id)}
              >
                {item.image && <LazyImage responsive src={getCdnImage(`equipment/${item.image}`)} alt={item.name} />}
              </button>
            );
          })}
        </div>
        {loadout.alternatives.length > 0 && (
          <div className="flex flex-wrap items-center gap-1 mt-1 text-xs text-gray-500 dark:text-gray-300">
            <span
              data-tooltip-id="tooltip"
              data-tooltip-content="Items that give the same DPS right now, but trade defence for offensive stats that may help once your boosts drain."
            >
              Same DPS:
            </span>
            {loadout.alternatives.map((alt) => (
              <button
                key={`${alt.slot}-${alt.item.id}`}
                type="button"
                className="flex items-center gap-1 pl-0.5 pr-1 rounded bg-body-100 dark:bg-dark-400 hover:ring-2 hover:ring-orange-400"
                data-tooltip-id="tooltip"
                data-tooltip-content={alternativeTooltip(loadout, alt)}
                onClick={() => store.applyOptimizedLoadout({ ...loadout, equipment: { ...loadout.equipment, [alt.slot]: alt.item } }, false)}
              >
                <span className="w-4 h-4 flex items-center justify-center">
                  {alt.item.image && <LazyImage responsive src={getCdnImage(`equipment/${alt.item.image}`)} alt="" />}
                </span>
                {alt.item.name}
                {alt.betterAfterDrain && <span className="text-orange-500">{`(−${alt.betterAfterDrain.levels} lvl)`}</span>}
              </button>
            ))}
          </div>
        )}
      </td>
      <td className="px-2 py-1 text-right font-bold">{loadout.dps.toFixed(3)}</td>
      <td className="px-2 py-1 text-right">{loadout.maxHit}</td>
      <td className="px-2 py-1 text-right">{`${(loadout.accuracy * 100).toFixed(2)}%`}</td>
      <td className="px-2 py-1 text-right whitespace-nowrap">{`${loadout.weight.toFixed(1)} kg`}</td>
      <td className="px-2 py-1">
        <div className="flex gap-1 justify-end">
          <button
            type="button"
            className="form-control text-xs whitespace-nowrap"
            onClick={() => store.applyOptimizedLoadout(loadout, false)}
          >
            Apply
          </button>
          <button
            type="button"
            className="form-control text-xs whitespace-nowrap"
            disabled={!canCreateLoadout}
            onClick={() => store.applyOptimizedLoadout(loadout, true)}
            data-tooltip-id="tooltip"
            data-tooltip-content={canCreateLoadout ? 'Apply as a new loadout' : 'You have the maximum number of loadouts'}
          >
            New loadout
          </button>
        </div>
      </td>
    </tr>
  );
});

/**
 * Lets the user pick owned items that the search should never use.
 */
const ExcludedItems: React.FC<{ owned: EquipmentPiece[] }> = observer(({ owned }) => {
  const store = useStore();
  const { excludedItemIds } = store;

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
            if (i) store.toggleExcludedItem(i.value);
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
                onClick={() => store.toggleExcludedItem(item.id)}
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
            onClick={() => store.setExcludedItemIds([])}
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
const ExcludedSpells: React.FC = observer(() => {
  const store = useStore();
  const { excludedSpells } = store;

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
  const toggleClass = (names: string[], isExcluded: boolean) => store.setExcludedSpells(isExcluded
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
            if (i) store.toggleExcludedSpell(i.value);
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
                onClick={() => store.toggleExcludedSpell(sp.name)}
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
            onClick={() => store.setExcludedSpells([])}
          >
            Clear all
          </button>
        </div>
      )}
    </div>
  );
});

const fmt = (n: number) => n.toLocaleString();

/** The steps of the search, in order, with the jobs that make them up. */
const SEARCH_STEPS: {
  label: string,
  help: string,
  kinds: OptimizerJob['kind'][],
  detail: (s: StyleSearchSummary) => string,
}[] = [
  {
    label: 'Screening',
    help: 'Every weapon with its best stance, ammo and spell: first with no armour, then with an armour set built around the best weapon, to rank them.',
    kinds: ['plan'],
    detail: (s) => `${fmt(s.weaponsScreened)} weapons${s.spells > 0 ? `, ${s.spells} spells` : ''}`,
  },
  {
    label: 'Armour search',
    help: 'For each of the best weapons, swaps one armour slot at a time while that improves DPS. Also starts from any armour sets you own (void etc.), and with a minimum weight, from setups that spread the weight differently.',
    kinds: ['refine'],
    detail: (s) => `${fmt(s.weaponsRefined)} weapons${s.setStarts > 0 ? ` + ${s.setStarts} set starts` : ''}`,
  },
  {
    label: 'Two-slot swaps',
    help: 'Tries changing every pair of armour slots at once around the best results, to escape setups where no single swap helps.',
    kinds: ['pairSwap'],
    detail: (s) => `${fmt(s.pairSwapped)} results`,
  },
  {
    label: 'Combinations',
    help: 'Around each shown result, tries every combination of the most promising items per slot, which finds improvements that need many slots to change at once.',
    kinds: ['shortlist', 'exhaust'],
    detail: (s) => `${fmt(s.exhaustiveCombinations)} tried, ${s.exhaustiveImprovements} improved`,
  },
  {
    label: 'Final pass',
    help: 'A last round of single swaps and style and spell changes, and the search for equal-DPS alternatives (including how they hold up as boosts drain).',
    kinds: ['describe'],
    detail: () => '',
  },
];

/**
 * A summary of what the search simulated, per style and step.
 */
const SearchSummary: React.FC<{ result: OptimizerResult, elapsed: number }> = ({ result, elapsed }) => {
  const { summary } = result;
  const styles = OPTIMIZER_STYLES.filter((style) => summary[style]);
  const stepEvaluations = (style: OptimizerStyle, kinds: OptimizerJob['kind'][]) => kinds
    .reduce((n, k) => n + (summary[style]!.evaluations[k] ?? 0), 0);
  const styleTotal = (style: OptimizerStyle) => Object.values(summary[style]!.evaluations).reduce((a, b) => a + b, 0);
  const armourSlots = DISPLAY_SLOTS.filter((s) => s !== 'weapon');

  return (
    <details className="mb-4 text-xs">
      <summary className="cursor-pointer text-gray-500 dark:text-gray-300 hover:text-black dark:hover:text-white">
        {`What was simulated: ${fmt(result.evaluations)} setups in ${(elapsed / 1000).toFixed(1)}s`}
      </summary>
      <div className="overflow-x-auto mt-2">
        <table className="text-xs">
          <thead>
            <tr className="text-left">
              <th className="px-2 py-1">Step</th>
              {styles.map((style) => <th key={style} className="px-2 py-1 text-right">{STYLE_LABELS[style]}</th>)}
            </tr>
          </thead>
          <tbody>
            {SEARCH_STEPS.map((step) => (
              <tr key={step.label} className="border-t border-body-300 dark:border-dark-200 align-top">
                <td className="px-2 py-1">
                  <span className="underline decoration-dotted" data-tooltip-id="tooltip" data-tooltip-content={step.help}>{step.label}</span>
                </td>
                {styles.map((style) => (
                  <td key={style} className="px-2 py-1 text-right tabular-nums">
                    <div>{`${fmt(stepEvaluations(style, step.kinds))} sims`}</div>
                    <div className="text-gray-500 dark:text-gray-300">{step.detail(summary[style]!)}</div>
                  </td>
                ))}
              </tr>
            ))}
            <tr className="border-t border-body-300 dark:border-dark-200 font-bold">
              <td className="px-2 py-1">Total</td>
              {styles.map((style) => (
                <td key={style} className="px-2 py-1 text-right tabular-nums">{`${fmt(styleTotal(style))} sims`}</td>
              ))}
            </tr>
          </tbody>
        </table>
        <div className="font-bold mt-3 mb-1">Items tried per slot</div>
        <p className="text-gray-500 dark:text-gray-300 mb-1">
          Items that are never better than another item you own for that style (in every relevant stat) are skipped,
          unless they have a special effect. Ammo is compared per weapon (the count is the most tried with any one
          weapon), and for weapons that don&apos;t use ammo only its defence and prayer bonuses count.
        </p>
        <table className="text-xs">
          <thead>
            <tr>
              <th className="px-2 py-1 text-left">Style</th>
              {armourSlots.map((slot) => (
                <th key={slot} className="px-1 py-1">
                  <div className="w-5 h-5 mx-auto" data-tooltip-id="tooltip" data-tooltip-content={slot}>
                    <LazyImage responsive src={SLOT_PLACEHOLDERS[slot]} alt={slot} />
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {styles.map((style) => (
              <tr key={style} className="border-t border-body-300 dark:border-dark-200">
                <td className="px-2 py-1">{STYLE_LABELS[style]}</td>
                {armourSlots.map((slot) => (
                  <td key={slot} className="px-1 py-1 text-center tabular-nums">{summary[style]!.candidatesPerSlot[slot] ?? 0}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
};

interface ISlotLocksProps {
  equipment: PlayerEquipment;
  lockedSlots: (keyof PlayerEquipment)[];
  setLockedSlots: (slots: (keyof PlayerEquipment)[]) => void;
}

/**
 * Lets the user pick slots of the current loadout to keep fixed while the rest of the gear is searched.
 */
const SlotLocks: React.FC<ISlotLocksProps> = observer(({ equipment, lockedSlots, setLockedSlots }) => {
  const toggle = (slot: keyof PlayerEquipment) => setLockedSlots(
    lockedSlots.includes(slot) ? lockedSlots.filter((s) => s !== slot) : [...lockedSlots, slot],
  );

  return (
    <div className="my-3">
      <div className="font-bold mb-1">Locked slots</div>
      <p className="text-xs text-gray-500 dark:text-gray-300 mb-1.5">
        Click a slot to keep the current loadout&apos;s item in it (or keep it empty). The search only changes the unlocked slots.
      </p>
      <div className="flex flex-wrap items-center gap-1">
        {DISPLAY_SLOTS.map((slot) => {
          const item = equipment[slot];
          const isLocked = lockedSlots.includes(slot);
          const label = `${slot}: ${item ? item.name : '(empty)'}${isLocked ? ' — locked' : ''}`;
          return (
            <button
              key={slot}
              type="button"
              onClick={() => toggle(slot)}
              className={`relative w-9 h-9 p-1 rounded border-2 flex items-center justify-center transition-colors ${isLocked
                ? 'border-orange-400 bg-orange-200 dark:bg-orange-900'
                : 'border-transparent bg-body-100 dark:bg-dark-400 hover:border-body-300 dark:hover:border-dark-200'}`}
              data-tooltip-id="tooltip"
              data-tooltip-content={label}
              aria-label={label}
              aria-pressed={isLocked}
            >
              <LazyImage
                responsive
                src={item?.image ? getCdnImage(`equipment/${item.image}`) : SLOT_PLACEHOLDERS[slot]}
                alt=""
              />
              {isLocked && <IconLock size={14} className="absolute -top-1.5 -right-1.5 text-orange-500" />}
            </button>
          );
        })}
      </div>
    </div>
  );
});

const GearOptimizer: React.FC = observer(() => {
  const calc = useCalc();
  const store = useStore();
  const { bank, player, monster } = store;

  const [isOpen, setIsOpen] = useState(true);
  const [includeEquipped, setIncludeEquipped] = useState(true);
  const [prayerUnlocks, setPrayerUnlocks] = useState(true);
  const [usePrayers, setUsePrayers] = useState(false);
  const [lockedSlots, setLockedSlots] = useState<(keyof PlayerEquipment)[]>([]);
  const [training, setTraining] = useState<TrainingSkill | undefined>(undefined);
  const [styles, setStyles] = useState<OptimizerStyle[]>(OPTIMIZER_STYLES);
  const [spell, setSpell] = useState<string | undefined>(undefined);
  const [minWeight, setMinWeight] = useState(0);
  const [running, setRunning] = useState<{ start: number }>();
  const [progress, setProgress] = useState<OptimizerProgress>();
  const [now, setNow] = useState(0);

  // tick a timer while the search runs, so that long searches don't look stuck
  useEffect(() => {
    if (!running) return undefined;
    const interval = setInterval(() => setNow(performance.now()), 500);
    return () => clearInterval(interval);
  }, [running]);
  const [result, setResult] = useState<{
    data: OptimizerResult, inputsKey: string, elapsed: number, hadFilters: boolean, styles: OptimizerStyle[], spell?: string,
  }>();

  const equippedIds = JSON.stringify(store.loadouts.flatMap((l) => Object.values(l.equipment)
    .filter(isDefined)
    .flatMap((e) => [e.id, e.itemVars?.blowpipeDartId].filter(isDefined))));

  const ownedAll = useMemo(() => {
    if (!bank) return [];
    return resolveOwnedEquipment(bank.items, includeEquipped ? JSON.parse(equippedIds) : []);
  }, [bank, includeEquipped, equippedIds]);

  const { excludedItemIds } = store;
  const owned = useMemo(
    () => ownedAll.filter((i) => !excludedItemIds.includes(i.id)),
    [ownedAll, excludedItemIds],
  );

  // the locked slots take whatever is in the current loadout
  const locked: Partial<PlayerEquipment> = {};
  for (const slot of lockedSlots) {
    locked[slot] = toJS(player.equipment[slot]);
  }

  const searchStyles = searchedStyles({ styles });
  const castSpell = searchStyles.includes('magic') ? spell : undefined;

  // used to tell whether the results are out of date
  const inputsKey = JSON.stringify([
    toJS(monster), toJS(player.skills), toJS(player.boosts), toJS(player.buffs), owned.map((o) => o.id), prayerUnlocks, usePrayers, locked, training ?? null,
    castSpell ? null : toJS(store.excludedSpells), minWeight, searchStyles, castSpell ?? null,
  ]);

  const toggleStyle = (style: OptimizerStyle) => setStyles(styles.includes(style)
    ? styles.filter((s) => s !== style)
    : [...styles, style]);

  const run = async () => {
    if (!calc.isReady() || owned.length === 0 || searchStyles.length === 0) return;

    const start = performance.now();
    setRunning({ start });
    setNow(start);
    setProgress(undefined);
    const req: OptimizeGearRequest = {
      type: WorkerRequestType.OPTIMIZE_GEAR,
      data: {
        owned,
        player: toJS(player),
        monster: toJS(monster),
        opts: {
          prayerUnlocks,
          noPrayers: !usePrayers,
          locked,
          training,
          excludedSpells: toJS(store.excludedSpells),
          spell: castSpell,
          minWeight,
          styles: searchStyles,
        },
      },
    };

    try {
      const resp = await calc.do(req, { onProgress: setProgress });
      setResult({
        data: resp.payload,
        inputsKey,
        elapsed: performance.now() - start,
        hadFilters: lockedSlots.length > 0 || !!training || minWeight > 0,
        styles: searchStyles,
        spell: castSpell,
      });
    } catch (e) {
      console.error('[GearOptimizer] Failed to optimize gear', e);
      toast.error('Failed to find the best gear. See the browser console for details.');
    } finally {
      setRunning(undefined);
    }
  };

  const isStale = result && result.inputsKey !== inputsKey;

  return (
    <SectionAccordion
      defaultIsOpen={isOpen}
      onIsOpenChanged={setIsOpen}
      title={(
        <div className="flex items-center gap-2">
          <div className="w-6 flex justify-center"><LazyImage src={equipmentStats.src} /></div>
          <h3 className="font-serif font-bold">
            Find Best Gear
          </h3>
        </div>
      )}
    >
      <div className="px-6 py-4 text-sm text-black dark:text-white">
        {!bank ? (
          <p>
            Import your bank to find the best gear you own against the selected monster. Click the upload icon next to the
            loadout name and choose a bank export CSV (with the columns ID, Name, Quantity), such as the one exported by the
            RuneLite Bank Memory or Dude Where&apos;s My Stuff plugins.
          </p>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
              <div>
                <span className="font-bold">{bank.fileName}</span>
                {' '}
                <span className="text-gray-500 dark:text-gray-300">
                  {`${bank.items.length} items, ${ownedAll.length} usable equipment${ownedAll.length !== owned.length ? ` (${ownedAll.length - owned.length} excluded)` : ''}`}
                </span>
              </div>
              <button
                type="button"
                onClick={() => {
                  store.clearBank();
                  setResult(undefined);
                }}
                className="text-body-500 dark:text-dark-100 hover:text-red transition-colors"
                data-tooltip-id="tooltip"
                data-tooltip-content="Remove imported bank"
              >
                <IconTrash aria-label="Remove imported bank" />
              </button>
            </div>
            <div className="flex flex-wrap gap-x-6 items-center">
              <Toggle
                checked={includeEquipped}
                setChecked={setIncludeEquipped}
                label="Include items worn in your loadouts"
                help="Bank exports don't include worn items. Enable this to also consider everything equipped in your loadouts."
              />
              <Toggle
                checked={usePrayers}
                setChecked={setUsePrayers}
                label="Use offensive prayers"
                help="If disabled, no offensive prayers are used, and applying a result turns off the loadout's offensive prayers."
              />
              <Toggle
                checked={prayerUnlocks}
                setChecked={setPrayerUnlocks}
                disabled={!usePrayers}
                label="Rigour & Augury unlocked"
                help="If disabled, Eagle Eye and Mystic Might are used for ranged and magic instead."
              />
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-300 my-2">
              {`Uses the current loadout's levels, potions and buffs, with ${
                // eslint-disable-next-line no-nested-ternary
                !usePrayers ? 'no offensive prayers' : prayerUnlocks ? 'Piety, Rigour and Augury' : 'Piety, Eagle Eye and Mystic Might'}. `}
              {'Item and spell requirements are not checked. The search is not exhaustive: around each result it tries every '
                + 'combination of the most promising items per slot, so setups that need many unlikely items may be missed.'}
            </p>
            <div className="my-3">
              <div className="font-bold mb-1">Styles</div>
              <p className="text-xs text-gray-500 dark:text-gray-300 mb-1.5">
                Only search the selected combat styles. Fewer styles make the search faster.
              </p>
              <div className="flex flex-wrap gap-x-6 items-center">
                {OPTIMIZER_STYLES.map((style) => (
                  <Toggle
                    key={style}
                    checked={styles.includes(style)}
                    setChecked={() => toggleStyle(style)}
                    label={STYLE_LABELS[style]}
                  />
                ))}
              </div>
            </div>
            <div className="my-3 max-w-sm">
              <div className="font-bold mb-1">Train</div>
              <p className="text-xs text-gray-500 dark:text-gray-300 mb-1.5">
                Only use attack stances that give experience in this skill. Attack, Strength and Shared apply to melee;
                Defence also applies to ranged (Longrange) and magic (Defensive Autocast).
              </p>
              <Select
                id="gear-optimizer-training"
                items={TRAINING_OPTIONS}
                value={TRAINING_OPTIONS.find((o) => o.value === training)}
                onSelectedItemChange={(i) => setTraining(i?.value)}
              />
            </div>
            <div className="my-3">
              <div className="font-bold mb-1">Minimum gear weight</div>
              <p className="text-xs text-gray-500 dark:text-gray-300 mb-1.5">
                Only return setups whose equipment weighs at least this much (in kg), for content that requires it. Set to 0
                to ignore weight. A minimum weight makes the search go deeper, so it takes longer.
              </p>
              <div className="flex items-center gap-2">
                <NumberInput
                  id="gear-optimizer-min-weight"
                  className="form-control w-20"
                  value={minWeight}
                  min={0}
                  max={500}
                  step={0.1}
                  onChange={(v) => setMinWeight(Number.isFinite(v) ? v : 0)}
                />
                <span className="text-xs text-gray-500 dark:text-gray-300">kg</span>
              </div>
            </div>
            <SlotLocks equipment={player.equipment} lockedSlots={lockedSlots} setLockedSlots={setLockedSlots} />
            <ExcludedItems owned={ownedAll} />
            {searchStyles.includes('magic') && (
              <div className="my-3 max-w-sm">
                <div className="font-bold mb-1">Spell</div>
                <p className="text-xs text-gray-500 dark:text-gray-300 mb-1.5">
                  Only cast this spell with magic. Powered staves then only manually cast it, instead of using their built-in spell.
                </p>
                <Select
                  id="gear-optimizer-spell"
                  items={SPELL_OPTIONS}
                  value={SPELL_OPTIONS.find((o) => o.value === spell)}
                  onSelectedItemChange={(i) => setSpell(i?.value)}
                />
              </div>
            )}
            {searchStyles.includes('magic') && !castSpell && <ExcludedSpells />}
            <div className="flex flex-wrap items-center gap-3 my-3">
              <button
                type="button"
                className="form-control font-bold"
                disabled={!!running || owned.length === 0 || searchStyles.length === 0}
                onClick={run}
              >
                {`Find best gear vs ${monster.name}`}
              </button>
              {running && (
                <span className="flex items-center text-xs text-gray-500 dark:text-gray-300">
                  <Spinner className="w-5" />
                  {`Searching${progress ? ` (${progress.stylesDone}/${searchStyles.length} styles done)` : ''}... `}
                  {`${(progress?.evaluations ?? 0).toLocaleString()} setups simulated · ${Math.max(0, (now - running.start) / 1000).toFixed(0)}s`}
                </span>
              )}
              {result && !running && (
                <span className={`text-xs ${isStale ? 'text-orange-500' : 'text-gray-500 dark:text-gray-300'}`}>
                  {isStale
                    ? 'Inputs have changed since this search. Run it again to update the results.'
                    : `Searched ${result.data.evaluations.toLocaleString()} setups in ${(result.elapsed / 1000).toFixed(1)}s`}
                </span>
              )}
            </div>
            {result && (
              <div className={`overflow-x-auto ${isStale ? 'opacity-60' : ''}`}>
                {result.data.summary && <SearchSummary result={result.data} elapsed={result.elapsed} />}
                {result.styles.map((style) => (
                  <div key={style} className="mb-4">
                    <h4 className="font-serif font-bold mb-1">
                      {STYLE_LABELS[style]}
                      {style === 'magic' && result.spell && (
                        <span className="font-sans font-normal text-xs text-gray-500 dark:text-gray-300">{` (${result.spell} only)`}</span>
                      )}
                    </h4>
                    {result.data[style].length === 0 ? (
                      <p className="text-gray-500 dark:text-gray-300">
                        {/* eslint-disable-next-line no-nested-ternary */}
                        {result.hadFilters
                          ? "No usable setups found with the locked slots, training choice and minimum weight (for example, the locked weapon can't attack with this style, has no stance that trains the chosen skill, or your gear for this style can't reach the minimum weight)."
                          : style === 'magic' && result.spell
                            ? `No usable setups found that can cast ${result.spell}.`
                            : 'No usable setups found.'}
                      </p>
                    ) : (
                      <table className="w-full">
                        <thead>
                          <tr className="text-left text-xs text-gray-500 dark:text-gray-300">
                            <th className="px-2">#</th>
                            <th className="px-2">Weapon</th>
                            <th className="px-2">Equipment</th>
                            <th className="px-2 text-right">DPS</th>
                            <th className="px-2 text-right">Max hit</th>
                            <th className="px-2 text-right">Accuracy</th>
                            <th className="px-2 text-right">Weight</th>
                            <th className="px-2"><span className="sr-only">Actions</span></th>
                          </tr>
                        </thead>
                        <tbody>
                          {result.data[style].map((l, i) => (
                            <LoadoutRow
                              // eslint-disable-next-line react/no-array-index-key
                              key={i}
                              loadout={l}
                              rank={i + 1}
                              canCreateLoadout={store.canCreateLoadout}
                            />
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </SectionAccordion>
  );
});

export default GearOptimizer;
