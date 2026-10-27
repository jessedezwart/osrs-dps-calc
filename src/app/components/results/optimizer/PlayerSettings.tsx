import React, { useState } from 'react';
import { observer } from 'mobx-react-lite';
import { IconLock } from '@tabler/icons-react';
import { useOptimizer } from '@/optimizerState';
import LazyImage from '@/app/components/generic/LazyImage';
import { Player, PlayerEquipment, PlayerSkills } from '@/types/Player';
import { getCdnImage } from '@/utils';
import PlayerTab from '@/app/components/player/PlayerTab';
import { SkillsAndBoosts } from '@/app/components/player/Skills';
import { PrayerGrid } from '@/app/components/player/Prayers';
import { ExtraOptionsList } from '@/app/components/player/ExtraOptions';
import EquipmentSelect from '@/app/components/player/equipment/EquipmentSelect';
import WikiSyncButton from '@/app/components/player/WikiSyncButton';
import skillsTab from '@/public/img/tabs/skills.png';
import equipmentTab from '@/public/img/tabs/equipment.png';
import optionsTab from '@/public/img/tabs/options.webp';
import prayerTab from '@/public/img/tabs/prayer.png';
import { DISPLAY_SLOTS, SLOT_PLACEHOLDERS } from './constants';

/**
 * Lets the user lock slots to an item (or to being empty) while the rest of the gear is searched.
 */
const SlotLocks: React.FC = observer(() => {
  const optimizer = useOptimizer();
  const { locked } = optimizer.settings;

  return (
    <div className="px-4 py-4">
      <p className="text-xs text-gray-500 dark:text-gray-300 mb-2">
        Search for an item to lock its slot to it. It doesn&apos;t need to be owned. Click an unlocked slot to keep it
        empty, or a locked slot to unlock it. The search only changes the unlocked slots.
      </p>
      <div className="flex flex-wrap items-center gap-1 mb-2">
        {DISPLAY_SLOTS.map((slot) => {
          const isLocked = Object.hasOwn(locked, slot);
          const item = locked[slot];
          // eslint-disable-next-line no-nested-ternary
          const label = `${slot}: ${!isLocked ? 'searched' : item ? `${item.name} (locked)` : 'empty (locked)'}`;
          return (
            <button
              key={slot}
              type="button"
              onClick={() => optimizer.setLock(slot, isLocked ? undefined : null)}
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
      <EquipmentSelect
        id="gear-optimizer-lock-select"
        placeholder="Lock a slot to an item..."
        onSelectedItemChange={(option) => {
          if (option) optimizer.setLock(option.equipment.slot as keyof PlayerEquipment, option.equipment);
        }}
      />
    </div>
  );
});

type SettingsTab = 'skills' | 'prayer' | 'equipment' | 'options';

/**
 * The levels, potions, prayers, locked items and extra options the search uses. These are separate from the loadouts.
 */
const PlayerSettings: React.FC = observer(() => {
  const optimizer = useOptimizer();
  const settings = optimizer.settings;
  const [tab, setTab] = useState<SettingsTab>('skills');

  return (
    <div className="w-full max-w-[350px] shrink-0 flex flex-col rounded-lg border border-body-300 dark:border-dark-200 bg-tile dark:bg-dark-300">
      <div className="flex justify-center items-center rounded-t-lg bg-body-100 dark:bg-dark-400 border-b border-body-400 dark:border-dark-200 px-4 py-3 gap-1">
        <PlayerTab name="Skills" isActive={tab === 'skills'} image={skillsTab} onClick={() => setTab('skills')} />
        <PlayerTab name="Prayer" isActive={tab === 'prayer'} image={prayerTab} onClick={() => setTab('prayer')} />
        <PlayerTab name="Locked equipment" isActive={tab === 'equipment'} image={equipmentTab} onClick={() => setTab('equipment')} />
        <PlayerTab name="Extra options" isActive={tab === 'options'} image={optionsTab} onClick={() => setTab('options')} />
      </div>
      {tab === 'skills' && (
        <SkillsAndBoosts
          skills={settings.skills}
          boosts={settings.boosts}
          potions={settings.buffs.potions}
          onChange={(change) => optimizer.updateSettings(change)}
          togglePotion={optimizer.togglePotion}
          onLookup={optimizer.fetchSkills}
          lookupExtra={(
            <WikiSyncButton
              id="gear-optimizer-wikisync"
              onImport={(p) => optimizer.updateSettings({
                skills: p.skills as Partial<PlayerSkills>,
                buffs: p.buffs as Partial<Player['buffs']>,
              })}
            />
          )}
        />
      )}
      {tab === 'prayer' && (
        <div className="px-4 mb-6">
          <PrayerGrid prayers={settings.prayers} onToggle={optimizer.togglePrayer} />
          <p className="text-xs text-gray-500 dark:text-gray-300 mt-4">
            Each style uses the selected prayers for it (e.g. Piety for melee), plus the ones for every style (e.g. Steel
            Skin). You can select one for each style at the same time.
          </p>
        </div>
      )}
      {tab === 'equipment' && <SlotLocks />}
      {tab === 'options' && (
        <ExtraOptionsList buffs={settings.buffs} onChange={(buffs) => optimizer.updateSettings({ buffs })} />
      )}
    </div>
  );
});

export default PlayerSettings;
