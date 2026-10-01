# Descents

A browser-based, first-person exploration game about descending into a vast
and dangerous abyss. Every world is generated from a seed: the city on the rim,
the layers below, rivers and lakes, caves, ruins, the creatures that live there
and the artifacts they guard. Generation is deterministic, so the same seed
always produces the same world, and different seeds produce different ones.

There is no combat loop, no hunger and no thirst. The game is about
**exploring, discovering, observing, cataloguing, finding artifacts, learning
and descending.**

![loop](https://img.shields.io/badge/loop-explore%20→%20discover%20→%20observe%20→%20catalog%20→%20descend-6b5530)

---

## Playing

```bash
npm start            # serves the game on http://localhost:8080
# or: node server.js 3000      /      python3 -m http.server 8080
```

Open the address in a recent desktop browser (Chrome, Edge, Firefox, Safari).
The game uses ES modules and web workers, so it has to be served over HTTP —
opening `index.html` directly from disk shows instructions instead. No build
step and no dependencies to install: three.js is vendored in `lib/three`.

On the title screen, type any seed (or roll a random one) and choose
**Begin a new descent**. Saved expeditions appear under **Continue** and
**Load expedition**.

### Controls

| Key | Action |
| --- | --- |
| `W A S D` / mouse | Move / look |
| `Shift` | Run |
| `Space` | Jump · hold against a rock face to climb · let go of the cable |
| `Ctrl` / `C` | Crouch · drop from a wall |
| Left click | Fire / release the grappling arm |
| Right click / `Q` / wheel up | Reel the cable in |
| `Z` / wheel down | Pay the cable out (rappel) |
| `X` | Release the cable |
| `E` | Take an artifact |
| `F` (hold) | Observe — zoom in and study a creature |
| `R` | Use the active artifact ability |
| `L` | Explorer's lamp |
| `M` | Map |
| `N` | Vertical abyss map |
| `J` / `Tab` | Creature catalog |
| `I` | Equipment |
| `Esc` / `P` | Pause (save, load, settings, controls) |

---

## The world

The world is an island about 3 km × 2.6 km of hexagonal terrain columns
(roughly 3000 × 3000 cells at one-metre resolution). At its centre lies the
**Abyss Eye**, a single enormous opening. Everything is one continuous space:
there are no loading screens between layers and no teleporting — every metre
of the descent is travelled.

### The city (surface)
A procedurally planned city rings the rim of the Abyss: radial avenues and
ring streets, districts of houses with varied roofs and floors, markets with
stalls and fountains, the Delvers' Guild and its tower, a temple, an
observatory, storage yards, windmills, outlying hamlets and farms, gates with
stairways down into the first layer, and observation platforms with cranes and
telescopes leaning over the void. Its layout, names and architecture change
with the seed.

### Layer 1 — The Verdant Edge (0–350 m)
A vast bowl curving down towards the Eye: grassy terraces, meadows, shrubs,
groves, ravines, rock outcrops and spires, ancient ruins and arches, caves,
lakes in depressions and rivers that follow the terrain downhill and plunge
over the lip of the Eye as great waterfalls. Near the lip the ground becomes
steeper, more vertical and more dangerous.

### Layer 2 — The Inverted Forest (350–900 m)
Below the lip the walls of the shaft open into huge galleries whose ceilings
grow forests upside-down: hanging trees, suspended vegetation, glowing fungus,
springs and waterfalls pouring from gallery mouths, natural bridges, ruins and
vertical routes. Near the bottom of the layer the shaft widens into a bell
chamber over the **Stone Plain**, a pale rock plain with scattered trees,
pools, ruins, rock formations and its own creatures.

### Layer 3 — The Great Fault (from 900 m)
The plain is split by the Great Fault. A ledge path leads down to **the
Threshold**, the entrance of the third layer. This version ends there; it is
also where the creatures stop ignoring you.

### Guaranteed routes
After generation, the planner traces and **validates** walkable routes —
step heights, headroom, floors — and the test suite checks they connect:
gate stairways out of the city; several Layer 1 journeys (the long and safe
Delvers' Road, a river trail, a cave route, a ridge trail); the Lip Approach;
the Great Spiral ledge down the shaft into the galleries; deep tunnels and
gallery trails; the Long Stair to the Stone Plain; the Plain Trail; and the
Threshold Descent. Shortcuts exist for the bold: cliffs to climb, caves, and
gaps that need the grappling arm.

### Water
Water is not made of blocks. Lakes are flat continuous surfaces at a
consistent level for every connected body, sitting a few tenths of a metre
below their banks; rivers follow elevation downhill with falls where the
terrain drops; waterfalls appear only where a river meets a cliff or the Eye;
no water ever floats in the air.

---

## Core mechanics

### Traversal
Walk, run, crouch and jump; step up small ledges and **mantle** higher ones
automatically; **climb** rock faces while stamina lasts; **swim** (rivers carry
you with their current). Falls hurt in proportion to the impact — water breaks
them. If you die, you wake at your last safe footing.

### The Mechanical Grappling Arm
Your starting artifact. It fires a claw up to **60 m**, bites into rock or
wood, and keeps you **physically connected** by an inextensible cable: swing on
it like a pendulum, reel in to haul yourself up, pay out to rappel down a
cliff, and get pulled over the ledge when you reach the claw. The cable snags
on edges it passes over. Artifacts can extend its range and winch speed.

### Creatures and the genome system
Each world has roughly 30 species across five families — **mammals,
reptilians, birds, arthropods and lithoseres** (living rock and mineral
creatures). Species are built from ecological roles (grazers, browsers,
predators, scavengers, pollinators, decomposers, lithophages, cliff gliders,
ceiling crawlers…) and a genome that sets size, proportions, number of legs,
locomotion, head and eyes, mouth or beak, horns, crests, spines, tails,
wings, covering, colours and patterns, diet, speed, strength, perception,
social structure, reproduction, aggression and activity period. Individuals
carry heritable variation and offspring inherit a blend of both parents plus
mutation — so parents and young look related but never identical.

### Ecosystem
Populations are simulated per region whether or not you are watching:
growth, predation, competition and migration continue in the background.
Near you, regions materialise into individual creatures that forage, graze,
drink, hunt, flee, defend territory, court, give birth, raise young that
follow their parents, flock, live in symbiosis with hosts, scavenge kills,
sleep by their activity cycle and migrate. In Layers 1 and 2 creatures ignore
the explorer; in the Great Fault something will hunt you — your lamp keeps it
at bay.

### Observing and the catalogs
Look at a creature to record it. Hold **F** to observe it closely: the longer
you watch, the more you learn (locomotion, size, activity, social life, diet,
traits, reproduction). Interactions you witness — who hunts whom, symbiosis,
courtship, births, territorial fights — are written into the catalog. The
**Creature Catalog** shows a 3D model, name, family, appearance, habitat,
diet, behaviour, traits and observed interactions; only what you have
discovered is shown.

### Artifacts
Around 50–60 artifacts are generated per world with procedural shape,
material, size, rarity (Fourth to Special Grade), category (tools, relics,
amulets, equipment, mechanical objects, scientific instruments, weapons,
organic, ritual and unknown objects) and properties: passive effects (stride,
spring, feather-fall, grip, reach, winch, light, creature sense, dowsing,
insight, vigour, wayfinding, swimming), active abilities (flare, updraft,
echo pulse, glide, survey) and sometimes drawbacks. They rest where it makes
sense — in ruins, deep cave chambers, atop spires, among crystal geodes, in the
spray of waterfalls, beneath the Threshold. Wear up to three; their properties
reveal themselves after carrying them a while. The **Artifact Catalog**
records appearance, category, rarity, known properties and where each was
found.

### Maps
- **Map (M):** a chart of the terrain you have actually explored, per depth
  band (surface & Layer 1, Layer 2, Layer 3), with hillshade and contours,
  water, discovered landmarks, routes you have walked, artifact sites, your
  trail and layer boundaries once you have reached them. Nothing is revealed
  automatically.
- **Vertical map (N):** the whole abyss in profile — every layer and its
  depth, the deepest point you reached, discovered places, known routes, and
  a true cross-section of the terrain along your bearing from the Eye.

### Saving
Expeditions are saved in the browser (autosave every two minutes and when
you reach a new layer, plus manual saves from the pause menu). A save stores
the seed and everything that changed — your position and state, discoveries,
catalog, artifacts, explored map, trail and ecosystem populations — so
loading regenerates exactly the same world. Saves can be exported to and
imported from JSON files.

### Atmosphere
Each layer has its own lighting, fog, sky, particles (pollen, fireflies,
spores, cave dust, embers) and sound. Days and nights pass (one game hour per
real minute). All audio is synthesised live: wind, rivers, lakes, waterfalls,
cave drips and reverb, the city, footsteps per ground material, the arm's
winch, every species' own call derived from its genome, and generative music
whose scale and instruments change with each layer.

---

## Project structure

```
index.html            entry page (canvas, UI root, import map)
css/                  style.css (menus), hud.css, journal.css
lib/three/            three.js (vendored)
server.js             tiny static server (npm start)
js/main.js            boots the app (or debug views via URL parameters)
js/game.js            game loop, plan generation in workers, systems
js/core/              rng (seeded), noise, hex grid, math, input, workers
js/world/             procedural generation
  params.js             seed → world parameters
  field.js              terrain field: rim, city plateau, bowl, Eye, galleries, plain, fault
  hydrology.js          coarse grid, lakes (priority flood), rivers, falls
  caves.js abyss.js     caves, the spiral, gallery windows, deep tunnels, fault ledge
  city.js ruins.js      city planning, ruins, arches, spires, crystals
  structures.js         building primitives
  routes.js             path finding, profiles, validation
  plan.js               orchestrates the whole plan
  column.js             column generator (CSG of terrain, caves, water, structures, routes)
  mesher.js flora.js    chunk meshes, vegetation and decor
  world.js              main-thread queries (collision, raycasts, water)
  layers.js             extensible layer definitions (visuals, audio, ecology, artifacts)
js/render/            renderer, materials/shaders, sky, particles, chunk streaming (LOD)
js/player/            explorer controller, collision, grappling arm
js/creatures/         genetics, creature meshes, procedural animation, ecosystem
js/artifacts/         artifact generation, models, in-world artifact system
js/systems/           discovery, map exploration data, environment probe, saves
js/audio/             procedural audio engine
js/ui/                app shell (menus), HUD, journal, maps, 3D previews
tests/                automated tests (npm test)
tools/                browser tests, screenshots, debug renders
changelogs/           one .txt file per version (see CHANGELOG.md)
```

### Adding a layer
Layers are described in `js/world/layers.js`: depth range, visuals (fog, light,
sky), audio profile, ecological roles for species generation, artifact pool
(count, rarity weights, categories), vegetation and traversal notes. The
terrain rules for a new layer go in `field.js` / `column.js`, its routes in
`plan.js`; species, artifacts, atmosphere, audio and maps pick the new layer
up from its definition.

### Performance
The world is never instantiated whole. A quadtree of hexagonal chunks streams
around the explorer with six levels of detail, meshed in parallel web workers;
far chunks are simplified, foliage is limited to near chunks and creatures are
materialised only within ~150 m (at most 120 at a time) with the rest of the
ecosystem simulated abstractly. Settings let you trade view distance,
resolution, shadows and particles for speed.

---

## Testing

```bash
npm test                              # world, creatures, artifacts, saves, performance
SEEDS="my seed,another" npm test      # on your own seeds
npm test World                        # one suite
```

`npm test` generates several worlds and checks: deterministic generation and
seed variety; the city; Layer 1, the Eye, Layer 2 galleries and plain, the
Layer 3 entrance; that every guaranteed route validates and is connected to
the city; water rules (level lakes, contained shores, downhill rivers, no
floating water); caves, overhangs and cliffs; species per layer and family,
morphological variety, food webs and inheritance; a headless ecosystem
simulation (behaviours happen without the player; Layer 1 creatures ignore
the explorer; the Layer 3 predator hunts); artifact placement and effects;
save round trips; and generation/meshing speed.

Browser checks use Playwright and a running server
(`node server.js 8099`):

```bash
npm run test:ui        # menus, HUD, journal tabs, pause, saving (screenshots in tests/output)
npm run test:play      # observe a creature, take an artifact, visit every layer
npm run test:traverse  # an autopilot walks every guaranteed route, city → Layer 3, with real physics
npm run test:grapple   # climb a rim cliff using only the grappling arm
```

Set `BASE_URL` if the server runs elsewhere.

Debug views: `index.html?debug=1&seed=…&loc=rim|station|bowl|shaft|gallery|plain|fault`
(free camera) and `index.html?bestiary=1&seed=…` (every species, adult and young).

---

## Changelogs

See [CHANGELOG.md](CHANGELOG.md) for the list of versions; each version's
notes are in `changelogs/vX.Y.Z.txt`.
