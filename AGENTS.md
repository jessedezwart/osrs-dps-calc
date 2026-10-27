# Agent notes

This is a fork of [weirdgloop/osrs-dps-calc](https://github.com/weirdgloop/osrs-dps-calc) (the `upstream` remote). It
adds the gear optimizer ("Find Best Gear"), bank import, wilderness risk and a desktop build. Upstream is merged in
regularly (`git fetch upstream && git merge upstream/main`), and `rerere` is enabled to remember conflict resolutions.

## Keep changes to upstream files small

Merge conflicts only come from lines we change in files upstream also edits. So:

- **Put fork features in their own files.** Upstream never touches them, so they always merge cleanly. For example,
  `src/lib/optimizer/` (the search, see its `index.ts`), `src/lib/ItemPrices.ts`, `src/lib/BankImport.ts`,
  `src/worker/OptimizerPool.ts`, and `src/app/components/results/GearOptimizer.tsx` with its parts in
  `src/app/components/results/optimizer/`.
- **Don't add state to `src/state.tsx`.** The optimizer's state lives in `src/optimizerState.ts` (`useOptimizer()`),
  which uses the global store but isn't part of it. Add new fork state there, or in a similar store of its own.
- **Wrap or compose upstream components instead of editing them.** When an upstream file has to change, keep it to a
  single extension point, such as an optional prop with the upstream behaviour as its default (see `onLookup` in
  `UsernameLookup.tsx`, or `onImport` in `WikiSyncButton.tsx`), and keep the logic in our own files.
- **Don't refactor or reformat upstream code** that the change doesn't need, even if it would be nicer. Copying a small
  helper into a fork file is better than moving it out of an upstream file.
- Before finishing, check what we change in upstream files with
  `git diff $(git merge-base HEAD upstream/main) --stat`, and look for anything that could move into a fork file.

## Checks

- `npx tsc --noEmit -p .`
- `npx eslint <changed files>`
- `npx jest --coverage=false`
