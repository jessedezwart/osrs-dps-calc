import React from 'react';
import LazyImage from '@/app/components/generic/LazyImage';
import {
  OPTIMIZER_STYLES, OptimizerJob, OptimizerResult, OptimizerStyle, StyleSearchSummary,
} from '@/lib/optimizer';
import { DISPLAY_SLOTS, SLOT_PLACEHOLDERS, STYLE_LABELS } from './constants';

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

export default SearchSummary;
