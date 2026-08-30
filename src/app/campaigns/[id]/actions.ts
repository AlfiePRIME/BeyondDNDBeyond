"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createServerSupabaseClient } from "@/data-access/supabase-server";
import { transferDM, removeCampaignMember } from "@/data-access";
import type { FormActionState } from "../../actions";

export async function transferDMAction(
  campaignId: string,
  _prevState: FormActionState,
  formData: FormData
): Promise<FormActionState> {
  const newDmUserId = String(formData.get("newDmUserId") ?? "").trim();
  if (!newDmUserId) {
    return { error: "Choose who to hand the DM role to." };
  }

  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  try {
    await transferDM(supabase, campaignId, newDmUserId);
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not transfer the DM role." };
  }

  revalidatePath(`/campaigns/${campaignId}`);
  return {};
}

/**
 * DM removes another member — a bound (campaignId, targetUserId) action,
 * the transferDMAction shape, called only from a "Confirm remove" button
 * that already required its own two-step confirm in RemoveMemberForm (no
 * `formData` field carries the target: it's baked into the bound action
 * itself, not user-editable form input). Final authorization is RLS
 * (0099_dm_remove_member.sql) either way, same as every other DM action in
 * this file.
 */
export async function removeCampaignMemberAction(
  campaignId: string,
  targetUserId: string
): Promise<FormActionState> {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  try {
    await removeCampaignMember(supabase, campaignId, targetUserId);
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not remove that member." };
  }

  revalidatePath(`/campaigns/${campaignId}`);
  revalidatePath("/campaigns");
  revalidatePath("/account");
  return {};
}
