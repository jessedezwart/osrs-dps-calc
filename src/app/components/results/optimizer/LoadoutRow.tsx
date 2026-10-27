import React from 'react';
import { observer } from 'mobx-react-lite';
import { IconAlertTriangle, IconShieldCheckFilled, IconX } from '@tabler/icons-react';
import { useOptimizer } from '@/optimizerState';
import LazyImage from '@/app/components/generic/LazyImage';
import { LoadoutAlternative, OptimizedLoadout } from '@/lib/optimizer';
import { formatGp } from '@/lib/ItemPrices';
import { EquipmentPiece, Player } from '@/types/Player';
import { getCdnImage } from '@/utils';
import { DISPLAY_SLOTS } from './constants';

/** A button to stop the search from loading this ammo (or blowpipe dart). */
const IgnoreAmmoButton: React.FC<{ name: string, size: number }> = observer(({ name, size }) => {
  const optimizer = useOptimizer();
  return (
    <button
      type="button"
      className="text-gray-500 dark:text-gray-300 hover:text-red transition-colors"
      onClick={() => optimizer.toggleIgnoredAmmo(name)}
      aria-label={`Ignore ${name}`}
      data-tooltip-id="tooltip"
      data-tooltip-content={`Don't load ${name} in future searches (other weapons and ammo are still used)`}
    >
      <IconX size={size} />
    </button>
  );
});

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

/**
 * The difference with the result below, coloured by whether it's better (green) or worse (red). Hidden if it rounds to
 * zero.
 */
const Delta: React.FC<{
  value: number,
  precision: number,
  lowerIsBetter?: boolean,
  tooltip: string,
  /** Formats the (positive) difference, instead of showing it to `precision` decimals. */
  format?: (n: number) => string,
}> = ({
  value, precision, lowerIsBetter, tooltip, format,
}) => {
  if (Math.abs(value) < 0.5 * 10 ** -precision) return null;
  const better = lowerIsBetter ? value < 0 : value > 0;
  return (
    <span
      className={`ml-1 text-xs font-semibold ${better ? 'text-green-400 dark:text-green-300' : 'text-red-400 dark:text-red-300'}`}
      data-tooltip-id="tooltip"
      data-tooltip-content={tooltip}
    >
      {`${value > 0 ? '+' : '−'}${format ? format(Math.abs(value)) : Math.abs(value).toFixed(precision)}`}
    </span>
  );
};

/** The levels, boosts and extra options a search was run with, which applying a result copies into the loadout. */
export type SearchBase = Pick<Player, 'skills' | 'boosts' | 'buffs'>;

const LoadoutRow: React.FC<{
  loadout: OptimizedLoadout,
  /** The result below this one, to compare with. */
  next?: OptimizedLoadout,
  base: SearchBase,
  rank: number,
  canCreateLoadout: boolean,
}> = observer(({
  loadout, next, base, rank, canCreateLoadout,
}) => {
  const optimizer = useOptimizer();

  return (
    <tr className="border-t border-body-300 dark:border-dark-200">
      <td className="px-2 py-1 text-gray-500 dark:text-gray-300">{rank}</td>
      <td className="px-2 py-1">
        <div className="font-bold flex items-center gap-1">
          {loadout.equipment.weapon ? loadout.equipment.weapon.name : 'Unarmed'}
          {loadout.equipment.weapon?.itemVars?.blowpipeDartName && (
            <span className="flex items-center gap-0.5 font-normal">
              {`(${loadout.equipment.weapon.itemVars.blowpipeDartName}`}
              <IgnoreAmmoButton name={loadout.equipment.weapon.itemVars.blowpipeDartName} size={12} />
              )
            </span>
          )}
          {loadout.equipment.weapon && (
            <button
              type="button"
              className="text-gray-500 dark:text-gray-300 hover:text-red transition-colors"
              onClick={() => optimizer.toggleExcludedItem(loadout.equipment.weapon!.id)}
              aria-label={`Exclude ${loadout.equipment.weapon.name}`}
              data-tooltip-id="tooltip"
              data-tooltip-content={`Exclude ${loadout.equipment.weapon.name} from future searches`}
            >
              <IconX size={14} />
            </button>
          )}
        </div>
        <div className="text-xs text-gray-500 dark:text-gray-300 flex flex-wrap items-center gap-x-1">
          {`${loadout.style.name} (${loadout.style.stance})`}
          {loadout.style.type === 'ranged' && loadout.equipment.ammo && (
            <>
              {' · '}
              <span>{loadout.equipment.ammo.name}</span>
              <IgnoreAmmoButton name={loadout.equipment.ammo.name} size={12} />
            </>
          )}
          {loadout.spell && (
            <>
              {' · '}
              <span>{loadout.spell.name}</span>
              <button
                type="button"
                className="hover:text-red transition-colors"
                onClick={() => optimizer.toggleExcludedSpell(loadout.spell!.name)}
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
            const kept = loadout.risk?.keptSlots.includes(slot);
            return (
              <button
                key={slot}
                type="button"
                className="relative w-7 h-7 flex items-center justify-center bg-body-100 dark:bg-dark-400 rounded hover:ring-2 hover:ring-red-400"
                data-tooltip-id="tooltip"
                data-tooltip-content={`${slot}: ${item.name}${kept ? ' (kept on death)' : ''} (click to exclude it from future searches)`}
                aria-label={`Exclude ${item.name}`}
                onClick={() => optimizer.toggleExcludedItem(item.id)}
              >
                {item.image && <LazyImage responsive src={getCdnImage(`equipment/${item.image}`)} alt={item.name} />}
                {kept && (
                  <IconShieldCheckFilled
                    size={12}
                    className="absolute -top-1 -right-1 text-green-700 dark:text-green-300"
                    aria-label="Kept on death"
                  />
                )}
              </button>
            );
          })}
          {loadout.risk && loadout.risk.untradeableSlots.length > 0 && (
            <div
              className="w-7 h-7 flex items-center justify-center text-orange-400 dark:text-orange-300"
              data-tooltip-id="tooltip"
              data-tooltip-content={`Untradeables at risk: ${loadout.risk.untradeableSlots.map((s) => loadout.equipment[s]!.name).join(', ')}. They have no GE price, so they count as free. Depending on the item and the Wilderness level, they may be lost, turn into coins for your killer, or need repairing.`}
            >
              <IconAlertTriangle size={20} aria-label="Untradeables at risk" />
            </div>
          )}
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
                onClick={() => optimizer.applyLoadout({ ...loadout, equipment: { ...loadout.equipment, [alt.slot]: alt.item } }, false, base)}
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
      <td className="px-2 py-1 text-right font-bold whitespace-nowrap">
        {loadout.dps.toFixed(3)}
        {next && <Delta value={loadout.dps - next.dps} precision={3} tooltip={`DPS compared with #${rank + 1}`} />}
      </td>
      <td className="px-2 py-1 text-right">{loadout.maxHit}</td>
      <td className="px-2 py-1 text-right">{`${(loadout.accuracy * 100).toFixed(2)}%`}</td>
      <td className="px-2 py-1 text-right whitespace-nowrap">
        {loadout.npcDps > 0 ? (
          <>
            <div>
              {loadout.avgDmgTaken !== undefined ? loadout.avgDmgTaken.toFixed(1) : '-----'}
              {loadout.avgDmgTaken !== undefined && next?.avgDmgTaken !== undefined && (
                <Delta
                  value={loadout.avgDmgTaken - next.avgDmgTaken}
                  precision={1}
                  lowerIsBetter
                  tooltip={`Damage taken per kill compared with #${rank + 1}`}
                />
              )}
            </div>
            <div className="text-xs text-gray-500 dark:text-gray-300">{`${loadout.npcDps.toFixed(3)}/s`}</div>
          </>
        ) : '-----'}
      </td>
      {loadout.risk && (
        <td className="px-2 py-1 text-right whitespace-nowrap">
          <div>
            {formatGp(loadout.risk.risk)}
            {next?.risk && (
              <Delta
                value={loadout.risk.risk - next.risk.risk}
                precision={0}
                lowerIsBetter
                format={formatGp}
                tooltip={`Risk compared with #${rank + 1}`}
              />
            )}
          </div>
          <div className="text-xs text-gray-500 dark:text-gray-300">{`of ${formatGp(loadout.risk.total)}`}</div>
        </td>
      )}
      <td className="px-2 py-1 text-right whitespace-nowrap">{`${loadout.weight.toFixed(1)} kg`}</td>
      <td className="px-2 py-1">
        <div className="flex gap-1 justify-end">
          <button
            type="button"
            className="form-control text-xs whitespace-nowrap"
            onClick={() => optimizer.applyLoadout(loadout, false, base)}
            data-tooltip-id="tooltip"
            data-tooltip-content="Replace the current loadout with this gear, and the levels, potions, prayers and extra options the search used"
          >
            Apply
          </button>
          <button
            type="button"
            className="form-control text-xs whitespace-nowrap"
            disabled={!canCreateLoadout}
            onClick={() => optimizer.applyLoadout(loadout, true, base)}
            data-tooltip-id="tooltip"
            data-tooltip-content={canCreateLoadout ? 'Add this setup to your loadouts at the top, to compare it with them' : 'You have the maximum number of loadouts'}
          >
            Add to loadouts
          </button>
        </div>
      </td>
    </tr>
  );
});

export default LoadoutRow;
