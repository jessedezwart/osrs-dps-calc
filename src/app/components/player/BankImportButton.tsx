import React, { useRef, useState } from 'react';
import { observer } from 'mobx-react-lite';
import { IconCheck, IconCopy, IconFileUpload } from '@tabler/icons-react';
import { toast } from 'react-toastify';
import { useStore } from '@/state';
import { parseBankCsv, resolveOwnedEquipment } from '@/lib/BankImport';

/** Where the Dude Where's My Stuff RuneLite plugin saves its exports (one folder per account). */
export const BANK_EXPORT_DIR = '%userprofile%\\.runelite\\plugin-data\\dude-wheres-my-stuff\\';

// the File System Access API is Chromium-only, so isn't in TypeScript's DOM types
type ShowOpenFilePicker = (opts: {
  id?: string;
  types?: { description: string, accept: Record<string, string[]> }[];
}) => Promise<{ getFile: () => Promise<File> }[]>;

/**
 * Imports a bank export CSV (ID,Name,Quantity) for use with the gear optimizer.
 */
const BankImportButton: React.FC = observer(() => {
  const store = useStore();
  const inputRef = useRef<HTMLInputElement>(null);

  const importFile = async (file: File) => {
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

  const onFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // allow re-selecting the same file later
    e.target.value = '';
    if (file) await importFile(file);
  };

  const openPicker = async () => {
    const showOpenFilePicker = (window as { showOpenFilePicker?: ShowOpenFilePicker }).showOpenFilePicker;
    if (!showOpenFilePicker) {
      inputRef.current?.click();
      return;
    }

    // browsers can't open the picker at a given path, but with an id it opens in the folder last picked from
    let handles: Awaited<ReturnType<ShowOpenFilePicker>>;
    try {
      handles = await showOpenFilePicker({
        id: 'bank-csv',
        types: [{ description: 'Bank export CSV', accept: { 'text/csv': ['.csv'] } }],
      });
    } catch (err) {
      // the user closed the picker
      if (err instanceof DOMException && err.name === 'AbortError') return;
      throw err;
    }
    await importFile(await handles[0].getFile());
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
        onClick={openPicker}
        className="text-body-500 dark:text-dark-100 hover:text-green transition-colors"
        data-tooltip-id="tooltip"
        data-tooltip-content={store.bank
          ? `Bank loaded (${store.bank.fileName}). Click to import a different bank CSV`
          : `Import bank CSV (ID,Name,Quantity). Dude Where's My Stuff saves them in ${BANK_EXPORT_DIR}`}
      >
        <IconFileUpload aria-label="Import bank CSV" />
      </button>
    </>
  );
});

/**
 * The folder Dude Where's My Stuff saves its exports in, to copy into the file picker (browsers can't open it there).
 */
export const BankExportDirCopy: React.FC = () => {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(BANK_EXPORT_DIR);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      console.error('[BankImport] Failed to copy the export folder', e);
      toast.error('Could not copy. Select the text and copy it instead.');
    }
  };

  return (
    <div className="px-5 py-2 border-b-body-400 dark:border-b-dark-200 border-b flex items-center gap-1 text-xs">
      <span
        className="shrink-0 text-gray-500 dark:text-gray-300 underline decoration-dotted cursor-help"
        data-tooltip-id="tooltip"
        data-tooltip-content="Dude Where's My Stuff saves its bank exports in this folder (one subfolder per account). Paste it into the address bar or file name box of the import file picker to jump there; the picker remembers the folder afterwards."
      >
        Bank exports
      </span>
      <input
        type="text"
        readOnly
        value={BANK_EXPORT_DIR}
        onFocus={(e) => e.target.select()}
        className="form-control flex-1 min-w-0 font-mono text-xs py-0.5"
        aria-label="Dude Where's My Stuff export folder"
      />
      <button
        type="button"
        onClick={copy}
        className="shrink-0 text-body-500 dark:text-dark-100 hover:text-green transition-colors"
        data-tooltip-id="tooltip"
        data-tooltip-content={copied ? 'Copied' : 'Copy folder path'}
      >
        {copied ? <IconCheck size={18} className="text-green-500" aria-label="Copied" /> : <IconCopy size={18} aria-label="Copy folder path" />}
      </button>
    </div>
  );
};

export default BankImportButton;
