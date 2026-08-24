"use server";

import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/data-access/supabase-server";
import { upsertProfile } from "@/data-access";

export async function completeProfileSetup(formData: FormData) {
  const displayName = String(formData.get("displayName") ?? "").trim();

  if (!displayName) {
    redirect("/profile-setup?error=A display name is required");
  }

  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  await upsertProfile(supabase, user.id, { displayName });
  redirect("/");
}
