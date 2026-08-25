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

Still future work: the perception/vision engine (Prompt 56) and advantage/disadvantage
enforcement from conditions/vision (Prompt 59) — Prompt 48 provides the manual toggle and
the two-d20 mechanics it will drive.
