import React, { useCallback, useMemo } from 'react';
import { observer } from 'mobx-react-lite';
import Combobox from '@/app/components/generic/Combobox';
import LazyImage from '@/app/components/generic/LazyImage';
import {
  collapseVariants, EQUIPMENT_OPTIONS, EquipmentOption, sortForMonster,
} from '@/app/components/player/equipment/equipmentOptions';
import { useMonster } from '@/state/MonsterStore';
import { getCdnImage } from '@/utils';

const OptionLabel: React.FC<{ item: EquipmentOption, itemString: string }> = ({ item, itemString }) => (
  <div className="flex items-center gap-2">
    <div className="basis-4 flex justify-center h-[20px] w-auto">
      {item.equipment.image && (<LazyImage responsive src={getCdnImage(`equipment/${item.equipment.image}`)} alt="" />)}
    </div>
    <div>
      {itemString}
      {item.version && (
        <span className="monster-version text-xs text-gray-400 dark:text-gray-300">
          #
          {item.version}
        </span>
      )}
    </div>
  </div>
);

interface ILockSelectProps {
  onSelect: (item: EquipmentOption) => void;
}

/**
 * The equipment search of the upstream EquipmentSelect, for picking an item to lock a gear optimizer slot to.
 */
const LockSelect: React.FC<ILockSelectProps> = observer(({ onSelect }) => {
  const monster = useMonster();
  const options = useMemo(() => sortForMonster(EQUIPMENT_OPTIONS, monster.id), [monster.id]);
  const customSort = useCallback((items: EquipmentOption[]) => sortForMonster(items, monster.id), [monster.id]);

  return (
    <Combobox<EquipmentOption>
      id="gear-optimizer-lock-select"
      className="w-full"
      items={options}
      keepOpenAfterSelect
      keepPositionAfterSelect
      placeholder="Lock a slot to an item..."
      onSelectedItemChange={(item) => {
        if (item) onSelect(item);
      }}
      CustomItemComponent={OptionLabel}
      customFilter={collapseVariants}
      customSort={customSort}
    />
  );
});

export default LockSelect;
