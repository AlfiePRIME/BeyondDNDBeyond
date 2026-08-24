import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { Panel } from "@/ui-components";
import { createServerSupabaseClient } from "@/data-access/supabase-server";
import { listSessionLogEntries, isDM } from "@/data-access";
import { SessionLog } from "./SessionLog";
import styles from "./session-log.module.css";

export default async function CampaignSessionLogPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
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

  // Any member can browse the log (matching session_log's read RLS from
  // 0020); only the DM gets the write form.
  const [entries, currentUserIsDM] = await Promise.all([
    listSessionLogEntries(supabase, campaignId),
    isDM(supabase, campaignId, user.id),
  ]);

  return (
    <div className={styles.page}>
      <main className={styles.main}>
        <Link href={`/campaigns/${campaignId}`} className={styles.backLink}>
          ← Back to {campaign.name}
        </Link>

        <Panel title="Session log" tone="purple" glow>
          <p className={styles.hint}>
            The story of {campaign.name} so far, one session at a time — oldest first.
          </p>
          <SessionLog campaignId={campaignId} initialEntries={entries} canManage={currentUserIsDM} />
        </Panel>
      </main>
    </div>
  );
}
