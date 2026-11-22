import localforage from 'localforage';
import { toJS } from 'mobx';
import { toast } from 'react-toastify';
import RootStore from '@/state/RootStore';
import { availableMonsters } from '@/state/MonsterStore';
import { createEmptyPlayer } from '@/state/PlayerStore';
import { resolveEquipment } from '@/lib/BankImport';
import { decodeSetupLink } from '@/lib/SetupLink';
import { spellByName } from '@/types/Spell';
import { EquipmentPiece, PlayerEquipment } from '@/types/Player';
import { Monster } from '@/types/Monster';
import { getOptimizerState } from '@/optimizerState';

// RootStore's browser storage key (not exported there)
const STATE_KEY = 'dps-calc-state';

/**
 * Loads a setup from a `?setup=` link (see SetupLink.ts) into a new loadout, on top of the restored session, and
 * selects its monster. Then removes the parameter from the URL, so a reload doesn't add the loadout again.
 */
const applySetupLink = (root: RootStore, encoded: string): void => {
  try {
    const setup = decodeSetupLink(encoded);

    const monster = availableMonsters.find((m) => m.id === setup.monster.id);
    if (!monster) throw new Error(`Unknown monster ${setup.monster.id}`);

    const equipment: PlayerEquipment = createEmptyPlayer().equipment;
    const missing: number[] = [];
    for (const [slot, item] of Object.entries(setup.equipment)) {
      if (!item) continue;
      const piece = resolveEquipment(item.id);
      if (!piece) {
        missing.push(item.id);
        continue;
      }
      equipment[slot as keyof PlayerEquipment] = (item.itemVars ? { ...piece, itemVars: item.itemVars } : piece) as EquipmentPiece;
    }

    root.monster.load(monster, (setup.monster.inputs ?? {}) as Partial<Monster['inputs']>);
    getOptimizerState(root).applyLoadout(
      {
        equipment, style: setup.style, spell: setup.spell ? spellByName(setup.spell) : null, prayers: setup.prayers,
      },
      true,
      { skills: setup.skills, boosts: setup.boosts, buffs: setup.buffs },
    );
    // the stores don't save changes made before they start, so save the new loadout now
    localforage.setItem(STATE_KEY, toJS(root.snapshot)).catch((e) => console.error(e));

    if (missing.length) {
      toast.warn(`Loaded the setup, but couldn't find item IDs ${missing.join(', ')}`, { toastId: 'setup-link' });
    } else {
      toast.success('Loaded the setup from the link', { toastId: 'setup-link' });
    }
  } catch (e) {
    console.error(e);
    toast.error('Failed to load the setup from the link', { toastId: 'setup-link' });
  }

  const url = new URL(window.location.href);
  url.searchParams.delete('setup');
  window.history.replaceState({}, '', url.toString());
};

export default applySetupLink;
