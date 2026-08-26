# BeyondDNDBeyond — Dice Numbers & Physics Prompt Plan

Generated 2026-08-26. Builds on the existing per-member personal dice tray system already shipped (`src/scene-3d/DiceTumble.tsx`, `diceAnimator.ts`, `diceGeometry.ts`).

## Context established during planning (read before starting any prompt below)

Direct research findings, confirmed by reading the real code, not assumed:

- **There is no physics simulation today.** `scriptedDiceAnimator` (`diceAnimator.ts`) computes every die's position/rotation as pure keyframed math (ease-out arcs, sine bounce, quaternion slerp) from elapsed time and a string-hash seed — no mass, no collision, no rigid-body integration. The file's own comments state this is deliberate scaffolding for a future physics upgrade, and a clean seam already exists for it: every caller depends only on the `DiceAnimator` interface (`step(spec, elapsedSeconds) → DicePose`), so a physics-backed implementation can be swapped in without touching call sites.
- **The dice have zero printed numbers or pips today.** All six die shapes (`diceGeometry.ts`) are plain three.js primitive geometries in one flat solid color, no texture atlas, no decals. The number a player actually sees is a separate 2D canvas-texture badge that floats above the die, always facing the camera (`DiceTumble.tsx`) — not printed on the die itself.
- **The orientation-to-result mapping is already correct.** `faceNormalForResult(kind, result)` deterministically maps the real rolled result to a specific real face normal, and the scripted animator rotates the die so that exact face ends up pointing up. This means once numbers/pips are actually added to the geometry, they will already be correctly oriented for free — this is NOT a "fix the correspondence" problem, it's a "there's nothing to look at yet" problem.
- **6 die types exist**: d4, d6, d8, d10, d12, d20, each with its own hardcoded face-normal table (a per-die-type concern, solved once per type). **There is no real d100 geometry** — percentile rolls are likely handled via a d10 pair or a placeholder fallback; this needs to be confirmed and explicitly scoped by Prompt 1.
- **Decision (project owner, confirmed during planning): both numbers and real physics, together, not sequenced as "ship numbers now, physics later."**
- **Decision (recommended by planning, not yet challenged): physics does not need to be frame-identical across clients.** Each connected client may independently simulate its own physics for a roll it's watching, as long as every client's simulation is constrained to land on the same authoritative result. This matches the existing scripted system's own "immediate local play, no network round trip for your own roll" architecture, and avoids a much larger streaming-keyframes-across-clients undertaking that nothing about this feature actually requires (only the final number matters for gameplay).

## Sequencing

1 → 2 → 3, sequenced (not parallel) — Prompts 2 and 3 both touch the dice rendering/animation files and depend on decisions Prompt 1 makes.

---

## Prompt 1 — Research spike: physics library choice, result-reconciliation design, and pip/numbering approach

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: dice numbers + physics — design spike

## Context
This is a design/research spike, not an implementation prompt — the deliverable is a
design document, matching this project's own established precedent for exactly this
kind of work (docs/design/pits-and-falling.md and docs/design/map-editor-toolbar-redesign.md
were both written this way: full research first, concrete recommendations with real
reasoning, explicit tradeoffs, no implementation code).

Read src/scene-3d/diceGeometry.ts, DiceTumble.tsx, diceAnimator.ts, and useDiceTumble.ts
(or wherever the tumble hook actually lives if the name has changed) in full, fresh —
do not assume any prior description of these files is still accurate. Also read the
server-side roll resolution path (src/app/campaigns/[id]/roll/route.ts and wherever the
real dice-notation math lives in src/rules-engine/) to confirm exactly how a roll's true
numeric result is computed and how it currently reaches the animation layer.

Confirmed by prior research, treat as ground truth unless your own reading contradicts it:
today's dice animation (scriptedDiceAnimator) is pure keyframed math with no physics at
all, explicitly built as scaffolding for a future physics upgrade via the DiceAnimator
interface seam; the dice render as solid-color polyhedra with zero printed numbers,
the visible result comes from a separate floating 2D badge; the animator already rotates
the geometrically-correct face to point up for the real result, so numbering placement
is not a correspondence problem, just a rendering-what-doesn't-exist-yet problem; there
is no real d100 geometry today.

## Task
Design both halves of this feature:

**Numbering/pips.** Decide how each of the 6 (or 7, if you determine d100 needs its own
treatment) die types gets legible printed numbers or pips on every face — a texture
atlas mapped per face, procedural numeral geometry, or another approach — and justify
the choice (texture is simpler and matches how the existing result badge already renders
text via canvas; real embossed/engraved geometry is more premium-looking but adds
real complexity and a performance/collision-mesh consideration, see below). Confirm
explicitly what happens for a d100 roll — is there a real percentile die pair (a d10
for tens, a d10 for ones) that needs its own two-die numbering (00/10/20...90 and
0-9), or some other resolution — do not leave this unscoped.

**Physics.** Check package.json and confirm no physics library is currently installed.
Evaluate real options for a react-three-fiber-compatible rigid-body physics engine
(check bundle size, WASM vs pure-JS, active maintenance, and ease of reading a settled
body's final transform back out) and recommend one, with reasoning. Design the exact
technique for reconciling a genuine physics simulation with the fact that the true
roll result is already computed server-side and authoritative before the animation
ever starts — the physics animation is not free to decide the outcome. Two concrete
approaches to evaluate and choose between (or propose a better one, with reasoning):
(a) bias the initial throw's velocity/angular momentum, seeded so it lands correctly
the vast majority of the time, with a corrective snap/nudge applied only if the
natural simulation is about to settle on the wrong face; (b) run genuine, unconstrained
physics for most of the tumble for visual flourish, then blend smoothly into a
guaranteed-correct scripted settle for the final short window, similar in spirit to how
the existing scripted system's own ease-out settle phase already works. State clearly
which you recommend and why.

Also design: whether multiple simultaneous dice (a single multi-die roll, or multiple
players rolling at once across separate personal trays, both already-existing real
scenarios in this app) pose a real performance concern for your chosen physics
approach — this project tracks a perf-budgets.json at its root; check it and reason
about whether a realistic worst case (several trays, each with several dice, all
physics-simulating at once) stays within a reasonable frame-budget, or flag it as a
real risk needing a cap (e.g., a maximum simultaneous physics-simulated die count,
falling back to the existing scripted animator beyond that) if you can't confirm it's fine.

Confirm whether the visual mesh (with printed numbers/pips, however you chose to add
them) should differ from the physics collision shape — a detailed visual mesh is
usually the wrong thing to also use as a collider; recommend using the existing plain
procedural polyhedra as the collision proxy regardless of what the visual layer becomes.

Cross-client consistency: the project owner has accepted (during planning, not to be
re-litigated here) that different connected clients may independently simulate their
own physics for the same roll and see slightly different visual tumbles, as long as
every client's simulation is constrained to land on the identical authoritative
result. Confirm your recommended reconciliation technique (above) actually supports
this per-client-independent-simulation model without needing any new network protocol
beyond what already exists (the roll result and any dice-notation metadata already
reach every client via the existing roll-log/broadcast system).

## Acceptance Criteria
- A written design document (docs/design/dice-numbers-and-physics.md, following the
  exact structure of docs/design/pits-and-falling.md: concrete recommendations with
  reasoning, explicit tradeoffs, open questions clearly flagged) covering: the chosen
  numbering/pip approach per die type including d100; the chosen physics library with
  real justification; the chosen result-reconciliation technique with real justification
  between the two evaluated options (or a better one you found); the collision-mesh
  vs visual-mesh decision; and a real performance assessment against this project's
  own perf-budgets.json for the realistic multi-die/multi-tray worst case.
- No implementation code shipped by this prompt — this is design only, exactly like
  the two precedent documents cited above.
- yarn lint / yarn tsc --noEmit / yarn test still pass (should be a no-op, confirm
  nothing broke).

## Dependencies
None.

## Notes
This spike's decisions directly determine the scope of Prompts 2 and 3 below — be
concrete and decisive, not a menu of options with no recommendation, matching this
project's own established design-spike discipline.
```

---

## Prompt 2 — Add printed numbers/pips to all die types

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: dice numbers + physics — numbering implementation

## Context
Read docs/design/dice-numbers-and-physics.md (written by the preceding research spike)
in full — it is your spec for the numbering/pip approach. Read the CURRENT state of
src/scene-3d/diceGeometry.ts and DiceTumble.tsx fresh before making any change; master
may have moved since the spike was written.

## Task
Implement the numbering/pip approach the spike designed, for every die type it scoped
(d4/d6/d8/d10/d12/d20, plus whatever it decided for d100). Confirm after implementing
that faceNormalForResult's existing face-to-result mapping still correctly determines
which numbered/pipped face ends up pointing up when a die settles — this should
require zero changes to that mapping logic if the spike's approach was purely additive
(adding numbers to existing faces, not restructuring which face is which), but verify
this directly rather than assuming.

## Acceptance Criteria
- Every die type shows a legible printed number (or correct pip count/arrangement,
  if that's the chosen approach for d6 specifically, matching real physical dice
  convention) on each of its faces.
- Rolling any die type and letting it settle shows the CORRECT number both on the
  die's own face (newly added) and on the existing floating result badge — the two
  must always agree, verified via a real roll test across every die type.
- No regression to the existing result-badge display or to any other visual aspect
  of dice rendering (color, size, tray positioning).
- Real screenshots of each die type showing its numbers/pips clearly.
- yarn lint / yarn tsc --noEmit / yarn test all clean.

## Dependencies
Prompt 1 (the design spike this implements).

## Notes
This can ship value independently of Prompt 3's physics work — a die with correct
numbers, still using today's scripted tumble, is already a real improvement. Don't
block this prompt's own completion/verification on Prompt 3 being done.
```

---

## Prompt 3 — Real physics-based dice rolling

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: dice numbers + physics — physics implementation

## Context
Read docs/design/dice-numbers-and-physics.md in full — it is your spec for the physics
library choice, the result-reconciliation technique, the collision-mesh decision, and
the performance assessment. Read the CURRENT state of diceAnimator.ts, DiceTumble.tsx,
useDiceTumble.ts, and diceGeometry.ts fresh, including whatever Prompt 2 already
shipped for numbering — do not assume any prior description of these files, including
this plan's own Prompt 2 description, is still accurate; read the real current code.

## Task
Implement a new physics-backed DiceAnimator (matching the existing interface exactly,
per the deliberate seam already built into that interface) using the library and
reconciliation technique the spike chose. Every die's collision shape should be the
plain procedural polyhedron (not the numbered/pipped visual mesh, per the spike's
collision-mesh decision) unless the spike explicitly decided otherwise. Wire this new
animator in as a replacement for scriptedDiceAnimator everywhere dice are rolled,
respecting whatever performance safeguard the spike specified (e.g., a simultaneous
physics-die cap with a scripted-animator fallback beyond it) if one was required.

## Acceptance Criteria
- A rolled die now visibly tumbles via real physics (real collision with the tray
  surface/walls, real settling behavior) rather than a scripted keyframed path.
- The number the die visibly settles on always matches the authoritative rolled
  result — verified via many repeated real rolls across every die type, checking for
  zero mismatches (this is the single most important correctness property of this
  entire feature: the physics animation must never appear to show the wrong number).
- Multiple simultaneous dice (a multi-die roll, and multiple players' personal trays
  rolling at once) perform acceptably per the spike's own performance assessment —
  verify this directly with a real multi-tray, multi-die concurrent test, not just a
  single-die happy path.
- No regression to the existing personal-tray system (correct tray-per-member
  attribution, private vs public roll visibility, the roll log).
- Real screenshots/recording evidence of a physics-based tumble settling correctly.
- yarn lint / yarn tsc --noEmit / yarn test all clean.

## Dependencies
Prompt 1 (the design spike). Not dependent on Prompt 2's completion for its own
correctness, but should be verified together with Prompt 2's numbering once both are
merged, since a physics tumble with unnumbered dice or numbered dice with the old
scripted tumble are both incomplete states of the same overall feature.

## Notes
The correctness property in the acceptance criteria above — the visible face must
always match the authoritative result — is non-negotiable. If your chosen
reconciliation technique cannot be made reliable in testing, escalate this as a real
finding rather than shipping something that occasionally shows the wrong number; a
wrong-looking roll in a game about probability and consequence is a serious
correctness bug, not a cosmetic one.
```
