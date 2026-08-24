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

Still future work: the perception/vision engine (Prompt 56) and advantage/disadvantage
(Prompt 59).
