import type { RaceDefinition } from "./types";

/** The derived racial stats character creation stamps onto a character row
 * (`speed` and `darkvision_feet`), resolved from its stored race string. */
export interface RaceOptionStats {
  speedFeet: number;
  darkvisionFeet: number | null;
}

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
      {
        name: "Eladrin",
        abilityScoreIncreases: [{ ability: "charisma", amount: 1 }],
        traits: [{ name: "Fey Step" }],
      },
      {
        name: "Sea Elf",
        abilityScoreIncreases: [{ ability: "constitution", amount: 1 }],
        traits: [
          { name: "Child of the Sea" },
          { name: "Friend of the Sea" },
          { name: "Sea Elf Training" },
        ],
      },
      {
        name: "Shadar-kai",
        abilityScoreIncreases: [{ ability: "constitution", amount: 1 }],
        traits: [{ name: "Blessing of the Raven Queen" }, { name: "Necrotic Resistance" }],
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
  // -- Volo's Guide to Monsters --
  {
    name: "Aarakocra",
    size: "medium",
    speedFeet: 25,
    abilityScoreIncreases: [
      { ability: "dexterity", amount: 2 },
      { ability: "wisdom", amount: 1 },
    ],
    traits: [{ name: "Flight" }, { name: "Talons" }],
  },
  {
    name: "Bugbear",
    size: "medium",
    speedFeet: 30,
    abilityScoreIncreases: [
      { ability: "strength", amount: 2 },
      { ability: "dexterity", amount: 1 },
    ],
    darkvisionFeet: 60,
    traits: [
      { name: "Long-Limbed" },
      { name: "Powerful Build" },
      { name: "Sneaky" },
      { name: "Surprise Attack" },
    ],
  },
  {
    name: "Firbolg",
    size: "medium",
    speedFeet: 30,
    abilityScoreIncreases: [
      { ability: "wisdom", amount: 2 },
      { ability: "strength", amount: 1 },
    ],
    traits: [
      { name: "Firbolg Magic" },
      { name: "Hidden Step" },
      { name: "Powerful Build" },
      { name: "Speech of Beast and Leaf" },
    ],
  },
  {
    name: "Goblin",
    size: "small",
    speedFeet: 30,
    abilityScoreIncreases: [
      { ability: "dexterity", amount: 2 },
      { ability: "constitution", amount: 1 },
    ],
    darkvisionFeet: 60,
    traits: [{ name: "Fury of the Small" }, { name: "Nimble Escape" }],
  },
  {
    name: "Goliath",
    size: "medium",
    speedFeet: 30,
    abilityScoreIncreases: [
      { ability: "strength", amount: 2 },
      { ability: "constitution", amount: 1 },
    ],
    traits: [
      { name: "Natural Athlete" },
      { name: "Stone's Endurance" },
      { name: "Powerful Build" },
      { name: "Mountain Born" },
    ],
  },
  {
    name: "Hobgoblin",
    size: "medium",
    speedFeet: 30,
    abilityScoreIncreases: [
      { ability: "constitution", amount: 2 },
      { ability: "intelligence", amount: 1 },
    ],
    darkvisionFeet: 60,
    traits: [{ name: "Martial Training" }, { name: "Saving Face" }],
  },
  {
    name: "Kenku",
    size: "medium",
    speedFeet: 30,
    abilityScoreIncreases: [
      { ability: "dexterity", amount: 2 },
      { ability: "wisdom", amount: 1 },
    ],
    darkvisionFeet: 60,
    traits: [{ name: "Expert Forgery" }, { name: "Kenku Training" }, { name: "Mimicry" }],
  },
  {
    name: "Kobold",
    size: "small",
    speedFeet: 30,
    abilityScoreIncreases: [
      { ability: "dexterity", amount: 2 },
      { ability: "strength", amount: -2 },
    ],
    darkvisionFeet: 60,
    traits: [
      { name: "Grovel, Cower, and Beg" },
      { name: "Pack Tactics" },
      { name: "Sunlight Sensitivity" },
    ],
  },
  {
    name: "Lizardfolk",
    size: "medium",
    speedFeet: 30,
    abilityScoreIncreases: [
      { ability: "constitution", amount: 2 },
      { ability: "wisdom", amount: 1 },
    ],
    traits: [
      { name: "Bite" },
      { name: "Cunning Artisan" },
      { name: "Hold Breath" },
      { name: "Hunter's Lore" },
      { name: "Natural Armor" },
      { name: "Hungry Jaws" },
    ],
  },
  {
    name: "Orc",
    size: "medium",
    speedFeet: 30,
    abilityScoreIncreases: [
      { ability: "strength", amount: 2 },
      { ability: "constitution", amount: 1 },
      { ability: "intelligence", amount: -2 },
    ],
    darkvisionFeet: 60,
    traits: [{ name: "Aggressive" }, { name: "Menacing" }, { name: "Powerful Build" }],
  },
  {
    name: "Tabaxi",
    size: "medium",
    speedFeet: 30,
    abilityScoreIncreases: [
      { ability: "dexterity", amount: 2 },
      { ability: "charisma", amount: 1 },
    ],
    darkvisionFeet: 60,
    traits: [{ name: "Cat's Claws" }, { name: "Cat's Talent" }, { name: "Feline Agility" }],
  },
  {
    name: "Triton",
    size: "medium",
    speedFeet: 30,
    abilityScoreIncreases: [
      { ability: "strength", amount: 1 },
      { ability: "constitution", amount: 1 },
      { ability: "charisma", amount: 1 },
    ],
    darkvisionFeet: 60,
    traits: [
      { name: "Amphibious" },
      { name: "Control Air and Water" },
      { name: "Emissary of the Sea" },
      { name: "Guardians of the Depths" },
    ],
  },
  {
    name: "Yuan-ti Pureblood",
    size: "medium",
    speedFeet: 30,
    abilityScoreIncreases: [
      { ability: "charisma", amount: 2 },
      { ability: "intelligence", amount: 1 },
    ],
    darkvisionFeet: 60,
    traits: [
      { name: "Innate Spellcasting" },
      { name: "Magic Resistance" },
      { name: "Poison Immunity" },
    ],
  },
  // -- Tortle Package / Eberron: Rising from the Last War appendix --
  {
    name: "Tortle",
    size: "medium",
    speedFeet: 30,
    abilityScoreIncreases: [
      { ability: "strength", amount: 2 },
      { ability: "wisdom", amount: 1 },
    ],
    traits: [
      { name: "Claws" },
      { name: "Hold Breath" },
      { name: "Natural Armor" },
      { name: "Shell Defense" },
      { name: "Survival Instinct" },
    ],
  },
  // -- Elemental Evil Player's Companion --
  {
    name: "Genasi",
    size: "medium",
    speedFeet: 30,
    abilityScoreIncreases: [{ ability: "constitution", amount: 2 }],
    traits: [],
    subraces: [
      {
        name: "Air Genasi",
        abilityScoreIncreases: [{ ability: "dexterity", amount: 1 }],
        traits: [{ name: "Unarmored Air" }, { name: "Mingle with the Wind" }],
      },
      {
        name: "Earth Genasi",
        abilityScoreIncreases: [{ ability: "strength", amount: 1 }],
        traits: [{ name: "Earth Walk" }, { name: "Merge with Stone" }],
      },
      {
        name: "Fire Genasi",
        abilityScoreIncreases: [{ ability: "intelligence", amount: 1 }],
        darkvisionFeet: 60,
        traits: [{ name: "Fire Resistance" }, { name: "Reach to the Blaze" }],
      },
      {
        name: "Water Genasi",
        abilityScoreIncreases: [{ ability: "wisdom", amount: 1 }],
        traits: [
          { name: "Acid Resistance" },
          { name: "Amphibious" },
          { name: "Call to the Wave" },
        ],
      },
    ],
  },
  // -- Mordenkainen's Tome of Foes --
  {
    name: "Duergar",
    size: "medium",
    speedFeet: 30,
    abilityScoreIncreases: [
      { ability: "strength", amount: 1 },
      { ability: "constitution", amount: 2 },
    ],
    darkvisionFeet: 120,
    traits: [
      { name: "Duergar Resilience" },
      { name: "Duergar Magic" },
      { name: "Sunlight Sensitivity" },
    ],
  },
  // -- Eberron: Rising from the Last War --
  {
    name: "Changeling",
    size: "medium",
    speedFeet: 30,
    abilityScoreIncreases: [
      { ability: "charisma", amount: 2 },
      { ability: "choice", amount: 1 },
    ],
    traits: [
      { name: "Shapechanger" },
      { name: "Changeling Instincts" },
      { name: "Divergent Persona" },
    ],
  },
  {
    name: "Kalashtar",
    size: "medium",
    speedFeet: 30,
    abilityScoreIncreases: [
      { ability: "wisdom", amount: 2 },
      { ability: "charisma", amount: 1 },
    ],
    traits: [
      { name: "Dual Mind" },
      { name: "Mental Discipline" },
      { name: "Mind Link" },
      { name: "Severed from Dreams" },
    ],
  },
  {
    name: "Shifter",
    size: "medium",
    speedFeet: 30,
    abilityScoreIncreases: [
      { ability: "dexterity", amount: 2 },
      { ability: "choice", amount: 1 },
    ],
    darkvisionFeet: 60,
    traits: [{ name: "Shifting" }],
    subraces: [
      {
        name: "Beasthide",
        abilityScoreIncreases: [{ ability: "constitution", amount: 1 }],
        traits: [{ name: "Beasthide" }],
      },
      {
        name: "Longtooth",
        abilityScoreIncreases: [{ ability: "strength", amount: 1 }],
        traits: [{ name: "Bite" }],
      },
      {
        name: "Swiftstride",
        abilityScoreIncreases: [{ ability: "dexterity", amount: 1 }],
        traits: [{ name: "Swift" }],
      },
      {
        name: "Wildhunt",
        abilityScoreIncreases: [{ ability: "wisdom", amount: 1 }],
        traits: [{ name: "Wildhunt Senses" }],
      },
    ],
  },
  {
    name: "Warforged",
    size: "medium",
    speedFeet: 30,
    abilityScoreIncreases: [
      { ability: "constitution", amount: 2 },
      { ability: "choice", amount: 1 },
    ],
    traits: [
      { name: "Constructed Resilience" },
      { name: "Sentry's Rest" },
      { name: "Integrated Protection" },
      { name: "Specialized Design" },
    ],
  },
  // -- Guildmasters' Guide to Ravnica --
  {
    name: "Centaur",
    size: "medium",
    speedFeet: 40,
    abilityScoreIncreases: [
      { ability: "strength", amount: 2 },
      { ability: "wisdom", amount: 1 },
    ],
    traits: [{ name: "Charge" }, { name: "Hooves" }, { name: "Equine Build" }, { name: "Survivor" }],
  },
  {
    name: "Loxodon",
    size: "medium",
    speedFeet: 30,
    abilityScoreIncreases: [
      { ability: "constitution", amount: 2 },
      { ability: "wisdom", amount: 1 },
    ],
    traits: [
      { name: "Loxodon Serenity" },
      { name: "Natural Armor" },
      { name: "Powerful Build" },
      { name: "Trunk" },
    ],
  },
  {
    name: "Minotaur",
    size: "medium",
    speedFeet: 30,
    abilityScoreIncreases: [
      { ability: "strength", amount: 2 },
      { ability: "constitution", amount: 1 },
    ],
    traits: [
      { name: "Horns" },
      { name: "Goring Rush" },
      { name: "Hammering Horns" },
      { name: "Imposing Presence" },
    ],
  },
  {
    name: "Vedalken",
    size: "medium",
    speedFeet: 30,
    abilityScoreIncreases: [
      { ability: "intelligence", amount: 2 },
      { ability: "wisdom", amount: 1 },
    ],
    traits: [{ name: "Vedalken Dispassion" }, { name: "Tireless Precision" }],
  },
  // -- Mythic Odysseys of Theros --
  {
    name: "Leonin",
    size: "medium",
    speedFeet: 30,
    abilityScoreIncreases: [
      { ability: "constitution", amount: 2 },
      { ability: "strength", amount: 1 },
    ],
    traits: [
      { name: "Daunting Roar" },
      { name: "Hunter's Instincts" },
      { name: "Natural Weapons" },
    ],
  },
  {
    name: "Satyr",
    size: "medium",
    speedFeet: 35,
    abilityScoreIncreases: [
      { ability: "charisma", amount: 2 },
      { ability: "dexterity", amount: 1 },
    ],
    traits: [
      { name: "Fey" },
      { name: "Ram" },
      { name: "Magic Resistance" },
      { name: "Mirthful Leaps" },
      { name: "Reveler" },
    ],
  },
];

/**
 * Every selectable race option, flattened: base race names plus subrace
 * names. This is the exact option list character creation (the wizard and
 * the importer) offers, and `characters.race` stores one of these strings —
 * a subrace pick stores the subrace name ALONE (e.g. "Wood Elf", never
 * "Elf (Wood Elf)"), so any surface reading the column back resolves it
 * with resolveRaceOption below.
 */
export const RACE_OPTION_NAMES: string[] = RACES.flatMap((race) => [
  race.name,
  ...(race.subraces?.map((subrace) => subrace.name) ?? []),
]);

/**
 * Resolves a stored `characters.race` string (a race OR subrace name from
 * RACE_OPTION_NAMES) to the derived stats creation writes alongside it,
 * with the wizard's subrace-overrides-race precedence — e.g. a Wood Elf's
 * 35 ft over the Elf's 30, a Drow's 120 ft darkvision over the Elf's 60,
 * and a Hill Dwarf inheriting the Dwarf's 60 ft darkvision it doesn't
 * redefine. An unknown name (e.g. an imported "Unknown") returns null:
 * nothing can be derived from it.
 */
export function resolveRaceOption(name: string): RaceOptionStats | null {
  for (const race of RACES) {
    if (race.name === name) {
      return { speedFeet: race.speedFeet, darkvisionFeet: race.darkvisionFeet ?? null };
    }
    const subrace = race.subraces?.find((s) => s.name === name);
    if (subrace) {
      return {
        speedFeet: subrace.speedFeet ?? race.speedFeet,
        darkvisionFeet: subrace.darkvisionFeet ?? race.darkvisionFeet ?? null,
      };
    }
  }
  return null;
}
