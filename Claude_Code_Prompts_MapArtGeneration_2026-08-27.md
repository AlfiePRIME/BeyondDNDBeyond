# Map Art Generation (ComfyUI/ControlNet) — Prompt Plan (2026-08-27)

Six prompts. This is genuinely new integration territory — zero existing
image-generation/diffusion code exists anywhere in this codebase today
(confirmed by research). Unlike Track D's text-provider abstraction, this is
an image-diffusion pipeline with its own settings/data shape — a different
technical domain, tracked separately, but sequenced to extend Track D's
settings/admin infrastructure rather than duplicate it.

**Cross-track sequencing requirement:** run Track D's D1 (global settings +
admin role) before this track's E2. E2 extends the same `app_settings` table
D1 creates.

**Recommended execution order:** E1 → (E2, E3 in parallel, E2 gated on
Track D's D1) → E4 → E5 → E6.

**Defaults chosen for this plan** (matching this session's own established
pattern of resolving smaller open questions with a stated, flagged default
rather than another round of questions):
- **One fixed, tested built-in ComfyUI workflow for v1** — not admin-editable
  raw workflow JSON. The admin configures a host URL and (optionally) a
  default style/theme; they don't design the node graph. Raw workflow
  customization is real future scope, not this batch's.
- **DM-triggered, generate-once-then-cache, matching the existing
  thumbnail/reference-image precedent** — not automatic regeneration on
  every cell edit (diffusion generation is slow; regenerating on every paint
  stroke would be impractical and costly).
- **Mid-session grid growth marks existing art stale rather than attempting
  live outpainting** — there's no real inpainting/outpainting infrastructure
  to build on, and attempting seamless extension of an already-generated
  image is a much larger, separate problem. A stale-art flag with an
  explicit "regenerate" action is the honest v1 answer, matching how this
  session has handled other real v1 limitations (e.g. the weather track's
  DM-connection dependency) — stated plainly, not hidden.

---

## E1 — Research spike: ComfyUI API shape + control-image tuning

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: Map Art Generation E1

## Context
No image-generation/diffusion integration exists anywhere in this codebase.
Read src/app/campaigns/[id]/maps/lib/thumbnail.ts's renderMapThumbnail in
full — it already draws one flat-colored rectangle per cell to a canvas,
colored by terrain/ground-type/elevation, deliberately mirroring
MapSurface's own palette. This is structurally a segmentation-style layout
export already; it needs a ControlNet-tuned variant, not a rebuild. Also read
src/ai/generateMapArea.ts and its route handler in full as the existing
prompt-then-preview-then-accept UX precedent to match (the actual generation
mechanism there — one forced-tool-use LLM call — shares no code with a
diffusion pipeline, only the interaction shape is worth copying).

## Task
This is a research/spike prompt — investigate and document, build a small
throwaway proof-of-concept, but do not build the final production feature
here.

**First, determine whether a real ComfyUI instance with GPU-backed model
checkpoints is actually reachable in your execution environment.** Unlike
Anthropic/OpenAI (a cloud API behind an API key) or even Ollama (a
lightweight local service), ComfyUI needs multi-GB model checkpoints and a
working GPU — there is a real chance nothing like that is reachable here.
Check plainly and report which case you're in before proceeding:
- **If a real instance is reachable**: do all four steps below against it,
  with real generated output images as evidence.
- **If nothing is reachable**: do NOT let this block the rest of the track.
  Design the API client interaction and the workflow JSON shape from
  ComfyUI's own documented API and well-established, publicly-known-good
  ControlNet/checkpoint combinations for segmentation-conditioned or
  edge-conditioned top-down layout art. State explicitly in your report that
  real visual validation (actually seeing generated output, picking between
  candidate ControlNet models by eye) is deferred until a real instance is
  available, and flag this as a real gap for the project owner to close
  later (by providing access to a real ComfyUI instance) rather than a
  completed research decision. Either way, produce a concrete, usable
  recommendation for E3/E4 to build against — don't leave this prompt with
  nothing for later prompts to build on.

Determine and document:
1. ComfyUI's real HTTP API shape for this use case: queuing a workflow
   (POST to its prompt-queue endpoint with a workflow JSON graph), polling
   for completion, and retrieving the output image. If reachable, get a real
   ComfyUI instance running a minimal workflow end to end from a script, and
   confirm you can drive it programmatically; if not reachable, document
   this shape from ComfyUI's own published API documentation instead.
2. Which ControlNet conditioning approach actually produces usable top-down
   "map art" results when conditioned on a segmentation-style control image
   derived from this app's own real map data — if you have a real instance,
   try at least a segmentation ControlNet and a Canny/edge ControlNet
   against a couple of real exported maps (small and large, with
   water/elevation/walls) and pick whichever tracks the layout more
   faithfully, with real example outputs as evidence. If you don't, pick the
   most commonly recommended approach for this exact use case (structural/
   layout-preserving conditioning) from public documentation/community
   knowledge, and say plainly that this is an unvalidated best-guess pending
   real testing.
3. Design the specific control-image variant: adapt renderMapThumbnail's
   color-per-category approach into one tuned for the ControlNet model you
   picked (likely more saturated/distinct colors per category than the
   current visual-parity-with-3D-render palette) — build this as a real,
   separate function, not a config flag on the existing thumbnail renderer
   (their purposes are different enough to diverge over time).
4. Settle on ONE fixed default ComfyUI workflow JSON (checkpoint model,
   ControlNet model, sampler settings) that produces acceptable results
   across the test maps from step 2 (or, if untested, your documented best
   recommendation) — this becomes the one workflow the rest of this track's
   prompts wire up to, per this plan's stated v1 scope (no admin-editable
   workflow JSON in this batch).

## Acceptance Criteria
- A clear, explicit statement of whether a real ComfyUI instance was
  actually reachable and tested, or whether this prompt's recommendations
  are a documented best-guess pending real access.
- If reachable: a real, working proof-of-concept script that exports a real
  map's cell data as a tuned control image, sends it to the real instance
  with a chosen workflow, and receives back a generated PNG, with real
  example output images attached to your report for at least two different
  maps.
- If not reachable: a concrete, documented recommendation (ControlNet model,
  checkpoint, workflow JSON shape) sourced from public documentation, with
  the "unvalidated, needs real testing" caveat stated plainly, not hidden.
- Either way: a concrete, documented recommendation the rest of this track
  can build against — E3/E4 must not be blocked by this prompt's own
  environment limitations.
- This prompt does not need to integrate with the app's UI, database, or
  settings — it's a standalone research/validation pass.

## Dependencies
None.

## Notes
Don't over-invest in perfecting image quality here — the bar is "produces a
recognizable, usable top-down map matching the layout," not photorealism.
The goal is a real, evidence-based technical decision the rest of the track
can build on with confidence where possible — and an honestly-flagged
best-guess, not a silently-assumed one, where a real instance isn't
available.
```

---

## E2 — Settings extension + admin UI additions

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: Map Art Generation E2

## Context
Depends on Track D's D1 (global app_settings table + admin role) having
already landed — read its actual resulting schema and RLS fresh before
starting. ComfyUI is an independent, always-available-if-configured image
pipeline, NOT one of the choices in D1's active_provider enum (a campaign
could use Anthropic for narrative text AND ComfyUI for map art
simultaneously — these are unrelated axes, don't conflate them).

## Task
Extend D1's app_settings table (a migration adding columns, not a new
table) with: comfyui_host_url text nullable, and any small number of
additional fields E1's chosen fixed workflow actually needs exposed to an
admin (e.g. a default style/theme prompt suffix) — keep this minimal, per
this plan's fixed-workflow v1 scope. RLS stays exactly as D1 already
defined it (admin-only read/write) — no new policy needed, only new
columns. Extend D2's existing /admin settings page with a "Map Art
(ComfyUI)" section: host URL field, default style field, and (reusing
whatever pattern D3 established, if it's landed, for a "test connection"
style check, or building a minimal one here if D3 hasn't landed yet) a way
to confirm the configured ComfyUI host is actually reachable.

**Carry over the exact same fix Track D's own D3 had to make for
isAiConfigured(), don't reintroduce the bug it fixed**: the map editor route
(where E4's "Generate map art" action lives) is gated on being the
campaign's DM, NOT on being the app-wide admin — these are different, and a
DM is very likely NOT the global admin. Under this table's admin-only RLS, a
non-admin DM's own session cannot read app_settings at all, including the
boolean-shaped "is map art configured" question the map editor needs to
decide whether to show the Generate action. Build a narrow, server-side-only
check (the same service-role-read-returns-a-boolean-only pattern D3 already
established for isAiConfigured(), reused or mirrored here) so any DM can get
a yes/no answer without ever reading the actual host URL or other admin
settings.

## Acceptance Criteria
- An admin can configure and save a ComfyUI host URL (and default style)
  via the existing /admin settings page.
- A non-admin cannot read or write these new fields (RLS-enforced, same
  posture as every other app_settings field).
- A DM who is NOT the global admin can still determine "is map art
  generation configured" (a boolean only, no secret values) — verify this
  specific case explicitly, since it's the exact regression this note exists
  to prevent.
- yarn lint / yarn tsc --noEmit / yarn test pass; a real Playwright check
  covers an admin setting and saving the ComfyUI fields, a non-admin being
  rejected, and a non-admin DM successfully reading just the boolean.

## Dependencies
Track D's D1.

## Notes
Don't touch active_provider or anything else in D1/D3's text-provider
logic — this is a purely additive extension to the same table.
```

---

## E3 — Control-image export pipeline

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: Map Art Generation E3

## Context
Depends on E1's findings (the specific control-image tuning that worked).
Read src/app/campaigns/[id]/maps/lib/thumbnail.ts's renderMapThumbnail in
full as the direct structural precedent — same per-cell canvas-drawing
approach, different color/tuning goal.

## Task
Build the real control-image exporter per E1's findings: a function that
takes a map's real cell data (terrain type, ground type, elevation, water
flow, walls/objects as relevant) and renders it to a canvas using the
ControlNet-tuned color/edge scheme E1 settled on, producing a real PNG
suitable for the chosen ControlNet model. Keep this as its own module,
separate from renderMapThumbnail (their purposes diverge: one is a small
visual-parity thumbnail, this is a precise structural control signal).

## Acceptance Criteria
- Given a real map's cell data, produces a real control image matching
  E1's documented tuning.
- Output is deterministic for the same map state (same cells in, same
  control image out) — no randomness in this step.
- A real unit/integration test confirms the exporter runs against actual
  map cell shapes without crashing, and a visual spot-check (a saved
  example image in your report) confirms it looks like what E1 validated.
- yarn lint / yarn tsc --noEmit / yarn test pass.

## Dependencies
E1.

## Notes
This can run in parallel with E2 — it doesn't touch settings or the admin
area at all, it's pure map-data-to-image logic.
```

---

## E4 — ComfyUI generation flow: prompt, generate, preview, accept

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: Map Art Generation E4

## Context
Depends on E2 (settings: ComfyUI host URL) and E3 (the control-image
exporter). Read src/ai/generateMapArea.ts's route handler and MapEditor.tsx's
own generate-area-prompt-input/generate-area-button/preview/accept-area UX
flow in full as the interaction pattern to mirror (prompt → server-side
generate → preview → explicit accept) — the underlying generation mechanism
is completely different (a ComfyUI HTTP call, not an LLM call), but the DM-
facing shape should feel consistent with the app's existing generate-content
pattern.

**Module boundary — already decided, don't re-litigate**: this ComfyUI
client belongs in its OWN dedicated module (e.g. src/image-ai/ or an
equivalent name — pick something clear once you see the codebase's own
naming conventions), NOT inside src/ai. src/ai's whole existing shape (a
single text-completion interface, SDK-per-provider) is built around LLM text
generation; ComfyUI's request/response shape (a node-graph workflow JSON in,
polling, a binary image out) is architecturally distant enough to deserve
its own boundary-enforced module with its own eslint.config.mjs restriction,
mirroring the existing pattern (e.g. "only src/image-ai may call the
ComfyUI HTTP API directly") rather than overloading src/ai's existing
contract.

**Storage/RLS posture — already decided, don't assume "reuse the existing
pattern" resolves this on its own**: this app has TWO existing image
patterns on a map, with OPPOSITE visibility: thumbnails (small, DM-facing)
and reference images (explicitly "DM-only in both directions, never
player-visible" per their own doc comment). Generated map art is neither —
it must be visible to every player at the table once accepted. Do NOT reuse
the reference-image bucket/RLS policy as-is; that would make the art
invisible to players by construction. Build (or extend) storage/RLS
specifically for player-visible map art — readable by any campaign member
who can already read the map (mirroring can_read_map's existing posture),
writable by the DM only.

## Task
Add a migration for whatever new column(s)/table is needed to associate a
map with its accepted generated art (at minimum: a reference to the stored
image, plus the style prompt used — E6 will add a `stale` flag to this same
place later, so design it as a real row/column set now, not an ad-hoc JSON
blob). Build the ComfyUI client per the module-boundary decision above:
takes a map's control image (from E3) and a DM-provided style prompt,
submits E1's fixed workflow to the configured ComfyUI host, polls for
completion, and retrieves the resulting PNG. Add a "Generate map art" action
in the map editor (or wherever fits best once you see the current UI — the
DM's book, the map editor's header, or a dedicated section) with a style-
prompt input, a real preview of the generated image before committing to
anything, and an explicit Accept step that stores the result using the
player-visible storage/RLS posture described above (a new bucket if nothing
existing already fits that exact posture — don't force-fit the
reference-image or thumbnail bucket) and writes the migration's new
association row. Handle generation failure/timeout with a clear, specific
error — ComfyUI generation can take a real amount of time and can fail
(model not loaded, host unreachable, malformed workflow response).

## Acceptance Criteria
- A DM can enter a style prompt, trigger generation, see a real preview of
  the generated image before it's saved anywhere, and explicitly accept or
  discard it.
- Accepting stores the generated image with a player-visible storage/RLS
  posture, associates it with the map, and — critically — a real player
  account (not just the DM) can actually read/fetch the stored image once
  accepted. Verify this explicitly; it's the exact thing the reference-image
  bucket would have silently gotten wrong.
- A ComfyUI host that's unreachable or slow fails with a clear, specific
  error rather than an indefinite hang or a generic failure message.
- No module outside the new ComfyUI client module calls the ComfyUI HTTP API
  directly — lint-enforced, mirroring src/ai's own existing convention.
- This prompt does NOT yet change how the map renders in the Game Room —
  that's E5. This prompt only gets a real generated image saved and
  associated with a map.
- yarn lint / yarn tsc --noEmit / yarn test pass; a real Playwright check
  covers the full prompt → preview → accept flow against a real (or
  realistically mocked, if a live ComfyUI instance isn't available in your
  environment — state plainly which you used) ComfyUI backend, including
  the player-read check above.

## Dependencies
E2, E3.

## Notes
If you can't reach a real ComfyUI instance in your environment, use this
codebase's existing transport-injection precedent (generateDraft.ts's own
pattern) to test the request/response handling logic without a live
network call, and say so plainly in your report rather than silently
skipping real verification of this flow.
```

---

## E5 — Apply generated art to the live table: transparent floor + faint grid

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: Map Art Generation E5

## Context
Depends on E4 (a real generated image now exists, associated with a map).
Read src/scene-3d/MapSurface.tsx's CellBlock in full — today it renders one
3D box mesh per cell with a flat `color` prop from `cellColor()`; elevation
is real extruded geometry, not a texture effect; water/pits/fog-of-war are
all separate rendering layers built on the same per-cell state. Also read
whatever component renders the map editor's own reference-image plane (the
existing DM-only, editor-only reference image feature) for its fit-the-
image-to-the-grid positioning math — directly reusable here, even though
that feature itself is unrelated and stays untouched.

Per the project owner's own explicit spec: when a map has generated art
attached and displayed, the floor tile colors should be removed and made
essentially transparent, and the grid boxes should be barely visible — faint
enough not to fight the art, but visible enough that players can still tell
cells apart.

## Task
Add a real image plane to the LIVE Game Room's own scene (GameTableScene,
not the separate editor-only scene) that renders a map's accepted generated
art, positioned/fitted to the grid using the same math the reference-image
feature already solved. When a map has generated art active, switch
ordinary floor cells (CellBlock's normal, non-elevated, non-water, non-pit
case) to a near-fully-transparent fill so the art shows through. For the
"faint but visible grid," note there is no existing separate grid-line
rendering layer today — cell boundaries are currently implied only by
adjacent cells having different flat colors, which disappears entirely once
fill becomes transparent. This will most likely need genuinely new line
geometry per cell (e.g. an edges/wireframe outline, or a shared grid-line
mesh across the floor), not just an opacity tweak on something that already
exists — budget real design/implementation time for this, don't assume it's
a one-line CSS-style change. Maps with no generated art attached must render
EXACTLY as they do today — this is a per-map, opt-in visual mode, not a
global rendering change.

**Use your own judgment, backed by real visual testing (render it and look
at it, don't guess from code alone), on these specific cases** — the project
owner's spec covers plain floor explicitly but doesn't resolve every
interaction:
- Elevated/raised terrain: should its 3D height/shape stay exactly as today
  (a real raised block), with only its flat top surface's fill becoming
  transparent to show the art, or does the whole raised cell need different
  treatment? Recommend keeping elevation's real 3D geometry untouched —
  losing it would be a real gameplay-legibility regression (players judging
  line of sight/movement cost from visible height) — and only changing
  fill/color, not shape.
- Water, concealed pits, and fog-of-war/vision-masking overlays: recommend
  leaving these exactly as they render today, unaffected by the new
  transparent-floor mode — they're hazard/gameplay-critical signals, not
  plain decorative floor coloring, and the owner's spec specifically named
  "floor tile colours," not every rendering layer.
Document whichever calls you make and why, with real screenshots showing
elevation/water/pits still reading clearly alongside the new transparent
floor and faint grid.

## Acceptance Criteria
- A map with accepted generated art shows that art on the live table,
  correctly positioned/fitted to the grid.
- Ordinary floor cells are visually transparent (the art shows through),
  with a faint but real grid line/edge per cell still visible.
- Elevation, water, concealed pits, and fog-of-war/vision masking all still
  render clearly and remain functionally correct (verify with a real
  Playwright check that elevation height, water rendering, pit concealment,
  and vision masking are all pixel/state-verifiable as unchanged from
  today's behavior on a map WITH generated art active).
- A map with no generated art renders identically to before this prompt —
  zero regression for every map that doesn't use this feature.
- yarn lint / yarn tsc --noEmit / yarn test pass; a real Playwright check
  covers a map with art (transparent floor + faint grid + working
  elevation/water/pits/vision) and a map without art (unchanged rendering).

## Dependencies
E4.

## Notes
This is the prompt most likely to need real iteration once you actually see
it rendered — "barely visible but visible enough" is a judgment call that
needs eyes on a real screenshot, not just a chosen opacity number reasoned
about in the abstract. Take real screenshots at each iteration and adjust
before finalizing.
```

---

## E6 — Grid-growth staleness handling

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: Map Art Generation E6

## Context
Depends on E5. This app supports mid-session grid growth (any edge). A
previously-generated map image covers the map's footprint AT THE TIME it was
generated — growing the grid afterward means the new cells have no
corresponding art. Per this plan's stated v1 scope, there's no real
inpainting/outpainting attempt here — growing the grid simply marks existing
art stale, with an explicit path back to a fresh, correct state.

## Task
Add a migration for a stale boolean flag on wherever E4 stored the
generated-art association (default false). When a map's grid grows (any
edge, any amount) and it has generated art attached, mark that art as stale
via this flag (not a deletion — the DM may still want to see/reference the
old art while deciding what to do).
While stale, the Game Room should visually indicate this to the DM only
(e.g. a small badge/notice near wherever the "Generate map art" action
lives) — players see no different behavior; the transparent-floor/faint-
grid rendering from E5 continues to display the (now out-of-date-footprint)
art exactly as before growth, simply covering less of the new, larger grid
than it should. Offer the DM a clear "Regenerate" action from the same spot
that re-runs E3/E4's pipeline against the map's new, full footprint and
clears the stale flag on acceptance.

## Acceptance Criteria
- Growing a map's grid that has generated art attached marks it stale, not
  deleted.
- The DM sees a clear stale indicator; players see no different behavior or
  indicator.
- The DM can regenerate directly from the stale indicator, producing new
  art covering the map's current (grown) footprint, clearing the stale flag
  on acceptance.
- Growing a map with NO generated art attached is completely unaffected —
  zero regression to the existing grid-growth feature.
- yarn lint / yarn tsc --noEmit / yarn test pass; a real Playwright check
  covers: generate art, grow the grid, confirm the DM sees a stale
  indicator and a player sees nothing different, regenerate, confirm the
  flag clears and new art reflects the grown footprint.

## Dependencies
E5.

## Notes
This is an explicitly honest v1 limitation, not a deficiency to hide —
state plainly in your report that this doesn't attempt seamless
outpainting/extension of the existing image, matching how this plan framed
the tradeoff from the start.
```
