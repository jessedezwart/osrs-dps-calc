# Gear optimizer server

A local HTTP server for "Find Best Gear", so scripts and AI assistants can ask for the best gear you own against a
monster. It reads your levels and items from the OSRS Data Sync RuneLite plugin's files in
`~/.runelite/plugin-data/osrsdatasync/<player>/` (only `progress.json` and `containers.json`, read only).

```powershell
node src/server/start.js
```

It also serves the calculator at http://localhost:3124/osrs-dps/ from the static build in `out/`, so run `npx next build`
once (and again after updating the code) for the `calcUrl` links below to work.

Env: `CALC_URL` (where `calcUrl` links point, default this server's `/osrs-dps/`), `PORT` (default 3124), `OSRS_SYNC_DIR` (default `~/.runelite/plugin-data/osrsdatasync`), `OSRS_PLAYER` (only
needed when the sync folder has more than one account). It listens on 127.0.0.1 only.

## Endpoints

- `GET /health`: the account it found, when its files were exported, and warnings if they're over a day old.
- `GET /monsters?name=kurask`: monsters whose name contains the text, with their versions and HP.
- `POST /optimize`: a JSON body (only `monster` is required):

```json
{
  "monster": "Abyssal demon",
  "version": "Standard",
  "onSlayerTask": true,
  "potions": ["super combat", "ranging", "saturated heart"],
  "prayers": ["piety", "rigour", "augury"],
  "styles": ["melee", "ranged", "magic"],
  "results": 3,
  "minWeight": 0,
  "locked": { "weapon": "Dragon warhammer", "shield": null },
  "excludeItems": ["Twisted bow"],
  "extraItems": ["Bandos chestplate"],
  "items": [4151, "Rune platebody"],
  "skills": { "atk": 99 },
  "boosts": { "str": 21 },
  "buffs": { "inWilderness": true, "chargeSpell": true },
  "monsterInputs": { "toaInvocationLevel": 300 },
  "spell": "Fire Surge",
  "excludedSpells": ["Ice Barrage"],
  "training": "strength"
}
```

- `prayers` default to the best ones the synced account is known to have (Piety with King's Ransom, else Ultimate
  Strength and Incredible Reflexes; Eagle Eye; Mystic Might). Rigour, Augury, Deadeye and Mystic Vigour need an unlock
  that isn't synced, so pass them when you have them.
- `potions` default to none. Names match the calculator's (e.g. "Super combat", "Ranging potion", "Saturated heart",
  "Overload (+)", "Smelling salts"), ignoring case and punctuation.
- `items` replaces the synced items, `extraItems` adds to them. Items are IDs or names.
- The Kandarin hard diary (bolt specs) is taken from the synced diaries.

The response has the monster used (and its other versions), the levels, boosts and prayers used, and per style the top
setups with `dps`, `secondsPerKill`, `maxHit`, `accuracy` (%), `style`, `spell`, `equipment` per slot, `weight`, the
damage the monster deals (`npcDps`, `avgDmgTakenPerKill`), equal-DPS alternatives, and `calcUrl`: a link that opens the
calculator with the monster selected and the setup (gear, style, spell, prayers, levels, potions and buffs) in a new
loadout, next to your saved ones. A full search over a large bank
takes about 5 to 20 seconds, with a thread per style.

## Live refresh for Claude pages (MCP)

`src/server/mcp.js` is a small stdio MCP server that lets Claude artifact pages (boss guides) refresh themselves when
opened in the Claude desktop app. Register it once:

    claude mcp add -s user osrs -- node <repo>/src/server/mcp.js

A page declares `capabilities: {mcp: {servers: [{server: "host:osrs", tools: [...]}]}}` and calls
`claude.use("mcp").callTool("host:osrs", tool, args)`. All tools are read-only:

- `boss_status {npc, items, caIds}`: loot tracker kills and drops, collection log counts, completed combat achievements
  and the sync files' export times.
- `dryness {filter, missingOnly}`: runs `dryness.py` (`OSRS_DRYNESS`, default `~/osrs-tools/dryness.py`) and parses its
  output into items with the % chance to be this dry or lucky.
- `optimize {monster, version, ...}`: the same body as `POST /optimize`; starts the optimizer server if it isn't running.

## Live boss guides

The server also serves the boss guides live: open http://localhost:3124/guides/ (e.g. `/guides/brutus`). Each page
(`src/server/guides/<name>.html`) calls `POST /tools/<tool>` on load for the kill count, collection log, combat
achievements and dryness, and its Refresh all button reruns the optimizer too. The same file is published as the Claude
artifact; there it shows the last saved snapshot and links to the live page, since Claude pages can't reach local
tools yet (it would use the MCP server above once they can). The tools live in `guideTools.js`.
## Guide data and the guide template

- `GET /guide-data?source=Brutus&monster=Brutus&kind=boss` (or `POST` the same JSON, or `?guide=<slug>` for a saved
  guide): everything a guide needs in one call (see `guideData.js`): kill count, collection log slots with have/missing,
  rate and dryness %, combat achievements, other drops, owned items (`items=`), missing quests/levels, stale-file
  warnings and, for bosses and slayer monsters, the best gear per style. The gear optimizer runs at the same time as the
  rest and is skipped for `kind=activity` or `gear=0`.
- Wiki data (collection log slots, combat achievements, item names, drop tables) is cached by `wikiCache.js` in
  `OSRS_WIKI_CACHE` (default `~/osrs-tools/cache/wiki`) and refreshed in the background when over a week old;
  `node src/server/wikiCache.js --refresh` fetches everything again.
- Guides are `guides/<slug>.json` (content) rendered with `guides/_template.html` (see `guidePage.js`). The server
  serves them live at `/guides/<slug>` and keeps the last data in `guides/snapshots/` (not committed).
  `node src/server/buildGuide.js <slug> [--cached|--no-gear]` writes `guides/<slug>.html` for publishing as an artifact
  and prints a summary. The guide workflow and layouts are in `.claude/skills/osrs-guides/SKILL.md`.
