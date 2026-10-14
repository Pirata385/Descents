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

### Playing on a phone or tablet

Descents runs in mobile browsers in **landscape**. Touch controls switch on
automatically on phones and tablets (or via *Settings → Touch → Touch
controls*). Starting a game goes full screen and locks landscape where the
browser allows it; turning the device upright pauses the game and asks you to
rotate back. Adding the page to the home screen launches it full screen in
landscape. The first launch on a mobile device picks the **Low** graphics
preset (render distance 6 chunks, frame rate in step with the screen), and the resolution (then the view distance) adapts automatically if
the frame rate drops. A PS4 controller paired with the phone or tablet works
too — the touch buttons hide while you use it.

| Touch | Action |
| --- | --- |
| Left thumb | Drag to move — the stick appears where you touch; push it fully to run |
| Right side | Drag to look around |
| **Jump** | Jump · hold while pushing into rock to climb · leap off a wall |
| **Arm** | Fire the grappling arm at the centre of the view (**Release** while attached) |
| **Reel in** / **Pay out** | Appear while the claw is attached — hold to wind or let out cable |
| **Crouch** | Crouch · drop from a wall |
| **Observe** (hold) | Zoom in and study a creature |
| **Take** | Appears beside an artifact |
| **Ability** · **Lamp** | Active artifact ability (when worn) · explorer's lamp |
| ☰ · map · book | Pause · map · journal (pinch to zoom the map) |

Button size, opacity and look speed are adjustable under *Settings → Touch*.

### Controls (keyboard and mouse)

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

### Controller (PS4 DualShock 4)

Connect a PS4 controller by USB or Bluetooth and press any button; the game
says when it is recognised. A PS5 DualSense or any controller the browser
reports with the standard layout works the same way. Prompts switch to
PlayStation button glyphs while you use it, and switch back as soon as you
touch the keyboard, mouse or screen.

| Button | Action |
| --- | --- |
| Left stick | Move (analog) · push up or down to climb |
| `L3` | Run (toggle; stopping ends it) |
| Right stick | Look (a response curve for fine aim; turning speeds up when held fully over) |
| `✕` | Jump · hold against rock to climb · let go of the cable |
| `○` | Crouch · drop from a wall |
| `□` | Take an artifact |
| `△` / `R3` (hold) | Observe — zoom in and study a creature |
| `R2` | Fire / release the grappling arm |
| `L2` / `L1` | Reel in / pay out the cable |
| `R1` | Release the cable |
| D-pad ↑ / ↓ | Explorer's lamp / active artifact ability |
| D-pad ← / → | Map / vertical abyss map |
| `SHARE` / touchpad | Creature catalog / equipment |
| `OPTIONS` | Pause |

Menus and the journal are fully playable with the controller: the d-pad or
left stick moves a highlight between buttons (and changes sliders and
lists), `✕` selects, `○` goes back, `L1`/`R1` switch journal tabs and the
right stick scrolls — on the map it pans, with `L2`/`R2` to zoom. The
controller rumbles when you are hurt, land hard and when the claw bites.
Stick look speed, dead zone and vibration are under *Settings → Controller*.

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

### Layer 3 — The Great Fault (900–1900 m)
The Stone Plain opens onto the Great Fault: a colossal round **tube** some
250–300 m across whose pale walls of limestone and granite drop almost sheer
for a full kilometre, stepping in gentle ledges and overhangs, hazy with the
daylight that filters down from far above. There is no staircase into it:
the way down is a **natural cave network** inside its walls. Every way in is
marked on the plain by a pale **stone arch** and a ring of standing stones
over a sinkhole (three to five per world, spread around the tube); each
sinkhole opens into passages that wind, switch back and corkscrew down
through the rock from hall to hall — vaults, galleries and grottos with
their own names — along two main trunks that cross, merge and loop, with
dead-end dens and side passages. **Windows** break out onto the void:
ledges with a view across the tube, its nesting cliffs and moss-grown
ledges, and the mist far below.

At the bottom the lowest passage opens into **the Basin**, a cavern floor of
dark pools and pale fungus, and from there **the Fourth Gate** leads to the
entrance of **Layer 4, the Lantern Sea** (1900 m), where this version ends.

Only two kinds of animal live in the fault: small lizards and mammals in the
caves (skinks, lichen geckos, cave shrews, tunnel ferrets), and the fliers
and climbers of the open chasm (swifts and falcons that nest on the walls,
rift bats and flying foxes that roost under overhangs, wall-climbing and
gliding lizards).

### Guaranteed routes
After generation, the planner traces and **validates** walkable routes —
step heights, headroom, floors — and the test suite checks they connect:
gate stairways out of the city; several Layer 1 journeys (the long and safe
Delvers' Road, a river trail, a cave route, a ridge trail); the Lip Approach;
the Great Spiral ledge down the shaft into the galleries; deep tunnels and
gallery trails; the Long Stair to the Stone Plain; the Plain Trail to the
main swallet. Below that, the planner checks every passage of the fault cave
network (step heights, headroom, floors, grades) and that the halls connect
the plain to the Basin and the Fourth Gate; passages that cannot be made
walkable are removed. Shortcuts exist for the bold: cliffs to climb, caves,
windows, and gaps that need the grappling arm.

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
Each world has 33–36 species across five families — **mammals, reptiles,
birds, arthropods and lithoseres** (living rock and mineral creatures) —
filling ecological niches per layer (grazers, browsers, predators,
scavengers, pollinators, decomposers, lithophages, cliff gliders, ceiling
crawlers, cave foragers, chasm raptors, roosting fliers…).

Every species is a **gene pool**, not a template. 49 continuous genes
(body length and depth, neck, head, snout, jaw, eyes, ears, leg length and
thickness, feet, tail length and thickness, wing span and chord, crest,
spikes, plates, shaggy cover, colours, pattern, glow, speed, agility,
boldness, curiosity, sociality, aggression, territoriality…) each have a
species mean and spread, and discrete traits — ear shape, horns, crest,
tail tip, pattern, eyes, spike rows, cheeks — are drawn from allele tables.
Twelve **body plans** (quadruped, biped, sprawler, serpent, bird, bat,
glider, insect, spider, centipede, golem, roller) turn genes into anatomy,
so two individuals of one species differ in proportions and ornaments, not
just colour. **Subspecies** arise by themselves: each species has two or
three regional forms with their own gene offsets and allele preferences,
chosen by depth, zone and sector — a form of the plain may be crested where
its cousins of the walls are not. Offspring take each gene from either
parent or a blend, plus mutation; hybrids between neighbouring forms happen
where their ranges meet.

Each creature is one procedurally built, skinned mesh (one draw call) with
painted patterns and, in the deep, glowing markings. Animation is
procedural: gaits by body plan with foot placement (two-bone IK), wing
flaps, folds and glides, head tracking, breathing, feeding, calling and
threat displays.

### Ecosystem
Populations are simulated per region whether or not you are watching:
growth, predation, competition and migration continue in the background,
and every region keeps a pool of genomes so the individuals you meet are
the descendants of those you met before. Near you, regions materialise into
individuals with needs (hunger, energy, fear, the urge to mate, the pull of
the group) and a temperament from their genes. Each decides what to do from
moment to moment: forage, graze, hunt, flee, scavenge, court, nest, raise
young that follow their parents, flock, mob a predator, defend a territory,
live beside a host, investigate the explorer or sleep by its activity
cycle. Creatures live where their bodies fit: on the ground, in the cave
passages, on the chasm walls, in the air, perched, or hanging from roosts.
Creatures keep appearing as you travel: whenever there is room under the
creature limit (*Settings → Graphics → Creatures nearby*), new individuals
are placed in real habitat around you — out of sight, in the kind of place
their species lives — and those you leave behind are folded back into their
region's population, making room for the next ones. Animals of the surface
and Layers 1 and 2 never attack the explorer; a
quiet, still observer is gradually tolerated. In the Great Fault, nesting
falcons and wall lizards defend their eggs — come too close and they will
dive at you until you back off.

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
spray of waterfalls, in the dens and windows of the Great Fault, beside its
nests and at the Fourth Gate. Wear up to three; their properties
reveal themselves after carrying them a while. The **Artifact Catalog**
records appearance, category, rarity, known properties and where each was
found.

### Maps
- **Map (M):** a chart of the terrain you have actually explored, per depth
  band (surface & Layer 1, Layer 2, the upper, middle and lower Great Fault,
  Layer 4), with hillshade and contours, the outline of the chasm,
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
imported from JSON files. Version 0.3.0 rebuilt the world below the Stone
Plain and the creatures, and 0.4.0 reshaped the Great Fault, so a save made
by an earlier version starts its seed anew (the game says so when you load
it).

### Atmosphere
Each layer has its own lighting, fog, sky, particles (pollen, fireflies,
spores, cave dust, the pale dust of the fault, the motes of the Lantern Sea)
and sound. Days and nights pass (one game hour per real minute). The Great
Fault is bright and misty: daylight scattered by haze between its pale
walls, a little cooler deeper down, dimmer inside the caves. All audio is
synthesised live: wind (and the updraft howling through the fault), rivers,
lakes, waterfalls, cave drips, scree falls, wingbeats in the tube, the
chimes of the Lantern Sea, the city, footsteps per ground material, the
arm's winch, every species' own call derived from its genome, and
generative music whose scale and instruments change with each layer.
Reverb follows the space: tight in passages, vast in the tube, with an
echo off its far wall. A compressor, make-up gain and limiter keep the mix
at a normal listening level. Browsers only start sound after a click, tap
or key press; if you start with a controller, the game tells you when it is
still waiting for one.

---

## Project structure

```
index.html            entry page (canvas, UI root, import map)
css/                  style.css (menus), hud.css, journal.css, touch.css (mobile)
manifest.webmanifest  home-screen install: full screen, landscape
lib/three/            three.js (vendored)
server.js             tiny static server (npm start)
js/main.js            boots the app (or debug views via URL parameters)
js/game.js            game loop, plan generation in workers, systems
js/core/              rng (seeded), noise, hex grid, math, input, gamepad (PS4), workers
js/world/             procedural generation
  params.js             seed → world parameters
  field.js              terrain field: rim, city plateau, bowl, Eye, galleries, plain, fault
  hydrology.js          coarse grid, lakes (priority flood), rivers, falls
  caves.js abyss.js     caves, the spiral, gallery windows, deep tunnels
  chasm.js              the Great Fault: shape of the chasm, wall distance queries
  faultcaves.js         the cave network in the fault walls, windows, dens, basin, gate, nest sites
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
js/creatures/         creature system
  genome.js             genes, alleles, niches, species, subspecies, inheritance, food webs
  anatomy.js            body plans: genes → proportions, features, colours, stats
  bodyMesh.js           one skinned mesh per individual, shared material
  motion.js             procedural animation (gaits, IK feet, wings, actions)
  brain.js              needs, temperament and utility-based decisions
  habitat.js            where creatures can live: ground, caves, walls, air, roosts
  ecosystem.js          regional populations, spawning, actions, movement, events
js/artifacts/         artifact generation, models, in-world artifact system
js/systems/           discovery, map exploration data, environment probe, saves
js/audio/             procedural audio engine
js/ui/                app shell (menus), HUD, journal, maps, 3D previews, touch controls
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
The world is never instantiated whole. Like a block game, only the chunks
within the **render distance** (*Settings → Graphics*, 3–32 chunks of 32 m)
are built and drawn; a quadtree of hexagonal chunks streams around the
explorer with levels of detail inside that radius, meshed in parallel web
workers, and a fog closes in towards the edge so the world fades out instead
of ending at a visible border (fog distances are measured from the eye, so
the edge does not swing as you turn). *Terrain detail* sets how far full
detail reaches. Creatures live within an area that follows the render
distance (up to ~170 m, 16–96 at a time, by setting) with the rest of the
ecosystem simulated abstractly; distant individuals think, move and animate
at a lower rate, new bodies are built within a small time budget per frame,
and each body is a single draw call. The shadow map is only redrawn where
the sun reaches. Graphics presets (Low, Medium, High, Ultra) set render
distance, terrain detail, resolution, shadows, particles and creature
count; with automatic quality on, the game first lowers the rendering
resolution and then the terrain detail to hold the frame rate, and gives
them back when it can.

The frame rate is not capped: *Frame rate limit* offers Unlimited (the
default on computers: every screen refresh gets a frame, and extra frames
are drawn in between while leaving the browser time to show them), the
display's refresh rate (V-Sync, the default on phones and tablets, where
extra frames only drain the battery) and fixed caps from 30 to 240 FPS.

---

## Testing

```bash
npm test                              # world, creatures, artifacts, saves, performance
SEEDS="my seed,another" npm test      # on your own seeds
npm test World                        # one suite
```

`npm test` generates several worlds and checks: deterministic generation and
seed variety; the city; Layer 1, the Eye, Layer 2 galleries and plain; the
Great Fault (a kilometre-deep chasm, a connected cave network from the plain
to the Basin and the Fourth Gate, walkable passages, windows, dens, nest
sites); that every guaranteed route validates and is connected to the city;
water rules (level lakes, contained shores, downhill rivers, no floating
water); caves, overhangs and cliffs; artifact placement and effects; save
round trips; and generation/meshing speed. The creature suite checks
that Layer 3 holds only cave and chasm fauna, that individuals of a species
differ in anatomy, that species differ in plan and behaviour, inheritance
and subspecies, food webs, animation, headless simulations of Layer 1, the
caves and the chasm, nest defence and breeding.

Browser checks use Playwright and a running server
(`node server.js 8099`):

```bash
npm run test:ui        # menus, HUD, journal tabs, pause, saving (screenshots in tests/output)
npm run test:play      # observe a creature, take an artifact, visit every layer
npm run test:traverse  # an autopilot walks every guaranteed route and the fault caves, city → Layer 4, with real physics
npm run test:grapple   # climb a rim cliff using only the grappling arm
npm run test:mobile    # emulated phone: touch controls, landscape/portrait, journal, pause, layout
npm run test:gamepad   # a scripted PS4 controller: menus, settings, play, journal, pause, rumble
```

Set `BASE_URL` if the server runs elsewhere.

Debug views: `index.html?debug=1&seed=…&loc=rim|station|bowl|shaft|gallery|plain|sinkhole|hall|fault|chasm|up|basin|gate`
(free camera; `&i=` picks a hall, `&y=` a chasm depth) and
`index.html?bestiary=1&seed=…&layer=layer3` (each species: two parents and four of
their young, showing inherited variation).

---

## Changelogs

See [CHANGELOG.md](CHANGELOG.md) for the list of versions; each version's
notes are in `changelogs/vX.Y.Z.txt`.
