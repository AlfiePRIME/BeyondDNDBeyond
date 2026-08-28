import { notFound, redirect } from "next/navigation";
// spellSlotResourceName/SPELL_SLOT_LEVELS were a local ORDINAL table here
// until Prompt 51 extracted them into the rules engine, so the
// quick-actions availability check reads the exact names this page
// provisions.
import { CLASSES, SPELL_SLOT_LEVELS, spellSlotResourceName, spellSlotsForClass, type ClassName } from "@/rules-engine";
import { createServerSupabaseClient } from "@/data-access/supabase-server";
import {
  getActiveCombatantForCharacter,
  getCharacter,
  getCharacterPawn,
  isDM,
  listCharacterResources,
  listCombatantConditions,
  createCharacterResource,
  type CharacterResource,
} from "@/data-access";
import { CharacterSheet } from "./CharacterSheet";

export default async function CharacterSheetPage({
  params,
}: {
  params: Promise<{ id: string; characterId: string }>;
}) {
  const { id: campaignId, characterId } = await params;
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const character = await getCharacter(supabase, characterId);
  // RLS hides characters from everyone but the owner and the campaign DM —
  // same 404 reasoning as the campaign detail page. Also 404 a character
  // reached via a URL for the wrong campaign.
  if (!character || character.campaign_id !== campaignId) notFound();

  // Anyone who can see the character at all (per the RLS above) is the owner
  // or the DM, both of whom may edit — canEdit is defense-in-depth for the
  // Client Component, not a reachable read-only mode.
  const canEdit = character.owner_id === user.id || (await isDM(supabase, campaignId, user.id));

  const klass = CLASSES.find((c) => c.name === character.class);
  let resources = await listCharacterResources(supabase, characterId);

  // Spell slots are tracked as ordinary character_resources rows. Character
  // creation doesn't provision them, so create any missing slot-level rows
  // on first load of a caster's sheet (idempotent by name).
  if (klass?.spellcastingAbility) {
    const slots = spellSlotsForClass(klass.name as ClassName, character.level);
    const missing = SPELL_SLOT_LEVELS.filter(
      (level) =>
        slots[level] > 0 && !resources.some((r) => r.name === spellSlotResourceName(level))
    );
    if (missing.length > 0) {
      const created: CharacterResource[] = [];
      for (const level of missing) {
        created.push(
          await createCharacterResource(supabase, {
            character_id: characterId,
            name: spellSlotResourceName(level),
            max_uses: slots[level],
            current_uses: slots[level],
            recharge: "long_rest",
          })
        );
      }
      resources = [...resources, ...created];
    }
  }

  // Conditions hang off the character's combatant row in the currently
  // active encounter, if any — a character not in combat simply has none.
  const combatant = await getActiveCombatantForCharacter(supabase, campaignId, characterId);
  const initialConditions = combatant ? await listCombatantConditions(supabase, [combatant.id]) : [];

  // Pawn Customization P2: this character's own pawn appearance row (0080)
  // — always present (the character-creation trigger guarantees it), owner
  // or DM readable, the exact same visibility as `character` itself, so no
  // extra RLS caveat applies here beyond the 404 already checked above.
  const pawn = await getCharacterPawn(supabase, characterId);

  return (
    <CharacterSheet
      campaignId={campaignId}
      initialCharacter={character}
      initialResources={resources}
      initialConditions={initialConditions}
      initialPawnModelRef={pawn?.pawn_model_ref ?? null}
      canEdit={canEdit}
    />
  );
}
