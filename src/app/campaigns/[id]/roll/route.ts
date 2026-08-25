import { NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/data-access/supabase-server";
import {
  getActiveCombatEncounter,
  getCharacter,
  listCombatCombatants,
  listCombatantConditions,
  listLightSources,
  listMapCells,
  listMapObjects,
  listMapTokens,
  resolveAttackDamage,
  rollConcentrationSave,
  rollDeathSave,
  setCombatantEconomyFlag,
  setCombatantInitiative,
  type AttackResolution,
  type Character,
  type D20RollBreakdown,
  type RollBreakdown,
  type RollKind,
  type RollLogEntry,
  type RollModifierPart,
  type SupabaseClient,
} from "@/data-access";
import {
  CLASSES,
  CONDITION_BY_KEY,
  SKILLS,
  SKILL_ABILITY,
  abilityModifier,
  attackBonus,
  combineAdvantageSources,
  computeVisibilityTier,
  doubleDiceExpression,
  parseDiceNotation,
  proficiencyBonus,
  resolveAttackOutcome,
  resolveDeathSave,
  rollD20,
  rollExpression,
  savingThrowBonus,
  skillCheckBonus,
  type AbilityScore,
  type AbilityScores,
  type AdvantageMode,
  type AttackKind,
  type ConditionKey,
  type SkillName,
} from "@/rules-engine";
import { resolveLightSourcePositions, visionBlockedForCharacter } from "../room/vision";
import type { RollRequest } from "./api";

// Every die result in the app is generated HERE, in a Node server process —
// never in the browser — so a malicious or buggy client can't claim "I
// rolled a 20". The dice math itself is rules-engine pure functions with an
// injectable random source; this handler is the one production caller that
// feeds them real randomness. Auth/membership shape mirrors the
// generate-draft route.

const ABILITIES: AbilityScore[] = [
  "strength",
  "dexterity",
  "constitution",
  "intelligence",
  "wisdom",
  "charisma",
];

const ATTACK_KINDS: AttackKind[] = ["melee", "ranged", "finesse", "spell"];

function isAbility(value: unknown): value is AbilityScore {
  return typeof value === "string" && (ABILITIES as string[]).includes(value);
}

function isSkill(value: unknown): value is SkillName {
  return typeof value === "string" && SKILLS.some((skill) => skill.name === value);
}

function isAttackKind(value: unknown): value is AttackKind {
  return typeof value === "string" && (ATTACK_KINDS as string[]).includes(value);
}

function parseMode(value: unknown): AdvantageMode | null {
  if (value === undefined || value === "normal") return "normal";
  if (value === "advantage" || value === "disadvantage") return value;
  return null;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function abilityScoresOf(character: Character): AbilityScores {
  return {
    strength: character.strength,
    dexterity: character.dexterity,
    constitution: character.constitution,
    intelligence: character.intelligence,
    wisdom: character.wisdom,
    charisma: character.charisma,
  };
}

function badRequest(message: string) {
  return NextResponse.json({ ok: false, message }, { status: 400 });
}

/** The saving-throw bonus as displayable parts — ability modifier plus
 * proficiency when the character's class has this ability among its
 * saving-throw proficiencies. Shared by the "save" kind and the
 * concentration save (which is exactly a Constitution save), with the same
 * parts-must-sum-to-the-rules-engine-bonus assertion either way. */
function savingThrowModifiers(character: Character, ability: AbilityScore): RollModifierPart[] {
  const scores = abilityScoresOf(character);
  const klass = CLASSES.find((c) => c.name === character.class) ?? null;
  const proficient = klass?.savingThrowProficiencies.includes(ability) ?? false;
  const modifiers: RollModifierPart[] = [
    { label: `${capitalize(ability)} modifier`, value: abilityModifier(scores[ability]) },
    ...(proficient ? [{ label: "Proficiency", value: proficiencyBonus(character.level) }] : []),
  ];
  // The displayed parts must sum to exactly the rules-engine bonus.
  if (
    modifiers.reduce((sum, part) => sum + part.value, 0) !==
    savingThrowBonus(ability, scores, character.level, proficient)
  ) {
    throw new Error("save bonus breakdown mismatch");
  }
  return modifiers;
}

/**
 * The attacking character's combatant row IF it is the campaign's CURRENT
 * combatant in an active encounter — the action-economy context (Prompt
 * 53). Null covers "no combat", "not in the fight", and "someone else's
 * turn", all of which leave the attack ungated: only the current
 * combatant's own turn is tracked. The current-combatant derivation is
 * the canonical turn-order query with advance_turn's clamp, same as the
 * combat panel's.
 */
async function currentCombatantForAttacker(
  supabase: SupabaseClient,
  campaignId: string,
  characterId: string
): Promise<{ combatantId: string; actionUsed: boolean } | null> {
  const { data: encounter, error: encounterError } = await supabase
    .from("combat_encounters")
    .select("id, current_turn_index")
    .eq("campaign_id", campaignId)
    .is("ended_at", null)
    .maybeSingle();
  if (encounterError) throw encounterError;
  if (!encounter) return null;

  const { data: combatants, error: combatantsError } = await supabase
    .from("combat_combatants")
    .select("id, character_id, action_used")
    .eq("encounter_id", encounter.id)
    .order("initiative", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: true })
    .order("id", { ascending: true });
  if (combatantsError) throw combatantsError;
  if (!combatants || combatants.length === 0) return null;

  const index = Math.min(encounter.current_turn_index, combatants.length - 1);
  const current = combatants[index];
  if (!current || current.character_id !== characterId) return null;
  return { combatantId: current.id, actionUsed: current.action_used };
}

async function insertRoll(
  supabase: SupabaseClient,
  row: {
    campaign_id: string;
    roller_user_id: string;
    character_id: string | null;
    kind: RollKind;
    breakdown: RollBreakdown;
    total: number;
  }
): Promise<RollLogEntry> {
  const { data, error } = await supabase.from("roll_log").insert(row).select().single();
  if (error) throw error;
  return data as RollLogEntry;
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: campaignId } = await params;

  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json(
      { ok: false, message: "You must be signed in to roll." },
      { status: 401 }
    );
  }

  // RLS hides campaigns you're not a member of — same 404 reasoning as the
  // generate-draft route.
  // action_economy_strict rides along for the attack branch's economy
  // gate below, and live_map for its perception check (Prompt 59) — one
  // read either way.
  const { data: campaign, error: campaignError } = await supabase
    .from("campaigns")
    .select("id, action_economy_strict, live_map")
    .eq("id", campaignId)
    .maybeSingle();
  if (campaignError) throw campaignError;
  if (!campaign) {
    return NextResponse.json({ ok: false, message: "Campaign not found." }, { status: 404 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest("Malformed request.");
  }
  const roll = (body ?? {}) as Partial<RollRequest> & Record<string, unknown>;

  if (roll.kind === "freeform") {
    if (typeof roll.notation !== "string") return badRequest("A dice expression is required.");
    const expression = parseDiceNotation(roll.notation);
    if (!expression) {
      return badRequest('That dice expression isn\'t valid — try something like "2d6+3".');
    }
    const result = rollExpression(expression);
    const entry = await insertRoll(supabase, {
      campaign_id: campaignId,
      roller_user_id: user.id,
      character_id: null,
      kind: "freeform",
      breakdown: {
        type: "dice",
        label: roll.notation.trim(),
        notation: roll.notation.trim(),
        groups: result.groups,
        modifier: result.modifier,
      },
      total: result.total,
    });
    return NextResponse.json({ ok: true, roll: entry });
  }

  if (roll.kind === "death_save") {
    if (typeof roll.characterId !== "string") return badRequest("A character is required.");
    // The caller's own client — RLS means only the owner or the DM can
    // read (and so roll for) this character.
    const character = await getCharacter(supabase, roll.characterId);
    if (!character || character.campaign_id !== campaignId) {
      return NextResponse.json({ ok: false, message: "Character not found." }, { status: 404 });
    }

    // A death save is always a plain d20 — no modifiers, and no
    // advantage/disadvantage (Prompt 59's territory), so any client-sent
    // mode is ignored rather than honored. Handled above the parseMode
    // gate on purpose.
    const d20 = rollD20("normal");
    const outcome = resolveDeathSave(d20.result);
    const breakdown: D20RollBreakdown = {
      type: "d20",
      label: `Death save — ${character.name}`,
      mode: "normal",
      d20Rolls: d20.rolls,
      d20Result: d20.result,
      modifiers: [],
      deathSave: {
        natural20: outcome.natural20,
        natural1: outcome.natural1,
        recovers: outcome.recovers,
        // Placeholders — rollDeathSave splices in the RPC's settled
        // after-state before anything is persisted.
        successesAfter: 0,
        failuresAfter: 0,
        stabilized: false,
        died: false,
      },
    };
    // apply_death_save_roll (0031) authorizes (owner or DM, via the
    // characters UPDATE policy) and rejects a character who isn't
    // actually dying; the state persists BEFORE the log write, so a
    // rejected roll logs nothing — the initiative-path ordering.
    try {
      const entry = await rollDeathSave(
        supabase,
        campaignId,
        user.id,
        character.id,
        outcome.successesDelta,
        outcome.failuresDelta,
        outcome.recovers,
        breakdown,
        d20.result
      );
      return NextResponse.json({ ok: true, roll: entry });
    } catch (err) {
      const message =
        err && typeof err === "object" && "message" in err && typeof err.message === "string"
          ? err.message
          : "No death save is needed right now.";
      return NextResponse.json({ ok: false, message }, { status: 400 });
    }
  }

  if (roll.kind === "concentration_save") {
    if (typeof roll.characterId !== "string") return badRequest("A character is required.");
    // The caller's own client — RLS means only the owner or the DM can
    // read (and so roll for) this character.
    const character = await getCharacter(supabase, roll.characterId);
    if (!character || character.campaign_id !== campaignId) {
      return NextResponse.json({ ok: false, message: "Character not found." }, { status: 404 });
    }

    // The DC comes from the character row, never the request — the damage
    // RPCs stored it server-side, so whoever triggered the damage can't
    // spoof it. Nothing pending means nothing to roll.
    const dc = character.pending_concentration_dc;
    if (dc === null) {
      return badRequest("No concentration check is pending.");
    }

    // A plain d20 like a death save — no advantage/disadvantage (Prompt
    // 59's territory), any client-sent mode ignored — but unlike a death
    // save it carries the Constitution SAVE bonus, computed by exactly the
    // "save" kind's logic.
    const modifiers = savingThrowModifiers(character, "constitution");
    const d20 = rollD20("normal");
    const total = d20.result + modifiers.reduce((sum, part) => sum + part.value, 0);
    const passed = total >= dc;
    const breakdown: D20RollBreakdown = {
      type: "d20",
      label: `Concentration save (DC ${dc})`,
      mode: "normal",
      d20Rolls: d20.rolls,
      d20Result: d20.result,
      modifiers,
      concentrationSave: {
        dc,
        total,
        passed,
        // Captured before the RPC runs — a failure clears it on the row.
        spellName: character.concentrating_on,
      },
    };
    // resolve_concentration_save (0032) authorizes (owner or DM, via the
    // characters UPDATE policy locking the row) and re-validates that a
    // check is still pending — a stale double-submit fails there; the
    // state persists BEFORE the log write, so a rejected roll logs
    // nothing — the death-save/initiative-path ordering.
    try {
      const entry = await rollConcentrationSave(
        supabase,
        campaignId,
        user.id,
        character.id,
        passed,
        breakdown,
        total
      );
      return NextResponse.json({ ok: true, roll: entry });
    } catch (err) {
      const message =
        err && typeof err === "object" && "message" in err && typeof err.message === "string"
          ? err.message
          : "No concentration check is pending.";
      return NextResponse.json({ ok: false, message }, { status: 400 });
    }
  }

  const mode = parseMode(roll.mode);
  if (mode === null) return badRequest("Unknown advantage mode.");

  if (roll.kind === "initiative") {
    if (typeof roll.combatantId !== "string") return badRequest("A combatant is required.");
    const { data: combatant, error: combatantError } = await supabase
      .from("combat_combatants")
      .select("id, character_id, npc_name, encounter:combat_encounters!inner(campaign_id, ended_at)")
      .eq("id", roll.combatantId)
      .maybeSingle();
    if (combatantError) throw combatantError;
    const encounter = (combatant?.encounter ?? null) as {
      campaign_id: string;
      ended_at: string | null;
    } | null;
    if (!combatant || encounter?.campaign_id !== campaignId) {
      return NextResponse.json({ ok: false, message: "Combatant not found." }, { status: 404 });
    }
    if (encounter.ended_at !== null) {
      return badRequest("That encounter has already ended.");
    }

    // A PC combatant's DEX modifier if the roller can read the character
    // (owner or DM under RLS); an NPC has no stats anywhere yet, so its
    // initiative is a plain d20.
    const character = combatant.character_id
      ? await getCharacter(supabase, combatant.character_id)
      : null;
    const modifiers: RollModifierPart[] = character
      ? [{ label: "Dexterity modifier", value: abilityModifier(character.dexterity) }]
      : [];

    const d20 = rollD20(mode);
    const total = d20.result + modifiers.reduce((sum, part) => sum + part.value, 0);

    // RLS (can_write_combatant) is the authorization: DM, or the owning
    // player. Persist the initiative BEFORE logging so a rejected write
    // logs nothing.
    try {
      await setCombatantInitiative(supabase, combatant.id, total);
    } catch {
      return NextResponse.json(
        { ok: false, message: "You may not roll initiative for that combatant." },
        { status: 403 }
      );
    }

    const label = `Initiative — ${character?.name ?? combatant.npc_name ?? "combatant"}`;
    const entry = await insertRoll(supabase, {
      campaign_id: campaignId,
      roller_user_id: user.id,
      character_id: combatant.character_id,
      kind: "initiative",
      breakdown: {
        type: "d20",
        label,
        mode,
        d20Rolls: d20.rolls,
        d20Result: d20.result,
        modifiers,
      },
      total,
    });
    return NextResponse.json({ ok: true, roll: entry });
  }

  if (
    roll.kind !== "check" &&
    roll.kind !== "save" &&
    roll.kind !== "skill" &&
    roll.kind !== "attack"
  ) {
    return badRequest("Unknown roll kind.");
  }

  if (typeof roll.characterId !== "string") return badRequest("A character is required.");
  // The caller's own client — RLS means only the owner or the DM can read
  // (and so roll for) this character.
  const character = await getCharacter(supabase, roll.characterId);
  if (!character || character.campaign_id !== campaignId) {
    return NextResponse.json({ ok: false, message: "Character not found." }, { status: 404 });
  }

  const scores = abilityScoresOf(character);
  const klass = CLASSES.find((c) => c.name === character.class) ?? null;

  let label: string;
  let modifiers: RollModifierPart[];
  let attackContext: { bonus: number; attackKind: AttackKind } | null = null;

  if (roll.kind === "check") {
    if (!isAbility(roll.ability)) return badRequest("Unknown ability.");
    label = `${capitalize(roll.ability)} check`;
    modifiers = [
      { label: `${capitalize(roll.ability)} modifier`, value: abilityModifier(scores[roll.ability]) },
    ];
  } else if (roll.kind === "save") {
    if (!isAbility(roll.ability)) return badRequest("Unknown ability.");
    label = `${capitalize(roll.ability)} save`;
    modifiers = savingThrowModifiers(character, roll.ability);
  } else if (roll.kind === "skill") {
    if (!isSkill(roll.skill)) return badRequest("Unknown skill.");
    const ability = SKILL_ABILITY[roll.skill];
    const proficient = character.proficiencies.includes(roll.skill);
    label = `${roll.skill} check`;
    modifiers = [
      { label: `${capitalize(ability)} modifier`, value: abilityModifier(scores[ability]) },
      ...(proficient
        ? [{ label: "Proficiency", value: proficiencyBonus(character.level) }]
        : []),
    ];
    if (
      modifiers.reduce((sum, part) => sum + part.value, 0) !==
      skillCheckBonus(roll.skill, scores, character.level, proficient)
    ) {
      throw new Error("skill bonus breakdown mismatch");
    }
  } else {
    if (!isAttackKind(roll.attackKind)) return badRequest("Unknown attack kind.");
    const spellAbility = klass?.spellcastingAbility;
    if (roll.attackKind === "spell" && !spellAbility) {
      return badRequest(`${character.name}'s class has no spellcasting ability.`);
    }
    const ability: AbilityScore =
      roll.attackKind === "melee"
        ? "strength"
        : roll.attackKind === "spell"
          ? (spellAbility as AbilityScore)
          : "dexterity";
    const bonus = attackBonus(roll.attackKind, scores, character.level, spellAbility);
    label = `${capitalize(roll.attackKind)} attack`;
    modifiers = [
      { label: `${capitalize(ability)} modifier`, value: abilityModifier(scores[ability]) },
      { label: "Proficiency", value: proficiencyBonus(character.level) },
    ];
    if (modifiers.reduce((sum, part) => sum + part.value, 0) !== bonus) {
      throw new Error("attack bonus breakdown mismatch");
    }
    attackContext = { bonus, attackKind: roll.attackKind };
  }

  // Action economy (Prompt 53), attacks ONLY — checks/saves/skills are
  // deliberately never gated (they aren't unambiguously action-consuming
  // the way an attack roll is, and blocking them would wrongly catch
  // legitimate non-combat/reactive rolls). Applies only when the attacker
  // IS the current combatant of an active encounter: in Strict mode a
  // spent action rejects here BEFORE any die is rolled — logging nothing,
  // like every other rejected-roll path — while Freeform never rejects
  // but still marks usage below for the live readout.
  let economyCombatantId: string | null = null;
  if (attackContext) {
    const economy = await currentCombatantForAttacker(supabase, campaignId, character.id);
    if (economy) {
      if (campaign.action_economy_strict && economy.actionUsed) {
        return badRequest("You've already used your action this turn.");
      }
      economyCombatantId = economy.combatantId;
    }
  }

  // Vision/condition-driven advantage and disadvantage (Prompt 59), attacks
  // ONLY — checks/saves/skills keep the caller's manual mode untouched
  // (automating those is explicitly out of scope, same as the death-save/
  // concentration comments above). Everything here is computed server-side
  // from freshly-read rows — like the die itself, never client-reported —
  // then combined with the player's manual toggle under the SRD rule
  // (sources never stack; any advantage plus any disadvantage cancels to a
  // flat roll) by the rules engine's combineAdvantageSources.
  let rolledMode: AdvantageMode = mode;
  const advantageSources: string[] = [];
  const disadvantageSources: string[] = [];
  if (attackContext) {
    if (mode === "advantage") advantageSources.push("manually selected");
    if (mode === "disadvantage") disadvantageSources.push("manually selected");

    const requestTargetTokenId =
      typeof roll.targetTokenId === "string" ? roll.targetTokenId : null;
    const requestTargetCharacterId =
      typeof roll.targetCharacterId === "string" ? roll.targetCharacterId : null;

    // Conditions only exist for active combatants (the
    // visionBlockedForCharacter reasoning) — one encounter-wide load
    // covers BOTH sides: the attacker's blocksVision-derived
    // vision-blocked state and the target's attacks-against flags.
    const encounter = await getActiveCombatEncounter(supabase, campaignId);
    const combatants = encounter ? await listCombatCombatants(supabase, encounter.id) : [];
    const conditions =
      combatants.length > 0
        ? await listCombatantConditions(
            supabase,
            combatants.map((combatant) => combatant.id)
          )
        : [];

    // The target's condition flags — matched by their token when the
    // client sent one (covers NPC targets), else by character id. Checked
    // via the GENERIC catalog flags, both directions independently: any
    // condition that carries (or ever gains) attacksAgainstHaveAdvantage/
    // attacksAgainstHaveDisadvantage reports itself here for free, under
    // its own display name — the blocksVision arrangement exactly.
    const targetCombatant =
      combatants.find(
        (combatant) =>
          (requestTargetTokenId !== null && combatant.token_id === requestTargetTokenId) ||
          (requestTargetCharacterId !== null &&
            combatant.character_id === requestTargetCharacterId)
      ) ?? null;
    if (targetCombatant) {
      for (const condition of conditions) {
        if (condition.combatant_id !== targetCombatant.id) continue;
        const definition = CONDITION_BY_KEY.get(condition.condition_key as ConditionKey);
        if (!definition) continue;
        if (definition.effects.attacksAgainstHaveAdvantage) {
          advantageSources.push(`target has ${definition.name} (advantage against)`);
        }
        if (definition.effects.attacksAgainstHaveDisadvantage) {
          disadvantageSources.push(`target has ${definition.name} (disadvantage against)`);
        }
      }
    }

    // The perception check: disadvantage when the attacker cannot SEE the
    // target at all — computeVisibilityTier === "none" for the target's
    // cell, evaluated from the attacker's position/vision/blocked state
    // ("dim" deliberately does NOT qualify: RAW disadvantage is for an
    // unseen target, not a dimly-lit one). Needs a live map with both
    // tokens on it; anything missing means there is nothing to compute
    // perception FROM, so no visibility source is added — a graceful
    // fallback, never an error or a forced disadvantage. A blinded
    // ATTACKER needs no special case: their vision-blocked tier is "none"
    // for every cell, so this same check already lands the disadvantage.
    if (campaign.live_map && requestTargetTokenId) {
      const tokens = await listMapTokens(supabase, campaign.live_map);
      const attackerToken =
        tokens.find((token) => token.character_id === character.id) ?? null;
      const targetToken =
        tokens.find((token) => token.id === requestTargetTokenId) ?? null;
      if (attackerToken && targetToken) {
        const [cells, lightSources, objects] = await Promise.all([
          listMapCells(supabase, campaign.live_map),
          listLightSources(supabase, campaign.live_map),
          listMapObjects(supabase, campaign.live_map),
        ]);
        const targetCell = cells.find(
          (cell) => cell.x === targetToken.x && cell.y === targetToken.y
        );
        const tier = computeVisibilityTier({
          observerPosition: { x: attackerToken.x, y: attackerToken.y },
          vision: {
            darkvisionFeet: character.darkvision_feet,
            visionBlocked: visionBlockedForCharacter(combatants, conditions, character.id),
          },
          cellPosition: { x: targetToken.x, y: targetToken.y },
          // Sparse storage: a cell with no row is the bright default.
          cellAmbientLight: targetCell?.light_level ?? "bright",
          lightSources: resolveLightSourcePositions(lightSources, objects, tokens),
        });
        if (tier === "none") disadvantageSources.push("target not perceived");
      }
    }

    rolledMode = combineAdvantageSources(advantageSources, disadvantageSources).mode;
  }

  let attack: AttackResolution | undefined;
  const d20 = rollD20(rolledMode);
  const total = d20.result + modifiers.reduce((sum, part) => sum + part.value, 0);

  if (attackContext) {
    if (
      typeof roll.targetAc !== "number" ||
      !Number.isInteger(roll.targetAc) ||
      roll.targetAc < 1 ||
      roll.targetAc > 99
    ) {
      return badRequest("Enter the target's AC (1-99).");
    }
    if (typeof roll.damageNotation !== "string") return badRequest("Damage dice are required.");
    const damageExpression = parseDiceNotation(roll.damageNotation);
    if (!damageExpression) {
      return badRequest('Those damage dice aren\'t valid — try something like "1d8+3".');
    }
    const targetCharacterId =
      typeof roll.targetCharacterId === "string" ? roll.targetCharacterId : null;
    const targetName =
      typeof roll.targetName === "string" && roll.targetName.trim() !== ""
        ? roll.targetName.trim().slice(0, 80)
        : null;

    const outcome = resolveAttackOutcome(d20.result, attackContext.bonus, roll.targetAc);

    let damage: AttackResolution["damage"] = null;
    const applied: AttackResolution["applied"] = null;
    if (outcome.hit) {
      const rolled = rollExpression(
        outcome.critical ? doubleDiceExpression(damageExpression) : damageExpression
      );
      damage = {
        notation: roll.damageNotation.trim(),
        doubled: outcome.critical,
        groups: rolled.groups,
        modifier: rolled.modifier,
        total: Math.max(0, rolled.total),
      };
      if (targetCharacterId && damage.total > 0) {
        attack = {
          attackKind: attackContext.attackKind,
          targetAc: roll.targetAc,
          targetName,
          targetCharacterId,
          ...outcome,
          damage,
          applied: null,
          // Placeholders — resolveAttackDamage splices in the RPC's real
          // outcome, exactly like `applied`.
          instantDeath: false,
          deathSaveFailureAdded: 0,
          advantageSources,
          disadvantageSources,
        };
        const breakdown: D20RollBreakdown = {
          type: "d20",
          label,
          mode: rolledMode,
          d20Rolls: d20.rolls,
          d20Result: d20.result,
          modifiers,
          attack,
        };
        // Attacker-based authorization (resolve_attack_damage, 0030) — a
        // failure here means the caller wasn't entitled to resolve this
        // attack at all, so nothing is logged. On success, the RPC applies
        // the damage AND logs this roll in the same transaction (see the
        // migration/resolveAttackDamage for why the two can't be split
        // into a separate insertRoll call below), so it returns the
        // persisted roll_log row directly.
        try {
          const entry = await resolveAttackDamage(
            supabase,
            campaignId,
            user.id,
            character.id,
            targetCharacterId,
            damage.total,
            // A crit on an already-0-HP target adds TWO death-save
            // failures instead of one — the RPC needs to know.
            outcome.critical,
            breakdown,
            total
          );
          // The attack resolved (and logged), so the action is spent —
          // a plain can_write_combatant update in both modes (Freeform
          // still tracks for the readout), the accepted write-then-
          // continue shape for self/DM-scoped side effects, not folded
          // into the RPC's transaction.
          if (economyCombatantId) {
            await setCombatantEconomyFlag(supabase, economyCombatantId, "action_used", true);
          }
          return NextResponse.json({ ok: true, roll: entry });
        } catch (err) {
          const message =
            err && typeof err === "object" && "message" in err && typeof err.message === "string"
              ? err.message
              : "Could not apply the damage.";
          return NextResponse.json({ ok: false, message }, { status: 403 });
        }
      }
    }

    attack = {
      attackKind: attackContext.attackKind,
      targetAc: roll.targetAc,
      targetName,
      targetCharacterId,
      ...outcome,
      damage,
      applied,
      // Nothing landed on a tracked 0-HP target on this path.
      instantDeath: false,
      deathSaveFailureAdded: 0,
      advantageSources,
      disadvantageSources,
    };
  }

  // The miss/untargeted attack path: the roll proceeded, so the action is
  // spent — a miss still costs it. Persist-then-log, the initiative-path
  // ordering; economyCombatantId is only ever set for the attack kind, so
  // checks/saves/skills never reach this write.
  if (economyCombatantId) {
    await setCombatantEconomyFlag(supabase, economyCombatantId, "action_used", true);
  }

  const entry = await insertRoll(supabase, {
    campaign_id: campaignId,
    roller_user_id: user.id,
    character_id: character.id,
    kind: roll.kind,
    breakdown: {
      type: "d20",
      label,
      // rolledMode === mode for every non-attack kind — only the attack
      // branch above ever recomputes it.
      mode: rolledMode,
      d20Rolls: d20.rolls,
      d20Result: d20.result,
      modifiers,
      ...(attack ? { attack } : {}),
    },
    total,
  });
  return NextResponse.json({ ok: true, roll: entry });
}
