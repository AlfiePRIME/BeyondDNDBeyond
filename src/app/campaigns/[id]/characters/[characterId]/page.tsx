import { notFound, redirect } from "next/navigation";
import { CLASSES, spellSlotsForClass, type ClassName, type SpellSlotLevel } from "@/rules-engine";
import { createServerSupabaseClient } from "@/data-access/supabase-server";
import {
  getCharacter,
  isDM,
  listCharacterResources,
  createCharacterResource,
  type CharacterResource,
} from "@/data-access";
import { CharacterSheet } from "./CharacterSheet";

const SLOT_LEVELS: SpellSlotLevel[] = [1, 2, 3, 4, 5, 6, 7, 8, 9];
const ORDINAL: Record<SpellSlotLevel, string> = {
  1: "1st",
  2: "2nd",
  3: "3rd",
  4: "4th",
  5: "5th",
  6: "6th",
  7: "7th",
  8: "8th",
  9: "9th",
};

function spellSlotResourceName(level: SpellSlotLevel): string {
  return `${ORDINAL[level]}-Level Spell Slots`;
}

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
    const missing = SLOT_LEVELS.filter(
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

  return (
    <CharacterSheet
      campaignId={campaignId}
      initialCharacter={character}
      initialResources={resources}
      canEdit={canEdit}
    />
  );
}
