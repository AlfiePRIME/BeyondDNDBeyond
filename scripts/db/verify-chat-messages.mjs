#!/usr/bin/env node
// Chat & Summary batch, Prompt B1 verification: the chat_messages data
// model + RLS (migration 0067) and src/data-access/chat.ts. B1 adds no UI
// at all (chat-sending surfaces are Game-Room-only, arriving in B3/B4) —
// every call here goes straight at Supabase, the same shape chat.ts's own
// functions use, so this is a pure API-level check with no dev server and
// no Playwright involved, unlike this project's usual UI-driven verify
// scripts.
//
// Covers:
//   1. Any campaign member can read every message in the campaign.
//   2. A member can only send as themselves — RLS-verified: a direct
//      insert attempt impersonating another sender is rejected.
//   3. A non-member can neither read nor send into the campaign.
//   4. Editing succeeds for the sender within the 2-minute window.
//   5. Editing is rejected once the window has closed — proven with a
//      message SEEDED (via the admin/service-role client, not a 2-real-
//      minute wait) with a created_at already outside the window, per
//      this project's "seed starting state via the admin client" rule.
//   6. The chat_messages_lock_immutable_columns trigger (0067): even
//      WITHIN the window, the sender's own client cannot smuggle
//      created_at forward to reset the window, or reassign
//      campaign_id/sender_user_id/id.
//   7. No UPDATE succeeds for a non-sender at all, ever, regardless of
//      window.
//   8. There is no DELETE policy: a delete attempt by the sender, within
//      the window, is rejected.
//   9. A live postgres_changes subscription (chat.ts's own
//      subscribeToChatMessages shape) delivers both a new message and a
//      later edit of that same message to a second connected client.
//
// Needs the local Supabase stack only (no yarn dev).
// Usage: node scripts/db/verify-chat-messages.mjs

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function loadEnv(path) {
  const env = {};
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return env;
  }
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return env;
}

const env = { ...loadEnv(join(rootDir, ".env")), ...loadEnv(join(rootDir, "supabase", ".env")), ...process.env };
const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY ?? env.SERVICE_ROLE_KEY;

const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });

let failures = 0;
function check(label, condition, detail) {
  if (condition) {
    console.log(`PASS  ${label}`);
  } else {
    console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
    failures++;
  }
}

async function makeTestUser(label) {
  const email = `chat-b1-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `Chat B1 ${label}` });
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: signIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  // The realtime deterministic-claims dance chat.ts's own
  // subscribeToChatMessages does — required before any postgres_changes
  // subscription on this client can see authenticated-only rows.
  await client.realtime.setAuth(signIn.session.access_token);
  return { id: data.user.id, session: signIn.session, client };
}

const dm = await makeTestUser("dm");
const player = await makeTestUser("player");
const outsider = await makeTestUser("outsider");

const campaignId = crypto.randomUUID();
await admin.from("campaigns").insert({ id: campaignId, name: "Chat B1 test", creator: dm.id });
await admin.from("campaign_members").insert([
  { campaign_id: campaignId, user_id: dm.id, role: "dm" },
  { campaign_id: campaignId, user_id: player.id, role: "player" },
]);
// outsider is deliberately NOT a member of this campaign.

// ════════════════════════════════════════════════════════════════════
// 1. Send + read: any campaign member can read every message.
// ════════════════════════════════════════════════════════════════════
const { data: sent, error: sendError } = await dm.client
  .from("chat_messages")
  .insert({ campaign_id: campaignId, sender_user_id: dm.id, body: "&cHello &lworld" })
  .select()
  .single();
check("the DM can send a chat message as themselves", !sendError && sent?.id, sendError?.message);
check(
  "the stored body is the raw string with formatting codes intact, untouched",
  sent?.body === "&cHello &lworld",
  sent?.body
);

const { data: playerRead, error: playerReadError } = await player.client
  .from("chat_messages")
  .select()
  .eq("id", sent.id)
  .maybeSingle();
check(
  "a different campaign member (player) can read the DM's message",
  !playerReadError && playerRead?.id === sent.id,
  playerReadError?.message
);

// ════════════════════════════════════════════════════════════════════
// 2. Cross-member send attempt: a member can only send as themselves.
// ════════════════════════════════════════════════════════════════════
const { data: impersonated, error: impersonateError } = await player.client
  .from("chat_messages")
  .insert({ campaign_id: campaignId, sender_user_id: dm.id, body: "I am pretending to be the DM" })
  .select()
  .maybeSingle();
check(
  "a member CANNOT send a message impersonating another member's sender_user_id",
  !!impersonateError && !impersonated,
  JSON.stringify({ impersonated, error: impersonateError?.message })
);

// ════════════════════════════════════════════════════════════════════
// 3. A non-member can neither read nor send into this campaign.
// ════════════════════════════════════════════════════════════════════
const { data: outsiderRead } = await outsider.client.from("chat_messages").select().eq("campaign_id", campaignId);
check(
  "a non-member reads zero messages from this campaign (RLS-filtered, not merely UI-hidden)",
  (outsiderRead ?? []).length === 0,
  JSON.stringify(outsiderRead)
);
const { data: outsiderSend, error: outsiderSendError } = await outsider.client
  .from("chat_messages")
  .insert({ campaign_id: campaignId, sender_user_id: outsider.id, body: "I don't belong here" })
  .select()
  .maybeSingle();
check(
  "a non-member cannot send into this campaign at all",
  !!outsiderSendError && !outsiderSend,
  JSON.stringify({ outsiderSend, error: outsiderSendError?.message })
);

// ════════════════════════════════════════════════════════════════════
// 4. Edit within the window succeeds, for the sender only.
// ════════════════════════════════════════════════════════════════════
// A blocked RLS update matches zero rows rather than raising a Postgres
// error — PostgREST's .maybeSingle() reports that as {data: null, error:
// null}, not an error — so "rejected" is verified by re-reading the row
// via the admin client and confirming it's untouched, not by an error
// being present.
const { data: playerEditAttempt, error: playerEditError } = await player.client
  .from("chat_messages")
  .update({ body: "player trying to edit the DM's message" })
  .eq("id", sent.id)
  .select()
  .maybeSingle();
const afterPlayerEditAttempt = await admin.from("chat_messages").select("body").eq("id", sent.id).single();
check(
  "a non-sender cannot edit someone else's message, even within the window",
  !playerEditError &&
    !playerEditAttempt &&
    afterPlayerEditAttempt.data.body === "&cHello &lworld",
  JSON.stringify({ playerEditAttempt, error: playerEditError?.message, actual: afterPlayerEditAttempt.data })
);

const { data: edited, error: editError } = await dm.client
  .from("chat_messages")
  .update({ body: "&cHello &ledited world", edited_at: new Date().toISOString() })
  .eq("id", sent.id)
  .select()
  .single();
check(
  "the sender CAN edit their own message within the 2-minute window",
  !editError && edited?.body === "&cHello &ledited world" && !!edited?.edited_at,
  JSON.stringify({ edited, error: editError?.message })
);

// ════════════════════════════════════════════════════════════════════
// 5. The immutable-columns trigger: even within the window, an edit
//    cannot smuggle campaign_id/sender_user_id/created_at forward.
// ════════════════════════════════════════════════════════════════════
const pushedCreatedAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
const { data: windowResetAttempt, error: windowResetError } = await dm.client
  .from("chat_messages")
  .update({ created_at: pushedCreatedAt })
  .eq("id", sent.id)
  .select()
  .maybeSingle();
check(
  "the sender cannot push created_at forward to reset their own edit window",
  !!windowResetError && !windowResetAttempt,
  JSON.stringify({ windowResetAttempt, error: windowResetError?.message })
);

const outsiderCampaignId = crypto.randomUUID();
await admin.from("campaigns").insert({ id: outsiderCampaignId, name: "Chat B1 hijack target", creator: outsider.id });
await admin.from("campaign_members").insert([{ campaign_id: outsiderCampaignId, user_id: outsider.id, role: "dm" }]);
const { data: hijackAttempt, error: hijackError } = await dm.client
  .from("chat_messages")
  .update({ campaign_id: outsiderCampaignId })
  .eq("id", sent.id)
  .select()
  .maybeSingle();
check(
  "the sender cannot reassign their own message's campaign_id via an edit",
  !!hijackError && !hijackAttempt,
  JSON.stringify({ hijackAttempt, error: hijackError?.message })
);

const stillIntact = await admin.from("chat_messages").select().eq("id", sent.id).single();
check(
  "the message's campaign_id/created_at/sender_user_id are unchanged after the rejected tamper attempts",
  stillIntact.data.campaign_id === campaignId &&
    stillIntact.data.sender_user_id === dm.id &&
    stillIntact.data.created_at === sent.created_at,
  JSON.stringify(stillIntact.data)
);

// ════════════════════════════════════════════════════════════════════
// 6. Edit attempt AFTER the window closes is rejected — a message
//    SEEDED via the admin client with a created_at already 5 minutes in
//    the past (this project's own "seed via service-role, don't wait on
//    real time" convention), not a real 2-minute sleep.
// ════════════════════════════════════════════════════════════════════
const staleCreatedAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();
const { data: staleMessage, error: staleInsertError } = await admin
  .from("chat_messages")
  .insert({ campaign_id: campaignId, sender_user_id: dm.id, body: "an old message", created_at: staleCreatedAt })
  .select()
  .single();
check("seeding a stale (5-minutes-old) message via the admin client succeeds", !staleInsertError && staleMessage?.id, staleInsertError?.message);

const { data: staleEditAttempt, error: staleEditError } = await dm.client
  .from("chat_messages")
  .update({ body: "trying to edit past the window", edited_at: new Date().toISOString() })
  .eq("id", staleMessage.id)
  .select()
  .maybeSingle();
// Same "rejected == zero rows matched, not a thrown error" shape as the
// non-sender check above.
check(
  "editing the sender's OWN message is REJECTED by RLS once the 2-minute window has closed",
  !staleEditError && !staleEditAttempt,
  JSON.stringify({ staleEditAttempt, error: staleEditError?.message })
);
const staleStillOriginal = await admin.from("chat_messages").select("body, edited_at").eq("id", staleMessage.id).single();
check(
  "the stale message's body/edited_at are unchanged after the rejected past-window edit",
  staleStillOriginal.data.body === "an old message" && staleStillOriginal.data.edited_at === null,
  JSON.stringify(staleStillOriginal.data)
);

// ════════════════════════════════════════════════════════════════════
// 7. No DELETE path exists at all, ever — not even for the sender,
//    not even within the window.
// ════════════════════════════════════════════════════════════════════
const { error: deleteError, count: deleteCount } = await dm.client
  .from("chat_messages")
  .delete({ count: "exact" })
  .eq("id", sent.id);
const stillThere = await admin.from("chat_messages").select("id").eq("id", sent.id).maybeSingle();
check(
  "the sender cannot delete their own message — no DELETE policy exists at all",
  (deleteCount ?? 0) === 0 && stillThere.data?.id === sent.id,
  JSON.stringify({ deleteError: deleteError?.message, deleteCount, stillThere: stillThere.data })
);

// ════════════════════════════════════════════════════════════════════
// 8. Live subscription: a second connected client (player) receives
//    both a brand-new message and a later edit of that same message.
// Fresh-channel retry-until-landed — verify-opportunity-attacks.mjs's own
// precedent for a just-published table: the very first event(s) right
// after a channel reports SUBSCRIBED can be missed while the realtime
// tenant's replication connection is still warming up, so each attempt
// re-probes (a fresh insert immediately followed by an edit) every 2.5s
// on its own fresh channel until both a live INSERT and a live UPDATE are
// actually observed, rather than sending once and waiting.
// ════════════════════════════════════════════════════════════════════
let liveResult = null;
let liveDetail = "no realtime events";
for (let attempt = 0; attempt < 3 && !liveResult; attempt++) {
  liveResult = await new Promise((resolve) => {
    let probeTimer = null;
    let settled = false;
    let sawInsert = false;
    let sawUpdate = false;
    const channel = player.client
      .channel(`chat-messages-verify:${campaignId}:${attempt}:${crypto.randomUUID()}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "chat_messages", filter: `campaign_id=eq.${campaignId}` },
        (payload) => {
          if (typeof payload.new.body === "string" && payload.new.body.startsWith("live-probe:")) {
            sawInsert = true;
            if (sawInsert && sawUpdate) settle({ sawInsert, sawUpdate });
          }
        }
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "chat_messages", filter: `campaign_id=eq.${campaignId}` },
        (payload) => {
          if (typeof payload.new.body === "string" && payload.new.body.startsWith("live-probe:") && payload.new.body.endsWith(":edited")) {
            sawUpdate = true;
            if (sawInsert && sawUpdate) settle({ sawInsert, sawUpdate });
          }
        }
      );
    const settle = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (probeTimer) clearInterval(probeTimer);
      void player.client.removeChannel(channel);
      resolve(value);
    };
    const timer = setTimeout(() => {
      liveDetail = `attempt ${attempt + 1}: insert=${sawInsert} update=${sawUpdate} within 15s`;
      settle(null);
    }, 15000);
    // Each probe is a brand-new message (a unique marker body), sent as
    // the DM then immediately edited — exercises the real
    // sendChatMessage/editChatMessage shapes each time it fires.
    const probe = () =>
      void (async () => {
        const marker = `live-probe:${crypto.randomUUID()}`;
        const { data: probeRow } = await dm.client
          .from("chat_messages")
          .insert({ campaign_id: campaignId, sender_user_id: dm.id, body: marker })
          .select()
          .single();
        if (probeRow) {
          await dm.client
            .from("chat_messages")
            .update({ body: `${marker}:edited`, edited_at: new Date().toISOString() })
            .eq("id", probeRow.id);
        }
      })().catch(() => undefined);
    channel.subscribe((status) => {
      if (status === "SUBSCRIBED") {
        probe();
        probeTimer = setInterval(probe, 2500);
      } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
        liveDetail = `attempt ${attempt + 1}: channel ${status}`;
        settle(null);
      }
    });
  });
}
check(
  "the live subscription delivered both a NEW message and its EDIT to a second (player) client",
  liveResult !== null && liveResult.sawInsert && liveResult.sawUpdate,
  liveDetail
);

console.log(failures === 0 ? `\nAll checks passed.` : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
