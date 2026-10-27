import React, { useEffect, useMemo, useState } from 'react';
import { observer } from 'mobx-react-lite';
import { toJS } from 'mobx';
import { toast } from 'react-toastify';
import { IconTrash } from '@tabler/icons-react';
import { useStore } from '@/state';
import { useOptimizer } from '@/optimizerState';
import { useCalc } from '@/worker/CalcWorker';
import { OptimizeGearRequest, WorkerRequestType } from '@/worker/CalcWorkerTypes';
import SectionAccordion from '@/app/components/generic/SectionAccordion';
import Toggle from '@/app/components/generic/Toggle';
import Select from '@/app/components/generic/Select';
import NumberInput from '@/app/components/generic/NumberInput';
import LazyImage from '@/app/components/generic/LazyImage';
import Spinner from '@/app/components/Spinner';
import equipmentStats from '@/public/img/Equipment Stats.png';
import { resolveOwnedEquipment } from '@/lib/BankImport';
import {
  keptItemsCount, OPTIMIZER_STYLES, OptimizerProgress, OptimizerResult, OptimizerStyle, TrainingSkill, searchedStyles,
} from '@/lib/optimizer';
import { itemValue, priceIdsFor } from '@/lib/ItemPrices';
import { isDefined } from '@/utils';
import { PrayerMap } from '@/enums/Prayer';
import BankImportButton, { BankExportDirCopy } from '@/app/components/player/BankImportButton';
import { ALL_SPELLS, STYLE_LABELS } from './optimizer/constants';
import LoadoutRow, { SearchBase } from './optimizer/LoadoutRow';
import { ExcludedItems, ExcludedSpells, IgnoredAmmo } from './optimizer/Exclusions';
import SearchSummary from './optimizer/SearchSummary';
import PlayerSettings from './optimizer/PlayerSettings';
import WildernessOptions from './optimizer/WildernessOptions';

const TRAINING_OPTIONS: { label: string, value: TrainingSkill | undefined }[] = [
  { label: 'Any stance (highest DPS)', value: undefined },
  { label: 'Attack (Accurate)', value: 'attack' },
  { label: 'Strength (Aggressive)', value: 'strength' },
  { label: 'Defence (Defensive / Longrange)', value: 'defence' },
  { label: 'Shared (Controlled)', value: 'shared' },
];

const SPELL_OPTIONS: { label: string, value: string | undefined }[] = [
  { label: 'Any spell (highest DPS)', value: undefined },
  ...ALL_SPELLS.map((sp) => ({ label: sp.name, value: sp.name })),
];

const GearOptimizer: React.FC = observer(() => {
  const calc = useCalc();
  const store = useStore();
  const optimizer = useOptimizer();
  const { monster } = store;
  const { bank, settings } = optimizer;
  const {
    styles, training, spell, minWeight, locked, prayers, wilderness,
  } = settings;

  // the bank and the settings are saved in the browser
  useEffect(() => optimizer.load(), [optimizer]);

  const [isOpen, setIsOpen] = useState(true);
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
    data: OptimizerResult,
    inputsKey: string,
    elapsed: number,
    hadFilters: boolean,
    styles: OptimizerStyle[],
    spell?: string,
    base: SearchBase,
    wilderness: boolean,
  }>();

  const equippedIds = JSON.stringify(store.loadouts.flatMap((l) => Object.values(l.equipment)
    .filter(isDefined)
    .flatMap((e) => [e.id, e.itemVars?.blowpipeDartId].filter(isDefined))));

  // bank exports don't include worn items, so everything equipped in the loadouts is also considered
  const ownedAll = useMemo(() => {
    if (!bank) return [];
    return resolveOwnedEquipment(bank.items, JSON.parse(equippedIds));
  }, [bank, equippedIds]);

  const { excludedItemIds } = optimizer;
  const owned = useMemo(
    () => ownedAll.filter((i) => !excludedItemIds.includes(i.id)),
    [ownedAll, excludedItemIds],
  );

  const searchStyles = searchedStyles({ styles });
  const castSpell = searchStyles.includes('magic') ? spell : undefined;

  // the items the search can use, and their variants, which a price can come from
  const lockedItems = Object.values(locked).filter(isDefined);
  const itemIds = [...new Set([...owned, ...lockedItems].map((i) => i.id))];
  const priceIds = useMemo(() => [...new Set(itemIds.flatMap(priceIdsFor))], [JSON.stringify(itemIds)]); // eslint-disable-line react-hooks/exhaustive-deps

  // used to tell whether the results are out of date
  const inputsKey = JSON.stringify([
    toJS(monster), toJS(settings.skills), toJS(settings.boosts), toJS(settings.buffs), owned.map((o) => o.id), toJS(prayers),
    toJS(locked), training ?? null, castSpell ? null : toJS(optimizer.excludedSpells), minWeight, searchStyles, castSpell ?? null,
    toJS(optimizer.ignoredAmmo), wilderness.enabled ? toJS(wilderness) : null,
  ]);

  /** The GE values of the items the search can use, fetching the ones that aren't cached. */
  const loadValues = async (): Promise<Record<number, number> | undefined> => {
    try {
      await optimizer.loadItemPrices(priceIds);
    } catch (e) {
      console.error('[GearOptimizer] Failed to load prices', e);
      if (priceIds.some((id) => !optimizer.itemPrices[id])) {
        toast.error('Failed to load the GE prices for wilderness mode. Try again later.');
        return undefined;
      }
      toast.warn('Failed to refresh the GE prices, so older prices are used.');
    }
    const values: Record<number, number> = {};
    for (const id of itemIds) {
      const value = itemValue(id, optimizer.itemPrices);
      if (value !== undefined) values[id] = value;
    }
    return values;
  };

  const toggleStyle = (style: OptimizerStyle) => optimizer.updateSettings({
    styles: styles.includes(style) ? styles.filter((s) => s !== style) : [...styles, style],
  });

  const run = async () => {
    if (!calc.isReady() || owned.length === 0 || searchStyles.length === 0) return;

    const start = performance.now();
    setRunning({ start });
    setNow(start);
    setProgress(undefined);
    const player = optimizer.basePlayer;
    const values = wilderness.enabled ? await loadValues() : undefined;
    if (wilderness.enabled && !values) {
      setRunning(undefined);
      return;
    }
    const req: OptimizeGearRequest = {
      type: WorkerRequestType.OPTIMIZE_GEAR,
      data: {
        owned,
        player,
        monster: toJS(monster),
        opts: {
          prayers: toJS(prayers),
          locked: toJS(locked),
          training,
          excludedSpells: toJS(optimizer.excludedSpells),
          ignoredAmmo: toJS(optimizer.ignoredAmmo),
          spell: castSpell,
          minWeight,
          styles: searchStyles,
          wilderness: values && {
            maxRisk: wilderness.maxRisk,
            keptItems: keptItemsCount(wilderness),
            values,
            skipUntradeables: wilderness.skipUntradeables,
          },
        },
      },
    };

    try {
      const resp = await calc.do(req, { onProgress: setProgress });
      setResult({
        data: resp.payload,
        inputsKey,
        elapsed: performance.now() - start,
        hadFilters: Object.keys(locked).length > 0 || !!training || minWeight > 0 || !!values,
        styles: searchStyles,
        spell: castSpell,
        base: { skills: player.skills, boosts: player.boosts, buffs: player.buffs },
        wilderness: !!values,
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
        <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
          <div>
            {bank ? (
              <>
                <span className="font-bold">{bank.fileName}</span>
                {' '}
                <span className="text-gray-500 dark:text-gray-300">
                  {`${bank.items.length} items, ${ownedAll.length} usable equipment${ownedAll.length !== owned.length ? ` (${ownedAll.length - owned.length} excluded)` : ''}`}
                </span>
              </>
            ) : (
              <span className="text-gray-500 dark:text-gray-300">
                Import your bank to find the best gear you own against the selected monster. Use the upload button to choose
                a bank export CSV (with the columns ID, Name, Quantity), such as the one exported by the RuneLite Bank
                Memory or Dude Where&apos;s My Stuff plugins.
              </span>
            )}
          </div>
          <div className="flex items-center gap-1">
            <BankImportButton />
            {bank && (
              <button
                type="button"
                onClick={() => {
                  optimizer.clearBank();
                  setResult(undefined);
                }}
                className="text-body-500 dark:text-dark-100 hover:text-red transition-colors"
                data-tooltip-id="tooltip"
                data-tooltip-content="Remove imported bank"
              >
                <IconTrash aria-label="Remove imported bank" />
              </button>
            )}
          </div>
        </div>
        <div className="-mx-5 mb-3">
          <BankExportDirCopy />
        </div>
        <div className="flex flex-wrap gap-6 items-start">
          <PlayerSettings />
          <div className="flex-1 min-w-[280px] flex flex-wrap gap-x-6 items-start">
            <div className="flex-1 min-w-[260px]">
              <div className="mb-3">
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
                  onSelectedItemChange={(i) => optimizer.updateSettings({ training: i?.value })}
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
                    onChange={(v) => optimizer.updateSettings({ minWeight: Number.isFinite(v) ? v : 0 })}
                  />
                  <span className="text-xs text-gray-500 dark:text-gray-300">kg</span>
                </div>
              </div>
              <WildernessOptions priceIds={priceIds} />
            </div>
            {/* the first section's top margin is dropped, so that both columns line up */}
            <div className="flex-1 min-w-[260px] [&>*:first-child]:mt-0">
              <ExcludedItems owned={ownedAll} />
              {searchStyles.includes('ranged') && <IgnoredAmmo />}
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
                  onSelectedItemChange={(i) => optimizer.updateSettings({ spell: i?.value })}
                />
              </div>
              )}
              {searchStyles.includes('magic') && !castSpell && <ExcludedSpells />}
            </div>
          </div>
        </div>
        <p className="text-xs text-gray-500 dark:text-gray-300 my-3">
          {`Prayers: ${prayers.length > 0 ? prayers.map((p) => PrayerMap[p].name).join(', ') : 'none'}. `}
          {'Item and spell requirements are not checked. The search is not exhaustive: around each result it tries every '
            + 'combination of the most promising items per slot, so setups that need many unlikely items may be missed.'}
        </p>
        <div className="flex flex-wrap items-center justify-end gap-3 my-3">
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
          <button
            type="button"
            className="form-control font-bold"
            disabled={!!running || owned.length === 0 || searchStyles.length === 0}
            onClick={run}
            data-tooltip-id="tooltip"
            data-tooltip-content={`Search your bank for the best gear against ${monster.name}`}
          >
            Find best gear
          </button>
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
                      ? "No usable setups found with the locked slots, training choice, minimum weight and max risk (for example, the locked weapon can't attack with this style, has no stance that trains the chosen skill, or your gear for this style can't reach the minimum weight or stay within the max risk)."
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
                        <th
                          className="px-2 text-right whitespace-nowrap cursor-help underline decoration-dotted"
                          data-tooltip-id="tooltip"
                          data-tooltip-content="The average damage you take from the monster per kill, and per second below it. The search doesn't take it into account."
                        >
                          Dmg taken
                        </th>
                        {result.wilderness && (
                          <th
                            className="px-2 text-right cursor-help underline decoration-dotted"
                            data-tooltip-id="tooltip"
                            data-tooltip-content="The GE value you lose on death in the Wilderness, and the value of the whole set below it. The items with a shield are kept."
                          >
                            Risk
                          </th>
                        )}
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
                          next={result.data[style][i + 1]}
                          base={result.base}
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
      </div>
    </SectionAccordion>
  );
});

export default GearOptimizer;
