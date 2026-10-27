import React from 'react';

import attack from '@/public/img/bonuses/attack.png';
import strength from '@/public/img/bonuses/strength.png';
import defence from '@/public/img/bonuses/defence.png';
import ranged from '@/public/img/bonuses/ranged.png';
import magic from '@/public/img/bonuses/magic.png';
import hitpoints from '@/public/img/bonuses/hitpoints.png';
import prayer from '@/public/img/tabs/prayer.png';
import mining from '@/public/img/bonuses/mining.png';
import herblore from '@/public/img/bonuses/herblore.png';
import farming from '@/public/img/bonuses/farming.png';
import { observer } from 'mobx-react-lite';
import UsernameLookup from '@/app/components/player/skills/UsernameLookup';
import SkillInput, { SkillChange } from '@/app/components/player/skills/SkillInput';
import Potion from '@/enums/Potion';
import { PotionMap } from '@/utils';
import BuffItem from '@/app/components/player/buffs/BuffItem';
import { useStore } from '@/state';
import { PlayerSkills } from '@/types/Player';

interface ISkillsAndBoostsProps {
  skills: PlayerSkills;
  boosts: PlayerSkills;
  potions: Potion[];
  onChange: (change: SkillChange) => void;
  togglePotion: (potion: Potion) => void;
  /** Whether the username lookup fills these levels in, or the current loadout's. */
  lookupTarget?: 'loadout' | 'optimizer';
  /** Shown after the username lookup, e.g. another way to import levels. */
  lookupExtra?: React.ReactNode;
}

/**
 * The levels and potions of a player, for a loadout or the gear optimizer.
 */
export const SkillsAndBoosts: React.FC<ISkillsAndBoostsProps> = observer(({
  skills, boosts, potions, onChange, togglePotion, lookupTarget, lookupExtra,
}) => {
  const skillProps = { skills, boosts, onChange };

  return (
    <div className="px-4 mt-4 flex flex-col mb-6 grow">
      <div className="flex items-center gap-1">
        <UsernameLookup target={lookupTarget} />
        {lookupExtra}
      </div>
      <div className="mt-4">
        <div className="grid items-center gap-x-2" style={{ gridTemplateColumns: '2fr 2fr 2fr 2fr' }}>
          <SkillInput name="Attack" field="atk" image={attack} {...skillProps} />
          <SkillInput name="Strength" field="str" image={strength} {...skillProps} />
          <SkillInput name="Defence" field="def" image={defence} {...skillProps} />
          <SkillInput name="Hitpoints" field="hp" image={hitpoints} {...skillProps} />
          <SkillInput name="Ranged" field="ranged" image={ranged} {...skillProps} />
          <SkillInput name="Magic" field="magic" image={magic} {...skillProps} />
          <SkillInput name="Prayer" field="prayer" image={prayer} {...skillProps} />
          <SkillInput name="Mining" field="mining" image={mining} {...skillProps} />
          <SkillInput name="Herblore" field="herblore" image={herblore} {...skillProps} />
          <SkillInput name="Farming" field="farming" image={farming} {...skillProps} />
        </div>
      </div>
      <h4 className="mt-4 font-bold font-serif">
        Boosts
      </h4>
      <div
        className="grow h-48 mt-2 bg-white dark:bg-dark-500 dark:border-dark-200 rounded border border-gray-300 overflow-y-scroll"
      >
        {
          Object.entries(PotionMap).sort((a, b) => a[1].order - b[1].order).map(([k, v]) => {
            const potion: Potion = parseInt(k);

            return (
              <BuffItem
                key={k}
                potion={potion}
                name={v.name}
                image={v.image}
                active={potions.includes(potion)}
                setActive={togglePotion}
              />
            );
          })
        }
      </div>
    </div>
  );
});

const Skills: React.FC = observer(() => {
  const store = useStore();
  const { player } = store;

  return (
    <SkillsAndBoosts
      skills={player.skills}
      boosts={player.boosts}
      potions={player.buffs.potions}
      onChange={(change) => store.updatePlayer(change)}
      togglePotion={store.togglePlayerPotion}
    />
  );
});

export default Skills;
