# rules-engine

Pure D&D 5e SRD game logic — no UI, no database dependency. Fully unit-testable in
isolation. Module boundary formalized in Prompt 2.

As of Prompt 9: the static SRD content dataset (races, classes, skills, spells, starting
equipment), ability modifiers, saving throw and skill check bonuses, passive scores, the
spell slot table (full/half/pact casters), attack bonus calculation, grid movement cost
(difficult terrain, climbing, flat 5 ft diagonal), and range/targeting queries.

As of Prompt 31: `movement.ts` gains `FEET_PER_ELEVATION_STEP` — the first place a stored
elevation step count (`map_cells.elevation`, `map_tokens.elevation`) is converted to feet,
fixed at 5 to match `FEET_PER_CELL`'s flat per-cell unit. `straightCellPath` walks the
diagonal-first grid path between two points (its length equals `gridCellDistance`), and
`pathMovementCost` sums `cellMovementCost` across that path, charging a climb once per
cell-to-cell elevation delta rather than per cell walked along a plateau. Both are pure and
DB-free like the rest of this module — callers (the `app` layer) supply the actual per-cell
terrain/elevation data, since this module can't fetch it itself.

As of Prompt 47: the status condition catalog (`srd/conditions.ts`) — `CONDITIONS`, the 14
on/off SRD conditions (blinded, charmed, deafened, frightened, grappled, incapacitated,
invisible, paralyzed, petrified, poisoned, prone, restrained, stunned, unconscious), each
with a stable `key`, display `name`, unique two-letter `abbreviation` (token badge labels),
SRD `description`, and a `ConditionEffects` flag set; `CONDITION_BY_KEY` for lookups.
Exhaustion is deliberately NOT in `CONDITIONS` — it's a stacking level 1-6 with cumulative
effects, exposed as `EXHAUSTION_KEY` (the stored condition_key), `MAX_EXHAUSTION_LEVEL`,
`EXHAUSTION_LEVEL_DESCRIPTIONS` (what each level newly adds, through death at 6), and
`exhaustionEffects(level)` returning the cumulative flags at a level (each level's flags
are a superset of the level below's).

The `ConditionEffects` flags are structured data for the later enforcement prompts, NOT
enforced anywhere yet: Prompt 53 (action economy) reads `incapacitated`/`speedZero`/
`speedHalved`, Prompt 56 (vision) reads `blocksVision`/`blocksHearing`/`hiddenFromSight`,
Prompt 59 (advantage/disadvantage) reads `attacksAgainstHaveAdvantage`/
`attacksAgainstHaveDisadvantage`/`ownAttacksHaveAdvantage`/`ownAttacksHaveDisadvantage`/
`abilityChecksHaveDisadvantage`/`savingThrowsHaveDisadvantage`/`autoFailStrDexSaves`. A
flag records that the condition imposes the effect at all; situational qualifiers in the
SRD text (frightened's line-of-sight clause, prone's within-5-feet vs ranged
attacks-against split, restrained's DEX-only save disadvantage) stay in the description
and are the enforcing prompt's job to resolve — so a new condition is a new catalog entry,
never a new storage shape. Level 4's halved HP maximum and level 6's death aren't
representable as boolean flags; consumers that care read the exhaustion level itself.
Applied-condition STATE lives in the database (`combatant_conditions`, see
`data-access/conditions.ts`) keyed by these catalog keys — the catalog is the single
source of truth for what keys are valid.

As of Prompt 48: dice (`dice.ts`) — the primitives Prompts 49 (death saves), 50
(concentration), and 59 (advantage/disadvantage) build on. Everything takes an injectable
`RandomSource` (`() => number` in [0,1), defaulting to `Math.random`) — the same
testable-seam pattern as `src/ai`'s LLM calls — because actual rolling must happen
server-side only (the roll Route Handler at `src/app/campaigns/[id]/roll/route.ts` is the
single production caller; a client claiming "I rolled a 20" is never trusted), while unit
tests inject a fixed sequence and assert exact outcomes. `parseDiceNotation` handles
"NdS"/"NdS±M" and multi-term sums ("2d6+1d4+3", subtracted terms, folded flat modifiers)
into a `DiceExpression`; `rollDie`/`rollDice`/`rollExpression` produce per-die results;
`doubleDiceExpression` doubles dice counts but not flat modifiers (the crit rule);
`rollD20(mode, random)` is THE d20 primitive — `AdvantageMode` ("normal" | "advantage" |
"disadvantage") rolls two dice and returns both plus which counted, implemented exactly
once so later d20 consumers reuse it rather than reimplementing; `resolveAttackOutcome
(naturalRoll, attackBonus, targetAc)` encodes natural-20-always-hits-and-crits,
natural-1-always-misses, meets-it-beats-it otherwise.

As of Prompt 49: `resolveDeathSave(naturalRoll)` — the SRD death saving throw, the first of
the promised d20 consumers built on Prompt 48's primitives. A death save is a plain d20
with no modifiers and (deliberately) no advantage/disadvantage — the Route Handler forces
`rollD20("normal")` for this kind, since adv/dis enforcement generally is Prompt 59's
territory. The resolution bands: natural 20 → `recovers` (regain 1 HP, the whole sequence
ends), natural 1 → TWO failures, 10 or higher → one success, 2-9 → one failure. The
returned `DeathSaveOutcome` carries *deltas* (`successesDelta`/`failuresDelta`), not
absolute counts, on purpose: accumulating the tally — capping at three, stabilizing at
three successes, dying at three failures — happens in the `apply_death_save_roll` RPC
under a row lock, which trusts these pre-computed numbers the same way
`resolve_attack_damage` trusts a pre-computed damage total rather than re-deriving
hit/crit in SQL. Unit-tested at every band boundary (1, 2, 9, 10, 19, 20, plus an
exactly-one-outcome sweep of all twenty rolls), the resolveAttackOutcome pattern.

Prompt 50 (concentration) landed as promised without adding any rules-engine surface: the
spell catalog's `concentration` flag, the conditions catalog's `effects.incapacitated`,
`rollD20`, and `savingThrowBonus` already covered everything the mechanic needs — the DC
arithmetic (`max(10, floor(damage / 2))`) lives in the damage RPCs' SQL, where the damage
number already is, not here.

As of Prompt 51: quick-action decision logic (`quickActions.ts`) plus two small additive
data-model extensions it reads. `Spell` gains an optional `attack?: { kind: "melee" |
"ranged"; damageNotation: string }`, curated in `srd/spells.ts` against the actual SRD 5.1
text (the Prompt 47 condition-catalog rigor): an entry exists ONLY where the SRD says "make
a melee/ranged spell attack" AND fixed on-hit damage dice exist — twelve spells (Chill
Touch, Eldritch Blast, Fire Bolt, Ray of Frost, Shocking Grasp; Chromatic Orb, Guiding
Bolt, Inflict Wounds, Ray of Sickness, Witch Bolt; Acid Arrow, Scorching Ray), with the
per-spell notation and every deliberate exclusion (save-based, auto-hit, no-damage-dice,
self-range, and conjured-recurring-attack spells) documented at the table. `kind` is range
flavor only — melee AND ranged spell attacks both roll with the spellcasting ability, so
the roll route's attackKind is always "spell". `spellSlots.ts` gains
`spellSlotResourceName(level)` and `SPELL_SLOT_LEVELS`, extracted from the character sheet
page's previously-local ORDINAL table so slot provisioning and slot-availability checks
share one source of truth. `computeQuickActions` itself is pure and DB-free like
`pathMovementCost` (the caller supplies positions, weapon-tagged inventory, known spell
names, and resource rows): an action is usable when `gridDistanceFeet(actor, hostile) -
speed <= range` — the character is assumed able to spend their FULL speed closing distance,
deliberately NOT a movement-budget tracker (none exists anywhere; Prompt 53's action
economy owns turn gating) — with melee/finesse defaulting to 5 ft reach, untyped ranged
weapons to a documented 60 ft stand-in (no per-weapon SRD range table is modeled yet),
`"touch"` counting as 5 ft, and `"self"` skipped defensively. Leveled spells additionally
need `current_uses > 0` on the MATCHING-level slot resource (no upcast fallback, so no
Pact Magic mapping — a documented simplification); cantrips are unlimited. Every
qualifying hostile is returned per action so the UI offers a target picker, never an
arbitrary nearest-only default. Unit-tested the resolveAttackOutcome way: in/out-of-range
boundaries at exactly speed + reach, the diagonal chessboard measure, slot-exhausted and
never-provisioned hiding, cantrips-always-available, and default-range behavior.

As of Prompt 52: `QuickAction` gains `blockedReason: string | null`, and
`computeQuickActions` no longer silently drops a leveled attack spell whose
matching-level slot is exhausted (or never provisioned) — it returns the action anyway,
with `blockedReason` set (e.g. `"No 1st-level spell slots remaining"`) and its target
list intact, so the panel can render it disabled with the reason and a "Flag to DM"
button for the DM rule-override flow, and an approved override can fire at those same
targets. Every usable action carries `blockedReason: null`. The range gate is unchanged
and still decides inclusion outright: an action out of reach even with full movement is
omitted entirely, because movement/targeting is explicitly outside what the DM override
covers — only resource/rule restrictions qualify. Same extended-existing-shape choice as
Prompt 49's breakdown fields (one array with a discriminating field, not a second
parallel array to keep ordered/deduplicated in step).

As of Prompt 54: opportunity-attack detection (`opportunityAttacks.ts`), pure and DB-free
in `computeQuickActions`'s exact mold (the caller supplies every input; the Game Room
assembles them from what it already holds right after a tracked move commits). Given the
mover's pre-move and post-move grid positions, whether the mover disengaged this turn, and
the hostile combatants' state (position, reach in feet, reaction spent, an optional
caller-derived `cannotReact` flag), `computeOpportunityAttacks` returns the combatant ids
of every hostile who was within reach of the PRE-move position, is no longer within reach
of the POST-move position, and still has their reaction — and nothing at all for a
disengaged mover. "Within reach" is inclusive (`distance <= reach`, the meets-it
convention every range query here uses, on `gridDistanceFeet`'s flat chessboard measure),
so a move ending exactly AT reach provokes nothing. Reach is deliberately NOT a new
per-creature stat (none exists in the SRD catalog): `meleeReachFeet(inventory)` is the
longest tagged melee/finesse weapon's `weaponRangeFeet`, floored at the same 5 ft
`DEFAULT_MELEE_RANGE_FEET` an unarmed/untagged creature uses everywhere else — ranged
weapons and spells never contribute (RAW 5e: only melee attacks threaten reach). Its
companion `meleeWeaponItems(inventory)` narrows an inventory to the melee/finesse
weapon-tagged entries with damage dice — the items usable AS an opportunity attack, shared
by reach above and the take-the-attack weapon picker. Crucially there is NO
range-with-movement check anywhere in resolution: the attack resolves as if the target
were still in reach at the instant they left it. Unit-tested the `computeQuickActions`
way: the exactly-at-reach boundary on both sides of a move, one cell past it, diagonal
escapes and slides along the reach ring under the chessboard rule, longer weapon reach,
spent-reaction and cannot-react exclusion, and the disengaged mover.

As of Prompt 56: the perception/vision engine (`perception.ts`) — `computeVisibilityTier`
resolves one observer/cell pair to a `VisibilityTier` (`"full" | "dim" | "none"`), and
`computeVisibilityTiers` sweeps a whole array of `{id, position, ambientLight}` cells (map
cells and token positions alike — a token is just another cell) against one observer in
input order, the `computeQuickActions`/`computeOpportunityAttacks` shape. Rule, in order:
(1) `ObserverVision.visionBlocked` — a plain boolean the CALLER derives from whether any of
the observer's active conditions has `ConditionEffects.blocksVision: true` (Prompt 47's
blinded, petrified, and unconscious) — short-circuits everything to `"none"` regardless of
light or range; this module never reads a condition key or catalog itself, so any condition
that carries (or later gains) that flag gets identical behavior for free, which is the
"per-condition vision effect property" the task called for, reusing Prompt 47's existing
flag rather than inventing a second, redundant one. (2) Absent that override, `effectiveLightLevel`
picks the brightest of a cell's own ambient light and every resolved light source reaching it
(`gridDistanceFeet(source.position, cell) <= source.radiusFeet`) — light only ever brightens,
never darkens, and the brightest overlapping contribution wins over the closest or
last-listed source. (3) Bright effective light is `"full"` for everyone; dim or dark is
`"full"` when the cell is within `ObserverVision.darkvisionFeet` of the observer, else dim
light is `"dim"` and darkness is `"none"`. Darkness-within-darkvision-range resolving to
`"full"` rather than the stricter RAW "darkvision renders darkness as dim, not bright" is a
deliberate simplification specified exactly as the task text framed it ("per SRD, darkvision
treats darkness as dim light," used there to justify full visibility) — implemented as
written, not corrected toward the stricter nuance. `CellLightLevel` and `ResolvedLightSource`
structurally mirror data-access's `LightLevel`/`LightSource` (rules-engine can't import
data-access, the `QuickActionInventoryItem` precedent) with the light source pre-resolved to
a concrete position — this module never looks up an object/token anchor itself. Wall/
line-of-sight blocking is still out of scope (the future upgrade Prompt 55's LOS flag is laid
for). Unit-tested exhaustively: bright/dim/dark crossed with normal vision and darkvision at,
inside, and outside range; light sources upgrading a dark or dim cell (including the
radius-boundary edge and outside-radius-contributes-nothing); overlapping sources taking the
brightest regardless of distance/order; the vision-blocked override winning over an
otherwise-bright, easy-darkvision-range cell; and a made-up, non-"blinded" condition-effect
flag producing identical behavior, proving the mechanism is genuinely generic (a source-level
check confirms no condition-key string appears anywhere in `perception.ts`).

As of Prompt 59: the promised advantage/disadvantage enforcement landed, and this module's
one new piece is deliberately tiny — `combineAdvantageSources(advantageSources,
disadvantageSources)` in `dice.ts`, the SRD combine rule as a pure decision function.
Callers collect every advantage source and every disadvantage source for a roll as
human-readable strings (a manual toggle, "target not perceived", a target-condition flag —
the strings are opaque here, only presence counts; they exist so the caller can store and
show WHY), and this returns the `AdvantageMode` to actually pass `rollD20` plus a
`canceled` flag: per SRD, multiple sources on one side never stack, and ANY advantage plus
ANY disadvantage cancels to a flat roll — otherwise the non-empty side wins, and both-empty
is plain normal. Everything else the mechanic needs already existed and is consumed, not
duplicated, by the roll Route Handler (the attack kind only): `computeVisibilityTier`
gains its first SERVER-side caller — the attacker's freshly-computed perception of the
target's cell, where `"none"` (and ONLY `"none"` — `"dim"` deliberately does not qualify;
RAW disadvantage is for an unseen target, not a dimly-lit one) contributes "target not
perceived", and a blinded ATTACKER needs no special case since a vision-blocked observer's
tier is `"none"` everywhere — and the Prompt 47 catalog's generic
`attacksAgainstHaveAdvantage`/`attacksAgainstHaveDisadvantage` flags on the TARGET's
active conditions contribute sources named via `CONDITION_BY_KEY`'s display name, so any
condition carrying (or ever gaining) either flag reports itself correctly for free.
Automating the remaining flags (`ownAttacksHave*`, `abilityChecksHaveDisadvantage`,
`savingThrowsHaveDisadvantage`, `autoFailStrDexSaves`) stays future work — checks/saves/
skills still take only the manual toggle. Unit-tested the resolveDeathSave way: both-empty,
each side alone, both-present canceling (including one-vs-many on either side),
never-stacking, and content-opacity.

Post-plan (sheet-side identity editing): `srd/races.ts` gains `RACE_OPTION_NAMES` — the
flattened base-race-plus-subrace option list character creation offers, one of which is
what `characters.race` stores (a subrace pick stores the subrace name ALONE) — and
`resolveRaceOption(name)`, which resolves that stored string back to a `RaceOptionStats`
(`speedFeet`, `darkvisionFeet`) with the wizard's subrace-overrides-race precedence, or
null for a name outside the catalog (e.g. an import's "Unknown"). Extracted from the
wizard's inline derivation and the import flow's local `darkvisionForRaceName` when the
character sheet's race editor became a third consumer; all three surfaces now share this
one resolver, so creation and later race edits derive identical speed/darkvision.

As of the void-terrain addition (post-roadmap — "Void terrain (non-rectangular room
shapes)", not a numbered prompt): `TerrainType` in `movement.ts` widens to
`"normal" | "difficult" | "void"`. A void cell is a cell with no floor at all — it renders
as absent for every viewer and can never be entered — which this module expresses in the
one way a pure cost engine can: `cellMovementCost` returns `Infinity` for void terrain,
before any elevation math (deliberately no special-casing beyond the terrain check —
Infinity plus any climb cost is still Infinity), so `pathMovementCost` over any path
containing a void cell sums to `Infinity` and every cost-based caller sees "impassable"
without new API. Everything else about void (rendering it as a hole, rejecting placement
and moves onto it, the widened DB CHECK) lives in the app layer/scene/schema, not here.
Unit-tested in `movement.test.ts`: void costs Infinity regardless of elevation delta
(ascending and descending both), and a path stays Infinity wherever the void cell falls in
it, including when later cells descend.

As of the reachable-cells addition (post-roadmap — "highlight valid destinations before a
move is chosen", not a numbered prompt): `movement.ts` gains `computeReachableCells`, which
answers "where COULD this token go" rather than `pathMovementCost`'s "what does going HERE
cost" — a cost-limited graph search (Dijkstra; `cellMovementCost` edge weights are never
negative) over the whole grid instead of one priced path. It takes `origin`, a flat
`cells: readonly MovementCellInput[]` sweep (`{position, terrain, elevationSteps}` — the
same whole-map-sweep shape `computeVisibilityTiers`'s `VisibilityCellInput` already uses,
built the same way: densify the sparse `cellOverlay`/`overlayFromRows` map with
`DEFAULT_CELL` where absent), a `budgetFeet`, and an optional `occupiedCells` list. A point
missing from `cells` is treated exactly like an explicit void cell (`cellMovementCost`
already returns `Infinity` for void terrain; GameRoom's own wording for void is "outside the
walkable map", which is exactly what an undescribed point is), so a caller only has to
describe real cells, never hand-paint a void border. Verified, not just assumed: void is
never reachable and never a cheaper route through to somewhere else, at any budget including
an unbounded one — the tentative cost through a void edge is rejected by an explicit
`Number.isFinite` check rather than only `<= budgetFeet`, because `Infinity <= Infinity` is
true in JS and an unbounded budget would otherwise let a void cell slip in as "reachable at
infinite cost". Occupied-cell judgment call, documented on `ComputeReachableCellsParams`:
passing THROUGH an occupied cell was already unrestricted before this addition (no existing
move/placement path — `dragPathCost`, `moveMapToken`, `moveCombatToken` — ever inspects
other tokens' positions, and the map-transition handler already states tokens may share a
cell "as anywhere else"), so this search matches that and prices it like any other cell;
there was no existing answer for whether an occupied cell should be OFFERED as a
destination, so this function excludes it from the returned set (a UI-highlight policy, not
a change to move legality — `moveMapToken`/`moveCombatToken` still allow a manual drag onto
one exactly as before). Unit-tested in `movement.test.ts`: the exact Chebyshev square an
open grid implies for a budget, cross-checked cell-by-cell against `pathMovementCost` for
both the reachable set and the ring just beyond it; difficult terrain shrinking that square;
a void wall blocking passage to cells behind it, not just the wall cells; an elevation climb
consuming the same extra cost `pathMovementCost` already charges for it; the origin always
included at zero cost; and the occupied-cell pass-through-but-not-landing behavior.

As of the pits-and-falling addition (post-roadmap — docs/design/pits-and-falling.md, not a
numbered prompt): `TerrainType` widens again to `"normal" | "difficult" | "void" | "pit"`. A
pit is a cell with a floor, just a lower one — its own `elevation` stores the pit's absolute
floor height (negative permitted specifically for this terrain), and `cellMovementCost`
prices it exactly like `"normal"` ground (no changes needed there, confirmed rather than
assumed: descending or level movement was already free before this addition, which is
exactly the SRD's "falling doesn't cost movement, you just fall"). The new pure module
`falling.ts` carries the actual consequence: `fallDamageDiceCount(depthFeet)` is the SRD
formula verbatim (1d6 per 10 ft, `Math.floor`, capped at `MAX_FALL_DAMAGE_DICE` = 20 at 200
ft, zero below the first full 10 ft); `resolveFall(depthFeet, random)` rolls that many d6
(reusing `dice.ts`'s `rollDice`, the same injectable-`RandomSource` seam) and sets `prone`
whenever `diceCount > 0` — SRD prone "unless it avoids taking damage from the fall", which
an Nd6 roll with N >= 1 can never do; `fallDepthFeet(fromElevationSteps, pitElevationSteps)`
is relative to where the MOVER stood immediately before entering the pit, not global
elevation 0, so a pit dug into a raised plateau reads correctly deeper from the plateau's
own rim. `MIN_HAZARD_DEPTH_STEPS` (2 steps / 10 ft) names, for the authoring side, exactly
the depth `fallDamageDiceCount` already stops returning zero at — the map editor's pit tool
warns below it rather than a second DB-level enforcement point. `CONCEALED_PIT_SAVE_DC` = 15
is the one new roll the design adds (a flat DC 15 Dexterity save for a pit a DM paints as
ordinary-looking terrain), resolved through the existing "save" roll kind, not a new dice
primitive. Production fall-damage rolls never call `resolveFall` with real randomness —
consistent with this module's server-only-dice architecture (see the Prompt 48 entry above),
the app layer (`GameRoom.tsx`) calls `fallDamageDiceCount` to size an ordinary "freeform"
roll through the Route Handler instead, and applies the server-attested total via the
existing `apply_hp_delta` RPC. Unit-tested in `falling.test.ts` at every SRD boundary (9/10/
19/20/199/200/250 ft, zero and negative depth) plus fixed-`RandomSource` sequences asserting
exact rolls and damage totals, the `resolveDeathSave`/`resolveAttackOutcome` rigor.
