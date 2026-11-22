---
name: osrs-guides
description: Jesse's OSRS guides (GIM Fasd). Use for any boss, slayer task, minigame/activity, skilling, achievement diary, collection log (dry/lucky) or OSRS calculation question. Holds the page layouts and the fast data path (local guide-data server, wiki cache, page template).
---

# OSRS guides for GIM Fasd

Treat Jesse as a solo ironman (no GE, trading or group content unless asked; never mention GE prices). Always check the
OSRS Wiki for facts the data below doesn't give; if the wiki and memory disagree, use the wiki. If something can't be
confirmed, say so in one line.

## Fast data path (use this first)

Everything runs on Bacchus in `E:\repos\osrs-dps-calc`. The server is `node src/server/start.js` (port 3124); the
tools below start it if it is down.

- **One call for the account and wiki data**: `GET http://localhost:3124/guide-data?source=<name>&monster=<name>&kind=boss|slayer|activity`
  (or `POST` the same as JSON). Returns kc (loot tracker, Wise Old Man, screenshots), collection log slots with
  have/missing, rate and dryness %, combat achievements with done flags, other drops, `owned` for `items=a,b`, `missing`
  for `quests=...`, levels, stale-file warnings and, for boss/slayer with a `monster`, the best gear per style (with
  calcUrl). Optional: `version`, `clog` (log entry names, default `source`), `dropPage`, `dryness` (filter), `caMonster`,
  `gear=0`. Gear uses Jesse's presets (boss: Piety/Eagle Eye/Mystic Might + super combat/super ranging; slayer: no
  prayers + super attack/super strength, on task). Activities never run the optimizer.
- `source` is the loot tracker name (e.g. `Brutus`, `Reward pool (Tempoross)`, `Lunar Chest`); if kc is 0 check
  `killcounts.json` for the exact name. Monster versions: `GET /monsters?name=...`.
- Wiki data (collection log slots, CAs, item ids, drop tables) is cached in `~/osrs-tools/cache/wiki` and refreshes
  itself weekly; `node src/server/wikiCache.js --refresh` after a game update.
- Raw files if needed (read only): `C:\Users\Jesse\.runelite\plugin-data\osrsdatasync\gim_fasd\` (progress.json,
  clog.json, killcounts.json, containers.json). Never open anything else in `.runelite` except file names in
  `.runelite/screenshots/GIM Fasd/`. Never write there.
- If the data's `stale` list is non-empty: one line telling Jesse to press Export. If `wiseOldMan.stale`: tell him to
  update https://wiseoldman.net/players/gim%20fasd.

## Boss and slayer guides: an artifact page

1. Write `src/server/guides/<slug>.json` (format below). Put the guide-data params in `"data"`.
2. `node src/server/buildGuide.js <slug>`: fetches the data (gear included, ~20-30s), writes `guides/<slug>.html` and
   prints a summary (kc, missing clog with dryness, open CAs with ids, gear, owned items, rare drops, warnings).
3. Fill in what the summary shows (`caHow` for open CAs, "you have it" pills), then `buildGuide.js <slug> --cached`.
4. Publish `guides/<slug>.html` with the Artifact tool (new guide: icon `sword`; an existing guide: pass its URL).
   Live version: http://localhost:3124/guides/<slug> (auto-refreshes, Rerun gear button).
5. In chat: just the link and one line on the key finding.

Content JSON (`"kind"`: `boss` | `slayer` | `activity`). Text fields take `[[Wiki page]]`, `[[Page|label]]`,
`**bold**`, and `{have:Item name}` (renders "you have it" / "not owned" from the bank, worn items and storage):

```json
{
 "kind": "boss", "title": "Brutus", "kicker": "Boss guide · off task", "subtitle": "Lumbridge cow field, NE corner",
 "stats": [["HP", "58"], ["Attack", "Crush"], ["Max hit", "19"], ["Weak", "Earth"]],
 "data": { "source": "Brutus", "monster": "Brutus", "version": "Post-quest", "quests": [] },
 "gearNote": "optional; default lists the prayers and potions used",
 "facts": [["Cannonable", "❌"], ["Instanced", "✅"], ["Location", "..."], ["Transportation", "[[Cowbell amulet]] {have:Cowbell amulet}"],
           ["Required item", "..."], ["Prayers", "..."], ["Inventory", "..."], ["Safespot", "..."], ["Slayer tips", "..."]],
 "mechanics": { "note": "optional", "items": [{ "cue": "*growls*", "title": "Charge.", "text": "Step to the side." }] },
 "caHow": { "636": "how to do it, only when not obvious" },
 "notableDrops": ["Clue scroll (easy)", ["Raw t-bone steak, bull bones", "always"]],
 "sections": [{ "title": "...", "column": "left|right|full", "items": ["bullets"], "facts": [["label", "text"]], "head": [], "rows": [[]] }]
}
```

Rules for the content:
- Facts, in this order, leaving out what doesn't apply: Cannonable ✅/❌; Multi-combat ✅/❌ (slayer only); Instanced ✅/❌
  (bosses only); Location/method (best spot + burst/barrage etc.); Transportation; Required item / weight (`{have:…}`,
  else one line on how an iron gets it, or "minimal weight"); Prayers; Inventory (beyond the obvious); Safespot;
  Slayer tips (Mortimer: pick or pass, block, superior, extension worth it). Yes/no facts only in their ✅/❌ field.
- Mechanics: the 1–3 that matter, as cue text → what to do.
- CAs: the page shows only incomplete ones from the data; add `caHow` where it isn't straightforward.
- Notable drops: useful for an iron, excluding collection log items (the clog table covers those).
- Don't write a requirements line; put real requirements in `data.quests` / `data.levels` and the page flags only
  missing ones.
- Example: https://claude.ai/artifact/A1o8FVZW6YNWQmfc11ryne (Brutus, `guides/brutus.json`).

## Minigames and activities

Use `kind: "activity"` with the same flow (no gear). `data.source` is the loot tracker reward source, `data.clog` the
collection log entry, `kcLabel` e.g. "permits". Put these in `facts` (left out when they don't apply): Transportation;
Requirements (only missing); Required item / weight; XP/hr and AFK level. Sections: How it works (2–4 bullets, core
loop); Strategy (most points/XP/loot per hour, solo); Rewards worth it for an iron (priority order with point cost, as a
table). The clog table comes from the data. If Jesse only wants a chat answer, answer in bullets with the same lines.

## Skilling (chat answer)

- Levels from `guide-data` (`levels`) or progress.json.
- Every method available now that isn't outclassed; one line each: [method](wiki), XP/hr, AFK level (low/med/high),
  short description.
- **Skilling gear**: the skill's outfit and boosting items he owns (check with `items=` on guide-data, e.g.
  `GET /guide-data?source=x&kind=activity&dryness=false&dropPage=false&caMonster=false&clog=&items=Prospector helmet,Celestial ring`),
  telling him to wear/bring them; for useful ones he lacks, one line on how an iron gets them.

## Achievement diaries (chat answer)

Full task list for the tier, each marked done/not done from progress.json `diaryTasks` (one char per task in the wiki
table order, 1 = done). Mark missing levels and quests; for levels say if and how they can be boosted. Never suggest
spicy stews.

## Dry or lucky

Run `python C:\Users\Jesse\osrs-tools\dryness.py [filter] [--missing] [--refresh]` and answer from its output (or use
the `dry` / `lucky` fields from guide-data). Dryness only for missing items (% chance this dry or drier), luck as %
chance this lucky or luckier. Area-locked drops and sources without a wiki drop table are left out.

## Calculations

Rates from the wiki, current XP from progress.json, calculate with code; show the result, not the working.

## Style

Bullets only. No intro, summary or "Want me to…?". Explain only when not obvious. No filler numbers he doesn't act on.
Link names inline to wiki pages you confirmed exist. If the question is vague ("trolls"), ask one short question first.
