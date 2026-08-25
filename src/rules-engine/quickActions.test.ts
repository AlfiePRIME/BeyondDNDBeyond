import { describe, expect, it } from "vitest";
import {
  DEFAULT_MELEE_RANGE_FEET,
  DEFAULT_RANGED_RANGE_FEET,
  computeQuickActions,
  weaponRangeFeet,
  type ComputeQuickActionsParams,
} from "./quickActions";

const origin = { x: 0, y: 0 };

// A hostile N cells due east — gridDistanceFeet(origin, at(n)) === n * 5.
function hostileAt(cells: number, tokenId = `hostile-${cells}`) {
  return { tokenId, position: { x: cells, y: 0 } };
}

function params(overrides: Partial<ComputeQuickActionsParams>): ComputeQuickActionsParams {
  return {
    position: origin,
    speed: 30,
    hostiles: [],
    inventory: [],
    knownSpellNames: [],
    resources: [],
    ...overrides,
  };
}

const sword = { name: "Longsword", quantity: 1, attackKind: "melee" as const, damageNotation: "1d8" };
const bow = {
  name: "Longbow",
  quantity: 1,
  attackKind: "ranged" as const,
  damageNotation: "1d8",
  rangeFeet: 150,
};

describe("weaponRangeFeet", () => {
  it("defaults melee and finesse to 5 ft reach", () => {
    expect(weaponRangeFeet({ attackKind: "melee" })).toBe(DEFAULT_MELEE_RANGE_FEET);
    expect(weaponRangeFeet({ attackKind: "finesse" })).toBe(DEFAULT_MELEE_RANGE_FEET);
  });

  it("defaults ranged to the 60 ft stand-in", () => {
    expect(weaponRangeFeet({ attackKind: "ranged" })).toBe(DEFAULT_RANGED_RANGE_FEET);
  });

  it("prefers an explicit rangeFeet over any default", () => {
    expect(weaponRangeFeet({ attackKind: "ranged", rangeFeet: 150 })).toBe(150);
    expect(weaponRangeFeet({ attackKind: "melee", rangeFeet: 10 })).toBe(10);
  });
});

describe("computeQuickActions — weapons", () => {
  it("surfaces a melee weapon against an adjacent hostile", () => {
    const actions = computeQuickActions(
      params({ inventory: [sword], hostiles: [hostileAt(1)] })
    );
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      source: "weapon",
      name: "Longsword",
      attackKind: "melee",
      damageNotation: "1d8",
      rangeFeet: 5,
      spellLevel: null,
      targetTokenIds: ["hostile-1"],
      blockedReason: null,
    });
  });

  it("extends reach by the full speed stat: usable at exactly speed + range, not one cell past", () => {
    // speed 30 + 5 ft reach = 35 ft = 7 cells.
    const inRange = computeQuickActions(
      params({ inventory: [sword], hostiles: [hostileAt(7)] })
    );
    expect(inRange.map((a) => a.name)).toEqual(["Longsword"]);

    const outOfRange = computeQuickActions(
      params({ inventory: [sword], hostiles: [hostileAt(8)] })
    );
    expect(outOfRange).toEqual([]);
  });

  it("lets a longer-ranged weapon reach a hostile a melee weapon can't", () => {
    // 30 cells = 150 ft: within the bow's 150 ft outright, far past the
    // sword's 35 ft melee-with-movement reach.
    const actions = computeQuickActions(
      params({ inventory: [sword, bow], hostiles: [hostileAt(30)] })
    );
    expect(actions.map((a) => a.name)).toEqual(["Longbow"]);
  });

  it("uses the ranged default when a ranged weapon has no explicit range", () => {
    const sling = { name: "Sling", quantity: 1, attackKind: "ranged" as const, damageNotation: "1d4" };
    // 60 + 30 = 90 ft = 18 cells reachable; 19 cells is not.
    expect(
      computeQuickActions(params({ inventory: [sling], hostiles: [hostileAt(18)] }))
    ).toHaveLength(1);
    expect(
      computeQuickActions(params({ inventory: [sling], hostiles: [hostileAt(19)] }))
    ).toEqual([]);
  });

  it("measures diagonal distance with the flat chessboard rule", () => {
    // (7, 7) is 7 cells = 35 ft away under gridCellDistance's max() rule.
    const actions = computeQuickActions(
      params({ inventory: [sword], hostiles: [{ tokenId: "h", position: { x: 7, y: 7 } }] })
    );
    expect(actions).toHaveLength(1);
  });

  it("ignores inventory items not tagged as weapons", () => {
    // Shaped like a real InventoryItem (extra fields like quantity are
    // fine structurally — the module only reads the weapon slice).
    const rope = { name: "Rope (50 ft)", quantity: 1 };
    const actions = computeQuickActions(
      params({
        inventory: [rope, sword],
        hostiles: [hostileAt(1)],
      })
    );
    expect(actions.map((a) => a.name)).toEqual(["Longsword"]);
  });

  it("lists every qualifying hostile as a target, not just the nearest", () => {
    const actions = computeQuickActions(
      params({
        inventory: [sword],
        hostiles: [hostileAt(1, "near"), hostileAt(7, "far"), hostileAt(8, "unreachable")],
      })
    );
    expect(actions[0].targetTokenIds).toEqual(["near", "far"]);
  });

  it("returns nothing when there are no hostiles at all", () => {
    expect(computeQuickActions(params({ inventory: [sword, bow] }))).toEqual([]);
  });
});

describe("computeQuickActions — spells", () => {
  const adjacentHostile = [hostileAt(1)];
  const fullSlots = [{ name: "1st-Level Spell Slots", current_uses: 2 }];

  it("surfaces a known attack-roll cantrip regardless of resource state", () => {
    const actions = computeQuickActions(
      params({ knownSpellNames: ["Fire Bolt"], hostiles: adjacentHostile, resources: [] })
    );
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      source: "spell",
      name: "Fire Bolt",
      attackKind: "spell",
      damageNotation: "1d10",
      rangeFeet: 120,
      spellLevel: 0,
      blockedReason: null,
    });
  });

  it("surfaces a leveled attack spell as usable only while its matching slot has uses", () => {
    const withSlot = computeQuickActions(
      params({ knownSpellNames: ["Witch Bolt"], hostiles: adjacentHostile, resources: fullSlots })
    );
    expect(withSlot.map((a) => [a.name, a.blockedReason])).toEqual([["Witch Bolt", null]]);
  });

  it("returns a slot-exhausted spell as blocked (Prompt 52), not omitted", () => {
    const exhausted = computeQuickActions(
      params({
        knownSpellNames: ["Witch Bolt"],
        hostiles: adjacentHostile,
        resources: [{ name: "1st-Level Spell Slots", current_uses: 0 }],
      })
    );
    expect(exhausted).toHaveLength(1);
    expect(exhausted[0]).toMatchObject({
      source: "spell",
      name: "Witch Bolt",
      attackKind: "spell",
      spellLevel: 1,
      // Targets still listed: the action is in reach, only the resource
      // blocks it, and an approved override fires at these same targets.
      targetTokenIds: ["hostile-1"],
      blockedReason: "No 1st-level spell slots remaining",
    });
  });

  it("treats a never-provisioned slot level as the same blocked state as an exhausted one", () => {
    const neverProvisioned = computeQuickActions(
      params({ knownSpellNames: ["Witch Bolt"], hostiles: adjacentHostile, resources: [] })
    );
    expect(neverProvisioned.map((a) => [a.name, a.blockedReason])).toEqual([
      ["Witch Bolt", "No 1st-level spell slots remaining"],
    ]);
  });

  it("checks the slot level matching the spell, not just any slot", () => {
    const wrongLevel = computeQuickActions(
      params({
        knownSpellNames: ["Scorching Ray"], // level 2
        hostiles: adjacentHostile,
        resources: fullSlots, // 1st-level only
      })
    );
    expect(wrongLevel.map((a) => [a.name, a.blockedReason])).toEqual([
      ["Scorching Ray", "No 2nd-level spell slots remaining"],
    ]);

    const rightLevel = computeQuickActions(
      params({
        knownSpellNames: ["Scorching Ray"],
        hostiles: adjacentHostile,
        resources: [{ name: "2nd-Level Spell Slots", current_uses: 1 }],
      })
    );
    expect(rightLevel.map((a) => [a.name, a.blockedReason])).toEqual([["Scorching Ray", null]]);
  });

  it("still omits a resource-blocked spell that is out of range — range is never override-eligible", () => {
    // Witch Bolt: 30 ft + 30 speed = 60 ft = 12 cells; 13 is out, so even
    // with the slot exhausted (a flaggable restriction on its own) the
    // action doesn't appear at all.
    const actions = computeQuickActions(
      params({ knownSpellNames: ["Witch Bolt"], hostiles: [hostileAt(13)], resources: [] })
    );
    expect(actions).toEqual([]);
  });

  it("applies the movement-extended range boundary to spells too", () => {
    // Witch Bolt: 30 ft + 30 speed = 60 ft = 12 cells; 13 is out.
    const inRange = computeQuickActions(
      params({ knownSpellNames: ["Witch Bolt"], hostiles: [hostileAt(12)], resources: fullSlots })
    );
    expect(inRange).toHaveLength(1);
    const outOfRange = computeQuickActions(
      params({ knownSpellNames: ["Witch Bolt"], hostiles: [hostileAt(13)], resources: fullSlots })
    );
    expect(outOfRange).toEqual([]);
  });

  it("treats a touch-range attack spell as 5 ft reach", () => {
    const actions = computeQuickActions(
      params({
        knownSpellNames: ["Shocking Grasp"],
        hostiles: [hostileAt(7), hostileAt(8)],
      })
    );
    expect(actions).toHaveLength(1);
    expect(actions[0].rangeFeet).toBe(5);
    expect(actions[0].targetTokenIds).toEqual(["hostile-7"]);
  });

  it("ignores known spells without attack metadata (save spells, utility, auto-hit)", () => {
    const actions = computeQuickActions(
      params({
        knownSpellNames: ["Fireball", "Magic Missile", "Mage Armor", "Sacred Flame"],
        hostiles: adjacentHostile,
        resources: [
          { name: "1st-Level Spell Slots", current_uses: 4 },
          { name: "3rd-Level Spell Slots", current_uses: 2 },
        ],
      })
    );
    expect(actions).toEqual([]);
  });

  it("ignores names that aren't in the catalog and duplicate known entries", () => {
    const actions = computeQuickActions(
      params({
        knownSpellNames: ["Homebrew Zapper", "Fire Bolt", "Fire Bolt"],
        hostiles: adjacentHostile,
      })
    );
    expect(actions.map((a) => a.name)).toEqual(["Fire Bolt"]);
  });

  it("keeps inventory order first, then known-spell order", () => {
    const actions = computeQuickActions(
      params({
        inventory: [sword, bow],
        knownSpellNames: ["Fire Bolt", "Witch Bolt"],
        hostiles: adjacentHostile,
        resources: fullSlots,
      })
    );
    expect(actions.map((a) => a.name)).toEqual(["Longsword", "Longbow", "Fire Bolt", "Witch Bolt"]);
  });
});
