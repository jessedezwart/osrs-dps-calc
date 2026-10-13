import React, { useRef } from 'react';
import { observer } from 'mobx-react-lite';
import { IconFileUpload } from '@tabler/icons-react';
import { toast } from 'react-toastify';
import { useStore } from '@/state';
import { parseBankCsv, resolveOwnedEquipment } from '@/lib/BankImport';

/**
 * Imports a bank export CSV (ID,Name,Quantity) for use with the gear optimizer.
 */
const BankImportButton: React.FC = observer(() => {
  const store = useStore();
  const inputRef = useRef<HTMLInputElement>(null);

  const onFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // allow re-selecting the same file later
    e.target.value = '';
    if (!file) return;

    try {
      const items = parseBankCsv(await file.text());
      const equippable = resolveOwnedEquipment(items);
      store.setBank(items, file.name);
      toast.success(`Imported ${items.length} bank items (${equippable.length} usable equipment). Use "Find Best Gear" below to search them.`, { toastId: 'bank-import' });
    } catch (err) {
      console.error(err);
      toast.error(`Could not import bank: ${err instanceof Error ? err.message : err}`, { toastId: 'bank-import' });
    }
  };

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept=".csv,text/csv"
        className="hidden"
        onChange={onFileChange}
      />
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        className="text-body-500 dark:text-dark-100 hover:text-green transition-colors"
        data-tooltip-id="tooltip"
        data-tooltip-content={store.bank ? `Bank loaded (${store.bank.fileName}). Click to import a different bank CSV` : 'Import bank CSV (ID,Name,Quantity)'}
      >
        <IconFileUpload aria-label="Import bank CSV" />
      </button>
    </>
  );
});

export default BankImportButton;
