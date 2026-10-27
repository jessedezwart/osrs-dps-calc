import { observer } from 'mobx-react-lite';
import React from 'react';
import { Prayer, SortedPrayers } from '@/enums/Prayer';
import { useStore } from '@/state';
import GridItem from '@/app/components/generic/GridItem';

interface IPrayerGridProps {
  prayers: Prayer[];
  onToggle: (prayer: Prayer) => void;
}

/**
 * The prayer book, for a loadout or the gear optimizer.
 */
export const PrayerGrid: React.FC<IPrayerGridProps> = observer(({ prayers, onToggle }) => (
  <div className="grid grid-cols-4 gap-y-4 mt-6 w-48 m-auto items-center justify-center">
    {
      SortedPrayers.map(([k, v]) => (
        <GridItem
          key={k}
          item={parseInt(k)}
          name={v.name}
          image={v.image}
          active={prayers.includes(parseInt(k))}
          onClick={(p: Prayer) => onToggle(p)}
        />
      ))
    }
  </div>
));

const Prayers: React.FC = observer(() => {
  const store = useStore();

  return (
    <div className="px-4 mb-8">
      <PrayerGrid prayers={store.player.prayers} onToggle={store.togglePlayerPrayer} />
    </div>
  );
});

export default Prayers;
