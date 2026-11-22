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
