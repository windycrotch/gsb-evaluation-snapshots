<p align="center">
  <a href="https://tunjaymikayilzade.github.io/Borders_and_Crowns/">
    <img src="https://img.shields.io/badge/%E2%96%B6%20PLAY%20NOW-in%20your%20browser-2ea44f?style=for-the-badge" alt="Play Borders & Crowns now">
  </a>
</p>

<p align="center"><b><a href="https://tunjaymikayilzade.github.io/Borders_and_Crowns/">https://tunjaymikayilzade.github.io/Borders_and_Crowns/</a></b><br>No download, no sign-up.</p>

# Borders & Crowns

A free browser strategy game for fans of Age of History II style map games. A free, turn-based grand strategy game on the real world map. Pick any of 169 nations, command armies across 3,424 provinces, manage your treasury, and deal with rivals through war, peace and alliances.

The whole game is one HTML file. It runs in any modern browser, needs no installation and no account, and saves itself in the browser.

> Borders & Crowns is an independent hobby project inspired by Age of History II. It is not affiliated with, endorsed by, or connected to that game or its developer. All code, design and names here are original.

## Play

Download `index.html` and open it in a browser. That is all.

## Features

- **Real world map**: 169 nations and 3,424 provinces, each named after a real city, with land borders and sea routes.
- **Turn-based orders**: plan your moves, then end the turn and watch them play out together with everyone else's.
- **Armies**: move, attack, and recruit. Sea landings attack at a penalty; capitals defend better.
- **Marches**: right-click a distant province and the army walks there by the shortest route, one province per turn.
- **Gather all armies**: bring every free army to one province with a single click.
- **Economy**: income from population and development, upkeep for soldiers; every nation's gold surplus is cut by 30% for a tougher game. Developing a province is costly and pays off gradually: +20% income over 10 turns, one development at a time per province.
- **Realm orders**: develop every province or recruit along the whole border in one click.
- **Diplomacy**: declare war, offer peace, improve relations, form and break alliances. Allies are called into defensive wars.
- **AI rivals**: every other nation recruits, attacks, makes peace and forms alliances on its own.
- **Capitulation**: a nation that loses its capital and most of its land surrenders to the conqueror.
- **Map modes**: political, diplomatic, population and income. In the data modes, darker means more.
- **Two save slots**: the game autosaves every turn into the slot you chose, and you can save to either slot from the menu. Right-click a slot on the start screen to reset or delete it.
- **Fog of war for armies**: you see armies only on your own land, in nations at war with you and in allied nations.
- **Navy**: ports build ships (a ship carries 500 soldiers). Fleets sail the long sea lanes for naval invasions, fight enemy fleets in port first, and can raid ports. AI nations use them too.
- **Diplomacy points**: improving relations costs 1 point. Points arrive slowly each turn and friendly nations cost upkeep.
- **Turn order**: at war, a turn has two parts. End move carries out your moves and attacks; then the enemy waits; then Enemy moves lets it answer. Recruiting and reinforcing a front-line province (one that borders a nation you are at war with) from a province next door happen at once, in either part, so the enemy meets whatever you have; every other journey takes one province per turn. At peace a turn is one press. Nations already at war are easier prey for a third party.
- **Peace terms**: demand or offer provinces and gold when you make peace, and see at once whether the other side would accept. AI nations make such demands and offers to you and to each other.
- **Tutorial**: a guided practice game as China (offered on your first visit, and always on the start screen). Glowing hints teach map modes, recruiting, moving and marching armies, diplomacy, war, the two-part turn, peace talks and ships. It is never saved.
- **Rankings, event log and autosave**.

## Controls

| Action | How |
| --- | --- |
| Select a province | Click it |
| Move or attack | Select your province, then click a highlighted neighbour |
| March far away | Select your province, then right-click the destination |
| End the turn | The End turn button, or Enter / Space |
| Clear selection | Esc |
| Pan and zoom | Drag, and scroll or pinch |

## Rules in short

- 100 soldiers cost 1 gold to recruit and 0.1 gold per turn to keep.
- Each action (a move, a recruitment, a development) uses one of your actions for the turn.
- Captured provinces start at 40% stability and recover over time.
- Peace is followed by a 10-turn truce.

## How it is built

Plain JavaScript and the Canvas API, with no framework and no build system beyond two small Python scripts.

```
index.html            the finished game (generated)
src/game.js           game logic, AI, rendering and interface
src/index.tpl.html    page markup and styles
src/data.json         nations, provinces, borders and sea routes (generated)
tools/build_map.py    turns country outlines into provinces (needs numpy, scipy, Pillow)
tools/countries.py    nation names, capitals, population and economy figures
tools/assemble.py     joins src/ into index.html
tools/map-source.txt  compact country outlines used by build_map.py
```

To rebuild after editing `src/`:

```
python tools/assemble.py
```

## Credits

- Country outlines come from [Natural Earth](https://www.naturalearthdata.com/) (public domain), taken from the world map bundled with [DataMaps](https://github.com/markmarkoh/datamaps) (MIT licence). The map shows territories as that dataset draws them. City names for the provinces come from the Natural Earth populated places dataset (public domain), with a few extra towns added for very small nations (`tools/cities.py`).
- Population and economy figures are rough approximations used only for game balance.
- Fonts: Marcellus and Barlow Semi Condensed, loaded from Google Fonts.
