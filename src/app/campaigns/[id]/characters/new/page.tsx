import { notFound, redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/data-access/supabase-server";
import { CharacterWizard } from "./CharacterWizard";

export default async function NewCharacterPage({ params }: { params: Promise<{ id: string }> }) {
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

  return <CharacterWizard campaignId={campaignId} campaignName={campaign.name} userId={user.id} />;
}
