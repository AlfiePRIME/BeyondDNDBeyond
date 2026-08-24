import type { ClassStartingEquipment } from "./types";

export const STARTING_EQUIPMENT: ClassStartingEquipment[] = [
  {
    className: "Barbarian",
    fixed: ["Explorer's Pack", "4 Javelins"],
    choices: [
      { options: [["Greataxe"], ["Any Martial Melee Weapon"]] },
      { options: [["Two Handaxes"], ["Any Simple Weapon"]] },
    ],
  },
  {
    className: "Bard",
    fixed: ["Leather Armor", "Dagger"],
    choices: [
      { options: [["Rapier"], ["Longsword"], ["Any Simple Weapon"]] },
      { options: [["Diplomat's Pack"], ["Entertainer's Pack"]] },
      { options: [["Lute"], ["Any Other Musical Instrument"]] },
    ],
  },
  {
    className: "Cleric",
    fixed: ["Shield", "Holy Symbol"],
    choices: [
      { options: [["Mace"], ["Warhammer"]] },
      { options: [["Scale Mail"], ["Leather Armor"], ["Chain Mail"]] },
      { options: [["Light Crossbow", "20 Bolts"], ["Any Simple Weapon"]] },
      { options: [["Priest's Pack"], ["Explorer's Pack"]] },
    ],
  },
  {
    className: "Druid",
    fixed: ["Leather Armor", "Explorer's Pack", "Druidic Focus"],
    choices: [
      { options: [["Wooden Shield"], ["Any Simple Weapon"]] },
      { options: [["Scimitar"], ["Any Simple Melee Weapon"]] },
    ],
  },
  {
    className: "Fighter",
    fixed: [],
    choices: [
      { options: [["Chain Mail"], ["Leather Armor", "Longbow", "20 Arrows"]] },
      { options: [["Martial Weapon", "Shield"], ["Two Martial Weapons"]] },
      { options: [["Light Crossbow", "20 Bolts"], ["Two Handaxes"]] },
      { options: [["Dungeoneer's Pack"], ["Explorer's Pack"]] },
    ],
  },
  {
    className: "Monk",
    fixed: ["10 Darts"],
    choices: [
      { options: [["Shortsword"], ["Any Simple Weapon"]] },
      { options: [["Dungeoneer's Pack"], ["Explorer's Pack"]] },
    ],
  },
  {
    className: "Paladin",
    fixed: ["Chain Mail", "Holy Symbol"],
    choices: [
      { options: [["Martial Weapon", "Shield"], ["Two Martial Weapons"]] },
      { options: [["Five Javelins"], ["Any Simple Melee Weapon"]] },
      { options: [["Priest's Pack"], ["Explorer's Pack"]] },
    ],
  },
  {
    className: "Ranger",
    fixed: ["Longbow", "Quiver of 20 Arrows"],
    choices: [
      { options: [["Scale Mail"], ["Leather Armor"]] },
      { options: [["Two Shortswords"], ["Two Simple Melee Weapons"]] },
      { options: [["Dungeoneer's Pack"], ["Explorer's Pack"]] },
    ],
  },
  {
    className: "Rogue",
    fixed: ["Leather Armor", "Two Daggers", "Thieves' Tools"],
    choices: [
      { options: [["Rapier"], ["Shortsword"]] },
      { options: [["Shortbow", "Quiver of 20 Arrows"], ["Shortsword"]] },
      { options: [["Burglar's Pack"], ["Dungeoneer's Pack"], ["Explorer's Pack"]] },
    ],
  },
  {
    className: "Sorcerer",
    fixed: ["Two Daggers"],
    choices: [
      { options: [["Light Crossbow", "20 Bolts"], ["Any Simple Weapon"]] },
      { options: [["Component Pouch"], ["Arcane Focus"]] },
      { options: [["Dungeoneer's Pack"], ["Explorer's Pack"]] },
    ],
  },
  {
    className: "Warlock",
    fixed: ["Leather Armor", "Any Simple Weapon", "Two Daggers"],
    choices: [
      { options: [["Light Crossbow", "20 Bolts"], ["Any Simple Weapon"]] },
      { options: [["Component Pouch"], ["Arcane Focus"]] },
      { options: [["Scholar's Pack"], ["Dungeoneer's Pack"]] },
    ],
  },
  {
    className: "Wizard",
    fixed: ["Spellbook"],
    choices: [
      { options: [["Quarterstaff"], ["Dagger"]] },
      { options: [["Component Pouch"], ["Arcane Focus"]] },
      { options: [["Scholar's Pack"], ["Explorer's Pack"]] },
    ],
  },
];
