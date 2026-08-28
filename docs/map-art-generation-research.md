# Map Art Generation — E1 Research Spike

Status: research/spike only. No app code (UI, database, settings) changed.
Everything here is either (a) something actually exercised against a real,
running ComfyUI instance, or (b) explicitly labeled as an unvalidated
best-guess. Section 1 draws the line precisely.

The real instance used throughout: `http://10.10.1.10:8188` (ComfyUI
0.34.0, RTX 4060 Ti / 16GB VRAM, run with `--lowvram
--use-pytorch-cross-attention`), confirmed live via its own `/system_stats`
before anything else in this spike happened.

## 1. What was actually reachable/tested vs. best-guess

**Tested for real, against the live instance, with saved evidence:**

- The instance is reachable and its exact hardware/software is as
  described (`/system_stats`, `/models`, `/models/<folder>`,
  `/object_info`).
- What's actually installed: FLUX.2-dev (fp8), its Mistral-3-small text
  encoder, its own VAE, and a "Turbo" LoRA for it. **No ControlNet model
  file for FLUX is installed** (`/models/controlnet` returns `[]`), and no
  CLIP-vision/style model is installed either (`/models/clip_vision` and
  `/models/style_models` both `[]`).
- The full ComfyUI HTTP API mechanics: upload an image, queue a workflow
  graph, poll for completion, fetch the output PNG — driven end-to-end
  from a real script four separate times (§3).
- FLUX.2's own native reference-latent image-conditioning path
  (`ReferenceLatent`) as the structural-conditioning substitute for the
  missing ControlNet, run against **two** synthetic test maps built from
  this app's real `MapCell`/`CellState` shapes (a small walled room and a
  larger outdoor+ruin map, both with water, elevation, and walls) — with
  real output PNGs saved to disk (§6).
- A concrete, live-discovered problem in the tuned control-image palette
  (water and stone hues too close together, causing visible bleed) and a
  fix, re-tested and confirmed (§5.3).
- A concrete, live-discovered problem in prompt wording (framing the
  control image as a "layout key to reinterpret" caused the model to
  discard the actual spatial layout and paint a collage of vignettes
  instead) and a partial fix, re-tested (§7).
- Timing: four full generations' wall-clock time, on this specific
  hardware, at this step count (§8).

**Explicitly NOT tested — documented best-guess or flagged gap, not silently assumed:**

- **No ControlNet-for-FLUX model is installed on this instance**, so the
  "does a dedicated segmentation ControlNet do better than
  ReferenceLatent" question is not something this spike could test at
  all — not "chose not to," genuinely can't without a model file that
  isn't there. This is the real gap the task's own IMPORTANT note
  anticipated. See §5 for what was actually available and why
  `ReferenceLatent` was the right substitute to reach for, not a fallback
  of convenience.
- The generic, reusable per-map prompt-generation function
  (`buildLegendPrompt` in `workflow.mjs`) produces measurably *lower*
  structural fidelity than the hand-tuned, per-map prose prompts used
  earlier in this same spike (compare
  `02-handtuned-prompt-fixed-palette-small-room.png` against
  `final-small-room.png` in `docs/map-art-poc-output/`). Both clear the
  "recognizable, usable top-down map" bar the task sets, but the gap
  between them is real and unresolved — flagged as an open follow-up for
  E2, not glossed over (§7, §10).
- No sweep of steps/guidance/sampler was run — one setting
  (steps=8, guidance=2.5, euler, the turbo LoRA at strength 1.0) was
  chosen from FLUX-community convention for a "turbo" distilled LoRA and
  worked well enough on the first real try that no tuning sweep was
  judged worth the GPU time for a spike. A production feature should
  probably still spend a *little* time sweeping this before locking it in
  further, though the current default is a real, working, recommended
  starting point, not an untested guess.
- No batch generation, no multi-reference (more than one conditioning
  image), no negative prompt, and no attempt to stack the actual
  `map-thumbnails` Storage bucket's real captured PNGs (none exist in this
  environment — no live campaign data) were tested.
- VRAM headroom under concurrent/production load (multiple DMs generating
  at once) was not tested — this spike only ever ran one generation at a
  time.

## 2. The conditioning approach question — investigated, not assumed

The task's IMPORTANT note anticipated exactly this: FLUX is not SD1.5/SDXL,
and classic ControlNet conventions don't unconditionally transfer. This
was checked against the real instance rather than assumed either way.

`GET /models/controlnet` on the real instance returns `[]` — no ControlNet
checkpoint for FLUX (or anything else) is installed. That closes off the
"classic ControlNet" path outright; it's not a matter of picking the right
node, there is no model file for any such node to load.

`GET /models/clip_vision` and `/models/style_models` are also `[]`, which
rules out an IP-Adapter/style-transfer-style path too (those need a
CLIP-vision encoder, which isn't installed either).

What IS installed, and what ComfyUI 0.34.0's own node set (`GET
/object_info`, ~898 node classes) supports for it: **FLUX.2 has its own
native in-context image-conditioning mechanism**, the same family of
functionality FLUX.1 Kontext (image editing) uses — a `ReferenceLatent`
node that folds a VAE-encoded reference image directly into the positive
conditioning, no separate ControlNet network involved at all. Relevant
node classes actually present on this instance:
`ReferenceLatent`, `FluxKontextImageScale`,
`FluxKontextMultiReferenceLatentMethod`, `EmptyFlux2LatentImage`,
`Flux2Scheduler`, `ModelSamplingFlux`, `FluxGuidance`.

This is exactly the situation the task's IMPORTANT note called out by
name: "FLUX's own tooling sometimes uses IP-Adapter or redux/canny
variants rather than classic ControlNet." `ReferenceLatent` is that
variant here — a real, installed, working capability of the base model
itself, not a bolt-on network. §6 shows it producing genuinely
recognizable top-down maps that preserve a real map's layout, on two
different real (synthetic) test maps.

**The honest gap**: this says nothing about whether a dedicated
ControlNet-for-FLUX (segmentation- or canny-trained) would do
*noticeably better* than `ReferenceLatent` at preserving hard boundaries —
that comparison needs a model file that isn't on this instance. If E2-E6
want to chase higher structural fidelity later, downloading a
FLUX-compatible ControlNet (several exist for FLUX.1; FLUX.2-specific ones
are newer/rarer as of this writing) and A/B-ing it against this spike's
`ReferenceLatent` baseline is the concrete next step — not a blind
assumption that it's needed, since `ReferenceLatent` alone already
produced strong results (§6).

## 3. ComfyUI's real HTTP API shape (deliverable #1)

Confirmed by actually driving it, not read off documentation. All of this
lives in `scripts/poc/map-art-generation/comfyClient.mjs`.

| Endpoint | Method | Purpose | Real shape observed |
|---|---|---|---|
| `/system_stats` | GET | health/hardware check | `{system: {...}, devices: [{name, vram_total, vram_free, ...}]}` |
| `/models` | GET | list model-folder categories | `["checkpoints", "diffusion_models", "controlnet", ...]` |
| `/models/:folder` | GET | list files in one category | e.g. `/models/diffusion_models` → `["flux2_dev_fp8mixed.safetensors"]` |
| `/object_info` or `/object_info/:ClassName` | GET | full node-type schema (inputs/outputs/combo option lists, including which checkpoint/LoRA/VAE filenames are actually loadable) | large JSON keyed by node class name |
| `/upload/image` | POST multipart (`image` file, optional `overwrite=true`) | upload a control image | `{name, subfolder, type}` — `name` is what a `LoadImage` node's `image` input references |
| `/prompt` | POST JSON `{prompt: <graph>, client_id}` | queue a workflow | `{prompt_id, number, node_errors}` — a non-empty `node_errors` means the graph was rejected outright (bad node/input name), not merely something that will fail mid-run |
| `/history/:prompt_id` | GET | poll for completion | `{}` while queued/running; once present, `{<prompt_id>: {status: {status_str, completed, messages: [...]}, outputs: {<nodeId>: {images: [{filename, subfolder, type}]}}}}` |
| `/view?filename=&subfolder=&type=` | GET | fetch the actual image bytes | raw PNG |

The graph JSON itself (`prompt` field) is a flat map of `nodeId ->
{class_type, inputs}`, where an input is either a literal value or a
`[otherNodeId, outputIndex]` reference — the same format ComfyUI's own web
UI produces via "Save (API format)". This spike's `workflow.mjs` builds
these by hand from the node schemas `/object_info` returned; no ComfyUI UI
was used to author them.

This spike polls `/history` on a fixed interval rather than using
ComfyUI's websocket progress channel — sufficient for a one-shot script,
and confirmed to work reliably across four real runs (§8's timings all
came from parsing `/history`'s own `execution_start`/`execution_success`
timestamps).

## 4. Real map data shape used for fixtures (deliverable #2's fixture requirement)

No live campaign data exists in this environment, so two synthetic test
maps were built — from the app's own real storage shape, not an
approximation of it. Read in full before building fixtures:
`src/data-access/maps.ts` (`MapCell`, `GROUND_TYPES`, `LIGHT_LEVELS`),
`src/rules-engine/movement.ts` (`TerrainType`), and
`src/app/campaigns/[id]/maps/[mapId]/edit/lib/cellGrid.ts` (`CellState`,
`DEFAULT_CELL`, `cellKey`, `overlayFromRows`).

`scripts/poc/map-art-generation/mapShapes.mjs` mirrors (not imports —
these are plain Node ESM scripts outside the Next.js/TS build, the same
"mirror rather than cross-runtime-import" call `thumbnail.ts` itself
already makes for `MapSurface`'s palette) the exact `MapCell` row shape and
`overlayFromRows`'s sparse-overlay reconstruction, so the fixtures are
built the same way a real map's rows would be turned into the overlay
`renderMapThumbnail`/`renderMapArtControlImage` both consume.

`scripts/poc/map-art-generation/fixtures.mjs` defines two maps, both
exercising water, elevation, and walls (void) per the brief:

- **`SMALL_MAP`** (`small-room`, 16x16): one walled stone room (void
  border with a south doorway gap), a two-step raised stone dais in one
  corner, a circular water pool in another, a difficult-terrain rubble
  patch in the middle, a two-cell pit near a wall, and a dirt path leading
  in through the doorway.
- **`LARGE_MAP`** (`large-outdoor`, 48x32): an outdoor scene — a lake
  fringed by sand then swamp, a forest block with a denser core and an
  undergrowth (difficult-terrain) patch, a walled stone ruin with a
  4-band elevation staircase and an interior pit, and a dirt path
  connecting the ruin back to the lakeshore, over an open grass field.

Both are entirely procedural (geometry rules, not hand-listed cells) and
sparse — only non-default cells are listed, exactly like real stored
`map_cells` rows.

## 5. The tuned control-image variant (deliverable #3)

`scripts/poc/map-art-generation/controlImage.mjs` — a real, separate
function (`renderMapArtControlImage`), not a flag on
`renderMapThumbnail`. Read `thumbnail.ts`'s `renderMapThumbnail` and
`thumbnailCellColor` in full first; three deliberate departures from it,
each for a conditioning-specific reason:

1. **Flat, high-saturation, evenly-spaced hues per category** instead of
   `thumbnailCellColor`'s muted palette (chosen there for visual parity
   with `MapSurface`'s 3D render). A conditioning image's job is to be
   maximally *distinguishable* per category, not pretty.
2. **Discrete elevation lightness bands** (4 bands) instead of
   `thumbnailCellColor`'s continuous lerp. A sharp band gives the
   diffusion model a crisp boundary to key off (a terrace edge); a smooth
   gradient blurs across what should be a step change in the output.
3. **Zero inter-cell gap.** `thumbnail.ts`'s `CELL_GAP_RATIO` exists for a
   graph-paper UI aesthetic — reproducing it here would bake a visible
   mosaic-grid texture into every generated image, since same-category
   neighboring cells should merge into one continuous region the way real
   terrain does.

The category-selection precedence is otherwise an exact mirror of
`thumbnailCellColor`'s real rule: void first (no floor, regardless of
ground/terrain), then a non-`'default'` ground type (which overrides the
terrain-driven hue entirely, since ground is purely a floor color), then
the terrain-driven hue (`normal`/`difficult`/`pit`) on `'default'` ground.

### 5.1 Palette, as shipped

12 hue-carrying categories plus void (near-black, `rgb(10,10,10)`,
hue-less by design — categorically different from every real category at
any lightness). See `controlImage.mjs`'s `HUE_BY_CATEGORY` for the exact
current values.

### 5.2 First live attempt (this spike's real evidence, not theory)

An initial even 30-degree-spaced 12-hue wheel placed `water` (210°),
`stone` (240°), and `pit` (270°) as three consecutive slots. Run for real
against `control-small-room.png` at that point
(`docs/map-art-poc-output/01-handtuned-prompt-uneven-palette-water-stone-confusion.png`):
the model correctly reproduced the room's walls, path, rubble patch, and
pit, but visibly bled watery texture and ripple highlights onto and around
the stone dais next to it, and softened the actual water pool's edge with
what reads as more stone-like rubble. **Finding: numeric hue distance
alone (even the mathematically-maximum even spacing for 12 categories)
does not guarantee the model treats two "cool blue/violet family" regions
as unrelated** — the model still read them as thematically connected.

### 5.3 The fix, also live-tested

`water` was given an isolated ~140-degree buffer (nothing else placed
between 140° and 280°); the other 11 categories share the remaining ~220°
arc at their own near-even spacing. `stone` moved from 240° (30° from
water) to 340° (130° from water); `pit` moved from 270° (60° from water)
to 300° (90° from water). Re-rendered and re-run against the identical
prompt and seed pattern: see
`docs/map-art-poc-output/02-handtuned-prompt-fixed-palette-small-room.png`
— the water/stone bleed is gone, and the dais now renders as a clean,
distinct raised stone platform. This specific asymmetric spacing (not a
generic "just use more separation" rule) is what's shipped in
`controlImage.mjs` now, with the reasoning inlined as a code comment so it
isn't rediscovered the hard way again.

### 5.4 What this doesn't cover

Only one bad pairing was actually found and fixed live (water/stone/pit).
Whether some other pairing in the current 12-category palette has a
similar, still-undiscovered issue was not exhaustively tested — a
reasonable thing for E2 to watch for on a wider variety of real maps
before treating the current spacing as final.

## 6. Results against both real test maps

All output images are real PNGs from the live instance, saved under
`docs/map-art-poc-output/`. The control images are also saved there
(`control-small-room.png`, `control-large-outdoor.png`) so the
input→output correspondence can be checked directly.

- **Small room** (hand-tuned prompt, fixed palette):
  `02-handtuned-prompt-fixed-palette-small-room.png`. Very high structural
  fidelity: wall border, the raised dais (correct position/size, rendered
  as a stepped stone platform with its own retaining wall), the rubble
  hazard patch (correct shape/position, rendered as broken wood/rock
  debris), the water pool (matches the control image's exact stepped
  pixel boundary), the south-entrance dirt path (correct shape, grass
  tufts added), and the pit (correct position, rendered as a round
  rubble-ringed hole).
- **Large outdoor+ruin** (hand-tuned prompt, fixed palette):
  `03-handtuned-prompt-fixed-palette-large-outdoor.png`. Also very high
  fidelity: lake with sand/reed shoreline in the right position and shape,
  forest block with a visibly denser (teal-tinted) core in the right
  place, the ruin's stone walls and two-toned terraced floor, the
  interior pit, and the connecting dirt path all land correctly.
- **Small room** (generic, reusable `buildLegendPrompt`, the actual
  shipped default mechanism): `final-small-room.png`. Recognizable and
  usable — every feature (water, dais/steps, rubble, pit, path, walls) is
  present and roughly correctly colored/positioned — but visibly lower
  fidelity than the hand-tuned version: the dais became more of a
  freestanding staircase than a cornered platform, and the room reads as
  more quadrant-divided than the source layout actually is.
- **Large outdoor+ruin** (generic prompt): `final-large-outdoor.png`.
  Close to the hand-tuned version's quality — lake, forest/dense-forest
  split, ruin structure, path, and pit are all clearly recognizable and
  well-positioned.

Both generic-prompt outputs clear the task's stated bar ("produces a
recognizable, usable top-down map matching the layout, not
photorealism"). The gap to the hand-tuned prompts is real, is flagged
explicitly in §1 and §7, and is the clearest concrete follow-up for E2.

## 7. Prompt construction — a second live finding

`buildLegendPrompt` in `workflow.mjs` is the reusable mechanism (not a
one-off per-fixture string) that turns a map's own overlay data into a
prompt: it scans which categories are actually present (using the exact
same `controlImageCategory` precedence the renderer itself uses, so it can
never describe a color that isn't really in the image) and emits one
description line per category actually used, plus a fixed elevation note
and closing render-style instruction.

**First version's wording backfired, live, not in theory.** It described
the control image as "a flat color-coded layout key, not the final art
style" and asked the model to "reinterpret every colored region." Run for
real against `control-small-room.png`: the model treated the input as an
abstract reference chart and repainted it as a four-quadrant collage of
disconnected vignettes — discarding the actual single coherent room shape
it was conditioned on, even though the reference latent still literally
encoded that one shape. This is the same generation whose (broken) output
is not separately saved — the fix below was applied and re-run before
being adopted; the important artifact is the *comparison* it establishes
against `final-small-room.png`, which used the fixed wording.

**The fix**: assert the input image IS already the map's real floorplan,
in its final position, and explicitly forbid rearranging, duplicating, or
splitting it into panels — not just describe what the colors mean. This
measurably improved coherence (the "quadrant collage" failure mode did not
recur), producing `final-small-room.png`/`final-large-outdoor.png`, but as
§6 notes, still trails the fully hand-tuned per-map prose in absolute
fidelity. The current wording is a real improvement over the first
attempt and a reasonable, working default — not a guess — but likely still
has room for further tuning in E2.

## 8. Timing (real, on this instance, at steps=8/turbo LoRA)

| Run | Resolution | Elapsed |
|---|---|---|
| Baseline unconditioned text-to-image (mechanics smoke test) | 512x512 | 58.5s |
| Reference-conditioned, small room, attempt 1 | 1024x1024 | 119.8s |
| Reference-conditioned, small room, fixed palette | 1024x1024 | 107.2s |
| Reference-conditioned, large outdoor | 1008x672 | 79.3s |
| Final scripted run, small room | 1024x1024 | 110.1s |
| Final scripted run, large outdoor | 1008x672 | 80.0s |

Roughly 1.5-2 minutes per generation on this single RTX 4060 Ti in
`--lowvram` mode at 1024x1024/8 steps. This instance reported ~8.7GB of
16.7GB VRAM free at idle before any of this ran; no OOM was hit at these
resolutions, but headroom for a larger production resolution or concurrent
requests was not tested (§1).

## 9. The one fixed default workflow (deliverable #4)

No admin-editable workflow JSON in this v1 — `scripts/poc/map-art-generation/workflow.mjs`'s
`buildMapArtWorkflow` (plus `MODELS`/`DEFAULTS`) IS the one shape E2-E6
build against:

- **Checkpoint / components**: `flux2_dev_fp8mixed.safetensors` (UNETLoader,
  `weight_dtype: "default"`), `mistral_3_small_flux2_fp8.safetensors`
  (CLIPLoader, `type: "flux2"` — a single encoder, not the dual
  clip_l/t5xxl pair FLUX.1 uses, confirmed via `/object_info`'s
  `CLIPTextEncodeFlux` vs. plain `CLIPTextEncode` — FLUX.2 uses the
  latter), `flux2-vae.safetensors` (VAELoader).
- **LoRA**: `Flux_2-Turbo-LoRA_comfyui.safetensors` via
  `LoraLoaderModelOnly` at strength 1.0 — this is what makes 8 steps
  produce a finished-looking image at all; without it 8 steps would badly
  underbake a non-distilled FLUX.2 model.
- **Conditioning**: `LoadImage` (the uploaded control PNG) → `VAEEncode` →
  `ReferenceLatent` (folded into the `CLIPTextEncode` output) →
  `FluxGuidance` (guidance 2.5) → `BasicGuider`. The empty latent
  (`EmptyFlux2LatentImage`) and the `Flux2Scheduler`'s width/height MUST
  exactly match the control image's real pixel dimensions — this is what
  makes it an in-place edit rather than an unrelated reference.
- **Sampling**: `RandomNoise` → `KSamplerSelect` (`euler`) →
  `Flux2Scheduler` (steps=8) → `SamplerCustomAdvanced` → `VAEDecode` →
  `SaveImage`. This "custom sampler" node pipeline (not the legacy
  `KSampler` node) is the pattern FLUX.2/Kontext-style workflows use
  because `Flux2Scheduler` computes FLUX.2's own resolution-aware sigma
  schedule directly, rather than a generic scheduler guessing at it.
- **Control-image sizing**: control images are sized to a 1024px long edge
  (rounded up to a multiple of 16, FLUX's own latent-size step) —
  `renderMapArtControlImage`'s `TARGET_LONG_EDGE`.

`buildBaselineWorkflow` (the same graph minus the conditioning branch) is
kept as the minimal mechanics-only smoke test — useful for E2 to
sanity-check connectivity to a ComfyUI instance without needing a control
image at all.

## 10. Concrete recommendation for E2-E6

1. **Conditioning approach**: FLUX.2's native `ReferenceLatent` node. No
   ControlNet-for-FLUX is installed on the validated instance, so this is
   the load-bearing recommendation, not a fallback — it produced strong,
   real results on two different test maps (§6). If a FLUX-compatible
   ControlNet is downloaded later, A/B it against this baseline before
   switching; don't assume it's strictly better without testing, since
   `ReferenceLatent` already clears the task's quality bar.
2. **Models**: `flux2_dev_fp8mixed.safetensors` +
   `mistral_3_small_flux2_fp8.safetensors` + `flux2-vae.safetensors` +
   `Flux_2-Turbo-LoRA_comfyui.safetensors` (strength 1.0) — exactly what's
   installed and validated; §9 has the full graph shape.
3. **Workflow shape**: `scripts/poc/map-art-generation/workflow.mjs`'s
   `buildMapArtWorkflow`, unmodified in structure — steps=8, guidance=2.5,
   euler sampler, control image sized to a 1024px long edge.
4. **Control-image renderer**: `renderMapArtControlImage` in
   `controlImage.mjs`, as a real, separate function from
   `renderMapThumbnail` (never fold this into it as a flag — the
   gap-vs-no-gap and lerp-vs-banded differences are structural, not
   cosmetic options). Port its exact palette (§5.1) rather than
   re-deriving a new one — the water/stone spacing fix (§5.3) is
   hard-won.
5. **Prompt construction**: start from `buildLegendPrompt`'s mechanism
   (auto-generated from the map's real category set) as the reusable
   base, but budget real time in E2 to close the fidelity gap documented
   in §6/§7 against hand-tuned prose before shipping it user-facing —
   this is the single clearest unfinished thread this spike leaves
   behind. Concrete angles worth trying first: shortening the legend to
   only the most visually-load-bearing categories per map, trying a
   higher `guidance` value specifically for structure-heavy scenes, or
   testing whether restating "region-for-region" language closer to the
   end of the prompt (recency) rather than only the start helps.
6. **What NOT to build yet**: no admin-editable workflow JSON (task's own
   v1 constraint) and no attempt to integrate a not-yet-installed
   ControlNet — flag the gap to the project owner instead (this doc is
   that flag): *FLUX.2 has no ControlNet model installed on the
   validated instance; if tighter structural adherence than
   `ReferenceLatent` achieves is needed later, that requires downloading
   one separately and is untested here.*

## 11. Where everything lives

- This doc: `docs/map-art-generation-research.md`
- PoC scripts: `scripts/poc/map-art-generation/`
  - `png.mjs` — dependency-free PNG encoder (Node's built-in zlib only)
  - `mapShapes.mjs` — mirrors the real `MapCell`/`CellState`/`overlayFromRows` shapes
  - `fixtures.mjs` — the two synthetic test maps
  - `controlImage.mjs` — the tuned control-image renderer (deliverable #3)
  - `comfyClient.mjs` — the ComfyUI HTTP client (deliverable #1)
  - `workflow.mjs` — the one fixed default workflow + prompt builder (deliverable #4)
  - `run.mjs` — end-to-end orchestrator (`node scripts/poc/map-art-generation/run.mjs`, needs `COMFYUI_URL` env var if the instance isn't at this spike's default address)
- Example outputs: `docs/map-art-poc-output/`
  - `00-baseline-mechanics-test.png` — unconditioned smoke test
  - `control-small-room.png`, `control-large-outdoor.png` — the tuned control images actually sent to the model
  - `01-handtuned-prompt-uneven-palette-water-stone-confusion.png` — the live-discovered palette bug
  - `02-handtuned-prompt-fixed-palette-small-room.png`,
    `03-handtuned-prompt-fixed-palette-large-outdoor.png` — best-case
    fidelity with hand-tuned prompts
  - `final-small-room.png`, `final-large-outdoor.png` — output of the
    actual shipped `run.mjs`/`buildLegendPrompt` mechanism, i.e. what
    E2-E6 get out of the box today
