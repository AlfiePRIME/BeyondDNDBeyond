import { notFound, redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/data-access/supabase-server";
import { getProfile, listCampaignMembers } from "@/data-access";
import { resolveAvatarUrl, type RoomMember } from "./avatar-url";
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
  const roomMembers: RoomMember[] = await Promise.all(
    members.map(async (member) => {
      const profile = await getProfile(supabase, member.user_id);
      return {
        ...member,
        avatar_url: await resolveAvatarUrl(
          supabase,
          profile?.avatar_source ?? null,
          profile?.avatar_ref ?? null
        ),
      };
    })
  );

  return (
    <GameRoom
      campaignId={campaignId}
      campaignName={campaign.name}
      members={roomMembers}
      currentUserId={user.id}
    />
  );
}
