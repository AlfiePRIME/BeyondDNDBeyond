import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { Panel } from "@/ui-components";
import { createServerSupabaseClient } from "@/data-access/supabase-server";
import { listNpcs, getNpcPortraitSignedUrl, isDM } from "@/data-access";
import { isAiConfigured } from "@/ai";
import { NpcRoster, type RosterNpc } from "./NpcRoster";
import styles from "./npcs.module.css";

// Same known limitation (deliberate) as the asset palette's URL resolution:
// no refresh before expiry — a roster tab left open past this window shows
// broken portraits until reload.
const SIGNED_URL_TTL_SECONDS = 6 * 60 * 60;

export default async function CampaignNpcsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: campaignId } = await params;
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: campaign, error } = await supabase
    .from("campaigns")
    .select()
    .eq("id", campaignId)
    .maybeSingle();
  if (error) throw error;
  // RLS hides campaigns you're not a member of — same 404 reasoning as the
  // campaign detail page.
  if (!campaign) notFound();

  // Any member can browse the roster (matching npcs' read RLS from 0020);
  // only the DM gets the create/edit/delete controls.
  const [npcs, currentUserIsDM] = await Promise.all([
    listNpcs(supabase, campaignId),
    isDM(supabase, campaignId, user.id),
  ]);

  const initialNpcs: RosterNpc[] = await Promise.all(
    npcs.map(async (npc) => {
      if (!npc.portrait_ref) return { ...npc, portraitUrl: null };
      try {
        return {
          ...npc,
          portraitUrl: await getNpcPortraitSignedUrl(supabase, npc.portrait_ref, SIGNED_URL_TTL_SECONDS),
        };
      } catch {
        // One unsignable portrait degrades to the placeholder, not a 500.
        return { ...npc, portraitUrl: null };
      }
    })
  );

  return (
    <div className={styles.page}>
      <main className={styles.main}>
        <Link href={`/campaigns/${campaignId}`} className={styles.backLink}>
          ← Back to {campaign.name}
        </Link>

        <Panel title="NPC roster" tone="purple" glow>
          <p className={styles.rosterHint}>
            Everyone {campaign.name}&apos;s party has met — or is yet to meet.
          </p>
          <NpcRoster
            campaignId={campaignId}
            initialNpcs={initialNpcs}
            canManage={currentUserIsDM}
            aiEnabled={isAiConfigured()}
          />
        </Panel>
      </main>
    </div>
  );
}
