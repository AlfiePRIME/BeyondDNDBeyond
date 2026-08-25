# Design spike: model orientation metadata and posing

Status: design only — no feature code shipped by this document. Written to be
implemented by two follow-up prompts (metadata/upload UI, then skeleton-based
posing); see "Recommended follow-up scope" at the end for the exact split.

## 1. Problem recap

Two related gaps, both rooted in the same fact: an uploaded `.glb` carries no
project-authored metadata beyond the raw file.

1. **No stored "forward" direction.** `SeatAvatar` (`src/scene-3d/SeatAvatar.tsx`),
   `PlacedObject` (`src/scene-3d/PlacedObject.tsx`), and `Chair`
   (`src/scene-3d/Chair.tsx`) all bounding-box-scale and `Clone` whatever glTF
   they're given, with zero rotation correction. `Chair.tsx`'s two hardcoded
   models are being fixed one-off by a concurrent prompt; this spike is about
   the *general* case for every future upload (map assets, avatars, NPC/monster
   tokens).
2. **No posing.** The same two components render a raw `Clone` of the loaded
   scene. A skinned humanoid with no baked default pose renders in a T-pose.
   Confirmed in scope for NPCs/monsters (`PlacedObject`) as well as player
   avatars (`SeatAvatar`).

## 2. What was read

Full files: `src/scene-3d/SeatAvatar.tsx`, `src/scene-3d/PlacedObject.tsx`,
`src/scene-3d/Chair.tsx`, `src/app/lib/validate-glb.ts`,
`src/app/campaigns/[id]/assets/AssetPalette.tsx` and `page.tsx`,
`src/data-access/assets.ts`, `src/data-access/profiles.ts`,
`src/app/campaigns/[id]/maps/[mapId]/edit/lib/assetUrl.ts`, the relevant
Supabase migrations (`0014_maps.sql`, `0016_asset_library_presets.sql`,
`0010_profile_avatar.sql`), `perf-budgets.json`,
`scripts/perf/asset-render-benchmark.mjs`, and `src/app/account/avatar-presets.ts`.

## 3. Sample/test assets used

**None of this repo's existing `.glb` files are suitable for testing skeleton
or animation extraction.** Verified by parsing every `.glb` under `public/`
(both the JSON chunk directly and via three.js's own `GLTFLoader`): every
preset (`public/assets/presets/*.glb`, `public/avatars/presets/*.glb`) and
both real chair models (`public/table/*.glb`) have **zero skins and zero
animations** — they're static, unrigged primitive/composite meshes (the
avatar presets are literally 6 fused primitive meshes each, 12–16KB). This
needed to be established, not assumed: the file-size and node-count profile
alone (7 nodes/6 meshes for a 16KB avatar) already told the story before
parsing confirmed it.

Because of that, three sample humanoid rigs were sourced from Khronos's
official glTF-Sample-Assets repository
(`https://github.com/KhronosGroup/glTF-Sample-Assets`) for this investigation:

| Asset | Bones | Tracks | Triangles | License |
|---|---|---|---|---|
| `RiggedSimple` | 2 | 3 | 188 | CC-BY-4.0 (Khronos) |
| `RiggedFigure` | 19 | 57 | 256 | CC-BY-4.0 (Khronos) |
| `CesiumMan` | 19 | 57 | 4,672 | CC-BY-4.0 (Cesium, © 2017; excludes the Cesium logo/trademark) |

These were downloaded to a scratch directory for this investigation only and
are **not** committed to the repo — this prompt ships no code or assets, per
its brief. `RiggedFigure`/`RiggedSimple` are Khronos's own purpose-built
skinning test rigs (no trademark encumbrance at all); `CesiumMan` is the
closest of the three to a "real" character in triangle count and is
attribution-only (CC-BY-4.0), which is compatible with inclusion in this repo
later provided a `© Cesium, CC-BY-4.0` attribution is kept.

**Recommendation for the follow-up posing prompt:** source a real permanent
test fixture from the same repository — either commit `CesiumMan.glb`
(textured, animated, attribution-required) or `RiggedFigure.glb`/
`RiggedSimple.glb` (untextured, tiny, no attribution burden beyond CC-BY) into
`public/` (or a test-fixtures path) for use by an automated test and by the
new performance benchmark script recommended in §7. All three are freely
redistributable under CC-BY-4.0. Do **not** use `CesiumMan` if attribution
becomes inconvenient to carry — `RiggedFigure` is the better long-term fixture
precisely because it has no logo/trademark carve-out to track, at the cost of
being visually a wireframe-plain mannequin rather than a textured character.
If a more game-appropriate humanoid (armed/armored, D&D-adjacent) test model
is wanted for demo purposes, `Mixamo` (`mixamo.com`, free, Adobe account
required) is the recommended source — its royalty-free license covers
personal, commercial, and non-profit use of both characters and animations
once **embedded in a finished product**; the one restriction is against
repackaging the raw character/animation files as a standalone asset pack for
resale, which does not apply here (confirmed against Adobe's Mixamo FAQ and
independent license summaries).

## 4. Does GLTFLoader expose usable skeleton/animation data?

Yes, confirmed directly (not assumed) by parsing all three sample rigs
through this project's own `GLTFLoader` import path (the same one
`validate-glb.ts` already uses: `three/examples/jsm/loaders/GLTFLoader.js`),
in a throwaway Node script:

- `gltf.animations` is a populated array of real `THREE.AnimationClip`
  objects (name, duration, per-bone position/quaternion/scale tracks) for
  every sample.
- Traversing `gltf.scene` finds real `THREE.SkinnedMesh` nodes with a
  populated `.skeleton.bones` array of named `THREE.Bone` objects.
- `new THREE.AnimationMixer(gltf.scene)` + `mixer.clipAction(clip).play()` +
  `mixer.update(dt)` ran without error and visibly advanced `action.time` —
  the standard playback path works against real parsed data.

One real (if narrow) gotcha surfaced along the way: `GLTFLoader`'s texture
path (`loadImageSource`) references the browser global `self` directly,
which doesn't exist in plain Node. This didn't affect any existing code (the
current avatar/asset presets carry no material images, so this path is never
exercised today), but it means a **future automated Node-based test that
loads a *textured* skinned model** (e.g. `CesiumMan`) will need either
`globalThis.self = globalThis` polyfilled or to run under `jsdom`/a browser —
this repo's `vitest.config.ts` currently uses `environment: "node"`, which
does not provide this automatically. Worth a one-line note in that future
test file rather than a surprise failure.

## 5. Is the existing three.js dependency tooling sufficient?

**Yes — no new dependency is required.** Confirmed by inspecting what's
already in `node_modules` and already in use:

- **`SkeletonUtils.clone`** — already a transitive dependency via
  `@react-three/drei`'s `Clone` component (`node_modules/@react-three/drei/core/Clone.js`
  imports `SkeletonUtils` from `three-stdlib` and calls `SkeletonUtils.clone`
  automatically whenever it detects a `SkinnedMesh` during traversal). This
  project is *already* relying on this, today, via the `<Clone object={scene} .../>`
  calls in `SeatAvatar`, `PlacedObject`, and `Chair` — the doc comments in all
  three files already say "Clone (SkeletonUtils-aware)". Verified experimentally
  that `SkeletonUtils.clone()` produces an independent skeleton per clone
  (two clones never share one `THREE.Skeleton` instance) — the reason it's
  needed at all: two placed instances of the same monster model must be able
  to play independent poses/animations without fighting over one skeleton.
- **`AnimationMixer` / `AnimationClip`** — core `three` (`node_modules/three/src/animation/`),
  already a direct dependency (`three: ^0.185.1`).
- **`useAnimations`** — `@react-three/drei` (`^10.7.8`) ships a ready-made hook
  (`node_modules/@react-three/drei/core/useAnimations.js`) that wraps
  `AnimationMixer` with a `useFrame`-driven update loop and lazy,
  clip-name-keyed `AnimationAction` creation. This is the natural integration
  point for the follow-up posing prompt — it already exists, is already a
  dependency, and needs no new wiring pattern beyond what `SeatAvatar`/
  `PlacedObject` already do with `useGLTF`.
- **`SkeletonUtils.retarget` / `retargetClip`** — also already present
  (`node_modules/three-stdlib/utils/SkeletonUtils.js`). These *do* exist and
  *can* remap one skeleton's motion onto a differently-named skeleton, but
  only via a hand-authored `options.names` bone-name mapping table plus a
  designated hip bone, applied per source/target rig pair, per frame (it's a
  real per-frame retargeting solve, not a one-time transform). This is a real
  capability, not a turnkey one — see §6.

**Conclusion:** everything needed for the recommended v1 scope (§8) is
already installed. No `package.json` change is needed for either follow-up
prompt.

## 6. Bone-naming reality: why "any arbitrary skeleton" isn't realistic for v1

This was tested directly, not assumed. `RiggedFigure` and `CesiumMan` are
both 19-bone/57-track rigs from the *same* Khronos sample set, describing
functionally the same humanoid skeleton shape — and they use **different bone
names** for the same joints:

```
RiggedFigure:  torso_joint_1, torso_joint_2, torso_joint_3, neck_joint_1, ...
CesiumMan:     Skeleton_torso_joint_1, Skeleton_torso_joint_2, torso_joint_3, ...
```

Then, directly exercising `AnimationMixer` proved the practical consequence:

- Applying `RiggedFigure`'s own clip to a **second independent instance of
  the same model** (same bone names) works correctly — the target bone's
  quaternion visibly changes after `mixer.update()`. This is the "shared
  convention" case: one clip, reused across multiple model instances that
  happen to share bone names.
- Applying that **same clip to `RiggedSimple`** (bones named `Bone`,
  `Bone001` — no overlap at all) does **not** throw, but silently no-ops:
  three.js logs `THREE.PropertyBinding: No target node found for track: ...`
  once per unmatched track (57 warnings in the test) and the skeleton simply
  never moves. This is the critical, easy-to-miss risk: a bone-name mismatch
  fails *silently and partially* at the animation layer, not with a catchable
  error — exactly the kind of half-broken result ("some bones move, some
  don't") that would look worse than today's static T-pose fallback if not
  guarded against explicitly.

This directly answers the brief's central question: a fixed bone-naming
convention **can** make one authored pose/clip work generically across many
different uploaded models (proven above) — but only for models that actually
follow that convention, and different real-world exports do not converge on
one naming scheme by accident, even within a single small sample set from one
source. Fully automatic support for arbitrary, unknown skeleton naming would
require either (a) real per-pair retargeting via `SkeletonUtils.retarget`
(needs a hand-authored name-mapping table per uploaded rig — not something a
generic upload flow can produce automatically) or (b) heuristic name-pattern
guessing (substring-matching "hip"/"spine"/"arm"/"leg" etc. case-insensitively)
which will silently mismatch or partially-match on real, unpredictable
exporter output. Neither is a one-prompt-sized feature, and (b) specifically
reintroduces the exact silent-partial-failure risk demonstrated above.

## 7. Performance: many simultaneous animated/skinned instances

The brief specifically asked not to assume this is fine. It was measured.

**What actually costs something new.** Posing adds two distinct costs beyond
today's static rendering: (1) CPU-side `AnimationMixer.update(delta)` per
instance per frame (keyframe interpolant evaluation across every track), and
(2) the GPU re-deriving each `SkinnedMesh`'s bone matrix texture from current
bone world matrices before each draw. Geometry/vertex/triangle counts and
draw-call counts are **unchanged** by animation — those costs already exist
identically for a static posed mesh and are already covered by this
project's own numbers (`perf-budgets.json`'s `render3d` section: 24 placed
objects and a fully populated 20×20 map editor both measured at 16.66ms,
exactly the 60fps vsync cap, on a real GPU). So the genuinely new,
posing-specific cost to isolate is (1).

**Measured (1) directly**, via a Node microbenchmark against the real,
parsed `RiggedFigure` rig (19 bones, 57 tracks — the same scale as
`CesiumMan`), using this project's own `three` and `three-stdlib` builds —
`SkeletonUtils.clone()` per instance (exactly what `<Clone>` already does)
plus a real `AnimationMixer` and `mixer.update()` per simulated frame,
300-frame steady-state average after warm-up:

| Concurrent animated instances | Total mixer-update cost / frame | Per-instance |
|---:|---:|---:|
| 1 | 0.009 ms | 0.0093 ms |
| 4 | 0.012 ms | 0.0030 ms |
| 8 | 0.028 ms | 0.0035 ms |
| 12 | 0.041 ms | 0.0034 ms |
| 20 | 0.060 ms | 0.0030 ms |
| 30 | 0.093 ms | 0.0031 ms |
| 50 | 0.149 ms | 0.0030 ms |

Against `perf-budgets.json`'s `render3d.maxAvgFrameTimeMs` of 33.3ms (and the
tighter real 16.66ms vsync-capped baseline this project already measures), 12
concurrent animated NPCs cost **~0.04ms**, roughly **0.25% of the 16.66ms
budget** — not measurable against real frame-to-frame jitter, let alone a
regression. Even 50 simultaneous instances stay under 0.15ms. A steady-state
memory check (20 mixers × 5,000 additional frames, forced GC before/after)
showed no heap growth — `AnimationMixer.update()` does not leak or allocate
meaningfully once warmed up.

**What this benchmark does *not* cover:** real GPU skinning/draw cost with
realistically-detailed character meshes (this bench used `RiggedFigure`'s
tiny 256-triangle test geometry, chosen because bone/track count — not
triangle count — drives CPU mixer cost). `CesiumMan` (4,672 triangles, still
a fairly modest low-poly character) is a better proxy for a "real" NPC/
monster model; a dozen such instances is ~56k triangles scene-wide, modest
next to what this project's own benchmarks already push through at a steady
60fps. This is a reasoned estimate, not a directly observed browser number.

**Concrete recommendation:** a genuinely looping animation (idle/sitting
clip via `AnimationMixer` + `useFrame`, i.e. drei's `useAnimations`) is
**affordable at realistic combat-encounter scale (a dozen-plus simultaneous
NPC/monster tokens)** — the measured marginal CPU cost is negligible, and a
static single-frame pose would only save that same negligible slice (a
`SkinnedMesh`'s bone matrix texture is recomputed every frame regardless of
whether the mixer is currently ticking, so "static" doesn't skip the GPU-side
part of the cost at all). **Recommend the looping clip as the default**, not
the static single-frame pose — the aesthetic gain (breathing/idle motion vs.
a frozen mid-pose) is real and the performance cost is not. Do **not** ship
this claim on the Node estimate alone, though: the follow-up posing prompt
should extend `scripts/perf/asset-render-benchmark.mjs`'s existing pattern
(a headless Playwright/Chromium harness against a real GPU, already checked
against `perf-budgets.json`) with a scenario that loads N real animated
skinned instances (e.g. `CesiumMan`, or the eventual real monster/NPC test
assets) and confirms the end-to-end number before this ships broadly. If
that real-GPU number ever shows pressure at high token counts, the cheap
mitigation is a simple, principled cap: cull `AnimationMixer.update()` calls
(freeze the pose, don't stop ticking geometry) beyond some measured instance
count or camera distance — not something today's evidence says is needed,
but worth having a name for in case the real-GPU check disagrees with the
CPU-only estimate here.

## 8. Recommendation: where forward-direction metadata lives

**Representation:** a single numeric yaw offset in **degrees** —
`forward_offset_deg`, applied as an additional Y-axis rotation. Degrees (not
radians) matches this project's own existing convention for exactly this
kind of value: `map_objects.rotation` is stored and manipulated in degrees
throughout (`MapEditor.tsx`'s `(object.rotation + 90) % 360`, displayed as
`{...}°`), converted to radians only at the render boundary
(`MapSurface.tsx`: `rotation={[0, (rotation * Math.PI) / 180, 0]}`). A
default of `0` is exactly today's behavior (no correction), so this is
fully backward-compatible with every existing preset and upload — nothing
regresses by adding the column.

**Composition with existing rotation:** verified this composes cleanly with
no changes to `GameTableScene`/`MapSurface`. `GameTableScene` already wraps
`SeatAvatar` in `<group rotation={[0, seat.rotationY, 0]}>` (seat-facing
rotation, extrinsic/positional) — the model's own `forward_offset_deg`
(intrinsic to the asset) is a second, independent Y rotation applied *inside*
`AvatarModel`/`PropModel`, on the same `<Clone>` element that already carries
`scale`/`position`, alongside the existing bounding-box normalization math.
Two independent rotations around the same axis simply add — no interaction
with the outer seat/placement wrapper to design around.

**Where the column lives — more nuanced than "just `asset_library`".** The
brief's instinct (alongside `asset_library.model_ref`) is correct for
`PlacedObject`'s path (map assets, NPCs, monsters), but `SeatAvatar`'s player
avatar path does **not** go through `asset_library` at all — it resolves
through `profiles.avatar_source`/`profiles.avatar_ref` (a structurally
identical but entirely separate `(source, ref)` pair, per
`0010_profile_avatar.sql`). The project owner explicitly confirmed this
matters for NPCs *and* player characters, so the design has to cover both
tables, not just the one the brief named.

Two ways to do that, and a concrete pick:

- **(a) Duplicate the column** on both `asset_library` and `profiles`. Simple,
  consistent with each table already owning its own `(source, ref)` pair, but
  two migrations, two RLS surfaces, two read call-sites to keep in sync.
- **(b) One small shared table**, e.g. `model_orientation(model_url text
  primary key, forward_offset_deg numeric not null default 0)`, keyed by the
  **resolved, loadable URL/path** — not the raw `avatar_ref`/`model_ref`
  value, which differ in shape between the two tables (`asset_library`
  presets store a full public path like `/assets/presets/torch.glb`;
  `profiles` presets store a bare preset id like `"vanguard"` — resolved to a
  path only by `AVATAR_PRESETS` lookup). Both `SeatAvatar`'s and
  `PlacedObject`'s existing resolution layers (`resolvePaletteAssets` in
  `assetUrl.ts`, and the analogous avatar-URL resolution before `SeatAvatar`
  receives its `url` prop) already compute this resolved string right before
  rendering, so joining on it costs nothing new to compute — it's already the
  value that gets read.

**Recommend (b).** It's one migration instead of two, needs no schema change
to either `asset_library` or `profiles`, and generalizes cleanly if a third
`model_ref`-shaped column ever appears. RLS on the new table is simple and
matches existing read openness (`asset_library`/`profiles` are both readable
by any authenticated campaign member/user already) — writes go through the
same upload code paths that already enforce DM-only (`createCustomAsset`) or
self-only (`setProfileAvatar`) permission, so the metadata write rides
alongside the existing insert/update rather than needing new RLS logic of
its own.

**One real gotcha to flag explicitly for the implementation prompt:**
`uploadAvatarFile` uses a **fixed path per user** (`${userId}/avatar.glb`,
replaced via `upsert: true` on every re-upload) — unlike
`uploadMapAssetFile`, which mints a fresh UUID path every time. That means a
`model_orientation` row keyed by resolved URL will go **stale** the moment a
user replaces their custom avatar with a different model at the same path,
unless the avatar upload flow explicitly **upserts** (not inserts) the
orientation row in the same transaction/request as the file replacement.
Getting this wrong produces a confusing, hard-to-repro bug: "my new avatar
renders sideways because of my old avatar's leftover rotation setting."
Map-asset uploads don't have this problem (new path every time = no stale
row possible).

**Upload UI — rotate-and-preview step.** Concretely: after
`validateGlbFile` succeeds and *before* `createCustomAsset`/
`setProfileAvatar` commits the reference, insert a confirmation step (modal
or inline panel) that:
1. Renders the model live using the exact same scale/recenter math
   `AvatarModel`/`PropModel` already use (so what the uploader sees matches
   what will actually render at the table/on the map).
2. Shows a fixed "this way is forward" reference marker in the scene (an
   arrow decal on the ground plane is simplest — reuses the flat-plane
   rendering this project already does elsewhere, e.g. `MapSurface`'s cell
   tinting).
3. Gives the uploader a simple rotate control (nudge buttons in fixed
   increments, e.g. 15°/45°/90°, is simpler and more predictable to build
   and test than a free-drag orbit gizmo, and is precise enough for a coarse
   "which way is forward" correction).
4. On confirm, saves the resulting `forward_offset_deg` via the
   `model_orientation` upsert described above, in the same request that
   creates/updates the `asset_library`/`profile` row.
This step is optional to *complete* (a Skip/default-to-0 option should exist)
so it never blocks an upload — it degrades to today's exact no-correction
behavior if skipped, same as an unrigged/unsupported model degrades to
today's static rendering (§9).

## 9. Recommendation: posing system scope

**Static single frame vs. looping clip: ship the looping clip.** See §7 —
the marginal cost of a real loop over a static pose is negligible at
realistic NPC-token counts, and the aesthetic gain is real. Build it as a
loop from the start rather than building a static-pose mechanism now and a
looping one later — they share the same underlying mechanism (an
`AnimationClip` played through `AnimationMixer`/`useAnimations`); a "static
pose" is just that same mechanism with the mixer paused at a fixed time, so
nothing here is wasted if a static mode is ever wanted as a fallback tier.

**Minimal but real posing system for this codebase:**

1. **One project-authored, documented bone-naming convention** — not literal
   "support any uploaded skeleton." Modeled on Mixamo's standard rig naming
   (the most common free/automatic humanoid-rigging pipeline a DM sourcing
   free NPC/monster models would realistically already have used — its
   auto-rigger is free and its license permits using the resulting rig and
   animations in a finished product like this app), but matched **tolerantly**
   by bone *role* rather than by one exact string: a small alias table per
   required role (e.g. hip role accepts `hips`/`pelvis`/`root`/`mixamorighips`,
   case-insensitive substring match), because §6's own evidence shows that
   even two closely-related sample rigs don't agree on exact bone-name
   strings. A minimal required-role set for a standing-idle/sitting pose:
   hips, spine/chest, head (optional), left/right upper-arm, left/right
   forearm, left/right upper-leg, left/right lower-leg. (Arms matter most for
   breaking a T-pose — that's literally what defines the T-pose visually;
   legs matter most for a believable "sitting" pose.)
2. **One small shared clip library**, authored once by the project (source
   from Mixamo's free "Idle"/"Sitting Idle" animations against a reference
   rig using this convention's names, or hand-authored — either is fine,
   licensing permitting per §3), reused across every uploaded model whose
   skeleton satisfies the required-role check. This is the mechanism §6
   proved works: an `AnimationClip`'s tracks bind by bone *name* at
   `mixer.clipAction(clip, root)` time, so one clip genuinely animates any
   skeleton sharing those names — no per-model retargeting math needed at
   all for this path.
3. **An explicit, upfront compatibility check** — compare the uploaded
   skeleton's bone-name set against the convention's required roles
   (cheap: a `Set` lookup per role, exactly what §6's experiment already
   demonstrated as a viable pre-check) — performed once, either at the
   upload/preview step (ideal: tell the uploader immediately whether posing
   will be available) or lazily on first render. If the check fails (missing
   skin data entirely, e.g. every current preset — or a skeleton that doesn't
   satisfy the required roles), render **exactly today's static
   bounding-box-scaled `Clone`** — never attempt a partial bind. This is the
   guard §6 showed is necessary: a partial match (some bones move, most
   don't) would look worse than the current T-pose, not better.

**Explicit recommendation on arbitrary skeletons:** no, not in a first
version. Require the one documented, tolerantly-matched convention above;
anything that doesn't satisfy it — including every asset in this repo today
— falls back to current static rendering, never a hard failure, exactly as
the brief specifies. Per-model authored clips uploaded alongside an arbitrary
skeleton (the other option the brief raised) is a real, viable *future*
extension — it fully sidesteps the naming-convention problem, since a clip
baked into its own model's `.glb` already binds to that model's own bone
names with no cross-model matching needed at all (proven in §4: `gltf.animations`
already comes through cleanly per-model) — but it only ever helps uploads
that already ship their own baked animation, doesn't produce the "one shared
pose reused everywhere" experience the brief's "sitting"/"standing-idle"
framing calls for, and needs its own UI for picking which embedded clip is
"the" pose if a model ships several. Recommend deferring it to a v2 note
rather than building both mechanisms in the first posing prompt.

## 10. Recommended follow-up scope

**Follow-up prompt A — orientation metadata + upload UI:**
- Migration adding `model_orientation(model_url text primary key,
  forward_offset_deg numeric not null default 0, updated_at timestamptz not
  null default now())`, RLS: readable by any authenticated user; writable by
  whoever can currently write the corresponding `asset_library`/`profiles`
  row (ride the existing `createCustomAsset`/`setProfileAvatar` permission
  checks rather than reinventing new ones).
- Data-access functions to read/upsert a row by resolved URL, wired into
  `resolvePaletteAssets` (`assetUrl.ts`) and the equivalent avatar-URL
  resolution path so `SeatAvatar`/`PlacedObject` receive the offset alongside
  the URL they already receive.
- `AvatarModel`/`PropModel` (and `ChairModel`, for consistency, though its
  two models are being fixed one-off elsewhere) gain a `rotationY` applied
  on the same `<Clone>` alongside existing `scale`/`position`.
- The rotate-and-preview upload step described in §8, wired into
  `AssetPalette.tsx`'s upload flow and the equivalent avatar upload flow on
  `/account`, including the upsert-on-reupload fix for the avatar fixed-path
  case.
- Explicitly **out of scope for this prompt**: anything about skeletons,
  skins, or animation — this prompt is rotation-only, and every model
  (rigged or not) benefits from it identically.

**Follow-up prompt B — skeleton-based posing** (depends on A only for the
`model_orientation` table existing, if the compatibility flag is stored
there too — see below):
- Add a `pose_compatible boolean` (or similar) alongside
  `forward_offset_deg` in `model_orientation` — computed once (upload time or
  first load) from the required-role bone-name check in §9, cached rather
  than recomputed every render.
- One project-authored idle clip and one sitting clip (source per §3/§9),
  committed as small data (not full `.glb` assets — just the clip's own
  keyframe data, or two minimal companion rigs if that's simpler to author
  against) — this needs a concrete authoring decision at build time; this
  spike does not source or commit either clip itself.
- `AvatarModel`/`PropModel` gain the `useAnimations` wiring, gated by the
  compatibility check, always falling back to today's static `Clone` when
  incompatible or when the model has no skin data at all.
- A source-controlled test fixture per §3 (`RiggedFigure.glb` recommended:
  no attribution burden, small, already proven to parse/animate correctly in
  this investigation).
- A new Playwright-based perf scenario extending
  `scripts/perf/asset-render-benchmark.mjs`'s pattern with N real animated
  skinned instances, checked against `perf-budgets.json`'s `render3d` budget,
  per §7's explicit recommendation to verify the real-GPU number before
  relying on the CPU-only estimate this spike produced.
- Explicitly **out of scope**: cross-skeleton retargeting
  (`SkeletonUtils.retarget`/`retargetClip`), per-model authored clips, and
  any UI for picking among multiple embedded clips — all deferred per §9.
