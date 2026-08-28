#!/usr/bin/env node
// Pawn Customization verification: two new, previously-nonexistent
// per-character-token customizations —
//   P1. profiles.default_pawn_color (0079): account-wide, follows a user
//       into every campaign/character, colors a party-aligned PC token's
//       disc/plinth instead of the hardcoded ALLEGIANCE_COLOR.party teal.
//   P2. character_pawns.pawn_model_ref (0080): per-character custom .glb,
//       overriding the disc entirely — the SAME C6/C7 live-pointer chain
//       shape (campaign_monster_template_overrides), one FK hop earlier.
//
// Checks, in order:
//   1. RLS, not just UI: a real second campaign member (playerB) cannot set
//      playerA's own default_pawn_color, and cannot set/upload a pawn model
//      for a character playerB doesn't own — both verified as direct
//      Supabase calls under playerB's own session, confirming zero rows
//      changed (admin re-read), not just trusting an error/success shape.
//      A user who ISN'T a campaign member at all (outsider) additionally
//      cannot even READ playerA's character_pawns row or fetch the pawn
//      model's storage object — the map-art-generation E4 "outsider gets
//      neither" proof, mirrored for this bucket. Profile colors, by
//      contrast, ARE readable by a total outsider (profiles' own existing
//      broad-SELECT posture) — asserted as a positive, not a denial.
//   2. Real two-client color live-update: the DM's own already-open Game
//      Room page (never reloaded) reflects playerA's chosen color on
//      playerA's placed token, then reflects a NEW color the moment
//      playerA changes it via the REAL /account page UI — read from the
//      hidden token-model-state mirror's colorOverrideByTokenId, the C6/C7
//      "WebGL has no DOM of its own" precedent applied to a resolved color
//      instead of a resolved model url.
//   3. Real model upload + cross-account render: playerA (the token's own
//      owner, a real player account, not the DM) uploads a real .glb via
//      the REAL character-sheet page UI (PawnModelPicker, a genuine
//      setInputFiles + validateGlbFile parse, no shortcuts). A different
//      real account (playerB, an ordinary campaign member) can then fetch
//      the stored object under their OWN session (the exact "a real second
//      account can fetch the stored object" proof this session's Map Art
//      Generation E4 established for its own bucket) and the DM's
//      already-open Game Room page, ON A RELOAD (the same "live pointer,
//      re-resolved fresh, on nothing more than a reload" proof C6/C7 used
//      for campaign_monster_template_overrides), now renders the model
//      instead of the disc — with a genuine measured bounding box, not
//      just a resolved URL string.
//   4. Removing the model, same reload-based live-pointer proof, falls back
//      to the disc — still colored by playerA's (still-changed) account
//      color, not hardcoded teal.
//   5. Zero NPC/monster regression: an ordinary stat-blocked NPC token
//      placed on the SAME map, in the SAME page loads, never gets a
//      colorOverride and keeps resolving its model through the unmodified
//      C6/C7 chain — checked inline, on top of separately re-running
//      verify-monster-template-overrides.mjs and
//      verify-monster-template-player-visibility.mjs as an external
//      regression pass (see this track's own final report for those
//      results).
//
// Needs the local/shared Supabase stack; starts this worktree's own
// `yarn dev` on a fixed, explicit, isolated port if it isn't already
// serving — never the usual :3000 default (this project's own hard-won
// lesson: that port is a live, unrelated server on this machine).
// Usage: node scripts/db/verify-pawn-customization.mjs
//        PAWN_CUSTOMIZATION_APP_PORT=4340 node scripts/db/verify-pawn-customization.mjs

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { GPU_LAUNCH_ARGS } from "./lib/browser.mjs";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const APP_PORT = Number(process.env.PAWN_CUSTOMIZATION_APP_PORT ?? 4340);
const APP_URL = `http://localhost:${APP_PORT}`;

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

// The @supabase/ssr cookie format — verify-monster-template-overrides.mjs's
// own established pattern for this app.
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
async function makeTestUser(label) {
  const email = `pawn-custom-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `Pawn ${label}` });
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: signIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  return { id: data.user.id, email, client, session: signIn.session };
}

async function readTokenModelState(page) {
  const el = await page.$('[data-testid="token-model-state"]');
  if (!el) return null;
  return JSON.parse(await el.textContent());
}

async function pollTokenModelState(predicate, page, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await readTokenModelState(page);
    if (last && predicate(last)) return last;
    await sleep(300);
  }
  return last;
}

// Reuses the real, on-disk Witch preset as the upload's source bytes — the
// SAME "what's under test is the linking/rendering mechanism, not new model
// content" reasoning verify-monster-template-overrides.mjs's own
// OVERRIDE_UPLOAD_SOURCE_PATH comment gives.
const UPLOAD_SOURCE_PATH = join(rootDir, "public", "assets", "presets", "witch.glb");

const TEAL_DEFAULT = "#1ec8c8";
const CHANGED_COLOR = "#ffd23f";

await ensureDevServer();

const dm = await makeTestUser("dm");
const playerA = await makeTestUser("player-a");
const playerB = await makeTestUser("player-b");
const outsider = await makeTestUser("outsider");
const browser = await chromium.launch({ args: GPU_LAUNCH_ARGS });

const campaignId = crypto.randomUUID();
const characterId = crypto.randomUUID();

try {
  // ═══════════════════════════════════════════════════════════════════
  // Seed: one campaign (DM + playerA + playerB — outsider is NOT a
  // member), a live map, playerA's own PC (party-aligned token) and an
  // ordinary Goblin-templated NPC token for the zero-regression check.
  // ═══════════════════════════════════════════════════════════════════
  await admin.from("campaigns").insert({ id: campaignId, name: "Pawn customization test", creator: dm.id });
  await admin.from("campaign_members").insert([
    { campaign_id: campaignId, user_id: dm.id, role: "dm" },
    { campaign_id: campaignId, user_id: playerA.id, role: "player" },
    { campaign_id: campaignId, user_id: playerB.id, role: "player" },
  ]);

  const mapId = crypto.randomUUID();
  await admin.from("campaign_maps").insert({
    id: mapId,
    campaign_id: campaignId,
    name: "Pawn customization test map",
    grid_width: 6,
    grid_height: 1,
  });
  await admin.from("campaigns").update({ live_map: mapId }).eq("id", campaignId);

  const { error: characterError } = await admin.from("characters").insert({
    id: characterId,
    campaign_id: campaignId,
    owner_id: playerA.id,
    name: "Pawn Test PC",
    race: "Human",
    class: "Fighter",
    level: 1,
    strength: 14,
    dexterity: 12,
    constitution: 13,
    intelligence: 10,
    wisdom: 10,
    charisma: 8,
    current_hp: 10,
    max_hp: 10,
    armor_class: 15,
    speed: 30,
    proficiencies: [],
    inventory: [],
    spells: [],
  });
  if (characterError) throw new Error(`seeding playerA's character: ${characterError.message}`);

  const { data: pcToken, error: pcTokenError } = await admin
    .from("map_tokens")
    .insert({ map_id: mapId, character_id: characterId, x: 1, y: 0, elevation: 0, allegiance: "party" })
    .select()
    .single();
  if (pcTokenError) throw new Error(`placing the PC token: ${pcTokenError.message}`);

  const { data: goblinTemplate, error: goblinError } = await admin
    .from("monster_templates")
    .select()
    .eq("name", "Goblin")
    .single();
  if (goblinError || !goblinTemplate) throw new Error(`reading the real Goblin template: ${goblinError?.message}`);

  const { data: statBlock, error: statBlockError } = await dm.client
    .from("monster_stat_blocks")
    .insert({
      campaign_id: campaignId,
      template_id: goblinTemplate.id,
      name: goblinTemplate.name,
      max_hp: goblinTemplate.max_hp,
      armor_class: goblinTemplate.armor_class,
      passive_perception: goblinTemplate.passive_perception,
      attacks: goblinTemplate.attacks,
      default_allegiance: goblinTemplate.default_allegiance,
    })
    .select()
    .single();
  if (statBlockError) throw new Error(`seeding the Goblin stat block: ${statBlockError.message}`);

  const { data: npcToken, error: npcTokenError } = await dm.client
    .from("map_tokens")
    .insert({
      map_id: mapId,
      npc_name: statBlock.name,
      monster_stat_block_id: statBlock.id,
      x: 3,
      y: 0,
      elevation: 0,
      allegiance: statBlock.default_allegiance,
    })
    .select()
    .single();
  if (npcTokenError) throw new Error(`placing the Goblin token: ${npcTokenError.message}`);

  // Sanity: the trigger-created character_pawns row exists with the
  // expected identity and no model set yet.
  const { data: initialPawnRow } = await admin
    .from("character_pawns")
    .select()
    .eq("character_id", characterId)
    .maybeSingle();
  check(
    "0080's trigger auto-created a character_pawns row for the new character",
    initialPawnRow?.owner_id === playerA.id && initialPawnRow?.campaign_id === campaignId && initialPawnRow?.pawn_model_ref === null,
    initialPawnRow
  );
  const { data: initialProfileRow } = await admin.from("profiles").select("default_pawn_color").eq("id", playerA.id).single();
  check(
    "0079's column default gives playerA today's exact TEAL color before any customization",
    initialProfileRow?.default_pawn_color === TEAL_DEFAULT,
    initialProfileRow
  );

  // ═══════════════════════════════════════════════════════════════════
  // 1. RLS checks — a real second account, not just a UI check.
  // ═══════════════════════════════════════════════════════════════════

  // 1a. playerB cannot set playerA's own account color.
  const colorHijack = await playerB.client
    .from("profiles")
    .update({ default_pawn_color: "#000000" })
    .eq("id", playerA.id)
    .select();
  const { data: afterColorHijack } = await admin.from("profiles").select("default_pawn_color").eq("id", playerA.id).single();
  check(
    "a non-owner (playerB) cannot set playerA's account-wide pawn color (RLS)",
    (colorHijack.data?.length ?? 0) === 0 && afterColorHijack?.default_pawn_color === TEAL_DEFAULT,
    { returned: colorHijack.data, afterColorHijack }
  );

  // 1b. playerB cannot set/upload a pawn model for playerA's character.
  const modelHijack = await playerB.client
    .from("character_pawns")
    .update({ pawn_model_ref: "hijacked.glb" })
    .eq("character_id", characterId)
    .select();
  const { data: afterModelHijack } = await admin
    .from("character_pawns")
    .select("pawn_model_ref")
    .eq("character_id", characterId)
    .single();
  check(
    "a non-owner (playerB) cannot set a pawn model for a character they don't own (RLS)",
    (modelHijack.data?.length ?? 0) === 0 && afterModelHijack?.pawn_model_ref === null,
    { returned: modelHijack.data, afterModelHijack }
  );

  const hijackUploadBytes = readFileSync(UPLOAD_SOURCE_PATH);
  const hijackUpload = await playerB.client.storage
    .from("character-pawns")
    .upload(`${characterId}/pawn.glb`, hijackUploadBytes, { contentType: "model/gltf-binary", upsert: true });
  check(
    "a non-owner (playerB) cannot upload to another character's pawn-model storage path (RLS)",
    Boolean(hijackUpload.error),
    hijackUpload.error?.message
  );

  // 1c. A total outsider (not even a campaign member) can read the
  //     account-wide color (profiles' own existing broad-SELECT posture —
  //     a positive check, not a denial) but cannot read the campaign-scoped
  //     character_pawns row or fetch its storage object at all — the
  //     map-art-generation E4 "outsider gets neither" proof, mirrored here.
  const outsiderProfileRead = await outsider.client.from("profiles").select("default_pawn_color").eq("id", playerA.id).maybeSingle();
  check(
    "a total outsider CAN read playerA's account-wide pawn color (profiles' existing broad-read RLS — a feature, not a leak)",
    !outsiderProfileRead.error && outsiderProfileRead.data?.default_pawn_color === TEAL_DEFAULT,
    outsiderProfileRead
  );
  const outsiderPawnRead = await outsider.client.from("character_pawns").select().eq("character_id", characterId).maybeSingle();
  check(
    "a total outsider (not a campaign member) cannot read the character_pawns row (RLS)",
    !outsiderPawnRead.error && outsiderPawnRead.data === null,
    outsiderPawnRead
  );

  // ═══════════════════════════════════════════════════════════════════
  // 2. Real two-client color live-update: the DM's own already-open Game
  //    Room page reflects playerA's color, then a CHANGE to it, without a
  //    reload — driven through the REAL /account page UI.
  // ═══════════════════════════════════════════════════════════════════
  const dmContext = await browser.newContext();
  await dmContext.addCookies(sessionCookies(dm.session));
  const dmPage = await dmContext.newPage();
  await dmPage.goto(`${APP_URL}/campaigns/${campaignId}/room`);
  await dmPage.waitForSelector('[data-testid="token-model-state"]', { state: "attached", timeout: 30000 });
  await dmPage.waitForSelector("canvas", { timeout: 30000 });

  const dmStateInitial = await pollTokenModelState(
    (state) => Object.hasOwn(state.colorOverrideByTokenId, pcToken.id),
    dmPage
  );
  check(
    "the DM's already-open Game Room page resolves playerA's PC token to playerA's own (default TEAL) account color",
    dmStateInitial?.colorOverrideByTokenId[pcToken.id]?.toLowerCase() === TEAL_DEFAULT,
    dmStateInitial?.colorOverrideByTokenId
  );

  const playerAAccountContext = await browser.newContext();
  await playerAAccountContext.addCookies(sessionCookies(playerA.session));
  const playerAAccountPage = await playerAAccountContext.newPage();
  await playerAAccountPage.goto(`${APP_URL}/account`);
  await playerAAccountPage.getByTestId("pawn-color-custom-input").waitFor({ state: "attached", timeout: 20000 });
  // The native color input's fill() sets its value and fires a change
  // event — the same real onChange -> setDefaultPawnColor path a manual
  // pick would take.
  await playerAAccountPage.getByTestId("pawn-color-custom-input").fill(CHANGED_COLOR);
  await playerAAccountPage.getByTestId("pawn-color-saved").waitFor({ state: "visible", timeout: 10000 });

  const dmStateAfterColorChange = await pollTokenModelState(
    (state) => state.colorOverrideByTokenId[pcToken.id]?.toLowerCase() === CHANGED_COLOR,
    dmPage
  );
  check(
    "THE LIVE PROOF: the DM's SAME already-open page (never reloaded) picks up playerA's NEW account color on the already-placed token",
    dmStateAfterColorChange?.colorOverrideByTokenId[pcToken.id]?.toLowerCase() === CHANGED_COLOR,
    dmStateAfterColorChange?.colorOverrideByTokenId
  );

  // Zero regression, inline: the Goblin NPC token, in this SAME page load,
  // still has no colorOverride at all (an NPC has no owning player account
  // to color it by) and still resolves its unmodified C6 default model.
  check(
    "zero regression: the Goblin NPC token never gets a colorOverride (no owning player account)",
    !dmStateAfterColorChange?.colorOverrideByTokenId[npcToken.id],
    dmStateAfterColorChange?.colorOverrideByTokenId
  );
  check(
    "zero regression: the Goblin NPC token still resolves its unmodified C6 default model",
    dmStateAfterColorChange?.modelUrlByTokenId[npcToken.id] === "/assets/presets/goblin.glb",
    dmStateAfterColorChange?.modelUrlByTokenId
  );
  check(
    "playerA's PC token has no model yet — still the flat colored disc, not a model",
    dmStateAfterColorChange?.modelUrlByTokenId[pcToken.id] === null,
    dmStateAfterColorChange?.modelUrlByTokenId
  );

  await playerAAccountContext.close();

  // ═══════════════════════════════════════════════════════════════════
  // 3. Real model upload (playerA's own account, the real character-sheet
  //    UI) + cross-account fetch (playerB's own session) + the DM's
  //    already-open page picking it up on reload.
  // ═══════════════════════════════════════════════════════════════════
  const playerASheetContext = await browser.newContext();
  await playerASheetContext.addCookies(sessionCookies(playerA.session));
  const playerASheetPage = await playerASheetContext.newPage();
  await playerASheetPage.goto(`${APP_URL}/campaigns/${campaignId}/characters/${characterId}`);
  await playerASheetPage.getByTestId("pawn-model-upload-button").waitFor({ state: "visible", timeout: 20000 });
  await playerASheetPage.getByLabel("Upload a custom pawn model").setInputFiles(UPLOAD_SOURCE_PATH);
  await playerASheetPage.getByTestId("pawn-model-saved").waitFor({ state: "visible", timeout: 20000 });

  const { data: pawnRowAfterUpload } = await admin
    .from("character_pawns")
    .select("pawn_model_ref")
    .eq("character_id", characterId)
    .single();
  check(
    "playerA's real upload (their own account, the real sheet UI) wrote a pawn_model_ref",
    pawnRowAfterUpload?.pawn_model_ref === `${characterId}/pawn.glb`,
    pawnRowAfterUpload
  );

  // The core storage/RLS proof, mirroring Map Art Generation E4's own: a
  // REAL second account (playerB, an ordinary campaign member, never the
  // uploader) can read the character_pawns row AND fetch the real model
  // bytes via a signed URL, using their OWN session.
  const playerBPawnRead = await playerB.client.from("character_pawns").select().eq("character_id", characterId).maybeSingle();
  check(
    "a real second campaign member (playerB, not the uploader) can read the character_pawns row under their own session",
    !playerBPawnRead.error && playerBPawnRead.data?.pawn_model_ref === `${characterId}/pawn.glb`,
    playerBPawnRead
  );
  const playerBSignedUrl = await playerB.client.storage
    .from("character-pawns")
    .createSignedUrl(`${characterId}/pawn.glb`, 300);
  check(
    "the same second account can mint a signed URL for the uploaded model under their own session",
    !playerBSignedUrl.error && Boolean(playerBSignedUrl.data?.signedUrl),
    playerBSignedUrl.error
  );
  if (playerBSignedUrl.data?.signedUrl) {
    const modelFetch = await fetch(playerBSignedUrl.data.signedUrl);
    const modelBytes = modelFetch.ok ? new Uint8Array(await modelFetch.arrayBuffer()) : null;
    // "glTF" magic (0x676c5446 little-endian == bytes 0x67,0x6c,0x54,0x46) —
    // validate-glb.ts's own GLB_MAGIC check, applied here to the FETCHED
    // bytes over HTTP, not just the local file on disk.
    const magicOk = Boolean(
      modelBytes && modelBytes.length > 100 && modelBytes[0] === 0x67 && modelBytes[1] === 0x6c && modelBytes[2] === 0x54 && modelBytes[3] === 0x46
    );
    check(
      "the second account's own signed URL actually serves real .glb bytes over HTTP",
      modelFetch.ok && magicOk,
      { status: modelFetch.status, length: modelBytes?.length }
    );
  }
  // The outsider still gets neither, even now that a model exists.
  const outsiderSignedUrlAfterUpload = await outsider.client.storage
    .from("character-pawns")
    .createSignedUrl(`${characterId}/pawn.glb`, 300);
  check(
    "a total outsider still cannot mint a signed URL for the uploaded model (RLS)",
    Boolean(outsiderSignedUrlAfterUpload.error) || !outsiderSignedUrlAfterUpload.data?.signedUrl,
    outsiderSignedUrlAfterUpload
  );

  // THE LIVE-POINTER PROOF (C6/C7 shape): the DM's SAME already-open page,
  // on nothing more than a reload, now renders playerA's custom model
  // instead of the disc — with a genuine measured bounding box.
  await dmPage.reload();
  await dmPage.waitForSelector('[data-testid="token-model-state"]', { state: "attached", timeout: 30000 });
  const dmStateAfterUpload = await pollTokenModelState(
    (state) => typeof state.modelUrlByTokenId[pcToken.id] === "string",
    dmPage
  );
  check(
    "on reload, the DM's page now resolves playerA's PC token to the uploaded custom model (not null, not the disc)",
    typeof dmStateAfterUpload?.modelUrlByTokenId[pcToken.id] === "string",
    dmStateAfterUpload?.modelUrlByTokenId
  );
  const dmMeasuredAfterUpload = await pollTokenModelState(
    (state) => Boolean(state.measured?.[pcToken.id]?.maxDim > 0),
    dmPage
  );
  check(
    "the DM's page ACTUALLY loaded the model in the real scene (a genuine measured bounding box, not just a resolved URL string)",
    Boolean(dmMeasuredAfterUpload?.measured?.[pcToken.id]?.maxDim > 0),
    dmMeasuredAfterUpload?.measured
  );
  check(
    "zero regression: the Goblin NPC token is unaffected by the PC's own model upload",
    dmStateAfterUpload?.modelUrlByTokenId[npcToken.id] === "/assets/presets/goblin.glb",
    dmStateAfterUpload?.modelUrlByTokenId
  );

  // ═══════════════════════════════════════════════════════════════════
  // 4. Removing the model — same reload-based live-pointer proof, falls
  //    back to the disc, still colored by playerA's (still-changed)
  //    account color, not hardcoded teal.
  // ═══════════════════════════════════════════════════════════════════
  await playerASheetPage.getByTestId("pawn-model-remove-button").click();
  await playerASheetPage.getByTestId("pawn-model-saved").waitFor({ state: "visible", timeout: 10000 });

  const { data: pawnRowAfterRemove } = await admin
    .from("character_pawns")
    .select("pawn_model_ref")
    .eq("character_id", characterId)
    .single();
  check(
    "removing the model (playerA's own real sheet UI) cleared pawn_model_ref back to null",
    pawnRowAfterRemove?.pawn_model_ref === null,
    pawnRowAfterRemove
  );

  await dmPage.reload();
  await dmPage.waitForSelector('[data-testid="token-model-state"]', { state: "attached", timeout: 30000 });
  const dmStateAfterRemove = await pollTokenModelState(
    (state) => state.modelUrlByTokenId[pcToken.id] === null,
    dmPage
  );
  check(
    "on reload, removing the model falls the DM's page back to the flat disc for playerA's token",
    dmStateAfterRemove?.modelUrlByTokenId[pcToken.id] === null,
    dmStateAfterRemove?.modelUrlByTokenId
  );
  check(
    "the disc fallback is still colored by playerA's own (changed) account color, not hardcoded teal",
    dmStateAfterRemove?.colorOverrideByTokenId[pcToken.id]?.toLowerCase() === CHANGED_COLOR,
    dmStateAfterRemove?.colorOverrideByTokenId
  );

  await playerASheetContext.close();
  await dmContext.close();

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
} catch (err) {
  console.error("\nUnexpected error:", err);
  failures++;
} finally {
  try {
    await admin.from("campaigns").delete().eq("id", campaignId);
  } catch {
    // best-effort cleanup only
  }
  for (const user of [dm, playerA, playerB, outsider]) {
    await admin.auth.admin.deleteUser(user.id).catch(() => {});
  }
  await browser.close().catch(() => {});
  if (devServer) {
    try {
      process.kill(-devServer.pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
}

process.exit(failures === 0 ? 0 : 1);
