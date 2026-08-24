"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createServerSupabaseClient } from "@/data-access/supabase-server";
import { transferDM } from "@/data-access";
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
