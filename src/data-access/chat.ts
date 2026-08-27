import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * One campaign chat message (0067). `body` is the raw text exactly as the
 * sender typed it, INCLUDING any Minecraft-style "&" formatting codes
 * (e.g. a literal "&cHello &lworld") — a separate rendering feature parses
 * codes from this same column at RENDER time, not storage time, so this
 * module never strips, escapes, or otherwise pre-processes `body`.
 *
 * `edited_at` is null until the sender uses their one short post-send edit
 * window (2 minutes, enforced server-side by the chat_messages UPDATE RLS
 * policy itself — not just by the UI hiding the control past that point).
 * There is no delete path for this table at all, ever, per the project
 * owner — unlike roll_log's append-only-because-it's-a-log reasoning,
 * chat can be corrected but never retracted.
 */
export interface ChatMessage {
  id: string;
  campaign_id: string;
  sender_user_id: string;
  body: string;
  created_at: string;
  edited_at: string | null;
}

/**
 * Most recent first — the listRollLog shape, so a caller wanting
 * chronological (oldest-first) display order reverses client-side after
 * fetching the latest `limit` messages.
 */
export async function listChatMessages(
  supabase: SupabaseClient,
  campaignId: string,
  limit = 200
): Promise<ChatMessage[]> {
  const { data, error } = await supabase
    .from("chat_messages")
    .select()
    .eq("campaign_id", campaignId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit);

  if (error) throw error;
  return (data ?? []) as ChatMessage[];
}

/**
 * Sends a chat message as `senderUserId`. The chat_messages INSERT policy
 * (0067) independently re-checks `sender_user_id = auth.uid()` — this
 * parameter is never trusted on its own, so a caller can't send as anyone
 * but the authenticated user regardless of what it passes here.
 */
export async function sendChatMessage(
  supabase: SupabaseClient,
  campaignId: string,
  senderUserId: string,
  body: string
): Promise<ChatMessage> {
  const { data, error } = await supabase
    .from("chat_messages")
    .insert({ campaign_id: campaignId, sender_user_id: senderUserId, body })
    .select()
    .single();

  if (error) throw error;
  return data as ChatMessage;
}

/**
 * Edits a previously sent message's body. Only `body` and `edited_at` are
 * ever written here — every other column is locked against change by the
 * chat_messages_lock_immutable_columns trigger (0067), and whether this
 * write is even allowed at all (sender-only, within 2 minutes of
 * created_at) is enforced by the UPDATE RLS policy itself. A rejected edit
 * (wrong sender, or the window has closed) surfaces as an ordinary
 * PostgREST "no rows" error from `.single()`, exactly like updateCharacter
 * hitting a row RLS filters out — there is no separate client-side check
 * this function performs first.
 */
export async function editChatMessage(
  supabase: SupabaseClient,
  messageId: string,
  body: string
): Promise<ChatMessage> {
  const { data, error } = await supabase
    .from("chat_messages")
    .update({ body, edited_at: new Date().toISOString() })
    .eq("id", messageId)
    .select()
    .single();

  if (error) throw error;
  return data as ChatMessage;
}

/**
 * Fires `handler` with every new or edited chat message in the campaign.
 * Two explicit postgres_changes registrations (INSERT and UPDATE) on the
 * same channel, NOT a single `event: "*"` — this table has no DELETE
 * policy at all, ever, so there is deliberately no third registration for
 * it (a DELETE payload's `new` is an empty object under the default
 * replica identity, which would hand callers a bogus "message").
 *
 * postgres_changes, NOT the Game Room's own campaign-channel broadcast —
 * the subscribeToRollLog/subscribeToOpportunityAttacks precedent: chat
 * must reach a member wherever they might be reading it, not only while
 * that specific room's channel happens to be joined (per this plan's own
 * scope note, the SENDING ui is Game-Room-only in this batch, but a member
 * reading is not). Per-subscriber visibility rides the chat_messages
 * SELECT policy (0067).
 */
export function subscribeToChatMessages(
  supabase: SupabaseClient,
  campaignId: string,
  handler: (message: ChatMessage) => void
): () => void {
  let removed = false;
  let channel: ReturnType<SupabaseClient["channel"]> | null = null;

  void (async () => {
    // Same deterministic-claims dance as subscribeToRollLog: without the
    // explicit setAuth, the socket can join as anon and RLS silently drops
    // every event.
    const { data } = await supabase.auth.getSession();
    if (removed) return;
    if (data.session) await supabase.realtime.setAuth(data.session.access_token);
    if (removed) return;

    channel = supabase
      .channel(`chat-messages:${campaignId}:${crypto.randomUUID()}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "chat_messages",
          filter: `campaign_id=eq.${campaignId}`,
        },
        (payload) => handler(payload.new as ChatMessage)
      )
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "chat_messages",
          filter: `campaign_id=eq.${campaignId}`,
        },
        (payload) => handler(payload.new as ChatMessage)
      )
      .subscribe();
  })();

  return () => {
    removed = true;
    if (channel) void supabase.removeChannel(channel);
  };
}
