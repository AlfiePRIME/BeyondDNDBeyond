import { RACES, type RaceDefinition, type SubraceDefinition } from "@/rules-engine";

/**
 * The default (no custom model, no NPC preset) pawn's build variant —
 * a handful of archetypal silhouettes (see MapSurface.tsx's own
 * PAWN_BODY_GEOMETRY), never a literal anatomical model per race. "small"
 * for a size:"small"/"tiny" race, "bulky" for a stocky/powerful build,
 * "slender" for a willowy build, "standard" for everything else — most
 * notably Human, the single most common pick, and every exotic race this
 * app's own build-archetype taxonomy doesn't have a strong opinion about
 * (Dragonborn, Aarakocra, Tiefling, Warforged, ...), which keep today's
 * unchanged pawn shape rather than a guessed, likely-wrong one.
 */
export type PawnBodyType = "standard" | "small" | "bulky" | "slender";

function findRaceAndSubrace(
  name: string
): { race: RaceDefinition; subrace: SubraceDefinition | null } | null {
  for (const race of RACES) {
    if (race.name === name) return { race, subrace: null };
    const subrace = race.subraces?.find((candidate) => candidate.name === name);
    if (subrace) return { race, subrace };
  }
  return null;
}

/** The SRD's own "counts as Medium for carrying capacity" trait — granted
 * to Bugbear, Firbolg, Goliath, and Loxodon in this app's race catalog.
 * Reading it structurally (rather than hardcoding those four race names)
 * means any future race added to RACES with this same trait picks up the
 * bulky pawn for free. */
const POWERFUL_BUILD_TRAIT = "Powerful Build";

/** The two archetypally stocky core races Powerful Build itself doesn't
 * cover (neither carries that trait in the SRD) — a small, deliberately
 * short list, not an attempt to classify every race's build by name. */
const BULKY_BASE_RACE_NAMES = new Set(["Dwarf", "Half-Orc"]);

/** Elf and its subraces (High/Wood/Drow/Eladrin/Sea/Shadar-kai) — the one
 * base race this taxonomy treats as slender by name, the same
 * deliberately-short-list reasoning as BULKY_BASE_RACE_NAMES above. */
const SLENDER_BASE_RACE_NAMES = new Set(["Elf"]);

/**
 * Derives a character's pawn body type from their stored `characters.race`
 * string — a base race name OR a subrace name alone (races.ts's own
 * RACE_OPTION_NAMES/resolveRaceOption convention). An unrecognized name
 * (an imported "Unknown", or a MapPlan P2 homebrew race the player typed
 * in freehand) falls back to "standard" — the same safe-default posture
 * resolveRaceOption itself takes for a lookup miss, rather than treating it
 * as an error.
 */
export function pawnBodyTypeForRace(raceName: string | null | undefined): PawnBodyType {
  if (!raceName) return "standard";
  const resolved = findRaceAndSubrace(raceName);
  if (!resolved) return "standard";
  const { race, subrace } = resolved;

  if (race.size === "small" || race.size === "tiny") return "small";

  const traits = [...race.traits, ...(subrace?.traits ?? [])];
  if (traits.some((trait) => trait.name === POWERFUL_BUILD_TRAIT)) return "bulky";
  if (BULKY_BASE_RACE_NAMES.has(race.name)) return "bulky";
  if (SLENDER_BASE_RACE_NAMES.has(race.name)) return "slender";

  return "standard";
}
