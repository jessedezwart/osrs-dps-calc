import React, { useEffect, useState } from 'react';
import { observer } from 'mobx-react-lite';
import { toast } from 'react-toastify';
import { IconRefresh } from '@tabler/icons-react';
import { useOptimizer } from '@/optimizerState';
import Toggle from '@/app/components/generic/Toggle';
import { keptItemsCount } from '@/lib/optimizer';
import { formatGp, parseGp } from '@/lib/ItemPrices';
import { isDefined } from '@/utils';

/** An amount of gp, typed like 500k or 1.2m. The value is only changed once the input is valid. */
const GpInput: React.FC<{ id: string, label: string, value: number, onChange: (gp: number) => void }> = ({
  id, label, value, onChange,
}) => {
  const [text, setText] = useState(formatGp(value));
  useEffect(() => setText(formatGp(value)), [value]);
  const valid = Number.isFinite(parseGp(text));

  return (
    <input
      id={id}
      type="text"
      aria-label={label}
      inputMode="decimal"
      className={`form-control w-24 ${valid ? '' : 'ring-2 ring-red-400'}`}
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        const gp = parseGp(e.target.value);
        if (Number.isFinite(gp)) onChange(gp);
      }}
      onBlur={() => setText(formatGp(value))}
    />
  );
};

/**
 * The wilderness mode options: limits how much the setups risk losing on death.
 * @param priceIds - the items whose prices the search needs
 */
const WildernessOptions: React.FC<{ priceIds: number[] }> = observer(({ priceIds }) => {
  const optimizer = useOptimizer();
  const { wilderness } = optimizer.settings;
  const [refreshing, setRefreshing] = useState(false);
  const update = (change: Partial<typeof wilderness>) => optimizer.updateSettings({ wilderness: { ...wilderness, ...change } });

  const fetchedAt = priceIds.map((id) => optimizer.itemPrices[id]?.fetchedAt).filter(isDefined);
  const oldest = fetchedAt.length > 0 ? Math.min(...fetchedAt) : undefined;
  const kept = keptItemsCount(wilderness);

  const refresh = async () => {
    setRefreshing(true);
    try {
      await optimizer.loadItemPrices(priceIds, true);
    } catch (e) {
      console.error('[GearOptimizer] Failed to refresh prices', e);
      toast.error('Failed to refresh the GE prices.');
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div className="my-3">
      <Toggle
        checked={wilderness.enabled}
        setChecked={(enabled) => update({ enabled })}
        label={<span className="font-bold">Wilderness</span>}
      />
      <p className="text-xs text-gray-500 dark:text-gray-300 mb-1.5">
        Only return setups that lose at most this much on death, after your most valuable items are kept. Uses GE prices,
        and turns on &quot;In the Wilderness&quot; for the wilderness weapons.
      </p>
      {wilderness.enabled && (
        <>
          <div className="flex items-center gap-2">
            <span className="text-xs">Max risk</span>
            <GpInput id="gear-optimizer-max-risk" label="Max risk (gp)" value={wilderness.maxRisk} onChange={(maxRisk) => update({ maxRisk })} />
            <span className="text-xs text-gray-500 dark:text-gray-300">{`gp (${kept} item${kept === 1 ? '' : 's'} kept)`}</span>
          </div>
          <div className="flex flex-wrap gap-x-6 mt-1">
            <Toggle checked={wilderness.protectItem} setChecked={(protectItem) => update({ protectItem })} label="Protect Item" />
            <Toggle checked={wilderness.skulled} setChecked={(skulled) => update({ skulled })} label="Skulled" />
            <Toggle
              checked={wilderness.skipUntradeables}
              setChecked={(skipUntradeables) => update({ skipUntradeables })}
              label={(
                <span
                  data-tooltip-id="tooltip"
                  data-tooltip-content="Untradeables have no GE price, so they count as free, but they may be lost or need repairing. Locked items are still used."
                >
                  Skip untradeables
                </span>
              )}
            />
          </div>
          <div className="flex items-center gap-1 text-xs text-gray-500 dark:text-gray-300 mt-1">
            {oldest
              ? `GE prices from ${new Date(oldest).toLocaleDateString()}`
              : 'GE prices are fetched from the Weird Gloop API when you search.'}
            {oldest && (
              <button
                type="button"
                className="hover:text-orange-500 transition-colors disabled:opacity-50"
                disabled={refreshing}
                onClick={refresh}
                aria-label="Refresh prices"
                data-tooltip-id="tooltip"
                data-tooltip-content="Refresh prices (they're otherwise kept for 30 days)"
              >
                <IconRefresh size={14} className={refreshing ? 'animate-spin' : ''} />
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
});

export default WildernessOptions;
