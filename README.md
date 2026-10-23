# osrs-dps-calc
[![](https://img.shields.io/badge/view%20online-red)](https://tools.runescape.wiki/osrs-dps) ![GitHub contributors](https://img.shields.io/github/contributors/weirdgloop/osrs-dps-calc)

Web-based DPS calculator for Old School RuneScape, created for the [OSRS Wiki](https://oldschool.runescape.wiki).

This calculator determines how well certain loadouts, consisting of equipment, prayers, and buffs, will perform against monsters in the game. It heavily uses data from the OSRS Wiki.

## Portable executable
Every push to `main` publishes a portable build to [GitHub releases](../../releases/latest). Download the file for your OS and run it: it serves the calculator locally and opens it in your browser. No install needed.

To build it yourself, run `yarn build`, copy `out/` to `desktop/site`, then run `go build` in `desktop/`.

## Contributing
We accept issues and pull requests! [Click here for info](CONTRIBUTING.md).

## Acknowledgements
* Bitterkoekje's [spreadsheet](https://docs.google.com/spreadsheets/d/1wzy1VxNWEAAc0FQyDAdpiFggAfn5U6RGPp2CisAHZW8/edit?pli=1#gid=158500257) for a lot of initial math, formulas, and more
* Many [OSRS Wiki](https://oldschool.runescape.wiki) contributors for information on items, monsters, spells, and more
* ...and all of the [contributors](https://github.com/weirdgloop/osrs-dps-calc/graphs/contributors) to this project!
