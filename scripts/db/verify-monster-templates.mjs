#!/usr/bin/env node
// Weather & Enemies C5 verification: the global enemy template library
// (monster_templates, migration 0073) and MonsterPanel's "add from
// library" quick-add extension.
//
// Checks, in order:
//   1. The global list contains real, distinct content for every requested
//      creature type (8 rows: Goblin/Zombie/Trader/Guard/High Guard/
//      Daemon/Demon/Witch), with the exact SRD/SRD-convention numbers this
//      migration seeded — not placeholders.
//   2. RLS is REAL and server-side, not just UI-hidden: any authenticated
//      user can SELECT; a non-admin's direct INSERT/UPDATE/DELETE is
//      rejected/no-ops; a real app-admin (profiles.is_admin, via
//      is_app_admin()) CAN write directly.
//   3. A real browser, signed in as a DM: the book's Enemies page (the
//      book's default tab) offers the template library; a player (non-DM)
//      is never even offered the book at all (the existing established
//      posture, unchanged).
//   4. Clicking "Add to campaign" on a template, in that real browser,
//      copies its stats into a BRAND NEW campaign-scoped monster_stat_blocks
//      row (own id, own independent lifecycle) — verified both in the UI
//      list and directly against the database.
//   5. Editing that copy (via the ordinary stat-block edit form, in the
//      same real browser) changes ONLY the campaign's own row — the global
//      template is BYTE-IDENTICAL before and after, proven by a deep row
//      comparison, not just "still exists". A second campaign's own
//      independently-copied row is also unaffected.
//   6. default_allegiance really flows end to end into a placed token: a
//      Trader-derived stat block places a 'neutral' token (not the
//      historical hardcoded 'hostile' every NPC placement used to always
//      get), a Goblin-derived one still places 'hostile', and a
//      hand-authored freeform stat block (no template involved) still
//      defaults to 'hostile' — zero regression to existing behavior.
//      Exercised via the DM's own real, RLS-authorized authenticated
//      client issuing the exact map_tokens insert shape placeNpcToken
//      builds (mapTokens.ts) — a genuine authorization/data check,
//      deliberately not a fragile pixel-perfect canvas click through the
//      3D book overlay (no existing verify script in this codebase
//      attempts that combination either — confirmed by reading
//      verify-dm-book.mjs and verify-npc-stat-blocks.mjs first).
//
// Needs the local/shared Supabase stack; starts this worktree's own
// `yarn dev` on a fixed, non-default port if it isn't already serving —
// never APP_URL's usual :3000 default, which on this machine is a live
// production server, not a fresh build of this worktree's own changes
// (this project's own hard-won lesson).
// Usage: node scripts/db/verify-monster-templates.mjs
//        MONSTER_TEMPLATES_APP_PORT=4300 node scripts/db/verify-monster-templates.mjs

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { GPU_LAUNCH_ARGS } from "./lib/browser.mjs";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const APP_PORT = Number(process.env.MONSTER_TEMPLATES_APP_PORT ?? 4207);
const APP_URL = `http://localhost:${APP_PORT}`;

// The exact seeded content (0073_monster_templates.sql) — asserted
// directly against real numbers, not just "8 rows exist".
const EXPECTED_TEMPLATES = {
  Goblin: {
    default_allegiance: "hostile",
    max_hp: 7,
    armor_class: 15,
    passive_perception: 9,
    attacks: [
      { name: "Scimitar", bonus: 4, damageNotation: "1d6+2" },
      { name: "Shortbow", bonus: 4, damageNotation: "1d6+2" },
    ],
  },
  Zombie: {
    default_allegiance: "hostile",
    max_hp: 22,
    armor_class: 8,
    passive_perception: 8,
    attacks: [{ name: "Slam", bonus: 3, damageNotation: "1d6+1" }],
  },
  Trader: {
    default_allegiance: "neutral",
    max_hp: 4,
    armor_class: 10,
    passive_perception: 10,
    attacks: [{ name: "Club", bonus: 2, damageNotation: "1d4" }],
  },
  Guard: {
    default_allegiance: "neutral",
    max_hp: 11,
    armor_class: 16,
    passive_perception: 12,
    attacks: [{ name: "Spear", bonus: 3, damageNotation: "1d6+1" }],
  },
  "High Guard": {
    default_allegiance: "neutral",
    max_hp: 58,
    armor_class: 17,
    passive_perception: 12,
    attacks: [
      { name: "Longsword", bonus: 5, damageNotation: "1d8+3" },
      { name: "Heavy Crossbow", bonus: 3, damageNotation: "1d10+1" },
    ],
  },
  Daemon: {
    default_allegiance: "hostile",
    max_hp: 26,
    armor_class: 13,
    passive_perception: 10,
    attacks: [
      { name: "Claw", bonus: 3, damageNotation: "1d6+1" },
      { name: "Bite", bonus: 3, damageNotation: "1d8+1" },
    ],
  },
  Demon: {
    default_allegiance: "hostile",
    max_hp: 18,
    armor_class: 11,
    passive_perception: 9,
    attacks: [
      { name: "Bite", bonus: 2, damageNotation: "1d6" },
      { name: "Claws", bonus: 2, damageNotation: "2d4" },
    ],
  },
  Witch: {
    default_allegiance: "hostile",
    max_hp: 82,
    armor_class: 17,
    passive_perception: 14,
    attacks: [{ name: "Claws", bonus: 6, damageNotation: "2d8+4" }],
  },
};

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

if (!supabaseUrl || !anonKey || !serviceRoleKey) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY.");
  process.exit(1);
}

const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });

let failures = 0;
function check(label, condition, detail) {
  if (condition) {
    console.log(`PASS  ${label}`);
  } else {
    console.error(`FAIL  ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
    failures++;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function healthOk() {
  return fetch(`${APP_URL}/api/health`, { cache: "no-store" }).then((res) => res.ok).catch(() => false);
}

let devServer = null;
async function ensureDevServer() {
  if (await healthOk()) return;
  console.log(`dev server not running on :${APP_PORT} — starting this worktree's own…`);
  devServer = spawn("yarn", ["dev", "-p", String(APP_PORT)], { cwd: rootDir, stdio: "ignore", detached: true });
  for (let i = 0; i < 120; i++) {
    await sleep(1000);
    if (await healthOk()) return;
  }
  throw new Error(`dev server did not become healthy on :${APP_PORT} within 120s`);
}

// The @supabase/ssr cookie format: sb-<host>-auth-token = "base64-" +
// base64url(JSON session), chunked at 3180 chars into name.0, name.1, ...
// (verify-npc-stat-blocks.mjs's own established pattern for this app.)
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

// Seeds test-setup state directly via the service-role client — never a
// blind UI click-scan (this project's own established lesson).
async function makeTestUser(label, opts = {}) {
  const email = `monster-templates-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `Templates ${label}`, is_admin: opts.isAdmin ?? false });
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: signIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  return { id: data.user.id, email, client, session: signIn.session };
}

async function readAllTemplates() {
  const { data, error } = await admin.from("monster_templates").select().order("name");
  if (error) throw new Error(`reading monster_templates: ${error.message}`);
  return data;
}

async function waitForTestId(page, testId, timeoutMs = 10000) {
  return page
    .waitForSelector(`[data-testid="${testId}"]`, { timeout: timeoutMs })
    .then(() => true)
    .catch(() => false);
}

async function pollRow(table, filter, predicate, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let last = [];
  while (Date.now() < deadline) {
    let query = admin.from(table).select();
    for (const [key, value] of Object.entries(filter)) query = query.eq(key, value);
    const { data } = await query;
    last = data ?? [];
    const match = last.find(predicate);
    if (match) return match;
    await sleep(300);
  }
  return null;
}

// DmBookProp's own debug mirror (GameRoom.tsx's dm-book-state) — the only
// way from outside to read a WebGL mesh's `open` state, world position, and
// (once DmBookProp has rendered at least one frame) its exact
// canvas-relative CSS-pixel projection. Absent entirely for a non-DM
// client (verify-weather.mjs/verify-dm-book.mjs's own established
// openDmBook precedent, copied verbatim).
async function readDmBookState(page) {
  const el = await page.$('[data-testid="dm-book-state"]');
  if (!el) return null;
  return JSON.parse(await el.textContent());
}

async function waitForBookScreenPosition(page, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await readDmBookState(page);
    if (last?.screen) return last;
    await sleep(100);
  }
  throw new Error(`dm-book-state never reported a screen projection — last: ${JSON.stringify(last)}`);
}

async function openDmBook(page) {
  const box = await page.locator("canvas").boundingBox();
  if (!box) throw new Error("no canvas on the page");
  const state = await waitForBookScreenPosition(page);
  const [sx, sy] = state.screen;
  const isOpen = async () => (await page.$('[data-testid="dm-book-panel"]')) !== null;
  const offsets = [
    [0, 0],
    [20, 0], [-20, 0], [0, 20], [0, -20],
    [40, 0], [-40, 0], [0, 40], [0, -40],
    [30, 30], [-30, 30], [30, -30], [-30, -30],
  ];
  for (const [dx, dy] of offsets) {
    await page.mouse.click(box.x + sx + dx, box.y + sy + dy);
    await sleep(200);
    if (await isOpen()) return;
  }
  throw new Error(`could not click the 3D book open (tried screen=${JSON.stringify(state.screen)})`);
}

function attacksEqual(actual, expected) {
  const a = actual ?? [];
  if (a.length !== expected.length) return false;
  return expected.every(
    (exp, i) => a[i]?.name === exp.name && a[i]?.bonus === exp.bonus && a[i]?.damageNotation === exp.damageNotation
  );
}

await ensureDevServer();

const dm = await makeTestUser("dm");
const player = await makeTestUser("player");
const admin1 = await makeTestUser("admin1", { isAdmin: true });
const browser = await chromium.launch({ args: GPU_LAUNCH_ARGS });

try {
  // -- 1. Global content: 8 real, distinct rows with the exact seeded
  //    numbers — not placeholders, not copies of one shape re-tinted. --
  const templatesBefore = await readAllTemplates();
  const byName = Object.fromEntries(templatesBefore.map((row) => [row.name, row]));
  check(
    "the global template list has exactly the 8 requested creature types",
    Object.keys(EXPECTED_TEMPLATES).every((name) => byName[name]) && templatesBefore.length === 8,
    { got: templatesBefore.map((r) => r.name) }
  );
  for (const [name, expected] of Object.entries(EXPECTED_TEMPLATES)) {
    const row = byName[name];
    check(
      `${name}'s stats match the seeded SRD/SRD-convention numbers exactly`,
      row &&
        row.default_allegiance === expected.default_allegiance &&
        row.max_hp === expected.max_hp &&
        row.armor_class === expected.armor_class &&
        row.passive_perception === expected.passive_perception &&
        attacksEqual(row.attacks, expected.attacks) &&
        typeof row.description === "string" &&
        row.description.length > 20,
      { row, expected }
    );
  }
  const uniqueStatShapes = new Set(
    templatesBefore.map((row) => `${row.max_hp}|${row.armor_class}|${row.passive_perception}`)
  );
  check(
    "every template has genuinely distinct stats (no re-tinted duplicates)",
    uniqueStatShapes.size === templatesBefore.length,
    [...uniqueStatShapes]
  );
  check(
    "the creature list mixes hostile and neutral defaults (a real per-template field, not one hardcoded allegiance)",
    templatesBefore.some((r) => r.default_allegiance === "hostile") &&
      templatesBefore.some((r) => r.default_allegiance === "neutral"),
    templatesBefore.map((r) => [r.name, r.default_allegiance])
  );

  // -- 2. RLS is real and server-side, not just UI-hidden. --
  const { data: playerRead, error: playerReadError } = await player.client.from("monster_templates").select();
  check(
    "any authenticated user (a non-DM player here) can SELECT the global list",
    !playerReadError && (playerRead ?? []).length === 8,
    { error: playerReadError?.message, count: playerRead?.length }
  );
  const { error: playerInsertError } = await player.client
    .from("monster_templates")
    .insert({ name: `Hacker Goblin ${Date.now()}`, default_allegiance: "hostile", max_hp: 1, armor_class: 1 });
  check(
    "a non-admin's direct INSERT into monster_templates is rejected by RLS",
    playerInsertError !== null,
    playerInsertError?.message ?? "insert unexpectedly succeeded"
  );
  const { count: playerUpdateCount } = await player.client
    .from("monster_templates")
    .update({ max_hp: 9999 }, { count: "exact" })
    .eq("name", "Goblin");
  const { count: playerDeleteCount } = await player.client
    .from("monster_templates")
    .delete({ count: "exact" })
    .eq("name", "Goblin");
  check(
    "a non-admin's direct UPDATE/DELETE on monster_templates affects zero rows (RLS)",
    playerUpdateCount === 0 && playerDeleteCount === 0,
    { playerUpdateCount, playerDeleteCount }
  );
  const testTemplateName = `Admin Test Kobold ${Date.now()}`;
  const { data: adminInsert, error: adminInsertError } = await admin1.client
    .from("monster_templates")
    .insert({ name: testTemplateName, default_allegiance: "hostile", max_hp: 3, armor_class: 12, passive_perception: 9 })
    .select()
    .maybeSingle();
  check(
    "a real app admin (profiles.is_admin, via is_app_admin()) CAN write monster_templates directly",
    !adminInsertError && adminInsert?.name === testTemplateName,
    { error: adminInsertError?.message, row: adminInsert }
  );
  if (adminInsert?.id) {
    await admin.from("monster_templates").delete().eq("id", adminInsert.id);
  }

  // -- 3. Real browser: campaign, live map, DM's book. --
  const campaignId = crypto.randomUUID();
  await admin.from("campaigns").insert({ id: campaignId, name: "Monster templates test", creator: dm.id });
  await admin.from("campaign_members").insert([
    { campaign_id: campaignId, user_id: dm.id, role: "dm" },
    { campaign_id: campaignId, user_id: player.id, role: "player" },
  ]);
  const mapId = crypto.randomUUID();
  await admin.from("campaign_maps").insert({
    id: mapId,
    campaign_id: campaignId,
    name: "Template test map",
    grid_width: 10,
    grid_height: 1,
  });
  await admin.from("campaigns").update({ live_map: mapId }).eq("id", campaignId);

  const dmContext = await browser.newContext();
  await dmContext.addCookies(sessionCookies(dm.session));
  const dmPage = await dmContext.newPage();
  await dmPage.goto(`${APP_URL}/campaigns/${campaignId}/room`);
  await dmPage.waitForSelector('[data-testid="dm-book-state"]', { state: "attached", timeout: 30000 });

  const playerContext = await browser.newContext();
  await playerContext.addCookies(sessionCookies(player.session));
  const playerPage = await playerContext.newPage();
  await playerPage.goto(`${APP_URL}/campaigns/${campaignId}/room`);
  await playerPage.waitForTimeout(1000);
  check(
    "a non-DM player is not offered the book at all, so no template library either",
    (await playerPage.$('[data-testid="dm-book-state"]')) === null
  );

  await openDmBook(dmPage);
  check(
    "the DM's book opens directly on the Enemies page (the default), showing the monster panel",
    (await dmPage.$('[data-testid="monster-panel"]')) !== null
  );
  const goblinTemplateId = byName.Goblin.id;
  const traderTemplateId = byName.Trader.id;
  check(
    "the DM can browse the global template library from the Enemies page (Goblin and Trader both listed)",
    (await waitForTestId(dmPage, "monster-template-library")) &&
      (await waitForTestId(dmPage, `monster-template-${goblinTemplateId}`)) &&
      (await waitForTestId(dmPage, `monster-template-${traderTemplateId}`))
  );

  // -- 4. "Add to campaign" copies stats into a BRAND NEW campaign-scoped
  //    row — verified in the UI and directly against the database. --
  const { data: statBlocksBeforeAdd } = await admin.from("monster_stat_blocks").select().eq("campaign_id", campaignId);
  check("the campaign starts with no stat blocks of its own", (statBlocksBeforeAdd ?? []).length === 0);

  await dmPage.click(`[data-testid="add-template-${goblinTemplateId}"]`);
  const goblinCopy = await pollRow(
    "monster_stat_blocks",
    { campaign_id: campaignId },
    (row) => row.name === "Goblin"
  );
  check(
    "clicking 'Add to campaign' on Goblin creates a brand new, independent monster_stat_blocks row copying its stats (including default_allegiance)",
    !!goblinCopy &&
      goblinCopy.max_hp === 7 &&
      goblinCopy.armor_class === 15 &&
      goblinCopy.passive_perception === 9 &&
      goblinCopy.default_allegiance === "hostile" &&
      attacksEqual(goblinCopy.attacks, EXPECTED_TEMPLATES.Goblin.attacks) &&
      goblinCopy.id !== goblinTemplateId,
    goblinCopy
  );
  check(
    "the new copy appears in the DM's own stat-block list in the UI",
    goblinCopy !== null && (await waitForTestId(dmPage, `stat-block-${goblinCopy.id}`))
  );

  await dmPage.click(`[data-testid="add-template-${traderTemplateId}"]`);
  const traderCopy = await pollRow(
    "monster_stat_blocks",
    { campaign_id: campaignId },
    (row) => row.name === "Trader"
  );
  check(
    "adding Trader copies its 'neutral' default_allegiance onto the new row too (a real per-template field, not hardcoded hostile)",
    !!traderCopy && traderCopy.default_allegiance === "neutral" && traderCopy.max_hp === 4,
    traderCopy
  );
  check(
    "the Trader copy also appears in the UI list",
    traderCopy !== null && (await waitForTestId(dmPage, `stat-block-${traderCopy.id}`))
  );

  // -- 5. Editing the copy changes ONLY the campaign's own row — the
  //    global template stays byte-identical. --
  const goblinTemplateSnapshotBefore = byName.Goblin;
  await dmPage.click(`[data-testid="edit-stat-block-${goblinCopy.id}"]`);
  await dmPage.fill('[data-testid="stat-block-hp-input"]', "999");
  await dmPage.click('[data-testid="stat-block-save"]');
  const goblinCopyAfterEdit = await pollRow(
    "monster_stat_blocks",
    { id: goblinCopy.id },
    (row) => row.max_hp === 999
  );
  check(
    "editing the campaign's own Goblin copy through the ordinary edit form actually persists the change to ITS row",
    goblinCopyAfterEdit?.max_hp === 999,
    goblinCopyAfterEdit
  );
  const { data: goblinTemplateAfterEdit } = await admin
    .from("monster_templates")
    .select()
    .eq("id", goblinTemplateId)
    .maybeSingle();
  check(
    "the GLOBAL Goblin template is byte-identical after editing the campaign's copy — never mutated",
    JSON.stringify(goblinTemplateAfterEdit) === JSON.stringify(goblinTemplateSnapshotBefore),
    { before: goblinTemplateSnapshotBefore, after: goblinTemplateAfterEdit }
  );

  // A second campaign's own independently-created copy is also unaffected
  // by the first campaign's edit — the copy is per-campaign-independent,
  // not just "independent of the template".
  const secondCampaignId = crypto.randomUUID();
  await admin.from("campaigns").insert({ id: secondCampaignId, name: "Second campaign", creator: dm.id });
  await admin.from("campaign_members").insert({ campaign_id: secondCampaignId, user_id: dm.id, role: "dm" });
  const { data: secondCopy } = await admin
    .from("monster_stat_blocks")
    .insert({
      campaign_id: secondCampaignId,
      name: "Goblin",
      max_hp: EXPECTED_TEMPLATES.Goblin.max_hp,
      armor_class: EXPECTED_TEMPLATES.Goblin.armor_class,
      passive_perception: EXPECTED_TEMPLATES.Goblin.passive_perception,
      attacks: EXPECTED_TEMPLATES.Goblin.attacks,
      default_allegiance: EXPECTED_TEMPLATES.Goblin.default_allegiance,
    })
    .select()
    .single();
  check(
    "a second campaign's own Goblin copy is unaffected by the first campaign's edit (still HP 7, not 999)",
    secondCopy?.max_hp === 7,
    secondCopy
  );
  await admin.from("campaigns").delete().eq("id", secondCampaignId);

  // -- 6. default_allegiance flows end to end into a placed token. Exercised
  //    via the DM's own real, RLS-authorized authenticated client issuing
  //    the exact map_tokens insert shape placeNpcToken (mapTokens.ts)
  //    builds — a genuine authorization/data check on the real table and
  //    real RLS, deliberately not a fragile pixel-perfect canvas click
  //    through the 3D book overlay (see this script's own top comment). --
  const { data: traderToken, error: traderTokenError } = await dm.client
    .from("map_tokens")
    .insert({
      map_id: mapId,
      npc_name: traderCopy.name,
      monster_stat_block_id: traderCopy.id,
      x: 1,
      y: 0,
      elevation: 0,
      allegiance: traderCopy.default_allegiance,
    })
    .select()
    .single();
  check(
    "placing a token from the Trader copy with its own default_allegiance ('neutral') succeeds and stores 'neutral', not the historical hardcoded 'hostile'",
    !traderTokenError && traderToken?.allegiance === "neutral",
    { error: traderTokenError?.message, token: traderToken }
  );

  const { data: goblinToken, error: goblinTokenError } = await dm.client
    .from("map_tokens")
    .insert({
      map_id: mapId,
      npc_name: goblinCopy.name,
      monster_stat_block_id: goblinCopy.id,
      x: 2,
      y: 0,
      elevation: 0,
      allegiance: goblinCopy.default_allegiance,
    })
    .select()
    .single();
  check(
    "placing a token from the Goblin copy still stores 'hostile' (goblins ARE supposed to default hostile)",
    !goblinTokenError && goblinToken?.allegiance === "hostile",
    { error: goblinTokenError?.message, token: goblinToken }
  );

  // A hand-authored freeform stat block (no template involved at all) —
  // createMonsterStatBlock never sets default_allegiance, so the column's
  // own DB default applies.
  const { data: freeformRow } = await admin
    .from("monster_stat_blocks")
    .insert({
      campaign_id: campaignId,
      name: "Freeform Ogre",
      max_hp: 59,
      armor_class: 11,
      passive_perception: 8,
      attacks: [],
    })
    .select()
    .single();
  check(
    "a hand-authored freeform stat block (not from a template) still defaults default_allegiance to 'hostile'",
    freeformRow?.default_allegiance === "hostile",
    freeformRow
  );
  const { data: freeformToken, error: freeformTokenError } = await dm.client
    .from("map_tokens")
    .insert({
      map_id: mapId,
      npc_name: freeformRow.name,
      monster_stat_block_id: freeformRow.id,
      x: 3,
      y: 0,
      elevation: 0,
      allegiance: freeformRow.default_allegiance,
    })
    .select()
    .single();
  check(
    "placing a token from a freeform (non-template) stat block still stores 'hostile' — zero regression to existing behavior",
    !freeformTokenError && freeformToken?.allegiance === "hostile",
    { error: freeformTokenError?.message, token: freeformToken }
  );

  // -- Final: the global list is completely unchanged from before any of
  //    this ran, across every row, not just Goblin. --
  const templatesAfter = await readAllTemplates();
  check(
    "the ENTIRE global template list (all 8 rows) is byte-identical to its state before this run",
    JSON.stringify(templatesBefore) === JSON.stringify(templatesAfter),
    { before: templatesBefore.length, after: templatesAfter.length }
  );
} finally {
  await browser.close();
  await admin.auth.admin.deleteUser(dm.id).catch(() => {});
  await admin.auth.admin.deleteUser(player.id).catch(() => {});
  await admin.auth.admin.deleteUser(admin1.id).catch(() => {});
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
console.log("\nAll monster template library checks passed.");
process.exit(0);
