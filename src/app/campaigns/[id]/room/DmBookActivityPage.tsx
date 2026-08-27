"use client";

import { useEffect, useMemo, useState } from "react";
import {
  subscribeToInteractionEvents,
  subscribeToRollLog,
  type InteractionEvent,
  type RollLogEntry,
} from "@/data-access";
import { createBrowserSupabaseClient } from "@/data-access/supabase-browser";
import { damageText, rollHeadline } from "../roll/format";
import type { RoomMember } from "./avatar-url";
import roomStyles from "./room.module.css";
import styles from "./DmBook.module.css";

/** Caps how many rows this page keeps in memory per feed — the same
 * "unbounded live session" ceiling DiceLogPanel's own LOG_CAP applies to
 * roll_log, here applied to interaction_events too. Plenty for a single
 * session's worth of triggers/pickups and attacks; older rows are still on
 * the DB for anyone who needs them (e.g. a later B6 summary), just not kept
 * in this component's own state. */
const FEED_CAP = 200;

/** Human labels for the action_type values every known writer path uses
 * (Map Editor Batch A6/A4/A9) — action_type is deliberately freeform at the
 * schema level (interactionEvents.ts's own doc comment) so a future writer
 * can add a new kind without a migration; this falls back to a
 * de-underscored version of the raw value for anything not listed here,
 * rather than hiding or crashing on it. */
const ACTION_VERBS: Record<string, string> = {
  step_on_trigger: "stepped on",
  click_trigger: "triggered",
  item_taken: "took",
  curse_narrative: "triggered a curse via",
  blessing_narrative: "triggered a blessing via",
};

function actionVerb(actionType: string): string {
  return ACTION_VERBS[actionType] ?? actionType.replace(/_/g, " ");
}

/** "who triggered which tagged object" — the event's own copied `tag`
 * (map_objects.tag or map_object_items.tag at the moment it was logged) is
 * the human-readable label; when the source had none set, this falls back
 * to naming which KIND of source it was (an object vs. a concealed pit —
 * the table's own map_object_id/concealed_pit_id CHECK constraint means
 * exactly one is ever set) rather than showing nothing at all. */
function targetLabel(event: InteractionEvent): string {
  if (event.tag) return `"${event.tag}"`;
  return event.map_object_id ? "an untagged object" : "a concealed pit";
}

function activityTimeText(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function upsertNewest<T extends { id: string; created_at: string }>(current: T[], row: T): T[] {
  if (current.some((existing) => existing.id === row.id)) return current;
  return [row, ...current].slice(0, FEED_CAP);
}

/**
 * Chat & Summary B5: the DM's book's live Activity page — a plain,
 * real-time feed of who triggered/took what tagged object (interaction_events,
 * Map Editor Batch A6/A4/A9's shared table) and a view of recent damage-dealt
 * rolls (roll_log, resolveAttackDamage/resolveNpcAttackDamage's own
 * `breakdown.attack.damage`). DM-only — this page is only ever mounted
 * inside DmBook, which GameRoom only renders for `currentUserIsDM`.
 *
 * Deliberately its own postgres_changes subscriptions rather than lifting
 * shared state from GameRoom (mirroring DiceLogPanel's own self-contained
 * "seed from an initial* prop, then subscribe" shape) — this is the only
 * consumer of interaction_events today, and roll_log's existing subscriber
 * (DiceLogPanel) never lifts its own `rolls` state up either. Both feeds
 * update live from ANY connected client's actions (a player's own trigger,
 * pickup, or attack), not just the DM's own, since each subscription rides
 * that table's real RLS-scoped realtime feed rather than the Game Room's
 * own campaign broadcast channel.
 *
 * "Keep this a plain list — no synthesis or summarization here" (this
 * prompt's own Notes) — a later prompt (B6) builds the end-of-session AI
 * summary on top of this same data; this page does no aggregation of its
 * own beyond newest-first ordering.
 */
export function DmBookActivityPage({
  campaignId,
  members,
  initialInteractionEvents,
  initialRolls,
}: {
  campaignId: string;
  members: RoomMember[];
  initialInteractionEvents: InteractionEvent[];
  initialRolls: RollLogEntry[];
}) {
  const [events, setEvents] = useState<InteractionEvent[]>(() => initialInteractionEvents.slice(0, FEED_CAP));
  const [rolls, setRolls] = useState<RollLogEntry[]>(() => initialRolls.slice(0, FEED_CAP));

  useEffect(() => {
    const supabase = createBrowserSupabaseClient();
    return subscribeToInteractionEvents(supabase, campaignId, (event) => {
      setEvents((current) => upsertNewest(current, event));
    });
  }, [campaignId]);

  useEffect(() => {
    const supabase = createBrowserSupabaseClient();
    return subscribeToRollLog(supabase, campaignId, (roll) => {
      setRolls((current) => upsertNewest(current, roll));
    });
  }, [campaignId]);

  const memberNameById = useMemo(
    () => new Map(members.map((member) => [member.user_id, member.display_name])),
    [members]
  );

  function actorName(userId: string | null): string {
    if (!userId) return "Someone";
    return memberNameById.get(userId) ?? "Someone";
  }

  // Damage events: attack rolls that actually resolved a non-null damage
  // block — resolveAttackDamage/resolveNpcAttackDamage only ever populate
  // `breakdown.attack.damage` on a hit (rolls.ts's own route.ts leaves it
  // `null` for a miss), so this is a reliable "damage was dealt" filter,
  // not a guess based on `hit` alone.
  const damageRolls = useMemo(
    () =>
      rolls.filter(
        (roll) => roll.breakdown.type === "d20" && roll.breakdown.attack && roll.breakdown.attack.damage
      ),
    [rolls]
  );

  return (
    <div className={styles.activityPage} data-testid="dm-book-activity-page">
      <div className={styles.activitySection} data-testid="activity-events-section">
        <span className={roomStyles.diceSectionLabel}>Triggered &amp; taken</span>
        {events.length === 0 ? (
          <p className={roomStyles.hint} data-testid="activity-events-empty">
            Nothing triggered or taken yet this session.
          </p>
        ) : (
          <div className={roomStyles.rollList} data-testid="activity-events-list">
            {events.map((event) => (
              <div
                key={event.id}
                className={roomStyles.rollEntry}
                data-testid={`activity-event-${event.id}`}
              >
                <span className={roomStyles.rollMeta}>{activityTimeText(event.created_at)}</span>
                <span className={roomStyles.rollHeadline}>
                  {actorName(event.actor_user_id)} {actionVerb(event.action_type)} {targetLabel(event)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className={styles.activitySection} data-testid="activity-damage-section">
        <span className={roomStyles.diceSectionLabel}>Damage dealt</span>
        {damageRolls.length === 0 ? (
          <p className={roomStyles.hint} data-testid="activity-damage-empty">
            No damage-dealing hits logged yet this session.
          </p>
        ) : (
          <div className={roomStyles.rollList} data-testid="activity-damage-list">
            {damageRolls.map((roll) => {
              // Both branches are narrowed non-null by the damageRolls filter
              // above — TypeScript can't see through that filter's closure,
              // so this re-asserts the same shape rollHeadline/damageText
              // themselves expect.
              const attack = roll.breakdown.type === "d20" ? roll.breakdown.attack : undefined;
              if (!attack) return null;
              return (
                <div
                  key={roll.id}
                  className={roomStyles.rollEntry}
                  data-testid={`activity-damage-${roll.id}`}
                >
                  <span className={roomStyles.rollMeta}>
                    {activityTimeText(roll.created_at)} · {actorName(roll.roller_user_id)}
                  </span>
                  <span className={roomStyles.rollHeadline}>{rollHeadline(roll)}</span>
                  <span className={roomStyles.rollDetail}>{damageText(attack)}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
