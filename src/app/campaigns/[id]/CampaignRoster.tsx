"use client";

import { useEffect, useState } from "react";
import { Badge } from "@/ui-components";
import { createBrowserSupabaseClient } from "@/data-access/supabase-browser";
import { joinCampaignChannel } from "@/realtime";
import type { CampaignMember } from "@/data-access";
import styles from "./campaign.module.css";

export function CampaignRoster({
  campaignId,
  currentUserId,
  currentUserDisplayName,
  members,
}: {
  campaignId: string;
  currentUserId: string;
  currentUserDisplayName: string | null;
  members: CampaignMember[];
}) {
  const [onlineUserIds, setOnlineUserIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    const supabase = createBrowserSupabaseClient();
    const channel = joinCampaignChannel(supabase, campaignId, {
      userId: currentUserId,
      displayName: currentUserDisplayName,
    });

    const unsubscribe = channel.onPresenceChange((present) => {
      setOnlineUserIds(new Set(present.map((member) => member.userId)));
    });

    return () => {
      unsubscribe();
      void channel.leave();
    };
  }, [campaignId, currentUserId, currentUserDisplayName]);

  return (
    <ul className={styles.memberList}>
      {members.map((member) => (
        <li key={member.user_id} className={styles.memberRow}>
          <span>{member.display_name ?? "Unnamed player"}</span>
          <span className={styles.characterMeta}>
            <Badge tone={member.role === "dm" ? "pink" : "teal"}>{member.role === "dm" ? "DM" : "Player"}</Badge>
            {onlineUserIds.has(member.user_id) ? (
              <Badge tone="teal" pulse>
                Online
              </Badge>
            ) : (
              <Badge tone="neutral">Offline</Badge>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}
