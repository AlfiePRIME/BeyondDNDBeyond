import { NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/data-access/supabase-server";
import {
  clearHiddenAsHider,
  getActiveCombatEncounter,
  getCharacter,
  getCharacterCurrentToken,
  getEncounterVisionStats,
  getMapToken,
  isDM,
  listCharactersForCampaign,
  listCombatCombatants,
  listCombatantConditions,
  listCombatantHiddenFrom,
  listLightSources,
  listMapCells,
  listMapObjects,
  listMapTokens,
  listMonsterStatBlocks,
  replaceHiddenAsHider,
  resolveAttackDamage,
  resolveNpcAttackDamage,
  resolvePcAttackOnNpcDamage,
  rollConcentrationSave,
  rollDeathSave,
  setCombatantEconomyFlag,
  setCombatantInitiative,
  type AttackResolution,
  type Character,
  type D20RollBreakdown,
  type HideObserverOutcome,
  type RollBreakdown,
  type RollKind,
  type RollLogEntry,
  type RollModifierPart,
  type RollVisibility,
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
  passiveScore,
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
  type VisibilityTier,
} from "@/rules-engine";
import {
  resolveLightSourcePositions,
  visionBlockedForCharacter,
  visionBlockedForCombatant,
} from "../room/vision";
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
    visibility: RollVisibility;
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
  // gate below. live_map itself is NOT read here (0046): every perception
  // check below resolves its map context from the relevant token's own
  // current map_id instead — see each branch's own comment for why that's
  // both more correct and RLS-safe once a token can live on a map other
  // than the campaign's shared one.
  const { data: campaign, error: campaignError } = await supabase
    .from("campaigns")
    .select("id, action_economy_strict")
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

  // Phase 3: DM-only in practice, not just in the UI — roll_log's own RLS
  // (0042) rejects a non-DM's insert attempt with visibility = 'private'
  // outright, so there's no need to re-check isDM here. Anything other
  // than the literal "private" (including every existing caller that never
  // sends this field at all) resolves to "public" — today's only behavior.
  const visibility: RollVisibility = roll.visibility === "private" ? "private" : "public";

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
      visibility,
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
      visibility,
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

  if (roll.kind === "hide") {
    if (typeof roll.combatantId !== "string") return badRequest("A combatant is required.");
    // Combatant-scoped like initiative (an NPC can Hide too and has no
    // character) — same fetch shape, plus encounter_id/token_id for the
    // observer sweep below.
    const { data: combatant, error: combatantError } = await supabase
      .from("combat_combatants")
      .select(
        "id, encounter_id, token_id, character_id, npc_name, encounter:combat_encounters!inner(campaign_id, ended_at)"
      )
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

    // A PC hider's linked character — readable exactly by the two parties
    // can_write_combatant authorizes (owner or DM under characters RLS).
    const character = combatant.character_id
      ? await getCharacter(supabase, combatant.character_id)
      : null;

    // Explicit controllership check BEFORE any die is rolled — mirroring
    // 0027's can_write_combatant (DM, or the hider's owning player; NPC
    // hiding is DM-only by construction). Unlike initiative, RLS alone
    // can't reject an outsider here: a Hide that ends up hiding from no
    // one performs only a zero-row DELETE, which RLS lets silently match
    // nothing — so the route must refuse up front rather than log a roll
    // an uninvolved player was never entitled to make.
    const callerIsDM = await isDM(supabase, campaignId, user.id);
    if (!callerIsDM && !(character !== null && character.owner_id === user.id)) {
      return NextResponse.json(
        { ok: false, message: "You may not hide that combatant." },
        { status: 403 }
      );
    }

    // A Stealth check: DEX + proficiency for a PC hider (the "skill"
    // kind's exact bonus math, asserted against the rules engine the same
    // way); a plain unmodified d20 for an NPC — the initiative branch's
    // "NPCs have no stats anywhere yet" precedent.
    const modifiers: RollModifierPart[] = [];
    if (character) {
      const scores = abilityScoresOf(character);
      const proficient = character.proficiencies.includes("Stealth");
      modifiers.push({ label: "Dexterity modifier", value: abilityModifier(scores.dexterity) });
      if (proficient) {
        modifiers.push({ label: "Proficiency", value: proficiencyBonus(character.level) });
      }
      if (
        modifiers.reduce((sum, part) => sum + part.value, 0) !==
        skillCheckBonus("Stealth", scores, character.level, proficient)
      ) {
        throw new Error("stealth bonus breakdown mismatch");
      }
    }
    const d20 = rollD20(mode);
    const total = d20.result + modifiers.reduce((sum, part) => sum + part.value, 0);

    // Everything the observer sweep needs, in one round of reads. The
    // vision stats come through get_encounter_vision_stats (0037) — the
    // one narrow SECURITY DEFINER crossing of characters' owner-or-DM
    // SELECT policy, because comparing against every OTHER combatant's
    // passive Perception (and knowing their darkvision) needs stats the
    // hider's own session cannot read. The RPC only READS; both actual
    // computations below reuse the established pure functions
    // (passiveScore, computeVisibilityTier) — nothing is reimplemented in
    // SQL. Map data and conditions are already member-readable, so those
    // reads are the caller's ordinary RLS-scoped ones.
    const combatants = await listCombatCombatants(supabase, combatant.encounter_id);
    const [conditions, visionStats, readableCharacters, campaignStatBlocks] = await Promise.all([
      listCombatantConditions(
        supabase,
        combatants.map((candidate) => candidate.id)
      ),
      getEncounterVisionStats(supabase, combatant.encounter_id),
      // Observer names for the log, best-effort: RLS trims this to the
      // caller's own characters (or all, for the DM) — an unreadable PC
      // observer falls back to the combat panel's "Party member" label.
      listCharactersForCampaign(supabase, campaignId),
      // Stat blocks (Prompt 61), member-readable: a stat-blocked NPC
      // observer resolves against its REAL passive_perception below — the
      // flat default of 10 now applies only to a truly bare NPC with no
      // linked block at all.
      listMonsterStatBlocks(supabase, campaignId),
    ]);
    const statsByCharacterId = new Map(visionStats.map((row) => [row.character_id, row]));
    const nameByCharacterId = new Map(readableCharacters.map((row) => [row.id, row.name]));
    const statBlockById = new Map(campaignStatBlocks.map((row) => [row.id, row]));

    // The hider's position and their OWN map's lighting, for the "could
    // this observer perceive the hider AT ALL" check — exactly the attack
    // branch's Prompt 59 perception context. Resolved from the hider's own
    // token's actual current map_id (0046), NOT campaign.live_map: once a
    // player's token can sit on a map other than the campaign's shared one
    // (a solo map-transition crossing), the hider's real position is
    // whatever ITS OWN token row says, which may or may not be the live
    // map. Missing pieces (the hider's token gone entirely) mean there is
    // nothing to compute perception FROM: the graceful fallback treats
    // every non-blinded observer as able to perceive, so the Hide still
    // resolves on passive Perception alone rather than erroring or
    // silently hiding from no one.
    let hiderContext: {
      position: { x: number; y: number };
      ambientLight: "bright" | "dim" | "dark";
      lightSources: ReturnType<typeof resolveLightSourcePositions>;
      tokens: Awaited<ReturnType<typeof listMapTokens>>;
    } | null = null;
    const hiderToken = await getMapToken(supabase, combatant.token_id);
    if (hiderToken) {
      const mapId = hiderToken.map_id;
      const [tokens, cells, lightSources, objects] = await Promise.all([
        listMapTokens(supabase, mapId),
        listMapCells(supabase, mapId),
        listLightSources(supabase, mapId),
        listMapObjects(supabase, mapId),
      ]);
      const hiderCell = cells.find(
        (cell) => cell.x === hiderToken.x && cell.y === hiderToken.y
      );
      hiderContext = {
        position: { x: hiderToken.x, y: hiderToken.y },
        // Sparse storage: a cell with no row is the bright default.
        ambientLight: hiderCell?.light_level ?? "bright",
        lightSources: resolveLightSourcePositions(lightSources, objects, tokens),
        tokens,
      };
    }

    // The sweep: every OTHER combatant is an observer. An observer with no
    // character row in the RPC result (an NPC placeholder, or any combatant
    // that simply has no matching row) gets the flat defaults — passive
    // Perception 10, normal vision with no darkvision — the same default
    // either way.
    const hiddenFrom: HideObserverOutcome[] = [];
    const noticedBy: HideObserverOutcome[] = [];
    const couldNotPerceive: HideObserverOutcome[] = [];
    for (const observer of combatants) {
      if (observer.id === combatant.id) continue;
      const observerStats = observer.character_id
        ? (statsByCharacterId.get(observer.character_id) ?? null)
        : null;
      const name =
        observer.npc_name ??
        (observer.character_id ? nameByCharacterId.get(observer.character_id) : undefined) ??
        "Party member";

      // Could this observer perceive the hider at all? Vision-blocked
      // (blinded/petrified/unconscious — combatant-keyed so an NPC
      // observer's blindness counts too) short-circuits to "none"; else
      // the observer's tier on the HIDER's cell, computed from their own
      // position/darkvision against the live lighting.
      let tier: VisibilityTier;
      if (visionBlockedForCombatant(conditions, observer.id)) {
        tier = "none";
      } else if (hiderContext) {
        const observerToken =
          hiderContext.tokens.find((token) => token.id === observer.token_id) ?? null;
        tier = observerToken
          ? computeVisibilityTier({
              observerPosition: { x: observerToken.x, y: observerToken.y },
              vision: {
                darkvisionFeet: observerStats?.darkvision_feet ?? null,
                visionBlocked: false,
              },
              cellPosition: hiderContext.position,
              cellAmbientLight: hiderContext.ambientLight,
              lightSources: hiderContext.lightSources,
            })
          : // An observer with no token on the live map: nothing to compute
            // their perception from — the graceful fallback above.
            "full";
      } else {
        tier = "full";
      }
      if (tier === "none") {
        // They already can't perceive the hider — hiding from them is
        // meaningless, so no comparison and no row.
        couldNotPerceive.push({ combatantId: observer.id, name });
        continue;
      }

      // A PC observer's computed passive Perception; a stat-blocked NPC's
      // stored passive_perception (Prompt 61 — snapshotted stat block via
      // the combatant's monster_stat_block_id); the flat default of 10
      // only for a genuinely bare NPC with neither.
      const passivePerception = observerStats
        ? passiveScore(
            "Perception",
            {
              strength: observerStats.strength,
              dexterity: observerStats.dexterity,
              constitution: observerStats.constitution,
              intelligence: observerStats.intelligence,
              wisdom: observerStats.wisdom,
              charisma: observerStats.charisma,
            },
            observerStats.level,
            observerStats.proficiencies.includes("Perception")
          )
        : (observer.monster_stat_block_id
            ? statBlockById.get(observer.monster_stat_block_id)?.passive_perception
            : undefined) ?? 10;
      // Meets-it-beats-it: a tie or better means they notice — only a
      // strict loss against their passive Perception hides.
      if (total < passivePerception) {
        hiddenFrom.push({ combatantId: observer.id, name, passivePerception });
      } else {
        noticedBy.push({ combatantId: observer.id, name, passivePerception });
      }
    }

    // Persist BEFORE logging (the initiative-path ordering): the fresh
    // hidden set REPLACES whatever a previous attempt left (delete-then-
    // insert — current concealment state, never an accumulation), through
    // plain hider-side RLS (0037's can_write_combatant policies) as a
    // backstop behind the explicit controllership check above.
    try {
      await replaceHiddenAsHider(
        supabase,
        combatant.id,
        hiddenFrom.map((outcome) => outcome.combatantId)
      );
    } catch {
      return NextResponse.json(
        { ok: false, message: "You may not hide that combatant." },
        { status: 403 }
      );
    }

    const label = `Hide (Stealth) — ${character?.name ?? combatant.npc_name ?? "combatant"}`;
    const entry = await insertRoll(supabase, {
      campaign_id: campaignId,
      roller_user_id: user.id,
      character_id: combatant.character_id,
      kind: "hide",
      visibility,
      breakdown: {
        type: "d20",
        label,
        mode,
        d20Rolls: d20.rolls,
        d20Result: d20.result,
        modifiers,
        hide: { hiddenFrom, noticedBy, couldNotPerceive },
      },
      total,
    });
    return NextResponse.json({ ok: true, roll: entry });
  }

  // The NPC stat-block attacker path (Prompt 61) — the SECOND attacker
  // shape alongside the PC path below, never a modification of it: the
  // attacker is a combatant whose snapshotted stat block stores the named
  // attack, and the stored bonus and damageNotation are used DIRECTLY in
  // place of every rules-engine-derived value (no attackBonus() call, no
  // ability-based damage). Authorization is is_campaign_dm, NOT
  // can_write_combatant: an NPC attacker has no owning-player concept at
  // all. The Prompt 59 advantage/disadvantage computation, the Prompt 60
  // hidden-attacker advantage and reveal-on-attack, and the Prompt 53
  // action-economy gate all thread through exactly like the PC path — an
  // asymmetry between the two attacker kinds would just confuse the table.
  if (roll.kind === "attack" && typeof roll.attackerCombatantId === "string") {
    const { data: attackerCombatant, error: attackerError } = await supabase
      .from("combat_combatants")
      .select(
        "id, encounter_id, token_id, character_id, npc_name, monster_stat_block_id, action_used, encounter:combat_encounters!inner(campaign_id, ended_at, current_turn_index)"
      )
      .eq("id", roll.attackerCombatantId)
      .maybeSingle();
    if (attackerError) throw attackerError;
    const encounter = (attackerCombatant?.encounter ?? null) as {
      campaign_id: string;
      ended_at: string | null;
      current_turn_index: number;
    } | null;
    if (!attackerCombatant || encounter?.campaign_id !== campaignId) {
      return NextResponse.json({ ok: false, message: "Combatant not found." }, { status: 404 });
    }
    if (encounter.ended_at !== null) {
      return badRequest("That encounter has already ended.");
    }
    if (attackerCombatant.character_id !== null || !attackerCombatant.monster_stat_block_id) {
      return badRequest("That combatant has no stat block to attack with.");
    }

    // DM-only, checked BEFORE any die is rolled — the hide branch's
    // refuse-up-front arrangement, with the stricter gate: there is no
    // owning player to fall back to for an NPC attacker.
    const callerIsDM = await isDM(supabase, campaignId, user.id);
    if (!callerIsDM) {
      return NextResponse.json(
        { ok: false, message: "Only the DM can attack with a monster." },
        { status: 403 }
      );
    }

    const { data: statBlock, error: statBlockError } = await supabase
      .from("monster_stat_blocks")
      .select()
      .eq("id", attackerCombatant.monster_stat_block_id)
      .maybeSingle();
    if (statBlockError) throw statBlockError;
    if (!statBlock) {
      return badRequest("That combatant's stat block no longer exists.");
    }
    const attacks = (statBlock.attacks ?? []) as {
      name?: unknown;
      bonus?: unknown;
      damageNotation?: unknown;
    }[];
    const statAttack = attacks.find(
      (candidate) =>
        typeof candidate.name === "string" &&
        typeof roll.attackName === "string" &&
        candidate.name === roll.attackName &&
        typeof candidate.bonus === "number" &&
        typeof candidate.damageNotation === "string"
    ) as { name: string; bonus: number; damageNotation: string } | undefined;
    if (!statAttack) {
      return badRequest("That stat block has no such attack.");
    }
    const damageExpression = parseDiceNotation(statAttack.damageNotation);
    if (!damageExpression) {
      return badRequest("That attack's stored damage dice aren't valid.");
    }
    if (
      typeof roll.targetAc !== "number" ||
      !Number.isInteger(roll.targetAc) ||
      roll.targetAc < 1 ||
      roll.targetAc > 99
    ) {
      return badRequest("Enter the target's AC (1-99).");
    }
    const targetAc = roll.targetAc;
    const targetCharacterId =
      typeof roll.targetCharacterId === "string" ? roll.targetCharacterId : null;
    const requestTargetTokenId =
      typeof roll.targetTokenId === "string" ? roll.targetTokenId : null;
    const targetName =
      typeof roll.targetName === "string" && roll.targetName.trim() !== ""
        ? roll.targetName.trim().slice(0, 80)
        : null;

    // One encounter-wide load covers the economy gate, the target's
    // condition flags, the attacker's vision-blocked state, and the
    // hidden-attacker lookup — the PC path's arrangement, minus the extra
    // getActiveCombatEncounter read (the attacker's own encounter IS the
    // active one, validated above).
    const combatants = await listCombatCombatants(supabase, attackerCombatant.encounter_id);
    const conditions =
      combatants.length > 0
        ? await listCombatantConditions(
            supabase,
            combatants.map((candidate) => candidate.id)
          )
        : [];

    // Action economy (Prompt 53), gated exactly like a PC attack for
    // consistency: applies only when the monster IS the current combatant
    // — in Strict mode a spent action rejects here BEFORE any die is
    // rolled; Freeform never rejects but still marks usage below.
    let economyCombatantId: string | null = null;
    if (combatants.length > 0) {
      const turnIndex = Math.min(encounter.current_turn_index, combatants.length - 1);
      const current = combatants[turnIndex];
      if (current && current.id === attackerCombatant.id) {
        if (campaign.action_economy_strict && current.action_used) {
          return badRequest("This monster has already used its action this turn.");
        }
        economyCombatantId = current.id;
      }
    }

    // Vision/condition-driven advantage and disadvantage (Prompt 59) —
    // the PC path's computation with the Prompt 59-anticipated NPC
    // attacker defaults: normal vision, no darkvision (the lightweight
    // stat block carries no vision field; the DM's manual toggle covers a
    // monster whose actual vision differs).
    const advantageSources: string[] = [];
    const disadvantageSources: string[] = [];
    if (mode === "advantage") advantageSources.push("manually selected");
    if (mode === "disadvantage") disadvantageSources.push("manually selected");

    const targetCombatant =
      combatants.find(
        (candidate) =>
          (requestTargetTokenId !== null && candidate.token_id === requestTargetTokenId) ||
          (targetCharacterId !== null && candidate.character_id === targetCharacterId)
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

    // Attacking from hiding (Prompt 60): a hidden NPC attacker gets the
    // advantage and the reveal-on-attack exactly like a PC.
    let hiddenAttackerCombatantId: string | null = null;
    const hiddenRows = await listCombatantHiddenFrom(supabase, [attackerCombatant.id]);
    if (hiddenRows.length > 0) {
      hiddenAttackerCombatantId = attackerCombatant.id;
      if (
        targetCombatant &&
        hiddenRows.some((row) => row.observer_combatant_id === targetCombatant.id)
      ) {
        advantageSources.push("attacking from hiding");
      }
    }

    // The perception check — the PC path's exact computation with the NPC
    // defaults, both positions resolved through their own tokens' own
    // current map_id (0046), NOT campaign.live_map — see the Hide branch's
    // own comment above for why. Attacker and target must actually share a
    // map for there to be anything to compute perception FROM; anything
    // else (either token gone, or the two on different maps) is the same
    // graceful "no visibility source added" fallback as a missing live map
    // always was.
    if (requestTargetTokenId) {
      const [attackerToken, targetToken] = await Promise.all([
        getMapToken(supabase, attackerCombatant.token_id),
        getMapToken(supabase, requestTargetTokenId),
      ]);
      if (attackerToken && targetToken && attackerToken.map_id === targetToken.map_id) {
        const mapId = attackerToken.map_id;
        const [tokens, cells, lightSources, objects] = await Promise.all([
          listMapTokens(supabase, mapId),
          listMapCells(supabase, mapId),
          listLightSources(supabase, mapId),
          listMapObjects(supabase, mapId),
        ]);
        const targetCell = cells.find(
          (cell) => cell.x === targetToken.x && cell.y === targetToken.y
        );
        const tier = computeVisibilityTier({
          observerPosition: { x: attackerToken.x, y: attackerToken.y },
          vision: {
            darkvisionFeet: null,
            visionBlocked: visionBlockedForCombatant(conditions, attackerCombatant.id),
          },
          cellPosition: { x: targetToken.x, y: targetToken.y },
          // Sparse storage: a cell with no row is the bright default.
          cellAmbientLight: targetCell?.light_level ?? "bright",
          lightSources: resolveLightSourcePositions(lightSources, objects, tokens),
        });
        if (tier === "none") disadvantageSources.push("target not perceived");
      }
    }

    const rolledMode = combineAdvantageSources(advantageSources, disadvantageSources).mode;
    const d20 = rollD20(rolledMode);
    // The stat block's stored number IS the whole bonus — no ability
    // modifier, no proficiency, nothing derived.
    const modifiers: RollModifierPart[] = [{ label: "Attack bonus", value: statAttack.bonus }];
    const total = d20.result + statAttack.bonus;
    const outcome = resolveAttackOutcome(d20.result, statAttack.bonus, targetAc);
    const monsterName = attackerCombatant.npc_name ?? statBlock.name;
    const label = `${monsterName} — ${statAttack.name}`;

    let damage: AttackResolution["damage"] = null;
    if (outcome.hit) {
      const rolled = rollExpression(
        outcome.critical ? doubleDiceExpression(damageExpression) : damageExpression
      );
      damage = {
        notation: statAttack.damageNotation.trim(),
        doubled: outcome.critical,
        groups: rolled.groups,
        modifier: rolled.modifier,
        total: Math.max(0, rolled.total),
      };
      if (targetCharacterId && damage.total > 0) {
        const attack: AttackResolution = {
          attackKind: "stat_block",
          targetAc,
          targetName,
          targetCharacterId,
          ...outcome,
          damage,
          applied: null,
          attackerCombatantId: attackerCombatant.id,
          attackName: statAttack.name,
          // Placeholders — resolveNpcAttackDamage splices in the RPC's
          // real outcome, exactly like the PC path.
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
        // resolve_npc_attack_damage (0038): DM-only attacker-side
        // authorization, the target-side clamp/death-save/instant-death/
        // concentration bookkeeping and the atomic roll_log insert all
        // mirroring resolve_attack_damage — a failure logs nothing.
        try {
          const entry = await resolveNpcAttackDamage(
            supabase,
            campaignId,
            user.id,
            attackerCombatant.id,
            targetCharacterId,
            damage.total,
            outcome.critical,
            breakdown,
            total
          );
          if (economyCombatantId) {
            await setCombatantEconomyFlag(supabase, economyCombatantId, "action_used", true);
          }
          if (hiddenAttackerCombatantId) {
            await clearHiddenAsHider(supabase, hiddenAttackerCombatantId);
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

    // The miss/untargeted path: the roll proceeded, so the action is
    // spent and a hidden attacker is revealed — the PC path's
    // miss-still-costs reasoning, both sides.
    if (economyCombatantId) {
      await setCombatantEconomyFlag(supabase, economyCombatantId, "action_used", true);
    }
    if (hiddenAttackerCombatantId) {
      await clearHiddenAsHider(supabase, hiddenAttackerCombatantId);
    }
    const entry = await insertRoll(supabase, {
      campaign_id: campaignId,
      roller_user_id: user.id,
      character_id: null,
      kind: "attack",
      visibility,
      breakdown: {
        type: "d20",
        label,
        mode: rolledMode,
        d20Rolls: d20.rolls,
        d20Result: d20.result,
        modifiers,
        attack: {
          attackKind: "stat_block",
          targetAc,
          targetName,
          targetCharacterId,
          ...outcome,
          damage,
          applied: null,
          attackerCombatantId: attackerCombatant.id,
          attackName: statAttack.name,
          instantDeath: false,
          deathSaveFailureAdded: 0,
          advantageSources,
          disadvantageSources,
        },
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
  // The attacker's combatant when they hold any hidden-from state as hider
  // (Prompt 60) — set inside the attack block below and consumed by the
  // reveal-on-attack deletes after the roll resolves. Order matters:
  // advantage is computed from the PRE-attack hidden state; the reveal is
  // a side effect of the attack COMPLETING, strictly after the roll.
  let hiddenAttackerCombatantId: string | null = null;
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

    // Attacking from hiding (Prompt 60): the attacker's combatant resolved
    // from the same encounter-wide load the target lookup above rides —
    // NOT a third parallel query (currentCombatantForAttacker answers a
    // different question: "is it their TURN"; a hidden attacker reveals
    // regardless of whose turn it is). If they hold a hidden-from row
    // against THIS target, the attack gains advantage; holding ANY rows as
    // hider flags them for the reveal-on-attack deletes after the roll —
    // per SRD, attacking gives their position away to everyone, not just
    // the creature they swung at.
    const attackerCombatant =
      combatants.find((candidate) => candidate.character_id === character.id) ?? null;
    if (attackerCombatant) {
      const hiddenRows = await listCombatantHiddenFrom(supabase, [attackerCombatant.id]);
      if (hiddenRows.length > 0) {
        hiddenAttackerCombatantId = attackerCombatant.id;
        if (
          targetCombatant &&
          hiddenRows.some((row) => row.observer_combatant_id === targetCombatant.id)
        ) {
          advantageSources.push("attacking from hiding");
        }
      }
    }

    // The perception check: disadvantage when the attacker cannot SEE the
    // target at all — computeVisibilityTier === "none" for the target's
    // cell, evaluated from the attacker's position/vision/blocked state
    // ("dim" deliberately does NOT qualify: RAW disadvantage is for an
    // unseen target, not a dimly-lit one). Both positions resolved through
    // their own tokens' own current map_id (0046), NOT campaign.live_map —
    // see the Hide branch's own comment above for why. The attacker here is
    // the ROLLING player's own character, resolved by character_id directly
    // (getCharacterCurrentToken) rather than through attackerCombatant's
    // token_id: a PC attacking doesn't always have a tracked combatant row
    // (attackerCombatant is null outside an active encounter, or if this
    // character was never added to it), so the token search can't route
    // through combat state the way the Hide/NPC-attack branches do. Anything
    // missing (either token gone, or the two on different maps) is the same
    // graceful "no visibility source added" fallback as a missing live map
    // always was. A blinded ATTACKER needs no special case: their
    // vision-blocked tier is "none" for every cell, so this same check
    // already lands the disadvantage.
    if (requestTargetTokenId) {
      const [attackerToken, targetToken] = await Promise.all([
        getCharacterCurrentToken(supabase, character.id),
        getMapToken(supabase, requestTargetTokenId),
      ]);
      if (attackerToken && targetToken && attackerToken.map_id === targetToken.map_id) {
        const mapId = attackerToken.map_id;
        const [tokens, cells, lightSources, objects] = await Promise.all([
          listMapTokens(supabase, mapId),
          listMapCells(supabase, mapId),
          listLightSources(supabase, mapId),
          listMapObjects(supabase, mapId),
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
    // Click-to-attack follow-up: captured alongside targetCharacterId so
    // the branch below can auto-apply damage to an NPC target too (see
    // resolvePcAttackOnNpcDamage) — absent (undefined) rather than null so
    // a pre-existing caller that never sent this field stays byte-
    // identical, matching every other optional AttackResolution field's
    // own convention.
    const targetTokenId =
      typeof roll.targetTokenId === "string" ? roll.targetTokenId : null;
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
          targetTokenId,
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
          // Reveal on attack (Prompt 60): the hidden attacker's position
          // is given away to EVERYONE — every hidden-from row they held as
          // hider goes, not just the target's — alongside marking the
          // action, strictly AFTER the advantage computation above read
          // the pre-attack state.
          if (hiddenAttackerCombatantId) {
            await clearHiddenAsHider(supabase, hiddenAttackerCombatantId);
          }
          return NextResponse.json({ ok: true, roll: entry });
        } catch (err) {
          const message =
            err && typeof err === "object" && "message" in err && typeof err.message === "string"
              ? err.message
              : "Could not apply the damage.";
          return NextResponse.json({ ok: false, message }, { status: 403 });
        }
      } else if (targetTokenId && damage.total > 0) {
        // Click-to-attack follow-up: the NPC-target counterpart of the
        // branch above — closes the gap where a PC's hit on an NPC token
        // never auto-applied (the DM previously had to reach for
        // apply_npc_hp_delta by hand every time, in AND out of combat
        // alike). Same shape as the PC-target branch: build the breakdown
        // with a null placeholder, let the RPC splice in the real
        // `applied`, return directly on success so nothing double-logs.
        attack = {
          attackKind: attackContext.attackKind,
          targetAc: roll.targetAc,
          targetName,
          targetCharacterId: null,
          targetTokenId,
          ...outcome,
          damage,
          applied: null,
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
        try {
          const entry = await resolvePcAttackOnNpcDamage(
            supabase,
            campaignId,
            user.id,
            character.id,
            targetTokenId,
            damage.total,
            outcome.critical,
            breakdown,
            total
          );
          if (economyCombatantId) {
            await setCombatantEconomyFlag(supabase, economyCombatantId, "action_used", true);
          }
          if (hiddenAttackerCombatantId) {
            await clearHiddenAsHider(supabase, hiddenAttackerCombatantId);
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
      targetTokenId,
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
  // Reveal on attack, the miss/untargeted counterpart of the resolved-
  // damage path above: swinging from hiding gives the position away even
  // on a miss (the miss-still-costs reasoning); hiddenAttackerCombatantId
  // is only ever set for the attack kind, after the advantage sources were
  // read from the pre-attack state.
  if (hiddenAttackerCombatantId) {
    await clearHiddenAsHider(supabase, hiddenAttackerCombatantId);
  }

  const entry = await insertRoll(supabase, {
    campaign_id: campaignId,
    roller_user_id: user.id,
    character_id: character.id,
    kind: roll.kind,
    visibility,
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
