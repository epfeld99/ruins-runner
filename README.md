# Ruins Runner

A browser-based 3D endless runner inspired by Temple Run. Grab the idol and outrun the Demon Monkeys through jungle ruins floating above the canopy.

It runs entirely in the browser: plain HTML, CSS and JavaScript, with no build step, backend or API keys. 3D rendering uses [Three.js r128](https://threejs.org/) from a CDN. Every sound is synthesised live with the Web Audio API.

**▶ Play:** open `index.html` in a browser, or visit the GitHub Pages site for this repo.

## Controls

| Key | Action |
| --- | --- |
| `↑` / `W` | Jump (logs, gaps, rubble) |
| `↓` / `S` | Slide (fire traps); in mid-air, slams you down |
| `←` / `→` / `A` / `D` (tap at a corner) | Turn 90° at a junction |
| `←` / `→` / `A` / `D` (hold on a straight) | Lean / shift lanes to grab coins |
| `Space` | Use your power-up when the meter is full, otherwise pause |
| `Esc` / `P` | Pause / resume |
| `M` | Mute |
| `Enter` | Start / play again |

## Gameplay

- **Track:** generated forever as straights joined by left, right and T-split junctions. It includes fallen logs, fire gates, rubble blocks, full gaps and broken half-paths. Your speed rises with distance.
- **Fatal vs. stumble:** hitting an obstacle head-on, falling into a gap or missing a corner ends the run. Clipping the edge of rubble, or catching a log with your feet, makes you **stumble**: you slow down and the monkeys close in. Stumble again within 5 seconds and they catch you.
- **Coins:** Gold = 1, Red = 2, Blue = 3. Coins fill the power meter and are banked for upgrades.
- **Power-ups** (pickups on the track, or from the meter):
  - 🧲 **Coin Magnet:** pulls in nearby coins for 8s or more.
  - ⚡ **Boost:** a burst of speed for 5s or more. You smash through obstacles, float over gaps and take corners automatically.
  - 🛡️ **Shield:** absorbs one fatal hit, fall or catch.
- **Score** = distance × multiplier + coin points.
- **Persistence:** high scores, banked coins, upgrades and unlocked characters are saved in `localStorage`.

## Menus

- **Character Select:** four runners, each with a small perk. Unlock them with banked coins.
- **Power-up Upgrades:** longer magnet and boost, a faster-charging meter, a higher score multiplier and a starting shield. You also choose which power the meter fires.
- **High Scores:** your local top 10.

## Project structure

```
index.html   markup for the canvas, HUD and all menu screens
styles.css   UI styling
game.js      the whole game: config, save, audio, world gen, physics, rendering, UI
```

`game.js` is split into numbered, commented sections. The tuning knobs live in `CFG` at the top. Open `index.html?debug` to expose `window.__ruins` in the console.

## Deploying on GitHub Pages

The repo is already static. Go to **Settings → Pages**, choose *Deploy from a branch*, then `main` and `/ (root)`.
