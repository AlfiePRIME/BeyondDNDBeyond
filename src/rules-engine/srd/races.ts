import type { RaceDefinition } from "./types";

export const RACES: RaceDefinition[] = [
  {
    name: "Dwarf",
    size: "medium",
    speedFeet: 25,
    abilityScoreIncreases: [{ ability: "constitution", amount: 2 }],
    darkvisionFeet: 60,
    resistances: ["poison"],
    traits: [
      { name: "Dwarven Resilience" },
      { name: "Dwarven Combat Training" },
      { name: "Tool Proficiency" },
      { name: "Stonecunning" },
    ],
    subraces: [
      {
        name: "Hill Dwarf",
        abilityScoreIncreases: [{ ability: "wisdom", amount: 1 }],
        traits: [{ name: "Dwarven Toughness" }],
      },
      {
        name: "Mountain Dwarf",
        abilityScoreIncreases: [{ ability: "strength", amount: 2 }],
        traits: [{ name: "Dwarven Armor Training" }],
      },
    ],
  },
  {
    name: "Elf",
    size: "medium",
    speedFeet: 30,
    abilityScoreIncreases: [{ ability: "dexterity", amount: 2 }],
    darkvisionFeet: 60,
    traits: [{ name: "Keen Senses" }, { name: "Fey Ancestry" }, { name: "Trance" }],
    subraces: [
      {
        name: "High Elf",
        abilityScoreIncreases: [{ ability: "intelligence", amount: 1 }],
        traits: [{ name: "Elf Weapon Training" }, { name: "Cantrip" }],
      },
      {
        name: "Wood Elf",
        abilityScoreIncreases: [{ ability: "wisdom", amount: 1 }],
        speedFeet: 35,
        traits: [{ name: "Elf Weapon Training" }, { name: "Mask of the Wild" }],
      },
      {
        name: "Drow",
        abilityScoreIncreases: [{ ability: "charisma", amount: 1 }],
        darkvisionFeet: 120,
        traits: [{ name: "Drow Weapon Training" }, { name: "Drow Magic" }, { name: "Sunlight Sensitivity" }],
      },
    ],
  },
  {
    name: "Halfling",
    size: "small",
    speedFeet: 25,
    abilityScoreIncreases: [{ ability: "dexterity", amount: 2 }],
    traits: [{ name: "Lucky" }, { name: "Brave" }, { name: "Halfling Nimbleness" }],
    subraces: [
      {
        name: "Lightfoot Halfling",
        abilityScoreIncreases: [{ ability: "charisma", amount: 1 }],
        traits: [{ name: "Naturally Stealthy" }],
      },
      {
        name: "Stout Halfling",
        abilityScoreIncreases: [{ ability: "constitution", amount: 1 }],
        traits: [{ name: "Stout Resilience" }],
        // Not called out as a separate top-level resistance since it only
        // applies to this subrace, not every Halfling.
      },
    ],
  },
  {
    name: "Human",
    size: "medium",
    speedFeet: 30,
    abilityScoreIncreases: [
      { ability: "strength", amount: 1 },
      { ability: "dexterity", amount: 1 },
      { ability: "constitution", amount: 1 },
      { ability: "intelligence", amount: 1 },
      { ability: "wisdom", amount: 1 },
      { ability: "charisma", amount: 1 },
    ],
    traits: [],
  },
  {
    name: "Dragonborn",
    size: "medium",
    speedFeet: 30,
    abilityScoreIncreases: [
      { ability: "strength", amount: 2 },
      { ability: "charisma", amount: 1 },
    ],
    traits: [{ name: "Draconic Ancestry" }, { name: "Breath Weapon" }, { name: "Damage Resistance" }],
    draconicAncestries: [
      { dragonType: "Black", damageType: "acid", breathWeapon: "5 by 30 ft. line (Dex save)" },
      { dragonType: "Blue", damageType: "lightning", breathWeapon: "5 by 30 ft. line (Dex save)" },
      { dragonType: "Brass", damageType: "fire", breathWeapon: "5 by 30 ft. line (Dex save)" },
      { dragonType: "Bronze", damageType: "lightning", breathWeapon: "5 by 30 ft. line (Dex save)" },
      { dragonType: "Copper", damageType: "acid", breathWeapon: "5 by 30 ft. line (Dex save)" },
      { dragonType: "Gold", damageType: "fire", breathWeapon: "15 ft. cone (Dex save)" },
      { dragonType: "Green", damageType: "poison", breathWeapon: "15 ft. cone (Con save)" },
      { dragonType: "Red", damageType: "fire", breathWeapon: "15 ft. cone (Dex save)" },
      { dragonType: "Silver", damageType: "cold", breathWeapon: "15 ft. cone (Con save)" },
      { dragonType: "White", damageType: "cold", breathWeapon: "15 ft. cone (Con save)" },
    ],
  },
  {
    name: "Gnome",
    size: "small",
    speedFeet: 25,
    abilityScoreIncreases: [{ ability: "intelligence", amount: 2 }],
    darkvisionFeet: 60,
    traits: [{ name: "Gnome Cunning" }],
    subraces: [
      {
        name: "Forest Gnome",
        abilityScoreIncreases: [{ ability: "dexterity", amount: 1 }],
        traits: [{ name: "Natural Illusionist" }, { name: "Speak with Small Beasts" }],
      },
      {
        name: "Rock Gnome",
        abilityScoreIncreases: [{ ability: "constitution", amount: 1 }],
        traits: [{ name: "Artificer's Lore" }, { name: "Tinker" }],
      },
    ],
  },
  {
    name: "Half-Elf",
    size: "medium",
    speedFeet: 30,
    abilityScoreIncreases: [
      { ability: "charisma", amount: 2 },
      { ability: "choice", amount: 1 },
      { ability: "choice", amount: 1 },
    ],
    darkvisionFeet: 60,
    traits: [{ name: "Fey Ancestry" }, { name: "Skill Versatility" }],
  },
  {
    name: "Half-Orc",
    size: "medium",
    speedFeet: 30,
    abilityScoreIncreases: [
      { ability: "strength", amount: 2 },
      { ability: "constitution", amount: 1 },
    ],
    darkvisionFeet: 60,
    traits: [{ name: "Menacing" }, { name: "Relentless Endurance" }, { name: "Savage Attacks" }],
  },
  {
    name: "Tiefling",
    size: "medium",
    speedFeet: 30,
    abilityScoreIncreases: [
      { ability: "charisma", amount: 2 },
      { ability: "intelligence", amount: 1 },
    ],
    darkvisionFeet: 60,
    resistances: ["fire"],
    traits: [{ name: "Hellish Resistance" }, { name: "Infernal Legacy" }],
  },
];
