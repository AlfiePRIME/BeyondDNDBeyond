"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { createBrowserSupabaseClient } from "@/data-access/supabase-browser";
import { startSession, type SupabaseClient } from "@/data-access";
import { joinCampaignRoomChannel, type ChannelIdentity, type PresenceMember } from "@/realtime";
import { useLobby } from "./LobbyProvider";

export { SESSION_STARTED_EVENT, type SessionStartedPayload } from "./sessionEvents";

const PRESENCE_PROBE_TIMEOUT_MS = 4000;

/**
 * Briefly joins a campaign's Game-Room channel to count who's REALLY at the
 * table — the only way to tell a live session from a stranded session_active
 * flag (Postgres can't see Realtime's in-memory presence). Waits until the
 * probe's own presence appears (proof a real sync happened) rather than
 * trusting the immediate, possibly-empty snapshot, then excludes itself.
 */
export async function countOthersAtTable(
  supabase: SupabaseClient,
  campaignId: string,
  identity: ChannelIdentity
): Promise<number> {
  const channel = joinCampaignRoomChannel(supabase, campaignId, identity);
  try {
    const members = await new Promise<PresenceMember[]>((resolve) => {
      let settled = false;
      const finish = (snapshot: PresenceMember[]) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(snapshot);
      };
      const timer = setTimeout(() => finish(channel.getPresentMembers()), PRESENCE_PROBE_TIMEOUT_MS);
      channel.onPresenceChange((snapshot) => {
        if (snapshot.some((member) => member.userId === identity.userId)) finish(snapshot);
      });
    });
    return members.filter((member) => member.userId !== identity.userId).length;
  } finally {
    void channel.leave();
  }
}

function errorMessage(err: unknown): string | null {
  if (err && typeof err === "object" && "message" in err) {
    const { message } = err as { message: unknown };
    if (typeof message === "string") return message;
  }
  return null;
}

/**
 * Hosting a game: the caller becomes the campaign's DM for this session
 * (start_session), everyone online is told it's open to join, and the host
 * goes straight to the table. No minimum number of people online — the host
 * can set up and wait for the party to join.
 */
export function useHostGame(identity: ChannelIdentity) {
  const router = useRouter();
  const lobby = useLobby();
  const [hostingId, setHostingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const host = useCallback(
    async (campaign: { id: string; name: string }) => {
      const supabase = createBrowserSupabaseClient();
      setError(null);
      setHostingId(campaign.id);
      try {
        try {
          await startSession(supabase, campaign.id);
        } catch (err) {
          if (errorMessage(err)?.includes("already has a session in progress")) {
            // Someone is genuinely at the table → it's joinable, not hostable.
            const others = await countOthersAtTable(supabase, campaign.id, identity);
            if (others > 0) throw new Error(`“${campaign.name}” already has a game in progress — join it instead.`);
            await startSession(supabase, campaign.id, { reclaimAbandoned: true });
          } else {
            throw err;
          }
        }
        await lobby?.publishSessionStarted({
          campaignId: campaign.id,
          campaignName: campaign.name,
          hostName: identity.displayName,
        });
        router.push(`/campaigns/${campaign.id}/room`);
      } catch (err) {
        setError(errorMessage(err) ?? "Could not start hosting.");
        setHostingId(null);
      }
    },
    [identity, lobby, router]
  );

  return { host, hostingId, error };
}
