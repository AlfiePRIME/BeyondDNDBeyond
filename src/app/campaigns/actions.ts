"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createServerSupabaseClient } from "@/data-access/supabase-server";
import { createCampaign, joinCampaignByInviteCode } from "@/data-access";
import type { FormActionState } from "../actions";

export type { FormActionState } from "../actions";

export async function createCampaignAction(
  _prevState: FormActionState,
  formData: FormData
): Promise<FormActionState> {
  const name = String(formData.get("name") ?? "").trim();
  if (!name) {
    return { error: "Campaign name is required." };
  }

  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  let campaign;
  try {
    campaign = await createCampaign(supabase, { name, creatorId: user.id });
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not create the campaign." };
  }

  revalidatePath("/campaigns");
  redirect(`/campaigns/${campaign.id}`);
}

export async function joinCampaignAction(
  _prevState: FormActionState,
  formData: FormData
): Promise<FormActionState> {
  const inviteCode = String(formData.get("inviteCode") ?? "").trim();
  if (!inviteCode) {
    return { error: "Enter an invite code." };
  }

  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  let joined;
  try {
    joined = await joinCampaignByInviteCode(supabase, inviteCode);
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not join that campaign." };
  }

  revalidatePath("/campaigns");
  redirect(`/campaigns/${joined.campaignId}`);
}
