import type { SubclassDefinition } from "./types";

// One subclass per base class — deliberately NOT an attempt at every PHB
// subclass (out of scope for this pass; see the level-up wizard's own doc
// comments). Each is the exact subclass reproduced in the SRD 5.1 document
// itself (the same "SRD-legal, not full-PHB" boundary this file's sibling
// catalogs — classes.ts, spells.ts, races.ts — are already built from), so
// every one of these is real, citable content rather than an invented
// stand-in:
//   Barbarian -> Path of the Berserker      Bard -> College of Lore
//   Cleric    -> Life Domain                Druid -> Circle of the Land
//   Fighter   -> Champion                   Monk -> Way of the Open Hand
//   Paladin   -> Oath of Devotion           Ranger -> Hunter
//   Rogue     -> Thief                      Sorcerer -> Draconic Bloodline
//   Warlock   -> The Fiend                  Wizard -> School of Evocation
//
// `features` follows ClassFeature's exact shape so the level-up wizard's
// feature-diff (see rules-engine/levelUp.ts) treats base-class and
// subclass features identically. Levels here start at the class's own
// subclass-CHOICE level (Cleric/Sorcerer/Warlock choose at 1, Druid/Wizard
// at 2, everyone else at 3) — a subclass's first-tier features are granted
// the moment it's picked, same session as the class's own gate feature.
export const SUBCLASSES: SubclassDefinition[] = [
  {
    name: "Path of the Berserker",
    className: "Barbarian",
    features: [
      { name: "Frenzy", level: 3 },
      { name: "Mindless Rage", level: 6 },
      { name: "Intimidating Presence", level: 10 },
      { name: "Retaliation", level: 14 },
    ],
  },
  {
    name: "College of Lore",
    className: "Bard",
    features: [
      { name: "Bonus Proficiencies", level: 3 },
      { name: "Cutting Words", level: 3 },
      { name: "Additional Magical Secrets", level: 6 },
      { name: "Peerless Skill", level: 14 },
    ],
  },
  {
    name: "Life Domain",
    className: "Cleric",
    features: [
      { name: "Bonus Proficiency", level: 1 },
      { name: "Disciple of Life", level: 1 },
      { name: "Channel Divinity: Preserve Life", level: 2 },
      { name: "Blessed Healer", level: 6 },
      { name: "Divine Strike", level: 8 },
      { name: "Supreme Healing", level: 17 },
    ],
  },
  {
    name: "Circle of the Land",
    className: "Druid",
    features: [
      { name: "Bonus Cantrip", level: 2 },
      { name: "Natural Recovery", level: 2 },
      { name: "Circle Spells", level: 3 },
      { name: "Land's Stride", level: 6 },
      { name: "Nature's Ward", level: 10 },
      { name: "Nature's Sanctuary", level: 14 },
    ],
  },
  {
    name: "Champion",
    className: "Fighter",
    features: [
      { name: "Improved Critical", level: 3 },
      { name: "Remarkable Athlete", level: 7 },
      { name: "Additional Fighting Style", level: 10 },
      { name: "Superior Critical", level: 15 },
      { name: "Survivor", level: 18 },
    ],
  },
  {
    name: "Way of the Open Hand",
    className: "Monk",
    features: [
      { name: "Open Hand Technique", level: 3 },
      { name: "Wholeness of Body", level: 6 },
      { name: "Tranquility", level: 11 },
      { name: "Quivering Palm", level: 17 },
    ],
  },
  {
    name: "Oath of Devotion",
    className: "Paladin",
    features: [
      { name: "Oath Spells", level: 3 },
      { name: "Channel Divinity: Sacred Weapon", level: 3 },
      { name: "Channel Divinity: Turn the Unholy", level: 3 },
      { name: "Aura of Devotion", level: 7 },
      { name: "Purity of Spirit", level: 15 },
      { name: "Holy Nimbus", level: 20 },
    ],
  },
  {
    name: "Hunter",
    className: "Ranger",
    features: [
      { name: "Hunter's Prey", level: 3 },
      { name: "Defensive Tactics", level: 7 },
      { name: "Multiattack", level: 11 },
      { name: "Superior Hunter's Defense", level: 15 },
    ],
  },
  {
    name: "Thief",
    className: "Rogue",
    features: [
      { name: "Fast Hands", level: 3 },
      { name: "Second-Story Work", level: 3 },
      { name: "Supreme Sneak", level: 9 },
      { name: "Use Magic Device", level: 13 },
      { name: "Thief's Reflexes", level: 17 },
    ],
  },
  {
    name: "Draconic Bloodline",
    className: "Sorcerer",
    features: [
      { name: "Dragon Ancestor", level: 1 },
      { name: "Draconic Resilience", level: 1 },
      { name: "Elemental Affinity", level: 6 },
      { name: "Dragon Wings", level: 14 },
      { name: "Draconic Presence", level: 18 },
    ],
  },
  {
    name: "The Fiend",
    className: "Warlock",
    features: [
      { name: "Dark One's Blessing", level: 1 },
      { name: "Dark One's Own Luck", level: 6 },
      { name: "Fiendish Resilience", level: 10 },
      { name: "Hurl Through Hell", level: 14 },
    ],
  },
  {
    name: "School of Evocation",
    className: "Wizard",
    features: [
      { name: "Evocation Savant", level: 2 },
      { name: "Sculpt Spells", level: 2 },
      { name: "Potent Cantrip", level: 6 },
      { name: "Empowered Evocation", level: 10 },
      { name: "Overchannel", level: 14 },
    ],
  },
];
