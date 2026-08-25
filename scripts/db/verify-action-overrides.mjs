#!/usr/bin/env node
// DM rule-override control verification (Prompt 52 acceptance criteria).
//
// RLS phase (plain signed-in clients): a player can flag their own
// exhausted resource; another player cannot flag on someone else's
// character; the DM can flag on a player's behalf; every member can READ
// the flags (transparency); a non-DM cannot approve/deny; the DM
// approving sets status/resolved_by/resolved_at; a denied request stays
// denied and grants nothing (consume rejected, re-resolve rejected); a
// consumed approval cannot be consumed again. Realtime phase: approval
// and denial both reach ANOTHER member's postgres_changes subscription
// live (retry-until-landed, the verify-dice-rolls lesson — never a fixed
// timeout after "joined"). Browser phase (the verify-quick-actions
// arrangement): a slot-exhausted spell renders in the quick-actions panel
// as blocked with its reason and a Flag to DM button (no fire button);
// the DM's room shows the flag in the DM Controls panel and approving it
// flips the player's control to a one-time "Use anyway (DM-approved)"
// fire that posts a NORMAL kind:"attack" roll (shape-identical to an
// ordinary quick-action roll) WITHOUT decrementing the spell-slot
// resource, marks the override consumed, and reverts the panel to
// needing a fresh flag; the shared dice log shows the ruling as a
// distinct entry; and the character sheet's resource panel walks the same
// flag -> approve -> use-anyway cycle to consumed without current_uses
// ever moving (no setCharacterResourceUses call anywhere in the path).
//
// Needs the local Supabase stack; starts `yarn dev` itself (and polls
// /api/health) if the target port isn't already serving — respects APP_URL
// so it can run alongside another dev server on :3000 (the verify-day-
// night-mode.mjs/verify-dm-book.mjs convention).
// Usage: node scripts/db/verify-action-overrides.mjs
//        APP_URL=http://localhost:3120 node scripts/db/verify-action-overrides.mjs

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const APP_URL = process.env.APP_URL ?? "http://localhost:3000";

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function healthOk() {
  return fetch(`${APP_URL}/api/health`).then((res) => res.ok).catch(() => false);
}

let devServer = null;
async function ensureDevServer() {
  if (await healthOk()) return;
  const port = new URL(APP_URL).port || "3000";
  console.log(`dev server not running at ${APP_URL} — starting yarn dev on port ${port}…`);
  devServer = spawn("yarn", ["dev"], {
    cwd: rootDir,
    stdio: "ignore",
    detached: true,
    env: { ...process.env, PORT: port },
  });
  for (let i = 0; i < 120; i++) {
    await sleep(1000);
    if (await healthOk()) return;
  }
  throw new Error("dev server did not become healthy within 120s");
}

const COOKIE_NAME = `sb-${new URL(supabaseUrl).hostname.split(".")[0]}-auth-token`;
const MAX_CHUNK = 3180;

function sessionCookies(session) {
  const value = "base64-" + Buffer.from(JSON.stringify(session)).toString("base64url");
  if (value.length <= MAX_CHUNK) return [{ name: COOKIE_NAME, value, url: APP_URL }];
  const cookies = [];
  for (let i = 0; i * MAX_CHUNK < value.length; i++) {
    cookies.push({
      name: `${COOKIE_NAME}.${i}`,
      value: value.slice(i * MAX_CHUNK, (i + 1) * MAX_CHUNK),
      url: APP_URL,
    });
  }
  return cookies;
}

async function makeTestUser(label) {
  const email = `action-overrides-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `Overrides ${label}` });
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: signIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  return { id: data.user.id, session: signIn.session, client };
}

// A fresh override row via a real signed-in client — the requestOverride
// data-access shape.
async function flagAs(user, campaignId, characterId, actionLabel, reason) {
  return user.client
    .from("action_overrides")
    .insert({
      campaign_id: campaignId,
      character_id: characterId,
      requested_by: user.id,
      action_label: actionLabel,
      reason,
    })
    .select()
    .single();
}

// The resolveOverride data-access shape.
async function resolveAs(user, overrideId, approved) {
  return user.client
    .from("action_overrides")
    .update({
      status: approved ? "approved" : "denied",
      resolved_by: user.id,
      resolved_at: new Date().toISOString(),
    })
    .eq("id", overrideId)
    .eq("status", "pending")
    .select();
}

// The consumeOverride data-access shape (approved-only filter included).
async function consumeAs(user, overrideId) {
  return user.client
    .from("action_overrides")
    .update({ status: "consumed" })
    .eq("id", overrideId)
    .eq("status", "approved")
    .select();
}

async function overrideRow(overrideId) {
  const { data } = await admin.from("action_overrides").select().eq("id", overrideId).single();
  return data ?? null;
}

// Poll for the newest override row matching a predicate — browser clicks
// land asynchronously.
async function pollOverride(campaignId, predicate, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { data } = await admin
      .from("action_overrides")
      .select()
      .eq("campaign_id", campaignId)
      .order("created_at", { ascending: false })
      .limit(20);
    const found = (data ?? []).find(predicate);
    if (found) return found;
    await sleep(300);
  }
  return null;
}

async function newestAttackRollAfter(campaignId, knownIds, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { data } = await admin
      .from("roll_log")
      .select()
      .eq("campaign_id", campaignId)
      .eq("kind", "attack")
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(5);
    const fresh = (data ?? []).find((row) => !knownIds.has(row.id));
    if (fresh) return fresh;
    await sleep(300);
  }
  return null;
}

async function attackRollIds(campaignId) {
  const { data } = await admin
    .from("roll_log")
    .select("id")
    .eq("campaign_id", campaignId)
    .eq("kind", "attack");
  return new Set((data ?? []).map((row) => row.id));
}

await ensureDevServer();

const dm = await makeTestUser("dm");
const alice = await makeTestUser("alice");
const bob = await makeTestUser("bob");
const browser = await chromium.launch();

try {
  const campaignId = crypto.randomUUID();
  // Freeform (Prompt 53): this script fires several quick-action attacks
  // from the same current combatant across its scenarios, which Strict
  // (the default since Prompt 53) would correctly reject as a spent
  // action — that gating is this app's job, not something this script
  // about overrides needs to also exercise.
  await admin
    .from("campaigns")
    .insert({ id: campaignId, name: "Action overrides test", creator: dm.id, action_economy_strict: false });
  await admin.from("campaign_members").insert([
    { campaign_id: campaignId, user_id: dm.id, role: "dm" },
    { campaign_id: campaignId, user_id: alice.id, role: "player" },
    { campaign_id: campaignId, user_id: bob.id, role: "player" },
  ]);

  // Alice: a Wizard who knows Witch Bolt (level 1) with its 1st-level
  // slots EXHAUSTED — the quick-actions blocked case — plus Fire Bolt
  // (cantrip, always usable, the shape-comparison baseline) and an
  // exhausted limited-use resource for the sheet path.
  const aliceCharacterId = crypto.randomUUID();
  await admin.from("characters").insert({
    id: aliceCharacterId,
    campaign_id: campaignId,
    owner_id: alice.id,
    name: "Alice PC",
    race: "Human",
    class: "Wizard",
    level: 3,
    strength: 10,
    dexterity: 14,
    constitution: 13,
    intelligence: 16,
    wisdom: 12,
    charisma: 8,
    current_hp: 20,
    max_hp: 20,
    armor_class: 12,
    speed: 30,
    proficiencies: [],
    inventory: [],
    spells: [
      { name: "Fire Bolt", level: 0 },
      { name: "Witch Bolt", level: 1 },
    ],
  });
  const { data: slotRow } = await admin
    .from("character_resources")
    .insert({
      character_id: aliceCharacterId,
      name: "1st-Level Spell Slots",
      max_uses: 2,
      current_uses: 0,
      recharge: "long_rest",
    })
    .select()
    .single();
  const slotResourceId = slotRow.id;
  const { data: surgeRow } = await admin
    .from("character_resources")
    .insert({
      character_id: aliceCharacterId,
      name: "Heroic Surge",
      max_uses: 1,
      current_uses: 0,
      recharge: "short_rest",
    })
    .select()
    .single();
  const surgeResourceId = surgeRow.id;

  const mapId = crypto.randomUUID();
  await admin.from("campaign_maps").insert({
    id: mapId,
    campaign_id: campaignId,
    name: "Overrides arena",
    grid_width: 40,
    grid_height: 40,
  });
  const aliceTokenId = crypto.randomUUID();
  const goblinTokenId = crypto.randomUUID();
  await admin.from("map_tokens").insert([
    { id: aliceTokenId, map_id: mapId, character_id: aliceCharacterId, x: 0, y: 0, elevation: 0, allegiance: "party" },
    // 4 cells = 20 ft: inside Witch Bolt's 30 ft (and Fire Bolt's 120 ft)
    // outright.
    { id: goblinTokenId, map_id: mapId, npc_name: "Goblin", x: 4, y: 0, elevation: 0, allegiance: "hostile" },
  ]);
  await admin.from("campaigns").update({ live_map: mapId }).eq("id", campaignId);

  const encounterId = crypto.randomUUID();
  await admin.from("combat_encounters").insert({ id: encounterId, campaign_id: campaignId });
  await admin.from("combat_combatants").insert([
    { encounter_id: encounterId, token_id: aliceTokenId, character_id: aliceCharacterId, initiative: 20 },
    { encounter_id: encounterId, token_id: goblinTokenId, npc_name: "Goblin", initiative: 10 },
  ]);

  // ── 1. RLS: who can flag, see, resolve, consume. ──

  const { data: aliceFlag, error: aliceFlagError } = await flagAs(
    alice, campaignId, aliceCharacterId, "Heroic Surge", "No uses remaining"
  );
  check(
    "a player can flag their own exhausted resource",
    !aliceFlagError && aliceFlag?.status === "pending",
    aliceFlagError?.message
  );

  const { error: bobFlagError } = await flagAs(
    bob, campaignId, aliceCharacterId, "Heroic Surge", "No uses remaining"
  );
  check(
    "another player cannot flag on someone else's character (RLS)",
    Boolean(bobFlagError),
    "insert unexpectedly succeeded"
  );

  const { data: dmProxyFlag, error: dmProxyError } = await flagAs(
    dm, campaignId, aliceCharacterId, "Proxy Flag", "No uses remaining"
  );
  check(
    "the DM can flag on a player's behalf (owner-or-DM insert)",
    !dmProxyError && dmProxyFlag?.status === "pending",
    dmProxyError?.message
  );

  const { data: bobReads } = await bob.client
    .from("action_overrides")
    .select()
    .eq("campaign_id", campaignId);
  check(
    "every campaign member can read the flags (transparency SELECT)",
    (bobReads ?? []).some((row) => row.id === aliceFlag.id),
    `bob sees ${bobReads?.length ?? 0} rows`
  );

  const { data: bobResolve } = await resolveAs(bob, aliceFlag.id, true);
  check(
    "a non-DM cannot approve/deny (RLS: zero rows updated)",
    (bobResolve ?? []).length === 0,
    JSON.stringify(bobResolve)
  );

  const { data: bobConsumePending } = await consumeAs(bob, aliceFlag.id);
  const { data: aliceConsumePending } = await consumeAs(alice, aliceFlag.id);
  check(
    "a pending (unapproved) flag cannot be consumed by anyone",
    (bobConsumePending ?? []).length === 0 && (aliceConsumePending ?? []).length === 0
  );

  const before = Date.now();
  const { data: dmApprove } = await resolveAs(dm, aliceFlag.id, true);
  const approvedRow = dmApprove?.[0];
  check(
    "the DM approving sets status/resolved_by/resolved_at",
    approvedRow?.status === "approved" &&
      approvedRow?.resolved_by === dm.id &&
      approvedRow?.resolved_at !== null &&
      Math.abs(new Date(approvedRow.resolved_at).getTime() - before) < 60000,
    JSON.stringify(approvedRow)
  );

  const { data: aliceConsume } = await consumeAs(alice, aliceFlag.id);
  check(
    "the requesting player consumes an approved override",
    aliceConsume?.[0]?.status === "consumed",
    JSON.stringify(aliceConsume)
  );

  const { data: reconsume } = await consumeAs(alice, aliceFlag.id);
  check(
    "a consumed override cannot be consumed again (single-use)",
    (reconsume ?? []).length === 0,
    JSON.stringify(reconsume)
  );

  // Denial: a fresh flag, denied, grants nothing and stays denied.
  const { data: deniedFlag } = await flagAs(
    alice, campaignId, aliceCharacterId, "Heroic Surge", "No uses remaining"
  );
  const { data: dmDeny } = await resolveAs(dm, deniedFlag.id, false);
  check("the DM denying sets status denied", dmDeny?.[0]?.status === "denied", JSON.stringify(dmDeny));
  const { data: consumeDenied } = await consumeAs(alice, deniedFlag.id);
  const { data: reResolveDenied } = await resolveAs(dm, deniedFlag.id, true);
  const deniedAfter = await overrideRow(deniedFlag.id);
  check(
    "a denied request grants nothing and stays denied (no consume, no re-resolve)",
    (consumeDenied ?? []).length === 0 &&
      (reResolveDenied ?? []).length === 0 &&
      deniedAfter?.status === "denied",
    JSON.stringify(deniedAfter)
  );
  // Tidy the DM's proxy flag out of the pending list before the browser
  // phase reads it.
  await resolveAs(dm, dmProxyFlag.id, false);

  // ── 2. Live sync: approval AND denial reach another member's
  //    postgres_changes subscription. Retry-until-landed (the
  //    verify-dice-rolls lesson): the subscription can become active
  //    moments after the join, so each retry is a fresh flag+verdict. ──

  await bob.client.realtime.setAuth(bob.session.access_token);
  async function verdictReachesBob(label, approved) {
    return new Promise((resolve, reject) => {
      let probeTimer = null;
      let channel = null;
      const finish = (ok, detail) => {
        clearTimeout(timer);
        if (probeTimer) clearInterval(probeTimer);
        if (channel) void bob.client.removeChannel(channel);
        if (ok) resolve(detail);
        else reject(new Error(detail));
      };
      const timer = setTimeout(() => finish(false, "no realtime event within 20s"), 20000);
      const probe = () =>
        void (async () => {
          const { data: row } = await flagAs(alice, campaignId, aliceCharacterId, label, "No uses remaining");
          if (row) await resolveAs(dm, row.id, approved);
        })().catch(() => undefined);
      channel = bob.client
        .channel(`verify-overrides:${label}:${crypto.randomUUID()}`)
        .on(
          "postgres_changes",
          { event: "UPDATE", schema: "public", table: "action_overrides", filter: `campaign_id=eq.${campaignId}` },
          (payload) => {
            if (payload.new.action_label !== label) return;
            if (payload.new.status !== (approved ? "approved" : "denied")) return;
            finish(true, payload.new);
          }
        )
        .subscribe();
      probe();
      probeTimer = setInterval(probe, 2500);
    });
  }
  const liveApproved = await verdictReachesBob("Realtime Approve Probe", true).catch((err) => err);
  check(
    "an approval reaches another member's postgres_changes subscription live",
    !(liveApproved instanceof Error) && liveApproved.status === "approved",
    liveApproved instanceof Error ? liveApproved.message : undefined
  );
  const liveDenied = await verdictReachesBob("Realtime Deny Probe", false).catch((err) => err);
  check(
    "a denial reaches another member's postgres_changes subscription live",
    !(liveDenied instanceof Error) && liveDenied.status === "denied",
    liveDenied instanceof Error ? liveDenied.message : undefined
  );

  // ── 3. Browser: the quick-actions blocked-spell path, end to end. ──

  const aliceContext = await browser.newContext();
  await aliceContext.addCookies(sessionCookies(alice.session));
  const room = await aliceContext.newPage();
  await room.goto(`${APP_URL}/campaigns/${campaignId}/room`);
  await room.waitForSelector('[data-testid="quick-actions-panel"]', { timeout: 30000 });

  const visible = (page, testid, timeout = 15000) =>
    page
      .waitForSelector(`[data-testid="${testid}"]`, { timeout })
      .then(() => true)
      .catch(() => false);
  const absent = async (page, testid) => (await page.$(`[data-testid="${testid}"]`)) === null;

  check(
    "a slot-blocked spell renders in the quick-actions panel (not omitted)",
    await visible(room, "quick-action-spell-witch-bolt")
  );
  check(
    "it shows the exhaustion reason",
    ((await room.textContent('[data-testid="quick-action-blocked-spell-witch-bolt"]').catch(() => "")) ?? "")
      .includes("No 1st-level spell slots remaining")
  );
  check(
    "it offers Flag to DM and no fire control",
    (await visible(room, "quick-action-flag-spell-witch-bolt")) &&
      (await absent(room, "quick-action-fire-spell-witch-bolt")) &&
      (await absent(room, "quick-action-override-fire-spell-witch-bolt"))
  );
  check(
    "the usable cantrip beside it still has its ordinary fire control",
    await visible(room, "quick-action-fire-spell-fire-bolt")
  );

  await room.click('[data-testid="quick-action-flag-spell-witch-bolt"]');
  const witchFlag = await pollOverride(
    campaignId,
    (row) => row.action_label === "Witch Bolt" && row.status === "pending"
  );
  check(
    "clicking Flag to DM inserts the pending override with label + reason",
    witchFlag !== null &&
      witchFlag.character_id === aliceCharacterId &&
      witchFlag.requested_by === alice.id &&
      witchFlag.reason === "No 1st-level spell slots remaining",
    JSON.stringify(witchFlag)
  );
  check(
    "the row shows Flagged — waiting for the DM",
    await visible(room, "quick-action-flagged-spell-witch-bolt")
  );

  // The DM's room: the flag appears in the DM Controls panel; approve it.
  // STALE ASSUMPTION UPDATE (Phase 4): DmOverridesPanel used to be an
  // always-mounted DM-only panel — it now lives inside the DM's book
  // (DmBook.tsx), so it only exists in the DOM once the book is opened and
  // switched to its "DM Controls" tab. Everything below this is otherwise
  // unchanged: the same panel, the same testids, just reached through the
  // book first.
  const dmContext = await browser.newContext();
  await dmContext.addCookies(sessionCookies(dm.session));
  const dmRoom = await dmContext.newPage();
  await dmRoom.goto(`${APP_URL}/campaigns/${campaignId}/room`);
  await dmRoom.waitForSelector('[data-testid="dm-book-toggle"]', { timeout: 30000 });
  await dmRoom.click('[data-testid="dm-book-toggle"]');
  await dmRoom.waitForSelector('[data-testid="dm-book-panel"]', { timeout: 10000 });
  await dmRoom.click('[data-testid="dm-book-tab-dmControls"]');
  check("the DM sees the DM Controls panel", await visible(dmRoom, "dm-controls-panel", 30000));
  check(
    "the pending flag lists in the DM Controls rule-overrides section",
    await visible(dmRoom, `dm-override-${witchFlag.id}`)
  );
  const entryText =
    (await dmRoom.textContent(`[data-testid="dm-override-${witchFlag.id}"]`).catch(() => "")) ?? "";
  check(
    "the entry names the character, action, reason and requester",
    entryText.includes("Witch Bolt") &&
      entryText.includes("No 1st-level spell slots remaining") &&
      entryText.includes("Alice PC") &&
      entryText.includes("Overrides alice"),
    entryText
  );
  await dmRoom.click(`[data-testid="dm-override-approve-${witchFlag.id}"]`);
  const approvedWitch = await pollOverride(
    campaignId,
    (row) => row.id === witchFlag.id && row.status === "approved"
  );
  check(
    "the DM panel's Approve resolves the flag (resolved_by = DM)",
    approvedWitch !== null && approvedWitch.resolved_by === dm.id,
    JSON.stringify(approvedWitch)
  );
  check(
    "approving removes it from the DM panel's pending list",
    await dmRoom
      .waitForSelector(`[data-testid="dm-override-${witchFlag.id}"]`, { state: "detached", timeout: 15000 })
      .then(() => true)
      .catch(() => false)
  );

  // The player's panel flips live to the one-time DM-approved fire.
  check(
    "the player's blocked action gains Use anyway (DM-approved) live",
    await visible(room, "quick-action-override-fire-spell-witch-bolt", 20000)
  );
  check(
    "the shared dice log shows the ruling as a distinct non-roll entry",
    (await visible(room, `override-entry-${witchFlag.id}`)) &&
      (((await room.textContent(`[data-testid="override-entry-${witchFlag.id}"]`).catch(() => "")) ?? "")
        .includes("DM approved"))
  );

  let known = await attackRollIds(campaignId);
  await room.fill('[data-testid="quick-action-ac-spell-witch-bolt"]', "1");
  await room.click('[data-testid="quick-action-override-fire-spell-witch-bolt"]');
  const overrideRoll = await newestAttackRollAfter(campaignId, known);
  check(
    "the approved fire posts a NORMAL kind:'attack' spell roll",
    overrideRoll !== null &&
      overrideRoll.kind === "attack" &&
      overrideRoll.breakdown.type === "d20" &&
      overrideRoll.breakdown.label === "Spell attack" &&
      overrideRoll.breakdown.attack?.attackKind === "spell" &&
      overrideRoll.breakdown.attack?.targetAc === 1 &&
      overrideRoll.breakdown.attack?.targetName === "Goblin" &&
      overrideRoll.character_id === aliceCharacterId &&
      overrideRoll.roller_user_id === alice.id,
    JSON.stringify(overrideRoll?.breakdown)
  );

  const consumedWitch = await pollOverride(
    campaignId,
    (row) => row.id === witchFlag.id && row.status === "consumed"
  );
  check("the override is marked consumed once the roll lands", consumedWitch !== null);

  const { data: slotAfter } = await admin
    .from("character_resources")
    .select("current_uses, max_uses")
    .eq("id", slotResourceId)
    .single();
  check(
    "the spell-slot resource was NOT decremented by the override fire",
    slotAfter?.current_uses === 0 && slotAfter?.max_uses === 2,
    JSON.stringify(slotAfter)
  );

  check(
    "after consumption the action reverts to needing a fresh flag",
    (await visible(room, "quick-action-flag-spell-witch-bolt", 20000)) &&
      (await absent(room, "quick-action-override-fire-spell-witch-bolt"))
  );
  const { data: refire } = await consumeAs(alice, witchFlag.id);
  check(
    "re-consuming the spent override is rejected (fresh flag required)",
    (refire ?? []).length === 0,
    JSON.stringify(refire)
  );

  // Shape identity: an ordinary quick action (the cantrip) produces a
  // structurally identical roll_log row.
  known = await attackRollIds(campaignId);
  await room.fill('[data-testid="quick-action-ac-spell-fire-bolt"]', "1");
  await room.click('[data-testid="quick-action-fire-spell-fire-bolt"]');
  const ordinaryRoll = await newestAttackRollAfter(campaignId, known);
  check("an ordinary quick action still fires beside the override flow", ordinaryRoll !== null);
  if (overrideRoll && ordinaryRoll) {
    const keys = (obj) => Object.keys(obj ?? {}).sort().join(",");
    check(
      "the override-fired roll is shape-identical to an ordinary quick-action roll",
      ordinaryRoll.kind === overrideRoll.kind &&
        keys(ordinaryRoll.breakdown) === keys(overrideRoll.breakdown) &&
        keys(ordinaryRoll.breakdown.attack) === keys(overrideRoll.breakdown.attack) &&
        ordinaryRoll.breakdown.label === overrideRoll.breakdown.label &&
        ordinaryRoll.breakdown.mode === overrideRoll.breakdown.mode &&
        JSON.stringify(ordinaryRoll.breakdown.modifiers.map((m) => m.label)) ===
          JSON.stringify(overrideRoll.breakdown.modifiers.map((m) => m.label)),
      JSON.stringify({ ordinary: keys(ordinaryRoll.breakdown), override: keys(overrideRoll.breakdown) })
    );
  }

  // ── 4. Browser: the character-sheet resource path, end to end. ──

  const sheet = await aliceContext.newPage();
  await sheet.goto(`${APP_URL}/campaigns/${campaignId}/characters/${aliceCharacterId}`);
  await sheet.waitForSelector('[data-testid="resource-blocked-heroic-surge"]', { timeout: 30000 });
  check(
    "an exhausted resource shows why Spend is disabled and a Flag to DM button",
    ((await sheet.textContent('[data-testid="resource-blocked-heroic-surge"]').catch(() => "")) ?? "")
      .includes("No uses remaining") && (await visible(sheet, "resource-flag-heroic-surge"))
  );
  await sheet.click('[data-testid="resource-flag-heroic-surge"]');
  const surgeFlag = await pollOverride(
    campaignId,
    (row) => row.action_label === "Heroic Surge" && row.status === "pending"
  );
  check(
    "flagging from the sheet inserts the pending override",
    surgeFlag !== null && surgeFlag.reason === "No uses remaining" && surgeFlag.requested_by === alice.id,
    JSON.stringify(surgeFlag)
  );
  check(
    "the sheet row shows Flagged — waiting for the DM",
    await visible(sheet, "resource-flagged-heroic-surge")
  );

  const { data: surgeApprove } = await resolveAs(dm, surgeFlag.id, true);
  check("the DM approves the sheet flag", surgeApprove?.[0]?.status === "approved");
  check(
    "the sheet gains the one-time Use anyway (DM-approved) control live",
    await visible(sheet, "resource-use-anyway-heroic-surge", 20000)
  );
  check(
    "the sheet's recent-roll area notes the DM's ruling",
    (await visible(sheet, "sheet-override-notice")) &&
      (((await sheet.textContent('[data-testid="sheet-override-notice"]').catch(() => "")) ?? "")
        .includes("approved"))
  );

  await sheet.click('[data-testid="resource-use-anyway-heroic-surge"]');
  const consumedSurge = await pollOverride(
    campaignId,
    (row) => row.id === surgeFlag.id && row.status === "consumed"
  );
  check("Use anyway consumes the override", consumedSurge !== null);
  const { data: surgeAfter } = await admin
    .from("character_resources")
    .select("current_uses, max_uses")
    .eq("id", surgeResourceId)
    .single();
  check(
    "the resource row was never touched — current_uses still 0 (no setCharacterResourceUses call)",
    surgeAfter?.current_uses === 0 && surgeAfter?.max_uses === 1,
    JSON.stringify(surgeAfter)
  );
  check(
    "the sheet reverts to needing a fresh flag",
    (await visible(sheet, "resource-flag-heroic-surge", 20000)) &&
      (await absent(sheet, "resource-use-anyway-heroic-surge"))
  );
  check(
    "the sheet confirms the DM-granted use happened",
    (((await sheet.textContent('[data-testid="sheet-override-notice"]').catch(() => "")) ?? "")
      .includes("Used Heroic Surge with DM approval"))
  );
} finally {
  await browser.close();
  await admin.auth.admin.deleteUser(dm.id);
  await admin.auth.admin.deleteUser(alice.id);
  await admin.auth.admin.deleteUser(bob.id);
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
console.log("\nAll action-override checks passed.");
process.exit(0);
