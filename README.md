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
| `E` / `Shift` | Fire the grappling hook to swing across a canyon |
| `Space` | Use your power-up when the meter is full, otherwise pause |
| `Esc` / `P` | Pause / resume |
| `M` | Mute |
| `Enter` | Start / play again |

### Touch (phones & tablets — iOS and Android)

| Gesture | Action |
| --- | --- |
| Swipe up / down | Jump / slide |
| Swipe left / right | Turn at a corner (on a straight: hop one lane) |
| Hold the left / right half of the screen | Steer (a flick up/down while holding still jumps/slides) |
| Tap | Fire the grappling hook near a canyon, or use the full power meter |
| Tap the meter / ❚❚ button | Use power / pause |

**Settings → On-screen buttons** shows ◀ ▶ ▲ ▼ pads. They're on by default on touch devices, as a fallback in case swipes fight the browser. **Settings → Tilt steering** lets you lean the device to shift lanes; iOS asks for motion permission, and the tilt is re-calibrated at the start of each run. The game works in both portrait and landscape: in portrait the camera widens its view and pulls back so all three lanes stay visible. Browser pinch-zoom, double-tap zoom, pull-to-refresh and page scrolling are all blocked during play.

The first time you start a run, the game asks for your name for the high score board. You can change it in Settings.

## Gameplay

- **Track:** generated forever as straights joined by left, right and T-split junctions. Your speed rises with distance.
- **Obstacles:**
  - fallen logs (jump)
  - fire gates and low branches (slide)
  - rubble blocks (dodge)
  - gaps and broken half-paths
  - **swinging traps** that sweep across every lane: time your dodge, or jump at the bottom of the swing
  - **sliding blocks** that move back and forth on a rail
  - **collapsing floor**: cracked, glowing tiles shake and drop away just before you reach them, so jump
- **Grappling hook:** canyons are too wide to jump. When the golden ring above one pulses and the prompt appears, press `E` or `Shift` to swing across.
- **Biomes:** every 500 m the world changes: **Ancient Ruins → Lava Cavern → Deep Jungle**, then repeats. Each biome has its own fog, sky, lighting, stone, scenery (trees, basalt spires and embers, vines and fireflies) and its own obstacle mix. The lava has no logs but more fire and collapsing floors; the jungle has low branches, swinging logs and more canyons.
- **Game feel:** the camera shakes and the screen flashes on stumbles and impacts. Coin pickups burst into sparkles, and the coin counter bumps with each one. The FOV widens with speed and kicks out further when you boost or grapple.
- **Speed:** `currentSpeed = min(maxSpeed, baseSpeed + distance × accelerationRate)` is recomputed every frame. It starts at 13 m/s (47 km/h) and reaches the 34 m/s (122 km/h) cap at about 4.7 km. The HUD shows your speed in km/h. All the tuning values live in the `SPEED` object at the top of `game.js`. As you get faster:
  - obstacles are spaced by *time* (from about 0.95 s down to 0.7 s apart, never under 0.6 s), not by fixed metres
  - straights get longer, so corners don't come too often
  - you can see further ahead
  - power-ups become more common
  - jumps keep the same height but spend less time in the air, so a jump never sails absurdly far
  - slides get quicker and lane-shifting gets faster
  - coin arcs and canyon widths follow the real jump distance
- **Fatal vs. stumble:** hitting an obstacle head-on, falling into a gap or missing a corner ends the run. Clipping the edge of rubble, or catching a log with your feet, makes you **stumble**: your speed drops back toward the base speed for 3 seconds before ramping up again (the km/h readout turns red), and the monkeys close in. Stumble again within 5 seconds and they catch you.
- **Coins:** Gold = 1, Red = 2, Blue = 3. Coins fill the power meter and are banked for upgrades.
- **Power-ups** (pickups on the track, or from the meter):
  - 🧲 **Coin Magnet:** pulls in nearby coins for 8s or more.
  - ⚡ **Boost:** a burst of speed for 5s or more. You smash through obstacles, float over gaps and take corners automatically.
  - 🛡️ **Shield:** absorbs one fatal hit, fall or catch.
- **Score** = distance × multiplier + coin points.
- **Persistence:** high scores (with your name), banked coins, upgrades, unlocked characters and settings are saved in `localStorage`, per browser and per device.

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
