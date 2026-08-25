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

Still future work: the perception/vision engine (Prompt 56) and advantage/disadvantage
enforcement from conditions/vision (Prompt 59) — Prompt 48 provides the manual toggle and
the two-d20 mechanics it will drive.
