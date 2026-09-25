"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { createBrowserSupabaseClient } from "@/data-access/supabase-browser";
import { subscribeToCampaignChanges } from "@/data-access";

/** Re-renders the page whenever one of these campaigns starts, pauses, or
 * ends a session, so the live-game list and Join buttons stay current. */
export function LiveGamesRefresher({ campaignIds }: { campaignIds: string[] }) {
  const router = useRouter();
  const key = campaignIds.join(",");
  useEffect(() => {
    const supabase = createBrowserSupabaseClient();
    const lastState = new Map<string, string>();
    const unsubscribers = key
      .split(",")
      .filter(Boolean)
      .map((id) =>
        subscribeToCampaignChanges(supabase, id, (campaign) => {
          const state = `${campaign.session_active}:${campaign.session_started_at}`;
          const previous = lastState.get(id);
          lastState.set(id, state);
          if (previous !== undefined && previous !== state) router.refresh();
          if (previous === undefined) router.refresh();
        })
      );
    return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
  }, [key, router]);
  return null;
}
