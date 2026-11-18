import React from 'react';
import { observer } from 'mobx-react-lite';
import { Prayer, SortedPrayers } from '@/enums/Prayer';
import GridItem from '@/app/components/generic/GridItem';

interface IPrayerGridProps {
  prayers: Prayer[];
  onToggle: (prayer: Prayer) => void;
}

/**
 * The prayer book, like the upstream Prayers tab, but with its own selection rules: the gear optimizer can have a
 * prayer for each style selected at the same time.
 */
const PrayerGrid: React.FC<IPrayerGridProps> = observer(({ prayers, onToggle }) => (
  <div className="grid grid-cols-4 gap-y-4 mt-6 w-48 m-auto items-center justify-center">
    {SortedPrayers.map(([k, v]) => {
      const prayer = parseInt(k);

      return (
        <GridItem
          key={k}
          item={prayer}
          name={v.name}
          image={v.image}
          active={prayers.includes(prayer)}
          onClick={onToggle}
        />
      );
    })}
  </div>
));

export default PrayerGrid;
