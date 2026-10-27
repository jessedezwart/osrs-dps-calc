import React, { useRef, useState } from 'react';
import { observer } from 'mobx-react-lite';
import { useStore } from '@/state';
import localforage from 'localforage';

interface IUsernameLookupProps {
  /** Whether the levels are filled in for the current loadout (the default), or the gear optimizer. */
  target?: 'loadout' | 'optimizer';
}

const UsernameLookup: React.FC<IUsernameLookupProps> = observer(({ target }) => {
  const store = useStore();
  const username = store.ui.username || '';
  const shouldRemember = store.prefs.rememberUsername;
  const [btnDisabled, setBtnDisabled] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);

  return (
    <>
      <input
        type="text"
        className="form-control rounded w-full mt-auto"
        placeholder="OSRS username"
        value={username}
        onChange={(e) => {
          store.updateUIState({ username: e.currentTarget.value });
          if (shouldRemember) {
            localforage.setItem('dps-calc-username', e.currentTarget.value).catch(() => {
            });
          }
        }}
        onKeyUp={(e) => {
          if (e.key === 'Enter') {
            btn.current?.click();
          }
        }}
      />
      <button
        ref={btn}
        disabled={!username || btnDisabled}
        type="button"
        className="ml-1 text-sm btn"
        onClick={async () => {
          setBtnDisabled(true);
          await store.fetchCurrentPlayerSkills(target);
          setBtnDisabled(false);
        }}
      >
        Lookup
      </button>
    </>
  );
});

export default UsernameLookup;
