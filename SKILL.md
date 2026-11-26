---
name: place-to-3d
description: Turn any real place on Earth (a city, neighbourhood, street, mountain, canyon, island or coastline) into an interactive voxel 3D world in Spline, built from real terrain, buildings, parks, forests, roads and water. Use when the user asks for a 3D map, a 3D model or diorama of a real place, "my city / hometown / street in 3D", or voxel terrain of a real location.
---

# Place to 3D

Builds a real place as a voxel world inside a Spline scene: elevation from
the AWS Terrain Tiles, and buildings (with their mapped heights), roads,
water, parks, forests, fields, sand, rock and glaciers from OpenStreetMap via
OpenFreeMap. A 4 km city is 2–10M voxels; it builds in about half a second
once the map data has loaded (1–2 s) and renders at hundreds of fps on a
laptop.

Three ways to put it in a scene:

- **Live** (default): the scene stores only the place, the style and the
  framing. A script in the scene's HTML content fetches the map data and
  builds the voxels each time the scene plays, so the file stays small, any
  place is one edit away, and a small panel in the scene lets the viewer
  search for another place and change the size, detail, height, style and
  frame. The voxels exist only while it plays.
- **A .glb for the editor** (full detail, real objects): the place as a
  glTF file the user drags into the Spline editor. Every object is one
  material named for what it is ("Roofs · Terracotta", "Walls · White",
  "Water · Deep", "Strata 2", …), grouped under the place's name with the
  pedestal and vitrine, so recolouring a class is one edit and the user can
  select, move or delete anything. Per-voxel shading and water depth come in
  as vertex colours (a Multiply layer under each material). Made by the
  panel's "Save .glb for the editor" button, or by `scripts/export-glb.mjs`.
- **Baked over the MCP** (no file to hand over): the same idea, but the agent
  creates the objects itself with `3d_run_code`. Coarser (96–224 cells per
  side) because the data travels inside the scripts, and it needs a terminal.

Build live first. When the user wants to edit the voxels themselves, or
needs the place in an embed or on WebGL, give them a .glb; bake over the MCP
only when they can't import a file.

Work in one Spline file over the Spline MCP server: create it with
`spline_create_file` (`kind: "3d"`), pass its id as `file` on every call, and
give the user its link.

## 1. Choose the place

Decide the centre (latitude, longitude) and the ground size:

| Place | Size (`sizeM`) | Cells (`n`) |
|---|---|---|
| A street, campus or landmark | 1,500–3,000 m | 384–512 |
| A city centre or neighbourhood | 3,000–6,000 m | 512 |
| A mountain, canyon, island or coastline | 9,000–40,000 m | 512 |

Buildings and roads are included only when a cell is 25 m or smaller
(`sizeM / n ≤ 25`), and trees when it is 15 m or smaller, so keep cities
under ~8 km. Never go above `n: 768`.

Pick the centre deliberately. Geocoders return a city's administrative
point, which can be off in a suburb; centre on what the user will recognise
(Budapest: the Parliament, 47.507, 19.045; New York: Midtown, 40.748, −73.986).
`examples/demos.json` has six tested settings.

**If you can run commands,** check the place before building:

```bash
node scripts/cli.mjs "Budapest" --size 4000 --preview /tmp/place.png
node scripts/cli.mjs --lat 47.507 --lon 19.045 --size 4000 --preview /tmp/place.png
```

It prints the frame, the buildings, roads and land cover it found, the
terrain range and the biggest labels, and writes a top-down PNG. Look at the
PNG: is the landmark in the middle, is the river or coast where it should be,
is the area the right size? Adjust and rerun. (Node 18+, no install.)

## 2. Choose the look

- **Frame.** `crop` (default): a block cut out of the world, standing on a
  slab of rock strata, with a pedestal and a wireframe vitrine; it reads as a
  specimen, best for showing a whole city or mountain. It can be a 3:2 or 2:1
  strip (`aspect`) for a river, coast or ridge. `immersive`: no walls; the
  ground dissolves into the background at the edges, best for flying over a
  place.
- **Style.** `strata` (vivid and natural: sage ground, saturated greens,
  terracotta, slate, tile and brick roofs over white and pastel walls, turquoise
  to deep-blue water with waves, reflections and shore foam, rust strata), `night`
  (dark blocks, glowing roads, lit windows), `snow` (fresh snow, warm
  windows) or `model` (an architect's white model). Each style sets a background colour;
  use it for the scene (step 3) so the immersive fade blends in.

| Style | Background |
|---|---|
| `strata` | `#140e20` |
| `night` | `#07080d` |
| `snow` | `#c9d3df` |
| `model` | `#d9d6cf` |

## 3. Add a play camera

A new file has no camera. In `3d_run_code` (after loading the authoring guide
with `3d_load_skill`):

```js
const cam = add('PerspectiveCamera');
rename('Camera');
position({ x: 0, y: 600, z: 1200 });
rotation({ x: -27 });
setPlayCamera(cam);
playControls('none'); // the scene script orbits it
background('#140e20'); // the style's background
```

## 4. Add the builder

Call `3d_set_html_content` with [`scripts/scene.html`](scripts/scene.html),
editing only the `PLACE`, `ORBIT` and `SCENE` lines:

```js
const PLACE = { name: 'Budapest', lat: 47.507, lon: 19.045, sizeM: 4000, n: 512, style: 'strata', frame: 'crop' };
const ORBIT = { camera: 'Camera', dist: 1.45, pitch: 27, yaw: 205, speed: 5 };
const SCENE = { background: '#140e20', ui: true, worldWidth: 614 };
```

`PLACE` options beyond the ones in step 1 and 2 (all optional):

- `exag`: vertical exaggeration; default 1.2 for cities, 1.6 for landscapes.
  Lower it (1.0–1.1) for high mountains.
- `trees`: `false` to skip voxel trees.
- Crop only: `base`, the slab's depth in voxels (default 6% of `n`; more
  for a deeper cut); `vitrine`, the wireframe's height as a multiple (0 hides
  it); `aspect`, width ÷ depth (1, 1.5 or 2).

`ORBIT`: `dist` is the camera distance as a multiple of the place's width,
`pitch` its angle above the horizon, `speed` degrees per second (0 = still),
`yaw` the starting angle, `target` the point it circles (by default a little
above the ground, higher for tall places). Crop: `dist` 1.4–2.0, `pitch`
20–30. Immersive: `dist` 0.55–0.7, `pitch` 22–28.

`SCENE`: `background` is the colour you gave the scene in step 3 (scripts
can't read it, and the immersive edge fades into it); `ui: false` hides the
panel (for a clean published embed); `worldWidth` is the place's width in
world units, whatever `n` is, so the camera and lights you set keep working
when the viewer changes the detail.

**The panel.** With `ui: true` the scene shows a panel styled like Spline's
own sidebar, and every control applies live, with no Build button:

- Location: search (Enter; it geocodes once per search, never per
  keystroke), Size, Detail (`n`). These fetch new map data (1–2 s).
- Shape: Frame, Shape (aspect), Height (`exag`), Slab, Vitrine, Trees. These
  rebuild from the data already loaded (under a second for a 512 city).
- Style, Water, Light, Camera: preset, edge strength, regional tints, every
  class's colour stops (click a swatch), waves, reflection, foam, glints, sky,
  sun and shade colours, lit windows, glowing roads, orbit speed, distance
  and angle. These are shader uniforms and the palette texture: instant.
- Export: Save .glb (exactly what's on screen, with the edited colours),
  Copy link (`?place=lat,lon,km&style=&frame=`, which the scene reads on
  load), Copy settings (the PLACE and ORBIT lines for this look: ask the user
  to paste them to you, then put them in the scene's HTML).

**Inline the builder.** Paste the contents of
`scripts/place-scene.bundle.js` (38 KB) into a `<script>` just above the
template's script; the loader uses it when it's there. The template's
`BUNDLE` URL (jsDelivr) only works once this repository is public.

## Build, look, refine

- **Build:** the camera (`3d_run_code`), then the scene document
  (`3d_set_html_content`). The place builds itself in the viewer's browser,
  2–3 s after the scene starts playing.
- **Look:** hosted screenshots don't run scene scripts yet, so a capture can
  show an empty scene even when the build works. Ask the user to press Play
  in the Spline editor and to tell you what they see. If your screenshots do
  show the voxels, trust them.
- **Refine at least once with the user:** the centre (move it until the
  landmark sits mid-frame), the size, the height (`exag`), the style and
  frame, the camera's distance and angle. Each change is one
  `3d_edit_html_content` find-and-replace on the `PLACE` or `ORBIT` line;
  never resend the whole document to change a number. The user can also try
  settings in the panel and paste you the link it copies.

## Export a .glb for the editor

The user can press **Save .glb for the editor** in the scene's panel: it
downloads exactly what is on screen. Or, with a terminal:

```bash
node scripts/export-glb.mjs "Budapest" --size 4000 --n 384 --out budapest.glb
node scripts/export-glb.mjs --lat 47.507 --lon 19.045 --name Budapest --style strata --frame crop --aspect 1.5
```

Then the user drags the file into the Spline editor (or File → Import). Same
options as the bake below, plus `--n` up to 768. Size grows with detail: a
4 km city is about 30 MB at 384 and 50 MB at 512; a mountain at 512 about
60 MB. Suggest 384 unless they need the fine detail. Tell the user: each
object is one material, so to restyle a class they change that material's
colour; the vertex-colour layer under it carries the shading.

## Cube instances (a toy-brick version)

The place as real Spline cubes, one per visible voxel, over the MCP:

```bash
node scripts/cubes.mjs --lat 47.507 --lon 19.045 --name Budapest --size 3000 --n 128 --out /tmp/cubes-budapest
```

It writes two scripts; run them in order with `3d_run_code`. Each material
becomes one Cube (bevelled, a little smaller than its voxel) made a cloner
with `spreadType: 'vertex'` and `instanced: true` over a "points" mesh: one
zero-area triangle per voxel, so it samples as points and draws nothing (it
must stay visible; a hidden target gives the cloner no points). Budapest at
128 is ~21k cubes in 25 instanced draws, about 27 KB of script.

- Change one cube's size, bevel or material in the editor and every voxel of
  that class follows. Delete a class's cloner to drop it.
- Keep `sizeM / n` at 25 m or less, or there are no buildings (3 km at 128,
  4 km at 160). Mountains need ~1.6× the cubes of a city.
- `--gap` (default 0.94) sizes the cube against its voxel; 1 makes them touch.
  `--round` is the corner radius as a fraction of a voxel.
- Cubes are real objects, so hosted screenshots show them.

## Bake over the MCP

When the user can't import a file, the agent can create the objects itself.
With a terminal:

```bash
node scripts/bake.mjs "Budapest" --size 4000 --n 160 --style strata --out /tmp/bake-budapest
node scripts/bake.mjs --lat 47.507 --lon 19.045 --name Budapest --n 160 --frame crop --aspect 1.5
```

It writes a short series of scripts (`00-setup.js`, `01-band.js`, …,
`NN-frame.js`, `NN-group.js`) and prints their sizes. Run each one, in
order, as the `code` of one `3d_run_code` call, unchanged: read the file and
pass its contents. They create the material assets and the background,
then the meshes band by band, then the pedestal and vitrine, then group
everything as "<name> (baked)" and frame the view. Each band reports how many
meshes it made; if one fails, rerun that file alone.

- `--n` (96–224, default 160) trades detail for size: a city at 160 is about
  40 KB of scripts (≈ 13k tokens) in 5–7 calls. Go lower for a quick look.
- The same options as live: `--style`, `--frame`, `--slab` (percent of `n`),
  `--vitrine`, `--aspect`, `--exag`, `--width` (world units, default 614).
- Colours come from the style's palette, one flat colour per material. To
  restyle, change the "<name> Roofs" (etc.) material assets in Spline; every
  mesh using it follows.
- Baked meshes are real objects, so hosted screenshots show them: check the
  result with `3d_take_screenshot`.
- An agent without a terminal (ChatGPT) can't bake; build it live and point
  the user at the panel's Save .glb button.

## Make a style

A style in `scripts/builder/styles.js` is a table of colours: one row of
colour stops per cell type (`cut`, `land`, `grass`, `wood`, `farmland`,
`sand`, `rock`, `ice`, `wetland`, `water`, `road`, `building`, `roof`,
`tree`), sampled by terrain height, building height or road class, plus
`background`, `frame`, `pedestal`, `edge`, `ambient`, optional `glow` rows
and `windows`, `steps` (rows that pick one colour per building instead of
blending: walls and roofs), `sky` (what water reflects; `water: false`
turns the water effects off), and a `flat` table of plain colours. To give the user their
own look, copy a style, change its colours, rebuild the bundle
(`node scripts/build-bundle.mjs`) and inline it. You can also pass a style
object as `PLACE.style` directly.

Live styles render on WebGPU in Spline's Play mode, Public URL and Code
Export; WebGL2 and the `<spline-viewer>` embed show each style's flat
`fallback` colour. A baked place uses ordinary Spline materials and looks the
same everywhere.

## Keep

- **The attribution line.** OpenStreetMap data is licensed under the ODbL:
  the scene must show "© OpenStreetMap contributors". The template does.
- **What's real and what isn't.** Columns are 2.5D: bridges, tunnels and
  overhangs flatten. Buildings without a mapped height get a guess (7 m, or
  14 m for big footprints). Trees are placed at random inside mapped forests
  and parks. Say so if the user asks about accuracy.
- **Shared tile servers.** Data comes from OpenFreeMap, AWS Open Data and,
  for place names, Photon. Don't build a public search box that geocodes on
  every keystroke.
