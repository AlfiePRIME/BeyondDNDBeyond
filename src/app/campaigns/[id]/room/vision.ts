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
  CONDITION_BY_KEY,
  gridCellDistance,
  passiveScore,
  type ConditionKey,
  type GridPoint,
  type ResolvedLightSource,
} from "@/rules-engine";

// Per-player vision support for the Game Room (Prompt 58): the pure
// app-layer glue between live map/combat state and the rules engine's
// perception module. Kept out of GameRoom.tsx itself (the avatar-url.ts
// arrangement) so the resolution rules are unit-testable without a
// browser: rules-engine can't hold these functions — they consume
// data-access row shapes (`LightSource`'s three-way anchor, `MapToken`)
// that the module boundary keeps out of it, which is exactly why
// perception.ts takes PRE-resolved positions.

/**
 * The viewer's active character's token: of every token linked to a
 * character the viewer owns, the MOST RECENTLY placed one (`created_at`
 * desc, first) — a player may own several characters, but only one is "at
 * the table" this session, and re-placing a token is how they switch.
 * Null when the viewer has placed no token at all (they see the unfiltered
 * DM view until they do — there is nothing to mask against).
 */
export function mostRecentOwnToken(
  tokens: readonly MapToken[],
  ownCharacterIds: ReadonlySet<string>
): MapToken | null {
  let best: MapToken | null = null;
  for (const token of tokens) {
    if (token.character_id === null || !ownCharacterIds.has(token.character_id)) continue;
    if (!best || token.created_at > best.created_at) best = token;
  }
  return best;
}

/**
 * Resolves every light source row to the concrete position perception.ts
 * wants, from CURRENT object/token state — a token-anchored light (a
 * carried torch) moves with its carrier on every recompute, an
 * object-anchored one rides its prop's current x/y, a fixed anchor uses
 * its stored cell. A source whose anchor row no longer exists on this map
 * resolves to nothing (the DB cascades the row away, but a broadcast can
 * race the cascade).
 */
export function resolveLightSourcePositions(
  lightSources: readonly LightSource[],
  objects: readonly MapObject[],
  tokens: readonly MapToken[]
): ResolvedLightSource[] {
  return lightSources.flatMap((source) => {
    let position: { x: number; y: number } | null = null;
    if (source.object_id !== null) {
      const object = objects.find((candidate) => candidate.id === source.object_id);
      position = object ? { x: object.x, y: object.y } : null;
    } else if (source.token_id !== null) {
      const token = tokens.find((candidate) => candidate.id === source.token_id);
      position = token ? { x: token.x, y: token.y } : null;
    } else if (source.x !== null && source.y !== null) {
      position = { x: source.x, y: source.y };
    }
    if (!position) return [];
    return [{ position, radiusFeet: source.radius_feet, brightness: source.brightness }];
  });
}

/**
 * The combatant-keyed core of the vision-blocked derivation (split out in
 * Prompt 60): true when any of THIS combatant's active conditions carries
 * `blocksVision: true` in the rules-engine catalog (blinded, petrified,
 * unconscious — or anything that ever gains the flag, for free). Keyed by
 * combatant rather than character so an NPC observer — which has no
 * character row at all — gets the same condition-driven blindness a PC
 * does, which the Hide resolution's per-observer eligibility check needs.
 */
export function visionBlockedForCombatant(
  conditions: readonly CombatantCondition[],
  combatantId: string
): boolean {
  return conditions.some(
    (condition) =>
      condition.combatant_id === combatantId &&
      CONDITION_BY_KEY.get(condition.condition_key as ConditionKey)?.effects.blocksVision === true
  );
}

/**
 * The caller-derived `ObserverVision.visionBlocked` boolean: true when the
 * character is an active combatant in the ongoing encounter AND any of
 * that combatant's active conditions carries `blocksVision: true` in the
 * rules-engine catalog (see visionBlockedForCombatant, which this
 * delegates to). Outside combat there are no combatant_conditions rows
 * for anyone — conditions only exist for active combatants — so a
 * character not currently in the fight is simply never vision-blocked.
 */
export function visionBlockedForCharacter(
  combatants: readonly CombatCombatant[],
  conditions: readonly CombatantCondition[],
  characterId: string
): boolean {
  const combatant = combatants.find((candidate) => candidate.character_id === characterId);
  if (!combatant) return false;
  return visionBlockedForCombatant(conditions, combatant.id);
}

// Hidden items with passive-Perception reveal (Map Editor Batch A5): unlike
// combatant_hidden_from (a real roll, persisted because it must survive
// until something explicitly reveals it), an item's hidden_dc is reveal-by-
// computation — a character's passive Perception is fully determined by
// their own already-loaded ability scores/proficiencies/level, so there is
// nothing to store per (item, character) pair, only something to compute,
// fresh, every render. This is presentation masking in the Game Room, the
// exact same posture hiddenFrom.ts's own top comment describes for "you
// don't see a token hidden from you" — NOT an RLS concern (0061's own
// migration comment: a member can already read a chest item's hidden_dc
// column like any other column on an item they're allowed to read at all).

/**
 * "Near" a container, simplified to cell-adjacency — the container's own
 * cell plus its 8 surrounding cells (gridCellDistance, i.e. Chebyshev
 * distance, <= 1) — rather than a new distance/line-of-sight concept. A
 * deliberate simplification (see this feature's own prompt notes): nothing
 * elsewhere in the Game Room already models a finer-grained "how close is
 * close enough to notice something small" concept to reuse instead.
 */
export function isNearContainer(containerCell: GridPoint, viewerCell: GridPoint): boolean {
  return gridCellDistance(containerCell, viewerCell) <= 1;
}

/**
 * Whether ONE specific item is visible to ONE specific character —
 * independently of every other character who might also be looking at the
 * same container, matching hiddenFrom's per-viewer shape rather than
 * concealed_pits' single global reveal flag (two characters can have very
 * different passive Perception scores). `item.hidden_dc === null` is A4's
 * original always-visible-once-opened behavior, unconditionally — `near`
 * (see isNearContainer) is checked before passive Perception is even
 * computed, so a character far from the container never sees a hidden item
 * no matter how perceptive they are.
 */
export function isItemVisibleToCharacter(
  item: MapObjectItem,
  character: Character,
  near: boolean
): boolean {
  if (item.hidden_dc === null) return true;
  if (!near) return false;
  const proficient = character.proficiencies.includes("Perception");
  const passivePerception = passiveScore("Perception", character, character.level, proficient);
  return passivePerception >= item.hidden_dc;
}
