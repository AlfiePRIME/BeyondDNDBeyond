#!/usr/bin/env node
// Chat & Summary batch, Prompt B4 verification: the persistent chat log
// panel (ChatLogPanel.tsx) — full history on open, live delivery/edits via
// B1's subscribeToChatMessages, B2's ChatText formatting rendered inside
// the panel, the real send control, and the inline edit affordance
// (visible only on the viewer's own still-editable messages, genuinely
// rejected server-side once the window closes or for another member's
// message — not merely hidden by the UI).
//
// Real signed-in browsers (a DM and two players in the same live Game
// Room) plus a service-role client for setup/seeding, this script
// family's own established shape (verify-per-member-dice-trays.mjs/
// verify-chat-messages.mjs). Checks:
//   1. The panel shows full chat history (seeded via the admin client, per
//      this project's "seed starting state via the admin client, not a
//      blind UI click-scan" rule) on open, oldest-to-newest, and a
//      formatting-code message renders real color/bold via B2's ChatText —
//      on every connected client, not just the sender's.
//   2. Sending from the panel's own real input+button control is visible
//      in the sender's own log AND arrives live on a second, already-open
//      client.
//   3. The list auto-scrolls to the newest message on arrival.
//   4. The sender can edit their own message within B1's 2-minute window;
//      a visible "(edited)" marker appears afterward, live on every client.
//   5. No Edit control is ever offered for another member's message, and a
//      direct (non-UI) attempt to edit it is rejected server-side by RLS.
//   6. Once the 2-minute window closes (seeded via the admin client with a
//      created_at already 5 minutes in the past — no real wait), the
//      sender's own Edit control disappears, and a direct attempt to edit
//      it anyway is still rejected server-side, not merely UI-hidden.
//
// Needs the local Supabase stack; starts `yarn dev` itself (and polls
// /api/health) if the target port isn't already serving.
// Usage: CHAT_LOG_PANEL_APP_PORT=3933 node scripts/db/verify-chat-log-panel.mjs

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { GPU_LAUNCH_ARGS } from "./lib/browser.mjs";

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

// A dedicated, non-default port — this machine runs other worktrees' dev
// servers (and an unrelated production build) on other ports, including
// :3000 itself (the LIVE PRODUCTION SERVER — never default to it).
const APP_PORT = env.CHAT_LOG_PANEL_APP_PORT ? Number(env.CHAT_LOG_PANEL_APP_PORT) : 3933;
const APP_URL = `http://localhost:${APP_PORT}`;

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function healthOk() {
  return fetch(`${APP_URL}/api/health`).then((res) => res.ok).catch(() => false);
}

let devServer = null;
async function ensureDevServer() {
  if (await healthOk()) return;
  console.log(`dev server not running on :${APP_PORT} — starting yarn dev…`);
  devServer = spawn("yarn", ["dev", "-p", String(APP_PORT)], { cwd: rootDir, stdio: "ignore", detached: true });
  for (let i = 0; i < 120; i++) {
    await sleep(1000);
    if (await healthOk()) return;
  }
  throw new Error("dev server did not become healthy within 120s");
}

// The @supabase/ssr cookie format: sb-<host>-auth-token = "base64-" +
// base64url(JSON session), chunked at 3180 chars into name.0, name.1, ...
const COOKIE_NAME = `sb-${new URL(supabaseUrl).hostname.split(".")[0]}-auth-token`;
const MAX_CHUNK = 3180;
function sessionCookies(session) {
  const value = "base64-" + Buffer.from(JSON.stringify(session)).toString("base64url");
  if (value.length <= MAX_CHUNK) return [{ name: COOKIE_NAME, value, url: APP_URL }];
  const cookies = [];
  for (let i = 0; i * MAX_CHUNK < value.length; i++) {
    cookies.push({ name: `${COOKIE_NAME}.${i}`, value: value.slice(i * MAX_CHUNK, (i + 1) * MAX_CHUNK), url: APP_URL });
  }
  return cookies;
}

async function makeTestUser(label) {
  const email = `chat-log-panel-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `Chat ${label}` });
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: signIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  return { id: data.user.id, client, session: signIn.session };
}

await ensureDevServer();

const dm = await makeTestUser("dm");
const alice = await makeTestUser("alice");
const bob = await makeTestUser("bob");
const browser = await chromium.launch({ args: GPU_LAUNCH_ARGS });
const pageErrors = [];

async function openContext(user) {
  const context = await browser.newContext();
  await context.addCookies(sessionCookies(user.session));
  const page = await context.newPage();
  page.on("pageerror", (err) => pageErrors.push(`${user.id}: ${err.message}`));
  return { context, page };
}

async function chatListScroll(page) {
  return page.locator('[data-testid="chat-log"]').evaluate((el) => ({
    scrollTop: el.scrollTop,
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
  }));
}

async function waitForEntry(page, messageId, timeoutMs = 15000) {
  await page.waitForSelector(`[data-testid="chat-entry-${messageId}"]`, { state: "attached", timeout: timeoutMs });
}

async function entryText(page, messageId) {
  return page.locator(`[data-testid="chat-entry-${messageId}"]`).textContent();
}

try {
  const campaignId = crypto.randomUUID();
  await admin.from("campaigns").insert({ id: campaignId, name: "Chat log panel test", creator: dm.id });
  await admin.from("campaign_members").insert([
    { campaign_id: campaignId, user_id: dm.id, role: "dm" },
    { campaign_id: campaignId, user_id: alice.id, role: "player" },
    { campaign_id: campaignId, user_id: bob.id, role: "player" },
  ]);

  // -------------------------------------------------------------------
  // Seed starting state directly via the admin client (never a blind UI
  // click-scan) — a few history rows, oldest-first by construction (each
  // created_at strictly increasing), including one with real B2 formatting
  // codes, so "full history on open" and "formatting renders correctly"
  // are both genuinely pre-existing state, not something this run creates
  // through the UI it's supposed to be testing.
  // -------------------------------------------------------------------
  const baseTime = Date.now() - 60_000;
  const seedRows = [
    { campaign_id: campaignId, sender_user_id: dm.id, body: "Welcome to the table.", created_at: new Date(baseTime).toISOString() },
    {
      campaign_id: campaignId,
      sender_user_id: alice.id,
      // &4 is this app's own "red" color code (chatFormatting.ts's
      // CHAT_COLOR_CODES only maps 0-9/a/f, a deliberately narrower subset
      // than Minecraft's full 0-9/a-f table — &c is NOT one of them, and
      // correctly degrades to literal text rather than a color).
      body: "&4Red &lBold text",
      created_at: new Date(baseTime + 1000).toISOString(),
    },
    { campaign_id: campaignId, sender_user_id: bob.id, body: "hello all", created_at: new Date(baseTime + 2000).toISOString() },
  ];
  const { data: seeded, error: seedError } = await admin.from("chat_messages").insert(seedRows).select();
  check("seeding chat history via the admin client succeeds", !seedError && seeded?.length === 3, seedError?.message);
  const [welcomeMsg, formattedMsg, helloMsg] = seeded ?? [];

  const roomUrl = `${APP_URL}/campaigns/${campaignId}/room`;

  const { page: dmPage } = await openContext(dm);
  await dmPage.goto(roomUrl);
  await dmPage.waitForSelector('[data-testid="chat-log-panel"]', { state: "attached", timeout: 30000 });

  const { page: alicePage } = await openContext(alice);
  await alicePage.goto(roomUrl);
  await alicePage.waitForSelector('[data-testid="chat-log-panel"]', { state: "attached", timeout: 30000 });

  const { page: bobPage } = await openContext(bob);
  await bobPage.goto(roomUrl);
  await bobPage.waitForSelector('[data-testid="chat-log-panel"]', { state: "attached", timeout: 30000 });

  // ═══════════════════════════════════════════════════════════════════
  // 1. Full history on open, oldest-to-newest, on every connected client.
  // ═══════════════════════════════════════════════════════════════════
  for (const page of [dmPage, alicePage, bobPage]) {
    await waitForEntry(page, welcomeMsg.id);
    await waitForEntry(page, formattedMsg.id);
    await waitForEntry(page, helloMsg.id);
  }
  const dmOrder = await dmPage.locator('[data-testid="chat-log"] > div').evaluateAll((nodes) =>
    nodes.map((n) => n.getAttribute("data-testid"))
  );
  check(
    "history renders oldest-to-newest, top to bottom",
    dmOrder.indexOf(`chat-entry-${welcomeMsg.id}`) < dmOrder.indexOf(`chat-entry-${formattedMsg.id}`) &&
      dmOrder.indexOf(`chat-entry-${formattedMsg.id}`) < dmOrder.indexOf(`chat-entry-${helloMsg.id}`),
    JSON.stringify(dmOrder)
  );

  const welcomeText = await entryText(dmPage, welcomeMsg.id);
  check(
    "the DM's own seeded message shows the DM's sender name and (DM) tag",
    welcomeText.includes("Chat dm") && welcomeText.includes("(DM)"),
    welcomeText
  );
  const helloText = await entryText(dmPage, helloMsg.id);
  check("a player's message shows that player's sender name, no (DM) tag", helloText.includes("Chat bob") && !helloText.includes("(DM)"), helloText);

  // ═══════════════════════════════════════════════════════════════════
  // Formatting (B2) renders correctly inside the panel — real
  // getComputedStyle, the exact verify-chat-formatting.mjs idiom.
  // ═══════════════════════════════════════════════════════════════════
  const redSpan = alicePage.locator(`[data-testid="chat-entry-${formattedMsg.id}"] [data-chat-span-index="0"]`);
  const redColor = await redSpan.evaluate((el) => getComputedStyle(el).color);
  check("the &4 code renders real red text inside the log panel", redColor === "rgb(255, 59, 59)", `got ${redColor}`);
  const boldSpan = alicePage.locator(`[data-testid="chat-entry-${formattedMsg.id}"] [data-chat-span-index="1"]`);
  const boldWeight = await boldSpan.evaluate((el) => getComputedStyle(el).fontWeight);
  check("the &l code renders real bold text inside the log panel", boldWeight === "700", `got ${boldWeight}`);

  // ═══════════════════════════════════════════════════════════════════
  // 2. Send-and-see-in-log via the panel's own real input+button, live on
  //    a second, already-open client.
  // ═══════════════════════════════════════════════════════════════════
  await alicePage.fill('[data-testid="chat-input"]', "hi from alice's real send control");
  await alicePage.click('[data-testid="chat-send-button"]');

  let sentMessageId = null;
  for (let attempt = 0; attempt < 20 && !sentMessageId; attempt++) {
    const { data } = await admin
      .from("chat_messages")
      .select()
      .eq("campaign_id", campaignId)
      .eq("sender_user_id", alice.id)
      .eq("body", "hi from alice's real send control")
      .maybeSingle();
    if (data) sentMessageId = data.id;
    else await sleep(300);
  }
  check("sending via the panel's own input+button created a real chat_messages row", sentMessageId !== null);

  if (sentMessageId) {
    await waitForEntry(alicePage, sentMessageId);
    check("the sender's own client shows the message in its own log", true);
    await waitForEntry(dmPage, sentMessageId, 15000);
    check("a second, already-open client (the DM) receives it live via subscribeToChatMessages", true);
  }

  // ═══════════════════════════════════════════════════════════════════
  // 3. Auto-scroll to the newest message on arrival.
  // ═══════════════════════════════════════════════════════════════════
  const scrollAfterSend = await chatListScroll(dmPage);
  const nearBottom = scrollAfterSend.scrollTop + scrollAfterSend.clientHeight >= scrollAfterSend.scrollHeight - 4;
  check(
    "the log auto-scrolls to the newest message on arrival",
    nearBottom,
    JSON.stringify(scrollAfterSend)
  );

  // ═══════════════════════════════════════════════════════════════════
  // 4. Editing the sender's OWN message within the window — a visible
  //    "(edited)" marker afterward, live on every client.
  // ═══════════════════════════════════════════════════════════════════
  if (sentMessageId) {
    await alicePage.click(`[data-testid="chat-edit-button-${sentMessageId}"]`);
    await alicePage.fill(`[data-testid="chat-edit-input-${sentMessageId}"]`, "hi from alice, now edited");
    await alicePage.click(`[data-testid="chat-edit-save-${sentMessageId}"]`);

    let editedOk = false;
    for (let attempt = 0; attempt < 20 && !editedOk; attempt++) {
      const text = await entryText(alicePage, sentMessageId).catch(() => "");
      if (text.includes("hi from alice, now edited") && text.includes("(edited)")) editedOk = true;
      else await sleep(300);
    }
    check("the sender's own client shows the edited body and an (edited) marker", editedOk);

    let dmSeesEdit = false;
    for (let attempt = 0; attempt < 20 && !dmSeesEdit; attempt++) {
      const text = await entryText(dmPage, sentMessageId).catch(() => "");
      if (text.includes("hi from alice, now edited") && text.includes("(edited)")) dmSeesEdit = true;
      else await sleep(300);
    }
    check("a second, already-open client (the DM) sees the edit live", dmSeesEdit);
  }

  // ═══════════════════════════════════════════════════════════════════
  // 5. Another member's message: no Edit control shown, and a direct
  //    (non-UI) attempt is rejected server-side by RLS.
  // ═══════════════════════════════════════════════════════════════════
  check(
    "bob is never offered an Edit control on alice's message",
    (await bobPage.$(`[data-testid="chat-edit-button-${sentMessageId}"]`)) === null
  );
  check(
    "the DM is never offered an Edit control on alice's message either (sender-only, not role-based)",
    (await dmPage.$(`[data-testid="chat-edit-button-${sentMessageId}"]`)) === null
  );
  const { data: bobEditAttempt, error: bobEditError } = await bob.client
    .from("chat_messages")
    .update({ body: "bob trying to hijack alice's message" })
    .eq("id", sentMessageId)
    .select()
    .maybeSingle();
  check(
    "a direct attempt by another member to edit alice's message is rejected server-side (RLS), not merely UI-hidden",
    !bobEditError && !bobEditAttempt,
    JSON.stringify({ bobEditAttempt, error: bobEditError?.message })
  );
  const stillAlices = await admin.from("chat_messages").select("body, sender_user_id").eq("id", sentMessageId).single();
  check(
    "alice's message is unchanged after bob's rejected hijack attempt",
    stillAlices.data.sender_user_id === alice.id && stillAlices.data.body === "hi from alice, now edited",
    JSON.stringify(stillAlices.data)
  );

  // ═══════════════════════════════════════════════════════════════════
  // 6. Once the 2-minute window closes, the sender's own Edit control
  //    disappears, and a direct attempt to edit it anyway is still
  //    rejected server-side — seeded via the admin client with a
  //    created_at already 5 minutes in the past (no real wait), this
  //    project's own established convention (verify-chat-messages.mjs).
  // ═══════════════════════════════════════════════════════════════════
  const staleCreatedAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const { data: staleMessage, error: staleInsertError } = await admin
    .from("chat_messages")
    .insert({ campaign_id: campaignId, sender_user_id: alice.id, body: "an old message from alice", created_at: staleCreatedAt })
    .select()
    .single();
  check("seeding a stale (5-minutes-old) message via the admin client succeeds", !staleInsertError && staleMessage?.id, staleInsertError?.message);

  if (staleMessage) {
    // A fresh load picks the stale row up via listChatMessages (the same
    // "DB read for SSR" ChatLogPanel itself documents) — reloading is the
    // simplest way to get it into alice's own client's state for this
    // check, exactly like verify-per-member-dice-trays.mjs's own reload
    // step for a similarly out-of-band-seeded row.
    await alicePage.reload();
    await alicePage.waitForSelector('[data-testid="chat-log-panel"]', { state: "attached", timeout: 30000 });
    await waitForEntry(alicePage, staleMessage.id);
    check(
      "the sender's own Edit control is NOT offered once the 2-minute window has closed",
      (await alicePage.$(`[data-testid="chat-edit-button-${staleMessage.id}"]`)) === null
    );

    const { data: staleEditAttempt, error: staleEditError } = await alice.client
      .from("chat_messages")
      .update({ body: "trying to edit past the window", edited_at: new Date().toISOString() })
      .eq("id", staleMessage.id)
      .select()
      .maybeSingle();
    check(
      "a direct attempt to edit the sender's OWN message past the window is rejected server-side, not merely UI-hidden",
      !staleEditError && !staleEditAttempt,
      JSON.stringify({ staleEditAttempt, error: staleEditError?.message })
    );
    const staleStillOriginal = await admin.from("chat_messages").select("body, edited_at").eq("id", staleMessage.id).single();
    check(
      "the stale message is unchanged after the rejected past-window edit attempt",
      staleStillOriginal.data.body === "an old message from alice" && staleStillOriginal.data.edited_at === null,
      JSON.stringify(staleStillOriginal.data)
    );
  }

  check("no uncaught page error occurred during this run", pageErrors.length === 0, pageErrors.join(" | "));
} finally {
  await browser.close();
  await admin.auth.admin.deleteUser(dm.id).catch(() => undefined);
  await admin.auth.admin.deleteUser(alice.id).catch(() => undefined);
  await admin.auth.admin.deleteUser(bob.id).catch(() => undefined);
  if (devServer) {
    try {
      process.kill(-devServer.pid);
    } catch {
      // Already gone.
    }
  }
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll chat log panel checks passed.");
process.exit(0);
