# Design spike: pits and the fall-damage/fall-check mechanic

Status: design only — no feature code shipped by this document. This
codebase has no fall-damage or fall-check mechanic anywhere today; every
recommendation below is a new mechanic modeled directly against the SRD,
not an extension of something that already exists. Written to be built by
the follow-up prompt(s) scoped in §11.

## 1. Problem recap

The project owner wants **pits**: a paintable terrain feature with a depth,
where a character can fall down it, optionally linked to another map
(falling through transports you there). Three existing pieces this has to
fit into, none of which currently know anything about falling:

1. **`src/rules-engine/movement.ts`** — `TerrainType` (`"normal" |
   "difficult" | "void"`), `FEET_PER_ELEVATION_STEP` (5 ft/step), and the
   climb-cost model (`cellMovementCost`, `pathMovementCost`,
   `computeReachableCells`).
2. **`map_transitions`** (`supabase/migrations/0025_map_transitions.sql`) —
   a DM-authored, DM-confirmed link from one map's cell to another map's
   entry cell.
3. **The real SRD falling rule** (PHB/SRD 5.1, "Falling"): *"At the end of
   a fall, a creature takes 1d6 bludgeoning damage for each 10 feet it
   fell, to a maximum of 20d6. The creature lands prone, unless it avoids
   taking damage from the fall."*

## 2. What was read

`src/rules-engine/movement.ts` and its `movement.test.ts` /
`src/rules-engine/README.md` history; `src/rules-engine/dice.ts` (`rollDie`,
`rollDice(count, sides, random)`, `rollExpression`, `rollD20`,
`resolveDeathSave`, `resolveAttackOutcome` — the exact pattern a new pure
resolver should follow); `src/rules-engine/checks.ts`
(`savingThrowBonus(ability, abilityScores, level, proficient)`);
`src/rules-engine/srd/conditions.ts` (the existing `"prone"` condition key);
`supabase/migrations/0025_map_transitions.sql`,
`src/data-access/mapTransitions.ts`, and the runtime consumer in
`src/app/campaigns/[id]/room/GameRoom.tsx` (`maybeOfferTransition`,
`handleConfirmTransition`); `supabase/migrations/0014_maps.sql` (`map_cells`
schema) and `0039_void_terrain.sql` (the precedent for widening
`terrain_type`'s vocabulary without a new column); `0015_maps_rls.sql`
(`map_cells` RLS — readable by any campaign member viewing the map, **not**
DM-only, unlike `map_transitions`); `0028_hp_tracking.sql` /
`src/data-access/characters.ts` (`applyHpDelta` → `apply_hp_delta` RPC, and
0031's death-save-at-0 handling folded into it); `0030_dice_rolls.sql`
(`roll_log.kind` enum); and
`src/app/campaigns/[id]/maps/[mapId]/edit/lib/cellGrid.ts` (`MAX_ELEVATION`,
`applyTool`'s raise/lower clamp at 0, and its own comment: *"negative
elevation would render as a hole through the ground plane"*).

That last comment is the single most load-bearing fact in this spike: the
project's own elevation model already anticipated pits as negative
elevation. The design below builds on that rather than inventing a
parallel "depth" concept.

## 3. Representation: how depth maps onto the existing data model

**No new "depth" field.** A pit is `map_cells.terrain_type = 'pit'` (a
fourth value alongside `normal`/`difficult`/`void`, added the same way
`0039_void_terrain.sql` added `void` — widen the `map_cells_terrain_type_check`
constraint, no new column). The pit cell's **own `elevation` column stores
the absolute elevation of the pit's floor**, in the same step units
(`FEET_PER_ELEVATION_STEP = 5`) every other cell already uses — negative
values now permitted specifically for this terrain type (see §8 for the
editor-side clamp change this requires).

**Depth is derived, not stored**, at the moment a move resolves — reusing
exactly the delta arithmetic `pathMovementCost` already does per cell:

```
fallDepthFeet = max(0, (moverElevationSteps - pitCellElevationSteps)) * FEET_PER_ELEVATION_STEP
```

where `moverElevationSteps` is the elevation of the cell the token stood on
*immediately before* the move that entered the pit cell (already available
— it's the same `previousElevation` `pathMovementCost` threads through
today). This is deliberate, not a simplification of convenience: a pit dug
into a raised plateau is deeper relative to the plateau's rim than to
global elevation 0, and this formula gets that right for free, with zero
new stored state. A pit's *published* elevation (its floor) only has one
fixed meaning; how far any given creature falls into it depends on where
that creature was standing, exactly as in reality.

**Edge case — no antecedent position.** If a token is *placed* directly
onto a pit cell (initial placement, or landing there as a map-transition's
entry cell — see §6) rather than *moved* there, there is no "previous
elevation" to diff against. Recommendation: skip the fall check entirely in
that case. Placement is an authorial act (the DM/player choosing where a
token starts), not a physics event, matching this app's existing stance
that placement is never gated by movement rules.

**SRD formula translation** (the actual arithmetic, in a new pure
function — see §8):

```
fallDamageDiceCount(depthFeet) = min(floor(depthFeet / 10), 20)
```

Zero dice (zero damage) below 10 ft, one d6 per full 10 ft, capped at 20d6
at 200 ft (40 elevation steps) — exactly the SRD text, no house rule.

## 4. Depth threshold: hazard vs. cosmetic dip

**Recommendation: 2 elevation steps (10 ft) is the line.** Below it, don't
use `terrain_type = 'pit'` at all — author it as existing, fully-supported
`difficult` terrain with lowered `elevation` (a shin-deep uneven dip a
character just walks through, already free/costed today with zero new
code). At or above 10 ft, it's `'pit'` and a genuine fall hazard.

This isn't arbitrary — it falls directly out of the SRD formula itself, not
a threshold layered on top of it: `fallDamageDiceCount` returns `0` for any
depth under 10 ft, and the SRD's own prone clause reads *"unless it avoids
taking damage from the fall"* — a fall that deals literally zero damage has
trivially "avoided taking damage," so under a strict reading it doesn't
even impose prone. A sub-10-ft "fall" is a mechanical no-op under the raw
formula; there is nothing left for a `'pit'` cell to do differently from
ordinary difficult terrain at that depth, so the threshold just names where
the SRD's own math stops mattering.

This is self-enforcing at resolution time regardless of how a cell was
authored: `resolveFall`/`fallDamageDiceCount` (§8) returns zero dice and
`prone: false` for any depth under 10 ft even if a DM paints a shallow
`'pit'` cell anyway — belt-and-suspenders, never a broken state, but the
editor should still steer authors toward `difficult` terrain below the
threshold (a soft client-side warning on the pit brush, not a DB
constraint — the "local rim" a depth reads against depends on neighboring
cells, which a single-row CHECK can't see).

## 5. Automatic vs. check: visible vs. concealed pits

**Visible pit: automatic, no roll.** The SRD does not ask for a save to
walk into a hole you can see — choosing to enter it (or being dragged in by
the player/DM controlling the token) is itself the "check." This also
matches this app's own precedent: no other terrain feature gates entry
behind a roll (difficult terrain costs more movement, void rejects entry
outright, but neither rolls dice).

**Concealed pit: exactly one flat DC 15 Dexterity saving throw**, using
primitives that already exist (`rollD20("normal", random)` +
`savingThrowBonus("dex", abilityScores, level, proficient)` — no new dice
mechanism). This is the one new "check" the brief asks for, kept
deliberately narrow:

- `CONCEALED_PIT_SAVE_DC = 15` is a single named constant in the new
  `falling.ts` module (§8) — not DM-configurable in v1, with a per-trap
  override column left available at the data layer (see below) so a later
  prompt can expose DM configuration without a redesign.
- **Success:** the creature catches itself at the edge — its move stops at
  the last safe cell (it never enters the pit cell), no damage, no prone.
  The trap is **not** auto-revealed on a mere catch — the DM may narrate
  discovery, but mechanically the pit stays concealed and can catch the
  next unlucky mover too. (Recommendation, stated for the follow-up: don't
  auto-reveal on success. It's the simpler rule and matches common
  trap-table play — a near-miss doesn't necessarily mean you spotted it.)
- **Failure:** falls exactly like a visible pit (§3/§8's full damage +
  prone sequence) — and *this* is the point at which the pit becomes
  visible to everyone (there's now a person at the bottom of it). The
  reveal is a real write, not a rendering flag (see next paragraph).

**Why concealment can't be a plain column on `map_cells`.** `map_cells` is
member-readable by RLS (`0015_maps_rls.sql`), unlike `map_transitions`
which is DM-only precisely so players can never read a DM's secret link.
If a concealed pit's true `terrain_type = 'pit'` sat in the same
player-readable row, any player inspecting network traffic would see the
trap before triggering it — the exact problem `map_transitions`' RLS design
already solved once for a different secret. So: **a concealed pit's public
`map_cells` row looks like ordinary floor** (`normal` or `difficult`,
whatever the DM paints it as) for as long as it's concealed, and its true
nature lives in a new DM-only table mirroring `map_transitions`' shape and
RLS exactly:

```sql
create table public.concealed_pits (
  map_id uuid not null references public.campaign_maps (id) on delete cascade,
  x integer not null,
  y integer not null,
  bottom_elevation_steps integer not null,
  save_dc integer not null default 15,
  primary key (map_id, x, y)
);
-- RLS: DM-read/write only via can_write_map(map_id), verbatim from
-- map_transitions — a player's client never learns this table exists.
```

The DM authors a concealed pit by painting the cell as normal-looking
terrain, then separately recording the trap here (its real floor elevation,
since the public cell's elevation is the fake floor's, not the real
bottom's). On failure, the reveal write is: `map_cells.terrain_type =
'pit'`, `map_cells.elevation = bottom_elevation_steps`, delete the
`concealed_pits` row — after which it's mechanically and visually identical
to an ordinarily-painted visible pit. This mirrors `maybeOfferTransition`'s
existing shape closely: a DM-only table, read only by the DM's client, that
the DM's own move-handling code checks after a token lands on a cell.

## 6. The optional map-link

**Recommendation: reuse `map_transitions` completely unmodified — no
schema change, no parallel mechanism.** A pit that should drop a character
through to another map is simply a cell that is *both* `terrain_type =
'pit'` on its own map *and* the `from_map_id`/`from_x`/`from_y` of a
`map_transitions` row, authored with the existing transition tool. Nothing
about `maybeOfferTransition`'s trigger condition
(`candidate.from_map_id === token.map_id && from_x/from_y match`) cares
*how* a token arrived at that cell — it already fires identically whether
the move was a deliberate walk or a forced fall, so this composes for
free.

**Sequencing (the one real integration point):** fall damage and prone
must resolve on the **source map**, before the existing transition
offer/confirm UI appears — the character falls, hits the ground hard,
*then* (if a link exists) the DM is offered the option to send them
through. Concretely, this slots into the two existing "a token just landed
on `(x, y)`" call sites in `GameRoom.tsx` (around the `elevation =
cellElevation(current.cells, x, y)` lookups feeding `moveMapToken`/
`moveCombatToken`, immediately before `maybeOfferTransition(token)` is
called): if the destination cell's `terrain_type === 'pit'` (post any
concealed-pit reveal from §5) and the computed depth clears the §4
threshold, resolve the fall (damage + prone) first, *then* proceed to the
existing `maybeOfferTransition` call exactly as today.

**The DM-confirm gate is a feature here, not friction to route around.**
`map_transitions`' existing `wholeParty: boolean` choice in
`handleConfirmTransition` is *more* apt for a pit than for a staircase: a
staircase is usually a deliberate whole-party choice, but a pit is usually
one unlucky character stepping in while the rest of the party watches from
solid ground. The existing single-token-vs-whole-party toggle already
gives the DM exactly this choice with no new UI.

**No link (the common case): nothing new is needed at all.** Per the
existing `elevation = cellElevation(current.cells, x, y)` lookup that
already runs on every committed move (`GameRoom.tsx`), a token that walks
into a pit cell **already** has its stored elevation snapped to that cell's
(now negative-permitted) elevation by existing code, with zero changes.
"Take fall damage, land prone, end up standing at the bottom of the pit
cell, same map, lower elevation" is *already* the mechanical default of
today's move-token code path once `'pit'` terrain with negative elevation
is authorable — the only genuinely new work is the damage/prone side
effect itself (§8), never the positioning.

## 7. Why `movement.ts` itself needs no changes

Deliberately confirmed, not assumed: `cellMovementCost` already treats any
non-positive `elevationDeltaFeet` as free ("descending or level adds no
climbing cost"). That is, in fact, exactly the SRD rule for falling —
falling doesn't cost movement, you just fall. So `cellMovementCost`,
`pathMovementCost`, and `computeReachableCells` need **zero changes** for
pits to be enterable, reachable, and free to descend into exactly like any
other downward step. The only new logic is the *consequence* of landing on
a `'pit'`-tagged cell, which is a status-effect side effect resolved
alongside the move commit, not a movement-cost concern — so it belongs in
a new module, not a change to this one (see §8).

**One movement-adjacent rule this design does add, for the follow-up to
implement explicitly:** entering a pit cell **ends the move there** — any
further budgeted movement in a dragged multi-cell path is discarded once a
pit cell is entered, the same way a void cell is already a hard stop for
pathing (just passable rather than impassable). You fell in; you're not
still walking this turn.

## 8. Concrete module/schema plan

**New `TerrainType` value:** `"normal" | "difficult" | "void" | "pit"` in
`movement.ts`, plus a migration widening `map_cells`'s
`map_cells_terrain_type_check` the same way `0039_void_terrain.sql` did
(drop/re-add the named constraint; `map_seen_cells.terrain_type` needs no
change, same reasoning 0039 gave — it carries no CHECK).

**Editor clamp change (`cellGrid.ts`):** `applyTool`'s `"lower"` branch
currently floors at 0 (`if (current.elevation <= 0) return current`). This
needs a pit-specific path: a `"pit"` sculpt tool that permits negative
elevation down to a new `MIN_PIT_ELEVATION_STEPS = -40` (200 ft / 20d6,
`FEET_PER_ELEVATION_STEP`-consistent with `MAX_ELEVATION`'s existing
10-step/50 ft climbing cap) — chosen at exactly the SRD's own damage cap,
since depth beyond it changes nothing mechanically. The existing
`"raise"`/`"lower"` tools for ordinary plateaus are untouched.

**New pure module `src/rules-engine/falling.ts`**, in this codebase's
established one-mechanic-per-file shape (`dice.ts`, `conditions.ts`,
`opportunityAttacks.ts`, `perception.ts`):

```ts
export const FEET_PER_FALL_DAMAGE_DIE = 10;
export const MAX_FALL_DAMAGE_DICE = 20;
export const MIN_HAZARD_DEPTH_STEPS = 2; // 10 ft — see §4
export const CONCEALED_PIT_SAVE_DC = 15; // see §5

export function fallDamageDiceCount(depthFeet: number): number {
  if (depthFeet <= 0) return 0;
  return Math.min(Math.floor(depthFeet / FEET_PER_FALL_DAMAGE_DIE), MAX_FALL_DAMAGE_DICE);
}

export interface FallOutcome {
  diceCount: number;
  rolls: number[];
  damage: number;
  prone: boolean;
}

// Reuses dice.ts's rollDice — no new dice mechanism.
export function resolveFall(depthFeet: number, random: RandomSource = Math.random): FallOutcome {
  const diceCount = fallDamageDiceCount(depthFeet);
  if (diceCount === 0) return { diceCount: 0, rolls: [], damage: 0, prone: false };
  const rolls = rollDice(diceCount, 6, random);
  return { diceCount, rolls, damage: rolls.reduce((a, b) => a + b, 0), prone: true };
}

export function fallDepthFeet(fromElevationSteps: number, pitElevationSteps: number): number {
  return Math.max(0, fromElevationSteps - pitElevationSteps) * FEET_PER_ELEVATION_STEP;
}
```

Unit-test at the same boundaries this codebase always tests at (the
`resolveDeathSave`/`resolveAttackOutcome` rigor): 9 ft → 0 dice, 10 ft → 1
die, 19 ft → 1 die, 20 ft → 2 dice, 199 ft → 19 dice, 200 ft and 250 ft both
→ 20 dice (cap), 0/negative depth → 0 dice and `prone: false`, and a fixed
`RandomSource` sequence producing an exact, asserted `rolls`/`damage`.

**Damage application: reuse `apply_hp_delta` / `applyHpDelta`, no new
RPC.** It already clamps `[0, max_hp]` and already folds in the
death-save-at-0 state machine (0031) for any non-attack HP delta — exactly
what fall damage is (no attacker, no crit). Call
`applyHpDelta(supabase, characterId, -damage)` with `resolveFall`'s
computed `damage`.

**Prone: reuse the existing `"prone"` condition key**, applied through
whatever `data-access/conditions.ts` write path already applies
DM/rule-triggered conditions — no new condition, no new column.

**Logging:** log the damage roll via `roll_log` with `kind: 'freeform'`
(the existing catch-all for a dice roll not tied to attack/save/check/
skill/initiative — no schema change) and, when a concealed-pit save
occurs, log that separately with `kind: 'save'` through the existing save
roll path.

## 9. Rendering

**Visible pit:** `MapSurface.tsx` needs a new, distinct visual treatment —
a hole with visible walls down to the floor at its (now possibly negative)
elevation — separate from a `void` cell, which renders as *absent* (no
floor at all, nothing to stand on). A pit has a floor; you can stand on it
once you're down there. This is real new rendering work for the follow-up,
not just data plumbing, and is a natural place to also render the fall
itself (a short animation/transition of the token dropping to the new
elevation) if the follow-up prompt wants that polish — not required for
correctness.

**Concealed pit:** no special-case rendering is needed for the concealed
state itself, by construction — per §5, its public `map_cells` row *is*
ordinary-looking terrain until the reveal write happens, so every client
(player and DM alike) simply renders it as whatever `terrain_type` it
publicly holds. Once revealed, it renders exactly like any other visible
pit. This is a case where getting the schema/RLS boundary right (§5) makes
the rendering trivial rather than adding a second, DM-only-visible
rendering mode to maintain.

## 10. Explicit non-goals / deferred

- **Feather Fall, slow fall class features, or any "avoid the damage"
  effect.** Out of scope for this spike. `resolveFall`'s shape (a pure
  function of `depthFeet`) leaves an obvious extension point (an
  `avoidsDamage: boolean` parameter short-circuiting to `{diceCount: 0,
  rolls: [], damage: 0, prone: false}`) for whenever that's built, but
  nothing here builds it.
- **Being shoved/knocked off a ledge by an effect**, rather than a
  player/DM-initiated move onto a pit cell. This design only covers
  ordinary token movement landing on a `'pit'` cell; a forced-movement
  effect (a spell, a shove) triggering the same check is a natural future
  extension of the same mechanism, not a different one, but isn't scoped
  here.
- **DM-configurable per-trap DC beyond the `save_dc` column already
  proposed** on `concealed_pits` — the column exists in §5's schema so a
  later prompt can wire a UI to it, but v1 always uses the `15` default and
  ships no editor field for it.
- **Chained falls** (a pit whose linked destination map's entry cell is
  itself a pit). Not disallowed by anything above, but not specifically
  designed for either — it would just re-run the same sequence on arrival,
  which is a reasonable emergent behavior, not something requiring new
  design.

## 11. Recommended follow-up implementation scope

A single follow-up prompt is the right size — this is not the
two-way-split the model-orientation spike needed, since there's no
sourcing/tooling investigation left to do here, only build-out against a
fully concrete plan:

- Migration: widen `map_cells_terrain_type_check` to add `'pit'`
  (mirroring `0039_void_terrain.sql`); add the `concealed_pits` table with
  `map_transitions`-shaped RLS (§5).
- `movement.ts`: widen `TerrainType` to include `"pit"`. No changes to
  `cellMovementCost`/`pathMovementCost`/`computeReachableCells` (§7).
- New `src/rules-engine/falling.ts` per §8, unit-tested at the boundaries
  listed there.
- `cellGrid.ts`: a `"pit"` sculpt tool permitting negative elevation down
  to `MIN_PIT_ELEVATION_STEPS = -40`, separate from the existing
  `"raise"`/`"lower"` tools' floor-at-0 clamp.
- `GameRoom.tsx`: at each existing token-move commit point (where
  `elevation = cellElevation(...)` is already looked up), check the
  destination cell's `terrain_type`; if `'pit'` and depth (§3's formula)
  clears the §4 threshold, resolve `resolveFall`, apply damage via
  `applyHpDelta`, apply the `"prone"` condition, log the roll, truncate any
  remaining drag path (§7) — all *before* the existing
  `maybeOfferTransition` call. Also wire the `concealed_pits` check (§5)
  ahead of that: if a matching concealed-pit row exists, roll the DC 15 DEX
  save first and branch to either "stop at the edge, no reveal" or "reveal
  the cell (write `terrain_type='pit'`/real `elevation`, delete the
  `concealed_pits` row) and fall through to the same fall-resolution path."
- `MapSurface.tsx`: new visual treatment for `'pit'` terrain (§9) — a floor
  visible at its own elevation, distinct from `void`'s absence.
- A `"pit"` authoring affordance in `MapEditor.tsx`'s terrain toolbar
  (visible pit: paint + set depth via the new sculpt tool; concealed pit:
  paint normal-looking terrain, then a small form writing to
  `concealed_pits` with an optional DC override).
- Tests: `falling.ts` unit tests (§8); an integration/verify script in the
  `scripts/db/verify-*.mjs` style this project already uses for
  feature-level checks (e.g. `verify-void-terrain.mjs` is the closest
  existing precedent) covering the visible-pit-no-link, visible-pit-with-
  link, and concealed-pit-save/fail paths end to end.
