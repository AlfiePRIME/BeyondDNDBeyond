import { notFound, redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/data-access/supabase-server";
import { listCampaignMembers } from "@/data-access";
import { GameRoom } from "./GameRoom";

export default async function GameRoomPage({ params }: { params: Promise<{ id: string }> }) {
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
  // RLS returns no row for a campaign you're not a member of — same 404
  // reasoning as the campaign detail page.
  if (!campaign) notFound();

  const members = await listCampaignMembers(supabase, campaignId);

  return (
    <GameRoom
      campaignId={campaignId}
      campaignName={campaign.name}
      members={members}
      currentUserId={user.id}
    />
  );
}
