#!/usr/bin/env node
// Fixing the DM-only fetch gate: page.tsx's listMonsterTemplates and
// listMonsterTemplateOverridesForCampaign fetches were gated on
// currentUserIsDM, so a non-DM player's own initialMonsterTemplates/
// initialTemplateOverrides props were ALWAYS empty, even though both tables
// are RLS-readable by any campaign member (0073's own SELECT policy is any
// authenticated user; 0075's is any campaign member) — GameRoom's own C6/C7
// token-model resolution (the tableMap memo) runs per-viewer already and
// just needed the DATA, not a resolution-logic change. This script is the
// player-side proof verify-monster-templates.mjs (C5) and
// verify-monster-template-overrides.mjs (C7) never actually attempted: both
// of those scripts only ever read token-model-state from the DM's OWN page.
//
// Checks, in order:
//   1. Real browser, a non-DM PLAYER (own session, own cookies — never the
//      DM's): a Goblin-templated token on the live map resolves to Goblin's
//      own C6 default model on the PLAYER's page, with a genuine measured
//      bounding box (a real loaded model, not just a resolved URL string) —
//      matching exactly what the DM's own page already renders for the
//      same token.
//   2. After the DM sets this campaign's own C7 override for the Goblin
//      template, the SAME player's page (nothing more than a reload) now
//      renders the CUSTOM override model instead — again with a genuine
//      measured bounding box — matching the DM's own page.
//   3. Zero regression: the DM's own page renders identically to before
//      throughout (same default model, then same override model).
//
// Needs the local/shared Supabase stack; starts this worktree's own
// `yarn dev` on a fixed, non-default port if it isn't already serving —
// never APP_URL's usual :3000 default, which on this machine is a live
// production server, not a fresh build of this worktree's own changes
// (this project's own hard-won lesson).
// Usage: node scripts/db/verify-monster-template-player-visibility.mjs
//        MONSTER_TEMPLATE_PLAYER_VISIBILITY_APP_PORT=4300 node scripts/db/verify-monster-template-player-visibility.mjs

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { GPU_LAUNCH_ARGS } from "./lib/browser.mjs";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const APP_PORT = Number(process.env.MONSTER_TEMPLATE_PLAYER_VISIBILITY_APP_PORT ?? 4210);
const APP_URL = `http://localhost:${APP_PORT}`;

const GOBLIN_DEFAULT_MODEL = "/assets/presets/goblin.glb";

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
  const email = `monster-player-vis-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `PlayerVis ${label}` });
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: signIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  return { id: data.user.id, email, client, session: signIn.session };
}

// The hidden token-model-state mirror (GameRoom.tsx, C6/C7) — present for
// EVERY viewer (not DM-gated, confirmed by reading GameRoom.tsx directly:
// unlike dm-book-state/dm-private-tray-state immediately above it in the
// JSX, this div has no `currentUserIsDM ? … : null` wrapper). Read directly
// via textContent, never gated behind isVisible() (this project's own
// hard-won lesson about hidden debug-mirror divs).
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

// Each client independently calls resolvePaletteAssets, which mints its OWN
// freshly-signed URL (getMapAssetSignedUrl) for the same underlying custom
// asset — the DM's and the player's signed URLs for the SAME object
// therefore carry different signature/expiry query strings even when they
// point at the identical storage object. Comparing just the pathname (the
// actual object path: .../map-assets/<campaignId>/<uuid>.glb) is the real
// "same underlying model" check; comparing the full signed URL string
// would be a false negative baked into the signing scheme itself, not a
// product bug.
function assetPathOf(modelUrl) {
  if (typeof modelUrl !== "string") return modelUrl;
  try {
    return new URL(modelUrl).pathname;
  } catch {
    return modelUrl;
  }
}

// Reuses the real, on-disk Witch preset as the override upload's source
// bytes — the SAME "what's under test is the override-linking mechanism,
// not new model content" reasoning verify-monster-template-overrides.mjs's
// own OVERRIDE_UPLOAD_SOURCE_PATH comment gives.
const OVERRIDE_UPLOAD_SOURCE_PATH = join(rootDir, "public", "assets", "presets", "witch.glb");

await ensureDevServer();

const dm = await makeTestUser("dm");
const player = await makeTestUser("player");
const browser = await chromium.launch({ args: GPU_LAUNCH_ARGS });

const campaignId = crypto.randomUUID();
let uploadedCustomAssetId = null;

try {
  const { data: goblinTemplate, error: goblinError } = await admin
    .from("monster_templates")
    .select()
    .eq("name", "Goblin")
    .single();
  if (goblinError || !goblinTemplate) throw new Error(`reading the real Goblin template: ${goblinError?.message}`);

  // -- Seed: one campaign, a DM and a PLAYER (no character of their own —
  //    visionMasking stays null for a player with no placed token, per
  //    GameRoom.tsx's own tierAt doc comment: "null means unmasked… or a
  //    player yet to place a token", so this deliberately isolates the
  //    token-model-resolution fix from vision-masking entirely), a live
  //    map, and a Goblin-templated token. --
  await admin.from("campaigns").insert({ id: campaignId, name: "Player visibility test", creator: dm.id });
  await admin.from("campaign_members").insert([
    { campaign_id: campaignId, user_id: dm.id, role: "dm" },
    { campaign_id: campaignId, user_id: player.id, role: "player" },
  ]);
  const mapId = crypto.randomUUID();
  await admin.from("campaign_maps").insert({
    id: mapId,
    campaign_id: campaignId,
    name: "Player visibility test map",
    grid_width: 5,
    grid_height: 1,
  });
  await admin.from("campaigns").update({ live_map: mapId }).eq("id", campaignId);

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

  const { data: token, error: tokenError } = await dm.client
    .from("map_tokens")
    .insert({
      map_id: mapId,
      npc_name: statBlock.name,
      monster_stat_block_id: statBlock.id,
      x: 1,
      y: 0,
      elevation: 0,
      allegiance: statBlock.default_allegiance,
    })
    .select()
    .single();
  if (tokenError) throw new Error(`placing the Goblin token: ${tokenError.message}`);

  // -- 1. The PLAYER's own client — own session, own cookies, never the
  //    DM's — renders the templated monster's C6 default model, matching
  //    the DM's own page. --
  const dmContext = await browser.newContext();
  await dmContext.addCookies(sessionCookies(dm.session));
  const dmPage = await dmContext.newPage();
  await dmPage.goto(`${APP_URL}/campaigns/${campaignId}/room`);
  await dmPage.waitForSelector('[data-testid="token-model-state"]', { state: "attached", timeout: 30000 });
  await dmPage.waitForSelector("canvas", { timeout: 30000 });

  const playerContext = await browser.newContext();
  await playerContext.addCookies(sessionCookies(player.session));
  const playerPage = await playerContext.newPage();
  await playerPage.goto(`${APP_URL}/campaigns/${campaignId}/room`);
  await playerPage.waitForSelector('[data-testid="token-model-state"]', { state: "attached", timeout: 30000 });
  await playerPage.waitForSelector("canvas", { timeout: 30000 });

  const dmStateDefault = await pollTokenModelState(
    (state) => Object.hasOwn(state.modelUrlByTokenId, token.id),
    dmPage
  );
  check(
    "sanity: the DM's own page still renders the Goblin token's C6 default model, unchanged",
    dmStateDefault?.modelUrlByTokenId[token.id] === GOBLIN_DEFAULT_MODEL,
    dmStateDefault?.modelUrlByTokenId
  );

  const playerStateDefault = await pollTokenModelState(
    (state) => Object.hasOwn(state.modelUrlByTokenId, token.id),
    playerPage
  );
  check(
    "THE FIX: a non-DM player's OWN client (own session, not the DM's) now renders the Goblin token's distinct C6 default model too — not null, not the flat allegiance disc",
    playerStateDefault?.modelUrlByTokenId[token.id] === GOBLIN_DEFAULT_MODEL,
    playerStateDefault?.modelUrlByTokenId
  );

  const playerMeasuredDefault = await pollTokenModelState(
    (state) => Boolean(state.measured?.[token.id]?.maxDim > 0),
    playerPage
  );
  check(
    "the player's page ACTUALLY loaded the model in the real scene (a genuine measured bounding box, not just a resolved URL string)",
    Boolean(playerMeasuredDefault?.measured?.[token.id]?.maxDim > 0),
    playerMeasuredDefault?.measured
  );

  // -- 2. The DM sets this campaign's own C7 override for the Goblin
  //    template — the SAME player's page, on nothing more than a reload,
  //    now renders the CUSTOM override model instead. --
  const glbBuffer = readFileSync(OVERRIDE_UPLOAD_SOURCE_PATH);
  const uploadPath = `${campaignId}/${crypto.randomUUID()}.glb`;
  const { error: uploadError } = await dm.client.storage
    .from("map-assets")
    .upload(uploadPath, glbBuffer, { contentType: "model/gltf-binary" });
  check("DM can upload a custom override model to the map-assets bucket", !uploadError, uploadError?.message);

  const { data: customAsset, error: customAssetError } = await dm.client
    .from("asset_library")
    .insert({
      name: "Goblin (player-visibility custom)",
      source_type: "custom",
      model_ref: uploadPath,
      campaign_id: campaignId,
    })
    .select()
    .single();
  check(
    "DM can catalog the upload as a custom asset scoped to this campaign",
    !customAssetError && customAsset?.campaign_id === campaignId,
    customAssetError?.message
  );
  uploadedCustomAssetId = customAsset?.id ?? null;

  const { data: overrideRow, error: overrideError } = await dm.client
    .from("campaign_monster_template_overrides")
    .upsert(
      { campaign_id: campaignId, monster_template_id: goblinTemplate.id, custom_asset_id: customAsset.id },
      { onConflict: "campaign_id,monster_template_id" }
    )
    .select()
    .single();
  check(
    "DM can link the custom asset as this campaign's own override for the Goblin template",
    !overrideError && overrideRow?.custom_asset_id === customAsset.id,
    overrideError?.message
  );

  await dmPage.reload();
  await dmPage.waitForSelector('[data-testid="token-model-state"]', { state: "attached", timeout: 30000 });
  const dmStateOverride = await pollTokenModelState(
    (state) => state.modelUrlByTokenId[token.id] !== GOBLIN_DEFAULT_MODEL,
    dmPage
  );
  check(
    "sanity: the DM's own page renders the CUSTOM override model after the override is set, unchanged from before this fix",
    typeof dmStateOverride?.modelUrlByTokenId[token.id] === "string" &&
      dmStateOverride.modelUrlByTokenId[token.id] !== GOBLIN_DEFAULT_MODEL,
    dmStateOverride?.modelUrlByTokenId
  );

  await playerPage.reload();
  await playerPage.waitForSelector('[data-testid="token-model-state"]', { state: "attached", timeout: 30000 });
  const playerStateOverride = await pollTokenModelState(
    (state) => state.modelUrlByTokenId[token.id] !== GOBLIN_DEFAULT_MODEL,
    playerPage
  );
  check(
    "THE FIX: the SAME player's own client now renders the campaign's CUSTOM override model too — matching the DM's own page (same underlying storage object, independently signed per client), not the template's default and not the flat disc",
    typeof playerStateOverride?.modelUrlByTokenId[token.id] === "string" &&
      assetPathOf(playerStateOverride.modelUrlByTokenId[token.id]) !== GOBLIN_DEFAULT_MODEL &&
      assetPathOf(playerStateOverride.modelUrlByTokenId[token.id]) ===
        assetPathOf(dmStateOverride?.modelUrlByTokenId[token.id]),
    { player: playerStateOverride?.modelUrlByTokenId, dm: dmStateOverride?.modelUrlByTokenId }
  );

  const playerMeasuredOverride = await pollTokenModelState(
    (state) => Boolean(state.measured?.[token.id]?.maxDim > 0),
    playerPage
  );
  check(
    "the player's page ACTUALLY loaded the override model in the real scene (a genuine measured bounding box, not just a resolved URL string)",
    Boolean(playerMeasuredOverride?.measured?.[token.id]?.maxDim > 0),
    playerMeasuredOverride?.measured
  );
} finally {
  await browser.close();
  // PostgrestBuilder is a bare PromiseLike (only `.then`), not a real
  // Promise — it has no `.catch` method, so cleanup failures are guarded
  // with plain try/catch rather than chained `.catch()` calls.
  try {
    await admin.from("campaign_monster_template_overrides").delete().eq("campaign_id", campaignId);
  } catch {
    // Best-effort cleanup.
  }
  if (uploadedCustomAssetId) {
    try {
      await admin.from("asset_library").delete().eq("id", uploadedCustomAssetId);
    } catch {
      // Best-effort cleanup.
    }
  }
  try {
    await admin.from("campaigns").delete().eq("id", campaignId);
  } catch {
    // Best-effort cleanup.
  }
  await admin.auth.admin.deleteUser(dm.id).catch(() => {});
  await admin.auth.admin.deleteUser(player.id).catch(() => {});
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
console.log("\nAll player-visibility monster template checks passed.");
process.exit(0);
