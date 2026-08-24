"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Badge, Button, Modal } from "@/ui-components";
import { createBrowserSupabaseClient } from "@/data-access/supabase-browser";
import {
  listCampaignsForUser,
  startSession,
  type Campaign,
  type CampaignMembership,
  type SupabaseClient,
} from "@/data-access";
import { joinCampaignRoomChannel, type ChannelIdentity, type PresenceMember } from "@/realtime";
import styles from "./page.module.css";

export const SESSION_STARTED_EVENT = "session-started";

export interface SessionStartedPayload {
  campaignId: string;
  campaignName: string;
}

/** More than two adventurers (3+) present unlocks Start. */
export const START_SESSION_MIN_PRESENT = 3;

const PRESENCE_PROBE_TIMEOUT_MS = 4000;

/**
 * Briefly joins a campaign's Game-Room channel to count who's REALLY at
 * the table — the only way to tell a live session from a stranded
 * session_active flag (Postgres can't see Realtime's in-memory presence).
 * Waits until the probe's own presence appears (proof a real sync
 * happened) rather than trusting the immediate, possibly-empty snapshot,
 * then excludes itself from the count.
 */
async function countOthersPresent(
  supabase: SupabaseClient,
  campaignId: string,
  identity: ChannelIdentity
): Promise<number> {
  const channel = joinCampaignRoomChannel(supabase, campaignId, identity);
  try {
    const members = await new Promise<PresenceMember[]>((resolve) => {
      let settled = false;
      // No explicit unsubscribe needed — the finally's channel.leave() clears
      // every presence handler, and the settled guard makes extra calls no-op.
      const finish = (snapshot: PresenceMember[]) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(snapshot);
      };
      const timer = setTimeout(
        () => finish(channel.getPresentMembers()),
        PRESENCE_PROBE_TIMEOUT_MS
      );
      channel.onPresenceChange((snapshot) => {
        if (snapshot.some((member) => member.userId === identity.userId)) finish(snapshot);
      });
    });
    return members.filter((member) => member.userId !== identity.userId).length;
  } finally {
    void channel.leave();
  }
}

type CampaignAvailability = "startable" | "checking" | "in-progress" | "abandoned";

// Not `instanceof Error`: the browser-bundled PostgrestError fails that
// check (transpiled Error subclass), which would misroute a real "already
// in progress" rejection into the generic fallback.
function errorMessage(err: unknown): string | null {
  if (err && typeof err === "object" && "message" in err) {
    const { message } = err as { message: unknown };
    if (typeof message === "string") return message;
  }
  return null;
}

export function StartSessionControl({
  currentUserId,
  currentUserDisplayName,
  lobbyMemberCount,
  publishSessionStarted,
}: {
  currentUserId: string;
  currentUserDisplayName: string | null;
  lobbyMemberCount: number;
  publishSessionStarted: (payload: SessionStartedPayload) => Promise<void>;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [memberships, setMemberships] = useState<CampaignMembership[] | null>(null);
  const [availability, setAvailability] = useState<Record<string, CampaignAvailability>>({});
  const [error, setError] = useState<string | null>(null);
  const [startingId, setStartingId] = useState<string | null>(null);

  const identity: ChannelIdentity = {
    userId: currentUserId,
    displayName: currentUserDisplayName,
  };

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const supabase = createBrowserSupabaseClient();

    (async () => {
      const list = await listCampaignsForUser(supabase, currentUserId);
      if (cancelled) return;
      setMemberships(list);
      setAvailability(
        Object.fromEntries(
          list.map((m) => [m.campaign.id, m.campaign.session_active ? "checking" : "startable"])
        )
      );
      // A session_active campaign might be a stranded flag from a crashed
      // room — probe its real presence so a genuinely empty one is offered
      // as reclaimable instead of being disabled forever.
      await Promise.all(
        list
          .filter((m) => m.campaign.session_active)
          .map(async (m) => {
            const others = await countOthersPresent(supabase, m.campaign.id, {
              userId: currentUserId,
              displayName: currentUserDisplayName,
            });
            if (cancelled) return;
            setAvailability((prev) => ({
              ...prev,
              [m.campaign.id]: others === 0 ? "abandoned" : "in-progress",
            }));
          })
      );
    })().catch((err: unknown) => {
      if (!cancelled) {
        setError(errorMessage(err) ?? "Could not load your campaigns.");
      }
    });

    return () => {
      cancelled = true;
    };
  }, [open, currentUserId, currentUserDisplayName]);

  async function handleChoose(campaign: Campaign) {
    const supabase = createBrowserSupabaseClient();
    setError(null);
    setStartingId(campaign.id);
    try {
      try {
        await startSession(supabase, campaign.id);
      } catch (err) {
        if (errorMessage(err)?.includes("already has a session in progress")) {
          // Stale-flag recovery: re-probe right now, and only reclaim if the
          // room is genuinely empty — otherwise surface the real rejection.
          const others = await countOthersPresent(supabase, campaign.id, identity);
          if (others > 0) {
            throw new Error(`“${campaign.name}” already has a session in progress.`);
          }
          await startSession(supabase, campaign.id, { reclaimAbandoned: true });
        } else {
          throw err;
        }
      }
      await publishSessionStarted({ campaignId: campaign.id, campaignName: campaign.name });
      router.push(`/campaigns/${campaign.id}/room`);
    } catch (err) {
      setError(errorMessage(err) ?? "Could not start the session.");
      setStartingId(null);
    }
  }

  const enoughPresent = lobbyMemberCount >= START_SESSION_MIN_PRESENT;

  return (
    <div className={styles.startControl}>
      <Button
        variant="accent"
        disabled={!enoughPresent}
        onClick={() => {
          setMemberships(null);
          setAvailability({});
          setError(null);
          setStartingId(null);
          setOpen(true);
        }}
        data-testid="start-session-button"
      >
        Start
      </Button>
      {!enoughPresent ? (
        <p className={styles.startHint}>
          Start unlocks when more than two adventurers are in the lobby.
        </p>
      ) : null}

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Start a session"
        footer={
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
        }
      >
        <p className={styles.startModalHint}>
          Pick one of your campaigns — you&apos;ll become its DM, and every member here is
          brought straight to its game room.
        </p>
        {memberships === null ? (
          <p className={styles.startModalStatus}>Loading your campaigns…</p>
        ) : memberships.length === 0 ? (
          <p className={styles.startModalStatus}>
            You&apos;re not in any campaigns yet — create or join one first.
          </p>
        ) : (
          <ul className={styles.startList}>
            {memberships.map(({ campaign }) => {
              const state = availability[campaign.id] ?? "startable";
              const disabled =
                state === "in-progress" || state === "checking" || startingId !== null;
              return (
                <li key={campaign.id} className={styles.startRow}>
                  <span className={styles.startName}>{campaign.name}</span>
                  <span className={styles.startRowActions}>
                    {state === "in-progress" ? (
                      <Badge tone="orange">Session in progress</Badge>
                    ) : state === "checking" ? (
                      <Badge tone="neutral" pulse>
                        Checking…
                      </Badge>
                    ) : state === "abandoned" ? (
                      <Badge tone="teal">Abandoned — free to start</Badge>
                    ) : null}
                    <Button
                      size="sm"
                      variant="teal"
                      disabled={disabled}
                      onClick={() => handleChoose(campaign)}
                      data-testid={`start-campaign-${campaign.id}`}
                    >
                      {startingId === campaign.id ? "Starting…" : "Start"}
                    </Button>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        {error ? (
          <p role="alert" className={styles.startError} data-testid="start-session-error">
            {error}
          </p>
        ) : null}
      </Modal>
    </div>
  );
}
