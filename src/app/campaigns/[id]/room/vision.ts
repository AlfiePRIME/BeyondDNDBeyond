import type {
  CombatCombatant,
  CombatantCondition,
  LightSource,
  MapObject,
  MapToken,
} from "@/data-access";
import { CONDITION_BY_KEY, type ConditionKey, type ResolvedLightSource } from "@/rules-engine";

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
