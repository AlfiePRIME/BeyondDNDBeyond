# Design spike: dice numbers and physics

Status: design only — no feature code shipped by this document (no scratch
scripts either: the physics-library research below was done entirely
against public npm registry metadata, not by installing anything into this
worktree). Every recommendation is checked against the CURRENT state of
`src/scene-3d/diceGeometry.ts`, `DiceTumble.tsx`, `diceAnimator.ts`,
`useDiceTumble.ts`, the roll route, and `rules-engine/dice.ts` as they exist
today, re-read fresh for this spike rather than assumed from any prior
description. Written to be built by the follow-up prompt(s) scoped in §12.

## 1. Problem recap

Today's dice tumble (`scriptedDiceAnimator`) is a deliberate placeholder:
pure keyframed math (spin, arc, ease, slerp-to-target), explicitly built as
scaffolding for a future physics upgrade behind the `DiceAnimator` seam. The
dice themselves are solid-color procedural polyhedra with no printed
numbers or pips anywhere on them — the only legible readout is a
billboarded 2D canvas-texture badge that appears once a die has settled.
There is no real d100 geometry; a free-form roll with an odd side count
(100, 3, 2, ...) falls back to a plain placeholder icosahedron.

The project owner wants both gaps closed: real printed numbers/pips on
every face of the six standard dice (with d100 explicitly scoped, not left
as "whatever the fallback does"), and a genuine rigid-body physics
simulation replacing the scripted tumble — while never letting the physics
simulation actually decide a roll's outcome, since the true result is
already computed server-side and authoritative before any animation starts.

## 2. What was read

`src/scene-3d/diceGeometry.ts` (six standard dice built from three.js's
own Platonic-solid primitives plus a from-scratch pentagonal trapezohedron
for the d10; `DIE_FACE_NORMALS`/`faceNormalForResult`, each face's
local-space normal, hand-computed once and hardcoded — not derived by any
runtime utility today); `DiceTumble.tsx` (per-tray FIFO queue, one
`DiceTumble` instance mounted per connected member via
`memberTrayPositions`, `DieMesh`'s solid-color mesh +
`ResultBadge`'s billboarded canvas-texture readout, `scaledDiceAnimator`'s
existing "wrap the animator, don't touch its step math" seam precedent);
`diceAnimator.ts` (the `DiceAnimator` interface's own doc comment, which
already anticipates "a future `@react-three/rapier`-backed implementation…
stepping a physics world forward by `elapsedSeconds` and reading the
settling body's transform back out, still returning the same `DicePose`
shape"); `useDiceTumble.ts` (the imperative, no-React-render-cost
`useFrame` plumbing every `DiceAnimator` implementation must fit into);
`diceGeometry.test.ts` and `diceAnimator.test.ts` (the existing rigor bar
for any new geometry/animator code: exact-count/unit-length/antipodal-pair
assertions, purity assertions, settle-orientation assertions); the roll
route (`src/app/campaigns/[id]/roll/route.ts`) and `rules-engine/dice.ts`
(`rollDie`, `rollExpression`, `parseDiceNotation` — confirming the server
is the sole roller, via an injectable `RandomSource` defaulting to
`Math.random`, and that "d100" today is parsed and rolled as a single
`{count:1, sides:100}` term — one flat `rollDie(100)` integer in [1,100],
**not** modeled as two d10s anywhere); `src/app/campaigns/[id]/roll/tumble.ts`
(`buildDiceTumbleSpec` — the one place a persisted `RollLogEntry` becomes
the plain `{sides, result}[]` shape scene-3d consumes, and the exact spot
a d100 special case would need to live); `GameRoom.tsx`'s
`DICE_ROLLED_EVENT`/`handleRollLanded`/`DiceRolledPayload` wiring (confirms
the existing broadcast already carries the full `DiceTumbleSpec` — every
die's `sides` and authoritative `result` — to every other connected
client, before any client's animation starts); `package.json` (no physics
library present — `three`, `@react-three/fiber`, `@react-three/drei` only);
`perf-budgets.json` (`render3d.maxAvgFrameTimeMs: 33.3` with a real
measured baseline of 16.67ms/60fps vsync-capped; `realtimeLoad.concurrentClients: 10`
as this project's own declared realistic concurrency ceiling);
`scripts/perf/render-benchmark.mjs` and its siblings (the existing
Playwright-driven, real-page benchmark convention any new perf script
should match); `docs/design/pits-and-falling.md` and
`docs/design/map-editor-toolbar-redesign.md` (this document's own
structural precedent); and live npm registry metadata (below) for the
physics-library evaluation, since a stale, remembered "which library is
best" answer would be exactly the kind of assumption this spike's own
brief warns against.

## 3. Today's dice pipeline, end to end (confirmed ground truth)

1. **Server, `route.ts`**: every roll kind (`freeform`, `check`, `save`,
   `skill`, `attack`, `initiative`, `hide`, `death_save`,
   `concentration_save`) resolves through `rules-engine/dice.ts`'s
   `rollD20`/`rollExpression`/`rollDie`, using `Math.random` — never
   client-supplied. The result is persisted to `roll_log` as a
   `RollBreakdown` (`type: "d20"` with `d20Rolls`, or `type: "dice"` with
   per-term `groups[].results`) *before* anything is broadcast.
2. **App layer, `tumble.ts`**: `buildDiceTumbleSpec(roll)` flattens that
   persisted breakdown into `{ id: roll.id, dice: {sides, result}[] }` —
   one entry per physical die that was actually rolled (both dice of an
   advantage/disadvantage pair; every individual die in a `"2d6+1d4"`
   freeform roll, one tumble each).
3. **`GameRoom.tsx`**: `handleRollLanded` plays that spec immediately at
   the roller's own tray (`diceTumbleRefs.current.get(roll.roller_user_id)`),
   and — only for `visibility === "public"` — broadcasts the *exact same*
   `{ spec, rollerUserId }` payload over `DICE_ROLLED_EVENT` on the
   campaign channel, so every other already-connected client plays the
   identical `DiceTumbleSpec` at the identical tray. A private roll never
   broadcasts at all; `roll_log`'s own RLS is what actually hides it.
4. **`DiceTumble.tsx`**: each die in the active roll mounts a `Die`
   (`<group ref>` wrapping `DieMesh` + a conditional `ResultBadge`), driven
   by `useDiceTumble(spec, animator)`.
5. **`useDiceTumble.ts`**: one `useFrame` per die, imperatively writing
   `position`/`rotation` onto the group's ref every frame (no React
   re-render cost), calling `animator.step(spec, elapsedSecondsSinceMount)`.
6. **`diceAnimator.ts`**: `scriptedDiceAnimator.step` is a pure,
   stateless function of `(spec, elapsedSeconds)` — spins for
   `TUMBLE_SECONDS` (0.55s) while easing position from a per-die
   deterministically-seeded start point toward the tray's rest spot, then
   slerps rotation from wherever the spin left off into
   `faceNormalForResult(kind, spec.result)`-derived target orientation
   over `SETTLE_SECONDS` (0.85s total), and reports `settled: true` once
   that window closes.
7. **`diceGeometry.ts`**: `faceNormalForResult` is the one place "which
   way is up" for a given numeric result is decided — already
   geometrically correct today. Nothing about numbering/physics touches
   this function's contract; both halves of this spike build strictly on
   top of it.

The load-bearing fact for §6-§10 below: **the authoritative `{sides,
result}` pair for every die is already fully computed and already fully
propagated to every client (via `DiceTumbleSpec`) before step 4 even
mounts a die.** Nothing this spike designs needs to change what travels
over the wire — only what happens inside steps 4-7.

## 4. Numbering/pips: chosen approach

**Recommendation: per-face canvas-texture decals — small transparent-background
quads, one per face, positioned and oriented directly off the already-computed
`DIE_FACE_NORMALS`, each textured with a cached canvas-drawn numeral — layered
as sibling meshes on top of the existing solid-color base polyhedron.** Not a
single UV-mapped texture atlas with rewritten geometry UVs, and not real
embossed/engraved 3D geometry. Concretely, for die kind `k` with faces
`0..sides-1`:

```
faceCenter(k, i) = DIE_FACE_NORMALS[k][i] * FACE_PLANE_DISTANCE[k]
```

`FACE_PLANE_DISTANCE[k]` is one new scalar per die kind (every face of a
regular/fair die is, by construction, equidistant from the center — true
for all five true Platonic solids here, and true for the d10 by the
pentagonal trapezohedron's own isohedral construction, already relied on
implicitly by `DIE_FACE_NORMALS` itself). A small quad is placed at
`faceCenter(k, i) + normal * DECAL_EPSILON` (a hair of outward offset —
the standard coplanar-decal z-fighting fix), oriented by exactly the same
`Quaternion().setFromUnitVectors(new Vector3(0,0,1), new Vector3(...normal))`
technique `diceAnimator.ts` already uses to compute the settle-target
quaternion, and textured with a small, cached, transparent-background
canvas texture of that face's printed label (a new sibling function next
to `resultBadgeTexture` — same "canvas 2D `fillText`, cache by label
string" architecture, not a new pattern).

**Why this over a single UV-remapped texture atlas.** An atlas is the more
"obvious" texture-based answer, but none of the five three.js primitives
`buildDieGeometry` uses ship with per-physical-face UV islands out of the
box (their default UVs are per-triangle projections that don't respect
"one face = one flat region," and several faces here are built from
multiple triangles — the d12's pentagons, the d10's from-scratch kite
quads). Making an atlas work would mean writing new per-shape UV-rewrite
code for five different primitive topologies (grouping triangles into
faces exactly the way `DIE_FACE_NORMALS` was computed once, then
projecting each face's vertices into a 2D basis and packing them into an
atlas cell) — real, fiddly, one-time-per-kind geometry-authoring work with
a nontrivial chance of visible seams/stretching if any one shape's
projection math is slightly off. The decal approach needs none of that: it
never touches `buildDieGeometry`'s vertex/UV data at all, reuses
`DIE_FACE_NORMALS` completely unmodified, and reuses the *exact* canvas-
texture-cache pattern `ResultBadge` already established — genuinely less
new code, not just "simpler in spirit."

**Why this over real embossed/engraved geometry.** Carving or fusing actual
3D numeral geometry onto each face needs correct per-face orientation
(same normal-alignment problem as the decal, but now baked into
irreversible mesh topology) and either boolean CSG subtraction (engraving)
or per-face sub-mesh fusion (embossing) for all six kinds — a materially
bigger, riskier implementation lift for a purely cosmetic upgrade over a
crisp texture. It also complicates the collision question (§8): a mesh
whose surface has been perturbed by embossed digits is a worse physics
collider than a clean convex primitive, forcing the visual/collision split
sooner than it otherwise needs to be forced. And at this app's actual
render scale (`DIE_SIZE = 0.13` world units — a normal tabletop-sized die
relative to the game's other scene proportions, viewed from an ordinary
table-level or overhead camera, never a dice close-up), a few embossed
polygons per digit would rarely resolve to more than a handful of screen
pixels, while a canvas-rendered numeral is exactly as crisp as the texture
resolution regardless of triangle count. The complexity buys legibility
this app's actual viewing distance doesn't need.

**Numerals, not pips, on every face — including the d6.** One shared
"draw this string centered in this cell" renderer for all six kinds is
simpler to build and maintain than adding a second, materially different
pip-layout algorithm (variable dot counts and positions: 1 centered, 2
diagonal, 3 diagonal, 4 corners, 5 corners-plus-center, 6 two columns of
three) just for the d6. It's also more legible at `DIE_SIZE` scale from an
arbitrary camera angle around the table — one bold glyph reads faster than
six tiny dots. Many real polyhedral D&D sets already number every die
including the d6 for exactly this consistency reason, so this isn't an
invented convention. (Pips-on-the-d6 is a reasonable, common alternative —
flagged explicitly in the open questions below, not dismissed as wrong,
just not the recommendation.)

**Base label sets** (one `string[]`, index `i` = the label printed on the
face whose normal is `DIE_FACE_NORMALS[kind][i]`, i.e. what
`faceNormalForResult(kind, i+1)` points up for):

| kind | labels (face index 0 → sides-1) |
|---|---|
| d4  | "1","2","3","4" |
| d6  | "1","2","3","4","5","6" |
| d8  | "1".."8" |
| d10 | "1","2",...,"9","10" (see below — deliberately not "0") |
| d12 | "1".."12" |
| d20 | "1".."20" |

The ordinary (non-percentile) d10 prints **"10"** on its tenth face rather
than the "0" many physical d10s use, because `rollDie(10, random)` in
`rules-engine/dice.ts` already returns an integer in **[1, 10]** — there is
no "0" result to represent for a lone d10 roll in this app's own math, and
printing a face that can never correspond to any real result would be
actively confusing. This is a deliberate, stated departure from one
physical-dice convention in favor of consistency with this codebase's own
existing 1-indexed semantics — not an oversight.

**A new small module addition, no changes to existing exports.** A
`DEFAULT_FACE_LABELS: Record<DieKind, readonly string[]>` constant
alongside `DIE_FACE_NORMALS` in `diceGeometry.ts` is the natural home,
following that file's own "one array per die kind, index 0 = face 1"
convention exactly.

## 5. d100 / percentile dice: explicit resolution

**There is no dedicated d100 geometry, and there should not be one.** The
real-world percentile-dice convention — a "tens" d10 printed 00/10/…/90 and
a "ones" d10 printed 0-9, read together — is modeled as **two ordinary d10
tumbles, reusing the exact same geometry, `DIE_FACE_NORMALS`, and
`faceNormalForResult` the standalone d10 already uses**, distinguished only
by which label set is baked onto their face decals. No new die kind, no
new `dieKindForSides` entry, no new geometry function.

**Server-side math is unchanged.** `parseDiceNotation`/`rollExpression`
already produce a single, correct, uniform integer in [1,100] for a
`"1d100"` (or `"d100"`) term via one `rollDie(100, random)` call — that
*is* a valid, SRD-correct way to generate a percentile result, and nothing
about this spike's recommendation touches it. The decomposition into a
tens-die face and a ones-die face is a **pure, deterministic, display-only**
transform of that one already-authoritative integer, applied only where
`tumble.ts` flattens a persisted roll into tumble specs — never in
`rules-engine/`, and never re-randomized.

**The decomposition** (a small addition to `buildDiceTumbleSpec`, gated on
`group.sides === 100`), for authoritative result `r` in [1,100]:

```
tensValue = (r === 100) ? 0 : Math.floor(r / 10) * 10   // 0,10,20,...,90
onesValue = (r === 100) ? 0 : r % 10                     // 0-9
tensFaceResult = tensValue / 10 + 1   // 1..10, fed to faceNormalForResult("d10", ·)
onesFaceResult = onesValue + 1        // 1..10, fed to faceNormalForResult("d10", ·)
```

This produces two ordinary `DiceTumbleDieSpec`-shaped entries, both
`sides: 10`, whose `result` field is the *synthetic* 1-10 index above (so
`faceNormalForResult`/the animator/physics settle math need zero changes —
they only ever see a valid 1-10 d10 result). What differs is which
**label set** each one's face decals use — `["00","10","20",...,"90"]` for
the tens die, `["0","1",...,"9"]` for the ones die, both index-aligned to
the same synthetic-result convention as §4's table. This requires
`DiceTumbleDieSpec` (in `diceAnimator.ts`) to grow one new optional field —
`labelSet?: readonly string[]` — defaulting to `DEFAULT_FACE_LABELS[kind]`
when absent, so every non-percentile die is completely unaffected.

**No color-coding or extra UI is needed to tell the two dice apart**: a
face reading "40" is unambiguously the tens die, a face reading "4" is
unambiguously the ones die, exactly how a player reads real percentile
dice at a table. The one real UI wrinkle: `ResultBadge` currently displays
`spec.result` directly (the numeric value that also drives face
orientation) — for a percentile pair that value is the *synthetic* 1-10
index, not the printed value, so it would misleadingly show "6" over a die
whose face reads "50". `ResultBadge`'s prop needs to change from a raw
`value: number` to an already-formatted `label: string`, with each die's
own real face label (`labelSet[syntheticResult - 1]`) passed in instead —
a small, mechanical, backward-compatible change (`ResultBadge` already
just does `String(value)` today) rather than a design gap.

**This is a genuine scope decision, stated explicitly**: a d100 roll is
rendered as a real, distinct two-die percentile throw, never as a single
oversized placeholder die and never silently dropped to the fallback
icosahedron. `dieKindForSides(100)` correctly continues to return `null`
(there is still no such thing as "d100 geometry") — the percentile
handling lives entirely in the app-layer flattening step, one level above
where `dieKindForSides` is consulted, exactly mirroring how `tumble.ts`
already sits above `diceGeometry.ts` in this pipeline today.

## 6. Physics library: evaluation and recommendation

`package.json` confirmed: `three`, `@react-three/fiber`, `@react-three/drei`
only — no physics library installed today.

Real, current (checked live against the npm registry and download-stats
API, not remembered) comparison of the realistic candidates:

| package | latest | last published | weekly downloads | engine |
|---|---|---|---|---|
| `@dimforge/rapier3d-compat` | 0.20.0 | 2026-08-08 | ~6.85M | WASM (compiled Rust) |
| `@react-three/rapier` | 2.2.0 | 2025-11-03 | ~120K | wraps the above |
| `@react-three/cannon` | 6.6.0 | 2023-08-17 | ~26K | wraps `cannon-es` |
| `cannon-es` | 0.20.0 | 2022-08-12 | — | pure JS |
| `ammojs-typed` | 1.0.6 | 2020-07-13 | — | WASM (Emscripten C++ port) |

**`@react-three/cannon`/`cannon-es` are stale, not merely "less popular."**
Three-plus and four-plus years respectively since their last publish, both
predating this project's own React 19 / `@react-three/fiber` 9.x / three
0.185.x stack entirely, with no evidence of active maintenance to fix a
compatibility break if one surfaced. Pure-JS `cannon-es` is also simply
slower per simulated body than a WASM engine, which matters directly for
§9's multi-die/multi-tray question.

**`ammojs-typed` is effectively abandoned** (2020) with no dedicated
react-three-fiber binding at all — adopting raw Ammo would mean hand-
rolling all of the r3f integration Rapier's ecosystem already provides,
against a rawer, more C++-flavored Emscripten API that is materially more
awkward for "read a settled body's final transform back out" than
Rapier's `.translation()`/`.rotation()`.

**`@dimforge/rapier3d-compat` is the recommendation** — WASM (compiled
Rust, via `rapier3d-compat`'s async-init build specifically made for
bundler/browser use), Apache-2.0 licensed (permissive, trivially
clearable — this project's own `diceGeometry.ts` doc comment already
flags "nothing to license-check" as a value it cares about), extremely
actively maintained (a version shipped **18 days before** this spike, per
its own registry timestamp) and, at ~6.85M weekly downloads, the
overwhelmingly dominant WASM physics engine in the current JS ecosystem —
not a niche pick. `@react-three/rapier`'s own `2.2.0` release pins peer
dependencies of `react ^19`, `three >=0.159.0`, `@react-three/fiber ^9.0.4`
— an exact match for this project's actual installed versions (`react
19.2.8`, `three 0.185.1`, `@react-three/fiber 9.7.0`), a real, currently-
verified compatibility fact, not an assumption.

**Depend on `@dimforge/rapier3d-compat` directly — not on
`@react-three/rapier`'s React component layer.** This is a deliberate,
narrower choice than "just install the obvious r3f wrapper," and worth
stating plainly: `@react-three/rapier`'s actual value-add is its
*declarative* JSX API (`<Physics>`, `<RigidBody>`, `<CuboidCollider>`,
scene-graph-integrated stepping via its own internal `useFrame`). Nothing
about this app's dice-tumble architecture is declarative — the
`DiceAnimator` interface's own doc comment is explicit that it must stay
"a pure function of (spec, elapsed seconds) → pose, with no React and no
three.js scene access," called from exactly one hand-rolled `useFrame` in
`useDiceTumble.ts`. A Rapier-backed `DiceAnimator` implementation needs
the raw imperative `World`/`RigidBodyDesc`/`ColliderDesc` API (create a
world once per roll, step it by hand, read transforms back by hand) —
exactly what `@dimforge/rapier3d-compat` exposes directly, with none of
`@react-three/rapier`'s JSX layer ever entering the picture. Adding
`@react-three/rapier` as a dependency here would mean shipping and
version-pinning a whole declarative-component layer this seam has no use
for, for zero benefit over depending on the engine it itself wraps.
(If a *later*, unrelated feature ever wants declarative physics elsewhere
in the scene — dice genuinely colliding with a real tray-wall mesh that
also needs its own declarative collider, say — `@react-three/rapier`
remains the right escape hatch *then*; it is not being ruled out
permanently, just not pulled in for a seam that doesn't want it.)

**Real download-weight numbers** (not npm's `unpackedSize`, which mixes in
`.d.ts` files never shipped to a browser): `@dimforge/rapier3d-compat`
0.19.2's actual browser-loaded artifacts are `rapier_wasm3d_bg.wasm` at
1,569,397 bytes (~1.53MB raw; WASM binaries typically compress well over
the wire, gzip/brotli, but this is genuinely a multi-hundred-KB-to-low-MB
download either way) plus `rapier_wasm3d.js` glue at 215,084 bytes raw
(ordinary JS text, compresses far better). This is a real, one-time,
lazily-loaded, browser-cached cost — **and it does not touch
`perf-budgets.json`'s `bundleSize.mainPageFirstLoadKb` budget at all**,
per that budget's own documented scope: it only sums the shared
root/polyfill chunks *every* page loads, and deliberately excludes
route-specific code (exactly like the 3D scene code already excluded
today). The WASM only ever loads for a client that actually opens a Game
Room with dice physics active.

## 7. Reconciling the authoritative server result with real physics

The brief poses two options. **Recommendation: option (b) — real,
unconstrained physics for the tumble, blended smoothly into a
guaranteed-correct scripted settle for the final short window** — not
option (a)'s "bias the throw, snap-correct if trending wrong."

**Why (a) is the harder, riskier design, not just a less-preferred one.**
A tumbling asymmetric polyhedron's landing face is exactly the kind of
chaotic, initial-condition-sensitive outcome that makes physical dice
useful for randomness in the first place — there is no cheap way to
reliably predict "which face will this settle on" while it's still
mid-tumble; you can only really know once it has (nearly) stopped. That
leaves two ways to make (a) actually work, and both are meaningfully more
complex than they first sound:

- **Detect-and-snap after the fact**: let it actually settle, check if the
  face is wrong, and re-orient it if so. But by then it has already
  visually come to rest on a specific face in front of players — snapping
  it to a *different* face reads as an obvious, unmistakable correction
  ("the answer changed"), a strictly worse failure mode than anything
  option (b) risks.
- **Headless pre-simulation with rejection sampling**: run the seeded
  throw once, fast and unrendered, to completion; check whether it
  naturally lands correctly; if not, re-seed and retry (bounded by a
  retry cap, falling back to scripted beyond it); only then replay the
  verified trajectory in real time. This is workable but requires an
  entire frame-recording/replay layer, a retry loop with its own timeout
  and fallback, and — for a multi-die roll — either an independent
  per-die search (fine, since dice don't need to interact) or a
  meaningfully larger joint search if they're allowed to collide with
  each other. Real, but a lot of new machinery for what should be a
  cosmetic upgrade.

**Why (b) sidesteps both problems entirely.** The transition from real
physics to the guaranteed-correct pose happens at a **fixed point in the
timeline regardless of what the physics was doing**, so there is no
prediction problem to solve at all — the natural outcome of the physics
phase is simply never consulted. Concretely, this generalizes
`scriptedDiceAnimator`'s *own* existing tumble→settle blend rather than
inventing a new mechanism:

- Today: `quaternion = spinQuaternionAt(TUMBLE_SECONDS, ...).slerp(targetQuaternion, settleT)` —
  slerp from "wherever the deterministic spin formula says we are at the
  tumble/settle boundary" into the guaranteed target.
- Physics-backed: `quaternion = <the live Rapier rigid body's actual
  rotation at the transition instant>.slerp(targetQuaternion, settleT)` —
  slerp from "wherever the *real simulation* actually is" into the exact
  same guaranteed target, over the same kind of settle window. Position
  generalizes the same way (lerp from the live body's actual translation,
  not a formula-computed one).

This is a small, low-risk delta on already-existing, already-tested blend
math, not a rewrite, and it reads as completely natural: a die that's
still visibly tumbling smoothly settling into its final rest pose over the
last ~0.3s looks exactly like a real die's last little damped wobble
before it stops — nothing about it looks like an intervention, unlike
snapping an already-resting die to a different face.

**A genuine simplification this recommendation earns**: because the
settle is *unconditionally* scripted-correct regardless of the natural
physics outcome, **the initial throw's velocity/angular momentum never
needs to be biased toward the right answer at all.** Option (a) requires
seeding the throw so it's *statistically likely* to land correctly, which
inherently couples "looks like a fair, energetic throw" with "is quietly
weighted toward one outcome." Option (b) can randomize the throw
completely honestly, for pure visual variety, with zero coupling to
correctness — one fewer moving part, and a more defensible thing to have
running client-side at all (nothing about the visible tumble is ever
secretly biased).

**Recommended transition trigger — the later of a floor and a
settle-velocity check, capped by a deadline**: not a bare fixed timer.
Blend-start = `max(MIN_PHYSICS_SECONDS, <first frame where the body's
linear+angular speed drops under a small threshold>)`, clamped to never
exceed `MAX_PHYSICS_SECONDS` even if the body never naturally quiets down
(a die resting oddly against a tray wall, an edge-balance jitter — rare
but must not be allowed to stall a roll indefinitely, since the tray's
FIFO queue and `LINGER_MS` both depend on every roll eventually reaching
`settled`). `MIN_PHYSICS_SECONDS`/`MAX_PHYSICS_SECONDS` in the same
neighborhood as today's `TUMBLE_SECONDS`/`SETTLE_SECONDS` (≈0.4s /
≈1.2s) are reasonable starting points, tuned visually by the follow-up
implementer. This makes the blend itself *less* perceptible in the common
case (starting from a body that's already nearly at rest, not mid-bounce),
while the bare-fixed-timer version remains a perfectly acceptable, simpler
fallback if the velocity check proves fiddly to tune in practice.

**Concrete adaptation the `DiceAnimator` seam needs.** The interface's own
doc comment already anticipated this ("stepping a physics world forward by
`elapsedSeconds`"), and it holds up: `step(spec, elapsedSeconds): DicePose`
stays byte-for-byte the same signature — `useDiceTumble.ts`,
`DiceTumble.tsx`, `DiceLogPanel`, and `GameRoom.tsx` need **zero changes**
for physics, exactly as designed. What changes is that the *implementation*
can no longer be a stateless pure function like `scriptedDiceAnimator` is
today — a live physics world is unavoidably stateful. Concretely:

- One shared Rapier `World` **per roll, not per die** — dice in the same
  roll share a world (and, for free, can realistically collide with each
  other and the tray floor/wall colliders). `spec.id` already encodes
  `${rollId}:${index}` (see `ActiveTumble`'s existing die-id construction),
  so the implementation parses `rollId` back out to find/lazily-create
  that roll's world and per-die rigid bodies on first sight.
- **Step the shared world at most once per animation frame**, not once
  per die's own `step()` call — track `lastSteppedElapsed` per world;
  the first die to call `step()` in a given frame advances the world by
  `elapsedSeconds - lastSteppedElapsed` (clamped to a small max sub-step,
  standard physics-engine hygiene against a slow/janky frame), every
  other die's call that same frame just reads its own already-updated
  transform.
- **Explicit disposal.** Rapier's WASM memory is not garbage-collected by
  the JS engine — a finished roll's `World` needs an explicit `.free()`.
  `ActiveTumble`'s existing `onDone` callback (already fired exactly once
  per finished roll, after the `LINGER_MS` window) is the natural hook —
  this needs a small new disposal entry point on the physics-backed
  animator specifically (not added to the shared `DiceAnimator` interface
  itself, so `scriptedDiceAnimator` and any test double stay unaffected).
  Missing this is an easy, real way to slowly leak WASM memory across a
  long session with many rolls, worth flagging explicitly for whoever
  implements this.

## 8. Collision mesh vs visual mesh

**Recommendation, matching the brief's own suggested default: yes, keep
them separate, using the existing procedural polyhedra as the collider
regardless of what the visual layer looks like.** Concretely: build each
die kind's Rapier `ColliderDesc` directly from `buildDieGeometry`'s own
returned `BufferGeometry` — read its `position` attribute's raw vertex
array and feed it to `ColliderDesc.convexHull(positions)` for d4/d8/d10/
d12/d20, or use the simpler, cheaper analytic `ColliderDesc.cuboid(...)`
for the d6 (a box needs no convex-hull computation at all). This makes the
collider **mechanically identical to "the existing plain procedural
polyhedra"** — not a hand-maintained second copy of the same shape that
could silently drift from it — while staying architecturally independent
of whatever the *visual* layer does: the collider construction only ever
reads the base geometry's own vertices, never the decorated visual mesh
(base mesh + face decals) as a rendered whole.

**Worth noting explicitly**: with §4's decal-based numbering specifically,
the visual base mesh's own triangle topology is actually left completely
untouched — decals are separate sibling quads, not merged into the die's
core geometry — so today, the ideal collision proxy and the rendered base
mesh's triangles genuinely *are* the same data. That's a nice property of
having picked decals over an atlas-with-rewritten-UVs or embossed geometry
(either of which could plausibly need extra vertices/triangles for clean
per-face regions), but the recommendation above — construct the collider
from `buildDieGeometry`'s own vertices independently, never from
"whatever mesh happens to be on screen" — should hold regardless, so a
later purely-visual change (embossed digits, decorative bevels, a
branded tray-specific die skin) can never accidentally regress physics
behavior or performance by bloating the collider.

## 9. Multi-die / multi-tray performance assessment

Checked against `perf-budgets.json`'s two relevant numbers:
`render3d.maxAvgFrameTimeMs: 33.3` (30fps floor; real measured baseline
today is 16.67ms, exactly vsync-capped 60fps, on a GPU-backed sandbox —
roughly 2x headroom before even reaching the 30fps floor, let alone
dropping frames), and `realtimeLoad.concurrentClients: 10` — this
project's own already-declared realistic worst-case concurrency ceiling.

**The existing architecture already bounds most of this for free.** One
`DiceTumble` instance is mounted per connected member (`GameRoom.tsx`),
each with its own independent FIFO queue (`MAX_QUEUE = 8`) — only **one
roll animates per tray at a time**, others wait their turn. So the
realistic worst case to reason about is: all `concurrentClients` (10)
members happen to have an actively-tumbling roll at the exact same
instant (staggered turn-based play makes this less likely in practice,
but it's the correct ceiling to budget against) — **10 simultaneous
per-roll `World`s**, per §7's "one world per roll" design, each holding
only that one roll's own dice plus a static tray floor/wall.

**The real risk is per-roll dice count, not tray count.** Ordinary D&D
rolls are small (1-2 d20s, a handful of damage dice, rarely double
digits even for a big spell). But the freeform notation box already
accepts, unbounded by anything physics-related, up to `MAX_TERMS = 10`
terms of `MAX_DICE_PER_TERM = 100` dice each (`rules-engine/dice.ts`) —
a pathological (if unlikely) single "roll" of up to 1,000 individual
dice, which today's scripted animator shrugs off for free (cheap
per-die trigonometry) but which would be a genuinely different cost
profile as 1,000 simultaneous rigid bodies in one physics world.

**Recommendation: a hard per-roll cap, `MAX_PHYSICS_DICE_PER_ROLL`
(≈20-24)**, matching the SRD's own natural ceiling — the fall-damage
mechanic's own already-established 20d6 cap
(`docs/design/pits-and-falling.md`) is a real, in-codebase precedent for
"20-ish dice is the realistic maximum any legitimate roll produces." Any
roll whose dice count exceeds the cap falls back to
`scriptedDiceAnimator` **for the whole roll**, not a partial mix (a roll
half-physics/half-scripted would look inconsistent) — exactly the
existing seam's "swap which object `DEFAULT_DICE_ANIMATOR` points at"
mechanism, just decided per-roll instead of globally.

With that cap, the true worst-case concurrent load is bounded:
`10 trays × ~24 dice = ~240` simultaneously rigid-bodied dice, split
across 10 *independent* physics worlds (not one shared mega-world), each
world holding only simple convex/box colliders (the cheapest collider
class for any physics engine's broad- and narrow-phase) against one
static floor. This is a small workload by Rapier's own well-documented
standards (published benchmarks routinely handle thousands of dynamic
bodies in a *single* world at 60fps) — reasoned confidence, not a
measured number from this repository, stated plainly as such.

**Recommendation for the follow-up implementation prompt: measure this
for real before trusting it**, matching this project's own established
discipline (`perf-budgets.json`'s own footnotes explicitly warn against
guessing rather than re-measuring; the toolbar redesign spike made the
same call for its own uncapped Fill tool). A new
`scripts/perf/dice-physics-benchmark.mjs`, following the exact existing
Playwright-driven convention (`render-benchmark.mjs`/
`asset-render-benchmark.mjs`/`map-editor-benchmark.mjs`), simulating the
realistic worst case above (10 personal trays, each with a
capped-out ~24-dice roll, all physics-tumbling simultaneously) on a real
GPU-backed machine, is the concrete verification step — and the cap
value above should be treated as a starting point to tune down (not the
final word) if that measurement comes back over `render3d`'s budget.

## 10. Cross-client independent simulation

Confirmed compatible with the owner's already-accepted model — different
clients independently simulating their own physics for the same roll,
converging on the identical authoritative result — **with no new network
protocol beyond what already ships.**

Per §3, `DiceRolledPayload` already carries the complete `DiceTumbleSpec`
(every die's `sides` and authoritative `result`) to every connected
client before any client's tumble begins — this was already true for
today's scripted animator and needs no change for physics. What §7's
recommendation adds is purely **client-local, never networked**: each
client seeds its own physics throw with its own randomized initial
velocity/angular momentum (per the simplification in §7 — since the
natural physics outcome is never trusted, there is no correctness reason
two clients' seeds would ever need to match), runs its own real,
genuinely-divergent-looking tumble for the first ~0.4-1.2s, then
independently blends into **the exact same target pose** — because that
target is computed the same deterministic way `scriptedDiceAnimator`
already computes it today, straight from `faceNormalForResult(kind,
spec.result)`, which every client received identically over the existing
broadcast. Two clients' dice can genuinely look different mid-tumble
(different simulated chaos, different frame timing) and will always land
on bit-for-bit the same face everywhere — exactly the accepted model,
achieved because the reconciliation technique never asks the physics
simulation to agree with anything except its own client's copy of the one
already-shared authoritative number.

## 11. Explicit non-goals / deferred

- **Dice-vs-dice collision within a roll** is a natural, essentially free
  side effect of §7's "one shared world per roll" design (multiple dice
  in the same world will collide with each other unless explicitly
  filtered out), but is not load-bearing to this design and isn't
  required for v1 — recommend leaving it on since it costs nothing extra
  architecturally, but it's not something the follow-up needs to get
  right for this spike's recommendations to hold.
- **A custom tray model's own real collision geometry** (the
  `modelUrl`/`CustomTrayModel` GLB path) is out of scope — recommend the
  physics tray floor/walls stay a simple analytic collider (a flat disc
  or low cylinder matching `trayRadiusForScale`) regardless of whether a
  member has picked a custom-uploaded tray model, exactly mirroring §8's
  "don't collide against the pretty mesh" reasoning one level up. A
  custom tray's visual model is not a claim about its physical shape.
- **Rewriting `rules-engine/dice.ts`'s d100 handling** is explicitly not
  needed and not recommended (§5) — the single-integer `rollDie(100)`
  result is already correct; only the app-layer rendering of it changes.
- **Feather Fall/anti-gravity-style effects on a physical throw** (an
  in-fiction reason a die's toss should look different) are not
  considered — out of scope, no such mechanic exists in this app today.

## 12. Recommended follow-up implementation scope

Two follow-up prompts, sequenced — numbering/pips has zero dependency on
physics (per §4/§8, it never touches `useDiceTumble`/`diceAnimator.ts` at
all), so it can ship first and independently, giving the physics prompt a
smaller, more isolated diff to review on its own:

**Prompt A — Printed numbers/pips, including d100.** `DEFAULT_FACE_LABELS`
in `diceGeometry.ts` (§4); `FACE_PLANE_DISTANCE` per kind and the new
decal-quad sibling component in `DiceTumble.tsx`'s `DieMesh` (§4);
`ResultBadge`'s `value: number` → `label: string` prop change (§5); the
percentile decomposition in `tumble.ts` plus `DiceTumbleDieSpec`'s new
optional `labelSet` field (§5). Unit tests at the same rigor
`diceGeometry.test.ts` already applies: every decal's computed world
position lies exactly on its face's plane, oriented along the correct
normal; the percentile decomposition's boundary cases (`r=1`, `r=10`,
`r=57`, `r=90`, `r=100`) produce the exact expected tens/ones labels.

**Prompt B — Physics, depends on nothing from Prompt A.** Add
`@dimforge/rapier3d-compat` (§6) as a `scene-3d`-only dependency (no
`@react-three/rapier`, per §6's reasoning); a new physics-backed
`DiceAnimator` implementation in `diceAnimator.ts` per §7's per-roll-world/
once-per-frame-step/explicit-disposal design, swapped in as
`DEFAULT_DICE_ANIMATOR` (or left as an opt-in alternate export gated by
the new `MAX_PHYSICS_DICE_PER_ROLL` cap from §9, falling back to
`scriptedDiceAnimator` above it); the collider construction from §8
(`ColliderDesc.convexHull`/`cuboid` off `buildDieGeometry`'s own
vertices); and the new `scripts/perf/dice-physics-benchmark.mjs` from §9,
run and used to tune (or confirm) `MAX_PHYSICS_DICE_PER_ROLL` before
trusting the uncapped-below-the-cap case. Tests at `diceAnimator.test.ts`'s
existing rigor, generalized for a stateful implementation: purity is no
longer assertable the same way (`step` now depends on prior calls), so
recommend instead asserting the *settled* pose still lands on
`faceNormalForResult`'s exact target (the one invariant that must never
regress), plus a dedicated test that two dice sharing a roll only advance
their shared world once per `elapsedSeconds` tick.

## Open questions / explicit tradeoffs for the implementer

- **Numerals-vs-pips on the d6 is a low-stakes bikeshed**, exactly like
  the toolbar redesign spike's mode-naming call — this document's
  concrete recommendation is numerals-everywhere for implementation
  simplicity and legibility at this app's render scale, but a
  traditional pip layout on the d6 specifically is a reasonable,
  common-precedent substitution that changes nothing else in this design.
- **`MIN_PHYSICS_SECONDS`/`MAX_PHYSICS_SECONDS` and the settle-velocity
  threshold (§7) need to be felt in a real browser before being
  trusted** — the documented fallback (a bare fixed timer, matching
  today's `TUMBLE_SECONDS` shape exactly) should be used if the
  velocity-based trigger feels fiddly to tune, not treated as mandatory.
- **`MAX_PHYSICS_DICE_PER_ROLL`'s exact value (§9) is a starting
  recommendation (~20-24), not a measured number** — the new perf script
  this document recommends should be the actual source of truth for the
  shipped value, and may lower it once real numbers exist.
- **Whether dice-vs-dice collision within a roll should be enabled by
  default (§11)** is genuinely optional — it's free to leave on given
  the per-roll shared-world design, but nothing in this document depends
  on it being on, so it's fine to disable it (a per-body collision
  filter/group) if it ever looks visually chaotic for a large simultaneous
  roll.
- **A custom-uploaded tray model's true footprint vs. the analytic
  physics floor (§11)** could, in principle, mismatch (an oddly-shaped
  custom tray whose visual rim sits somewhere the physics floor doesn't)
  — not considered a real risk given trays are a shallow, mostly-flat
  surface by construction, but flagged rather than silently assumed.
