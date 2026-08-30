import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { SectionHeader } from "@/ui-components";
import { createServerSupabaseClient } from "@/data-access/supabase-server";
import {
  getActiveCombatEncounter,
  isDM,
  listCampaignMembers,
  listCharacterConditions,
  listCharactersForCampaign,
  listCombatCombatants,
  listCombatantConditions,
  type CharacterCondition,
  type CombatantCondition,
} from "@/data-access";
import { PartyDashboard } from "./PartyDashboard";
import styles from "./party.module.css";

/**
 * The DM party dashboard — the roster/overview layer the "Manage
 * characters" control in the Game Room's top bar opens in its own tab.
 * Every character in the campaign at a glance (level, XP + distance to the
 * next SRD threshold, HP, active conditions from BOTH sources) with inline
 * DM controls: award XP, confirm a threshold-crossed level-up, apply or
 * remove conditions (no combat required — 0101's character_conditions),
 * and grant advantage/disadvantage for the character's next roll wherever
 * it happens. Clicking a character goes to their EXISTING full sheet —
 * this page deliberately rebuilds nothing the sheet already is.
 */
export default async function PartyDashboardPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: campaignId } = await params;
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: campaign, error: campaignError } = await supabase
    .from("campaigns")
    .select("id, name")
    .eq("id", campaignId)
    .maybeSingle();
  if (campaignError) throw campaignError;
  // RLS hides campaigns you're not a member of — same 404 reasoning as the
  // campaign detail page.
  if (!campaign) notFound();

  const currentUserIsDM = await isDM(supabase, campaignId, user.id);
  // A player has no business here at all — characters RLS would trim the
  // roster to just their own anyway, and every control on the page is a
  // DM-only mutation at the data layer. Bounce them rather than render a
  // page of dead controls — the dm-notes redirect instinct exactly.
  if (!currentUserIsDM) redirect(`/campaigns/${campaignId}`);

  const [characters, members] = await Promise.all([
    listCharactersForCampaign(supabase, campaignId),
    listCampaignMembers(supabase, campaignId),
  ]);
  const characterIds = characters.map((character) => character.id);

  // Pre-0101 tolerance: until the migration is applied character_conditions
  // doesn't exist, and this page must still render (the verify script's
  // blocked-not-failed convention) — no conditions, not a 500.
  let characterConditions: CharacterCondition[] = [];
  try {
    characterConditions = await listCharacterConditions(supabase, characterIds);
  } catch {
    characterConditions = [];
  }

  // Combat-scoped conditions for any character currently in the active
  // encounter, keyed back to character ids for the merged-by-key display —
  // the sheet's dual-source arrangement, roster-wide.
  const encounter = await getActiveCombatEncounter(supabase, campaignId);
  const combatants = encounter ? await listCombatCombatants(supabase, encounter.id) : [];
  const combatConditionRows: CombatantCondition[] =
    combatants.length > 0
      ? await listCombatantConditions(
          supabase,
          combatants.map((combatant) => combatant.id)
        )
      : [];
  const characterIdByCombatant = new Map(
    combatants
      .filter((combatant) => combatant.character_id !== null)
      .map((combatant) => [combatant.id, combatant.character_id as string])
  );
  const initialCombatConditions = combatConditionRows.flatMap((row) => {
    const characterId = characterIdByCombatant.get(row.combatant_id);
    return characterId
      ? [{ character_id: characterId, condition_key: row.condition_key, level: row.level }]
      : [];
  });

  const ownerNames = Object.fromEntries(
    members.map((member) => [member.user_id, member.display_name])
  );

  return (
    <div className={styles.page}>
      <main className={styles.main}>
        <div className={styles.headerRow}>
          <Link href={`/campaigns/${campaignId}`} className={styles.backLink}>
            ← Back to {campaign.name}
          </Link>
        </div>
        <SectionHeader eyebrow="DM party dashboard" title={campaign.name} as="h1" />
        <PartyDashboard
          campaignId={campaignId}
          initialCharacters={characters}
          initialCharacterConditions={characterConditions}
          initialCombatConditions={initialCombatConditions}
          ownerNames={ownerNames}
        />
      </main>
    </div>
  );
}
