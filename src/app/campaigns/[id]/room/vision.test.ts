import { describe, expect, it } from "vitest";
import type {
  Character,
  CombatCombatant,
  CombatantCondition,
  LightSource,
  MapObject,
  MapObjectItem,
  MapToken,
} from "@/data-access";
import {
  isItemVisibleToCharacter,
  isNearContainer,
  mostRecentOwnToken,
  resolveLightSourcePositions,
  visionBlockedForCharacter,
  visionBlockedForCombatant,
} from "./vision";

function token(overrides: Partial<MapToken>): MapToken {
  return {
    id: "token-1",
    map_id: "map-1",
    character_id: null,
    npc_name: null,
    monster_stat_block_id: null,
    x: 0,
    y: 0,
    elevation: 0,
    allegiance: "party",
    current_hp: null,
    created_at: "2026-08-24T10:00:00.000Z",
    ...overrides,
  };
}

function light(overrides: Partial<LightSource>): LightSource {
  return {
    id: "light-1",
    map_id: "map-1",
    radius_feet: 20,
    brightness: "bright",
    x: null,
    y: null,
    object_id: null,
    token_id: null,
    created_at: "2026-08-24T10:00:00.000Z",
    ...overrides,
  };
}

function mapObject(overrides: Partial<MapObject>): MapObject {
  return {
    id: "object-1",
    map_id: "map-1",
    asset_id: "asset-1",
    x: 3,
    y: 4,
    elevation: 0,
    rotation: 0,
    behavior_config: {},
    blocks_line_of_sight: false,
    crossing_type: null,
    tag: null,
    tint: null,
    revealed_to_players: true,
    mount_object_id: null,
    mount_face_deg: null,
    created_at: "2026-08-24T10:00:00.000Z",
    asset: { name: "Torch", source_type: "preset", model_ref: "torch.glb" },
    ...overrides,
  };
}

function combatant(overrides: Partial<CombatCombatant>): CombatCombatant {
  return {
    id: "combatant-1",
    encounter_id: "encounter-1",
    token_id: "token-1",
    character_id: null,
    npc_name: null,
    monster_stat_block_id: null,
    npc_current_hp: null,
    initiative: null,
    action_used: false,
    bonus_action_used: false,
    reaction_used: false,
    movement_used_feet: 0,
    disengaged: false,
    created_at: "2026-08-24T10:00:00.000Z",
    ...overrides,
  };
}

function condition(overrides: Partial<CombatantCondition>): CombatantCondition {
  return {
    id: "condition-1",
    combatant_id: "combatant-1",
    condition_key: "blinded",
    level: null,
    applied_at: "2026-08-24T10:00:00.000Z",
    ...overrides,
  };
}

function character(overrides: Partial<Character>): Character {
  return {
    id: "character-1",
    campaign_id: "campaign-1",
    owner_id: "user-1",
    name: "Test Character",
    race: "Human",
    class: "Fighter",
    level: 1,
    strength: 10,
    dexterity: 10,
    constitution: 10,
    intelligence: 10,
    wisdom: 10,
    charisma: 10,
    current_hp: 10,
    max_hp: 10,
    armor_class: 10,
    speed: 30,
    darkvision_feet: null,
    proficiencies: [],
    inventory: [],
    spells: [],
    death_save_successes: 0,
    death_save_failures: 0,
    is_stable: false,
    is_dead: false,
    concentrating_on: null,
    pending_concentration_dc: null,
    created_at: "2026-08-24T10:00:00.000Z",
    updated_at: "2026-08-24T10:00:00.000Z",
    ...overrides,
  };
}

function containerItem(overrides: Partial<MapObjectItem>): MapObjectItem {
  return {
    id: "item-1",
    campaign_id: "campaign-1",
    map_object_id: "object-1",
    concealed_pit_id: null,
    name: "Ring of Protection",
    description: null,
    icon: null,
    tag: null,
    hidden_dc: null,
    curse_blessing: null,
    created_at: "2026-08-24T10:00:00.000Z",
    ...overrides,
  };
}

describe("mostRecentOwnToken", () => {
  const own = new Set(["char-a", "char-b"]);

  it("returns null when the viewer has placed no token", () => {
    expect(
      mostRecentOwnToken(
        [token({ character_id: "someone-elses" }), token({ npc_name: "Goblin" })],
        own
      )
    ).toBeNull();
  });

  it("picks the viewer's token over other players' and NPC tokens", () => {
    const mine = token({ id: "mine", character_id: "char-a" });
    const result = mostRecentOwnToken(
      [token({ id: "theirs", character_id: "char-x" }), mine, token({ id: "npc", npc_name: "Goblin" })],
      own
    );
    expect(result?.id).toBe("mine");
  });

  it("picks the MOST RECENTLY placed token when the viewer owns several", () => {
    const older = token({ id: "older", character_id: "char-a", created_at: "2026-08-24T10:00:00.000Z" });
    const newer = token({ id: "newer", character_id: "char-b", created_at: "2026-08-24T11:00:00.000Z" });
    // Order-independent: newest wins whichever side of the array it's on.
    expect(mostRecentOwnToken([older, newer], own)?.id).toBe("newer");
    expect(mostRecentOwnToken([newer, older], own)?.id).toBe("newer");
  });
});

describe("resolveLightSourcePositions", () => {
  it("resolves a fixed anchor to its stored cell", () => {
    expect(resolveLightSourcePositions([light({ x: 5, y: 6, radius_feet: 30, brightness: "dim" })], [], [])).toEqual([
      { position: { x: 5, y: 6 }, radiusFeet: 30, brightness: "dim" },
    ]);
  });

  it("resolves an object anchor to the object's CURRENT position", () => {
    expect(
      resolveLightSourcePositions([light({ object_id: "object-1" })], [mapObject({ x: 7, y: 8 })], [])
    ).toEqual([{ position: { x: 7, y: 8 }, radiusFeet: 20, brightness: "bright" }]);
  });

  it("resolves a token anchor to the carrier token's CURRENT position", () => {
    expect(
      resolveLightSourcePositions([light({ token_id: "token-1" })], [], [token({ x: 2, y: 9 })])
    ).toEqual([{ position: { x: 2, y: 9 }, radiusFeet: 20, brightness: "bright" }]);
  });

  it("drops a source whose anchor row is missing instead of throwing", () => {
    expect(resolveLightSourcePositions([light({ token_id: "gone" }), light({ object_id: "gone" })], [], [])).toEqual(
      []
    );
  });
});

describe("visionBlockedForCharacter", () => {
  const fighters = [combatant({ id: "c1", character_id: "char-a" }), combatant({ id: "c2", character_id: "char-b" })];

  it("is false when the character is not an active combatant (no conditions exist outside combat)", () => {
    expect(visionBlockedForCharacter(fighters, [condition({ combatant_id: "c1" })], "char-z")).toBe(false);
  });

  it("is true when the character's combatant has a blocksVision condition", () => {
    expect(visionBlockedForCharacter(fighters, [condition({ combatant_id: "c1", condition_key: "blinded" })], "char-a")).toBe(
      true
    );
  });

  it("is false for a non-vision-blocking condition, and for another combatant's blindness", () => {
    expect(visionBlockedForCharacter(fighters, [condition({ combatant_id: "c1", condition_key: "poisoned" })], "char-a")).toBe(
      false
    );
    expect(visionBlockedForCharacter(fighters, [condition({ combatant_id: "c1", condition_key: "blinded" })], "char-b")).toBe(
      false
    );
  });

  it("ignores the exhaustion pseudo-key rather than crashing the catalog lookup", () => {
    expect(
      visionBlockedForCharacter(fighters, [condition({ combatant_id: "c1", condition_key: "exhaustion", level: 3 })], "char-a")
    ).toBe(false);
  });
});

describe("visionBlockedForCombatant", () => {
  it("is true for the combatant carrying a blocksVision condition — including an NPC with no character", () => {
    expect(visionBlockedForCombatant([condition({ combatant_id: "npc-1", condition_key: "blinded" })], "npc-1")).toBe(true);
  });

  it("is false for a non-vision-blocking condition and for a different combatant's blindness", () => {
    expect(visionBlockedForCombatant([condition({ combatant_id: "npc-1", condition_key: "poisoned" })], "npc-1")).toBe(false);
    expect(visionBlockedForCombatant([condition({ combatant_id: "npc-1", condition_key: "blinded" })], "npc-2")).toBe(false);
  });
});

// Map Editor Batch A5: hidden items with passive-Perception reveal.
describe("isNearContainer", () => {
  it("is true on the container's own cell", () => {
    expect(isNearContainer({ x: 3, y: 3 }, { x: 3, y: 3 })).toBe(true);
  });

  it("is true on any of the 8 surrounding cells", () => {
    for (const [dx, dy] of [
      [-1, -1], [0, -1], [1, -1],
      [-1, 0], [1, 0],
      [-1, 1], [0, 1], [1, 1],
    ]) {
      expect(isNearContainer({ x: 3, y: 3 }, { x: 3 + dx, y: 3 + dy })).toBe(true);
    }
  });

  it("is false two cells away, orthogonally or diagonally", () => {
    expect(isNearContainer({ x: 3, y: 3 }, { x: 5, y: 3 })).toBe(false);
    expect(isNearContainer({ x: 3, y: 3 }, { x: 5, y: 5 })).toBe(false);
  });
});

describe("isItemVisibleToCharacter", () => {
  it("is always visible when hidden_dc is null, regardless of proximity or perception", () => {
    const item = containerItem({ hidden_dc: null });
    const dullCharacter = character({ wisdom: 1, level: 1, proficiencies: [] });
    expect(isItemVisibleToCharacter(item, dullCharacter, false)).toBe(true);
  });

  it("is invisible when not near the container, even to a highly perceptive character", () => {
    const item = containerItem({ hidden_dc: 5 });
    const sharpCharacter = character({ wisdom: 20, level: 5, proficiencies: ["Perception"] });
    expect(isItemVisibleToCharacter(item, sharpCharacter, false)).toBe(false);
  });

  it("is invisible to a character whose passive Perception is below the DC", () => {
    // wisdom 8 (-1 mod), not proficient, level 1: passive Perception = 10 - 1 = 9.
    const dullCharacter = character({ wisdom: 8, level: 1, proficiencies: [] });
    expect(isItemVisibleToCharacter(containerItem({ hidden_dc: 15 }), dullCharacter, true)).toBe(false);
  });

  it("is visible to a character whose passive Perception meets or beats the DC", () => {
    // wisdom 20 (+5 mod), proficient, level 5 (+3 proficiency): passive Perception = 10 + 5 + 3 = 18.
    const sharpCharacter = character({ wisdom: 20, level: 5, proficiencies: ["Perception"] });
    expect(isItemVisibleToCharacter(containerItem({ hidden_dc: 18 }), sharpCharacter, true)).toBe(true);
    expect(isItemVisibleToCharacter(containerItem({ hidden_dc: 15 }), sharpCharacter, true)).toBe(true);
  });

  it("gives two characters near the same container different visibility of the same item", () => {
    const item = containerItem({ hidden_dc: 15 });
    const sharpCharacter = character({ wisdom: 20, level: 5, proficiencies: ["Perception"] });
    const dullCharacter = character({ wisdom: 8, level: 1, proficiencies: [] });
    expect(isItemVisibleToCharacter(item, sharpCharacter, true)).toBe(true);
    expect(isItemVisibleToCharacter(item, dullCharacter, true)).toBe(false);
  });
});
