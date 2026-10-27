import React from 'react';
import { observer } from 'mobx-react-lite';
import { useStore } from '@/state';
import slayer from '@/public/img/misc/slayer.webp';
import skull from '@/public/img/misc/skull.webp';
import diary from '@/public/img/misc/diary.png';
import forinthry_surge from '@/public/img/misc/forinthry_surge.webp';
import soulreaper_axe from '@/public/img/misc/soulreaper_axe.png';
import ba_attacker from '@/public/img/misc/ba_attacker.webp';
import chinchompa from '@/public/img/misc/chinchompa.png';
import NumberInput from '@/app/components/generic/NumberInput';
import { Player } from '@/types/Player';
import Toggle from '../generic/Toggle';

interface IExtraOptionsListProps {
  buffs: Player['buffs'];
  onChange: (buffs: Partial<Player['buffs']>) => void;
}

/**
 * The extra options (on slayer task etc.) of a player, for a loadout or the gear optimizer.
 */
export const ExtraOptionsList: React.FC<IExtraOptionsListProps> = observer(({ buffs, onChange }) => (
  <div className="px-6 my-4">
    <div className="mt-2 mb-4">
      <Toggle
        checked={buffs.onSlayerTask}
        setChecked={(c) => onChange({ onSlayerTask: c })}
        label={(
          <>
            <img src={slayer.src} width={18} className="inline-block" alt="" />
            {' '}
            On Slayer task
            {' '}
            <span
              className="align-super underline decoration-dotted cursor-help text-xs text-gray-300"
              data-tooltip-id="tooltip"
              data-tooltip-content="Black mask and slayer helmet give bonuses while you are on a Slayer task."
            >
              ?
            </span>
          </>
          )}
      />
      <Toggle
        checked={buffs.inWilderness}
        setChecked={(c) => onChange({ inWilderness: c })}
        label={(
          <>
            <img src={skull.src} width={18} className="inline-block" alt="" />
            {' '}
            In the Wilderness
            {' '}
            <span
              className="align-super underline decoration-dotted cursor-help text-xs text-gray-300"
              data-tooltip-id="tooltip"
              data-tooltip-content="Some weapons give bonuses while you are in the Wilderness."
            >
              ?
            </span>
          </>
          )}
      />
      <Toggle
        checked={buffs.forinthrySurge}
        setChecked={(c) => onChange({ forinthrySurge: c })}
        label={(
          <>
            <img src={forinthry_surge.src} width={18} className="inline-block" alt="" />
            {' '}
            Forinthry Surge
            {' '}
            <span
              className="align-super underline decoration-dotted cursor-help text-xs text-gray-300"
              data-tooltip-id="tooltip"
              data-tooltip-content="Provides a bonus against revenants."
            >
              ?
            </span>
          </>
          )}
      />
      <Toggle
        checked={buffs.kandarinDiary}
        setChecked={(c) => onChange({ kandarinDiary: c })}
        label={(
          <>
            <img src={diary.src} width={18} className="inline-block" alt="" />
            {' '}
            Kandarin Hard Diary
            {' '}
            <span
              className="align-super underline decoration-dotted cursor-help text-xs text-gray-300"
              data-tooltip-id="tooltip"
              data-tooltip-content="10% activation chance increase to enchanted bolts."
            >
              ?
            </span>
          </>
          )}
      />
      <div className="w-full">
        <NumberInput
          className="form-control w-12"
          required
          min={0}
          max={5}
          value={buffs.soulreaperStacks}
          onChange={(v) => onChange({ soulreaperStacks: v })}
        />
        <span className="ml-1 text-sm select-none">
          <img src={soulreaper_axe.src} width={18} className="inline-block" alt="" />
          {' '}
          Soul stacks
          {' '}
          <span
            className="align-super underline decoration-dotted cursor-help text-xs text-gray-300"
            data-tooltip-id="tooltip"
            data-tooltip-content="When using the soulreaper axe, every hit gives a soul stack."
          >
            ?
          </span>
        </span>
      </div>
      <div className="w-full">
        <NumberInput
          className="form-control w-12"
          required
          min={0}
          max={5}
          value={buffs.baAttackerLevel}
          onChange={(v) => onChange({ baAttackerLevel: v })}
        />
        <span className="ml-1 text-sm select-none">
          <img src={ba_attacker.src} className="inline-block h-fit" alt="" />
          {' '}
          BA Attacker level
          {' '}
          <span
            className="align-super underline decoration-dotted cursor-help text-xs text-gray-300"
            data-tooltip-id="tooltip"
            data-tooltip-content="When fighting Penance Fighters and Penance Archers, your attacker level provides extra damage."
          >
            ?
          </span>
        </span>
      </div>
      <div className="w-full">
        <NumberInput
          className="form-control w-12"
          required
          min={1}
          max={10}
          value={buffs.chinchompaDistance}
          onChange={(v) => onChange({ chinchompaDistance: v })}
        />
        <span className="ml-1 text-sm select-none">
          <img src={chinchompa.src} className="inline-block h-fit" alt="" />
          {' '}
          Chinchompa distance (tiles)
          {' '}
          <span
            className="align-super underline decoration-dotted cursor-help text-xs text-gray-300"
            data-tooltip-id="tooltip"
            data-tooltip-content="When using chinchompas, accuracy is modified based on distance to the target."
          >
            ?
          </span>
        </span>
      </div>
    </div>
  </div>
));

const ExtraOptions: React.FC = observer(() => {
  const store = useStore();

  return <ExtraOptionsList buffs={store.player.buffs} onChange={(buffs) => store.updatePlayer({ buffs })} />;
});

export default ExtraOptions;
