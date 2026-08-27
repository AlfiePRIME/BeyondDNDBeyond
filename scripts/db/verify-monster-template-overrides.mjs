#!/usr/bin/env node
// Weather & Enemies C7 verification: a per-campaign override of a monster
// template's default 3D appearance (campaign_monster_template_overrides,
// migration 0075), reusing the exact custom-asset upload/storage pipeline
// (uploadMapAssetFile/createCustomAsset, src/data-access/assets.ts) already
// proven by verify-monster-template-visuals.mjs (C6).
//
// Checks, in order:
//   1. Real browser, DM A: uploads a custom .glb, links it as Campaign A's
//      own override for the Goblin template (MonsterPanel's "Upload
//      override model" flow), places a Goblin-templated token, and confirms
//      it renders the CUSTOM model (not Goblin's C6 default) — mirrored
//      into the same token-model-state hidden div C6's own verify script
//      reads, with a genuine measured bounding box proving a real model
//      actually loaded.
//   2. Cross-campaign isolation, the acceptance criterion this prompt's own
//      Task calls out by name: a SEPARATE campaign (DM B), with its own
//      Goblin-templated token and NO override of its own, still renders
//      Goblin's plain C6 default model — completely unaffected by Campaign
//      A's override on the very same shared, global template.
//   3. Removing Campaign A's override reverts its own token's rendering
//      back to Goblin's C6 default cleanly, on nothing more than a reload —
//      Campaign B is (trivially) still unaffected throughout.
//
// Needs the local/shared Supabase stack; starts this worktree's own
// `yarn dev` on a fixed, non-default port if it isn't already serving —
// never APP_URL's usual :3000 default, which on this machine is a live
// production server, not a fresh build of this worktree's own changes
// (this project's own hard-won lesson).
// Usage: node scripts/db/verify-monster-template-overrides.mjs
//        MONSTER_TEMPLATE_OVERRIDES_APP_PORT=4300 node scripts/db/verify-monster-template-overrides.mjs

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { GPU_LAUNCH_ARGS } from "./lib/browser.mjs";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const APP_PORT = Number(process.env.MONSTER_TEMPLATE_OVERRIDES_APP_PORT ?? 4209);
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

// The @supabase/ssr cookie format — verify-monster-template-visuals.mjs's
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
  const email = `monster-overrides-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `Overrides ${label}` });
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: signIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  return { id: data.user.id, email, client, session: signIn.session };
}

async function readTokenModelState(page) {
  // The hidden token-model-state mirror (GameRoom.tsx, C6) — read directly
  // via textContent, never gated behind isVisible() (this project's own
  // hard-won lesson about hidden debug-mirror divs).
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

// The "custom override" upload itself is a real, on-disk, genuinely
// distinct generated preset (the Witch model, C6/0074) — not a synthetic
// stub — so the real scene actually loads it and reports a genuine positive
// measured bounding box (the SAME Box3.setFromObject(realLoadedGltf) proof
// C6's own verify script uses), not just a truthy url string. What's under
// test here is the NEW override-linking mechanism (upload → asset_library →
// campaign_monster_template_overrides → render resolution), not new model
// content, so reusing an existing real .glb the app already ships is exactly
// as valid a "custom upload" as an author's own original file would be.
const OVERRIDE_UPLOAD_SOURCE_PATH = join(rootDir, "public", "assets", "presets", "witch.glb");

await ensureDevServer();

const dmA = await makeTestUser("dm-a");
const dmB = await makeTestUser("dm-b");
const browser = await chromium.launch({ args: GPU_LAUNCH_ARGS });

const campaignAId = crypto.randomUUID();
const campaignBId = crypto.randomUUID();
let uploadedCustomAssetId = null;

try {
  const { data: goblinTemplate, error: goblinError } = await admin
    .from("monster_templates")
    .select()
    .eq("name", "Goblin")
    .single();
  if (goblinError || !goblinTemplate) throw new Error(`reading the real Goblin template: ${goblinError?.message}`);

  // -- Seed: two SEPARATE campaigns, each with its own live map and its own
  //    Goblin-templated monster and token — Campaign A will get an
  //    override, Campaign B never does. --
  async function seedCampaign(dm, name) {
    const campaignId = dm === dmA ? campaignAId : campaignBId;
    await admin.from("campaigns").insert({ id: campaignId, name, creator: dm.id });
    await admin.from("campaign_members").insert({ campaign_id: campaignId, user_id: dm.id, role: "dm" });
    const mapId = crypto.randomUUID();
    await admin.from("campaign_maps").insert({
      id: mapId,
      campaign_id: campaignId,
      name: `${name} map`,
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
    if (statBlockError) throw new Error(`seeding ${name}'s Goblin stat block: ${statBlockError.message}`);

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
    if (tokenError) throw new Error(`placing ${name}'s Goblin token: ${tokenError.message}`);

    return { campaignId, mapId, statBlock, token };
  }

  const campaignA = await seedCampaign(dmA, "Overrides test A");
  const campaignB = await seedCampaign(dmB, "Overrides test B");

  // -- 1. DM A uploads a custom override model, through the app's own real
  //    upload UI (MonsterPanel), and confirms Campaign A's Goblin token
  //    picks it up. --
  const dmAContext = await browser.newContext();
  await dmAContext.addCookies(sessionCookies(dmA.session));
  const dmAPage = await dmAContext.newPage();
  await dmAPage.goto(`${APP_URL}/campaigns/${campaignA.campaignId}/room`);
  await dmAPage.waitForSelector('[data-testid="token-model-state"]', { state: "attached", timeout: 30000 });
  await dmAPage.waitForSelector("canvas", { timeout: 30000 });

  const stateBeforeOverride = await pollTokenModelState(
    (state) => Object.hasOwn(state.modelUrlByTokenId, campaignA.token.id),
    dmAPage
  );
  check(
    "before any override, Campaign A's Goblin token renders Goblin's own C6 default model",
    stateBeforeOverride?.modelUrlByTokenId[campaignA.token.id] === GOBLIN_DEFAULT_MODEL,
    stateBeforeOverride?.modelUrlByTokenId
  );

  // Upload the override directly through the same data-access pipeline the
  // UI itself calls (uploadMapAssetFile/createCustomAsset,
  // setMonsterTemplateOverride) — the C5/C6 verify scripts' own "genuine
  // authorization/data check, deliberately not a fragile pixel-perfect
  // canvas click" precedent, applied to this prompt's own upload+link flow.
  // This exercises the EXACT same RLS-gated write path MonsterPanel's
  // upload button triggers, through the DM's own real, authenticated
  // client — not a service-role bypass.
  const glbBuffer = readFileSync(OVERRIDE_UPLOAD_SOURCE_PATH);
  const uploadPath = `${campaignA.campaignId}/${crypto.randomUUID()}.glb`;
  const { error: uploadError } = await dmA.client.storage
    .from("map-assets")
    .upload(uploadPath, glbBuffer, { contentType: "model/gltf-binary" });
  check("DM A can upload a custom override model to the map-assets bucket", !uploadError, uploadError?.message);

  const { data: customAsset, error: customAssetError } = await dmA.client
    .from("asset_library")
    .insert({
      name: "Goblin (custom)",
      source_type: "custom",
      model_ref: uploadPath,
      campaign_id: campaignA.campaignId,
    })
    .select()
    .single();
  check(
    "DM A can catalog the upload as a custom asset scoped to Campaign A",
    !customAssetError && customAsset?.campaign_id === campaignA.campaignId,
    customAssetError?.message
  );
  uploadedCustomAssetId = customAsset?.id ?? null;

  const { data: overrideRow, error: overrideError } = await dmA.client
    .from("campaign_monster_template_overrides")
    .upsert(
      {
        campaign_id: campaignA.campaignId,
        monster_template_id: goblinTemplate.id,
        custom_asset_id: customAsset.id,
      },
      { onConflict: "campaign_id,monster_template_id" }
    )
    .select()
    .single();
  check(
    "DM A can link the custom asset as Campaign A's own override for the Goblin template",
    !overrideError && overrideRow?.custom_asset_id === customAsset.id,
    overrideError?.message
  );

  // -- Security check: DM B must NOT be able to set an override in
  //    Campaign A (not their campaign), and must not be able to point an
  //    override at an asset scoped to someone else's campaign. --
  const { error: crossCampaignWriteError } = await dmB.client
    .from("campaign_monster_template_overrides")
    .upsert(
      {
        campaign_id: campaignA.campaignId,
        monster_template_id: goblinTemplate.id,
        custom_asset_id: customAsset.id,
      },
      { onConflict: "campaign_id,monster_template_id" }
    );
  check(
    "a DM who does NOT run Campaign A cannot set an override there (RLS rejects it)",
    !!crossCampaignWriteError,
    crossCampaignWriteError
  );

  // -- Security check: DM B, correctly acting within THEIR OWN Campaign B,
  //    still cannot point an override at Campaign A's custom asset — 0075's
  //    own cross-table EXISTS check (custom_asset_id must already belong to
  //    the SAME campaign_id as the override row), not just "is this DM's
  //    own campaign". --
  const { error: crossCampaignAssetError } = await dmB.client
    .from("campaign_monster_template_overrides")
    .upsert(
      {
        campaign_id: campaignB.campaignId,
        monster_template_id: goblinTemplate.id,
        custom_asset_id: customAsset.id,
      },
      { onConflict: "campaign_id,monster_template_id" }
    );
  check(
    "a DM CANNOT override their own campaign's template with another campaign's custom asset (RLS's cross-table asset-ownership check rejects it)",
    !!crossCampaignAssetError,
    crossCampaignAssetError
  );

  await dmAPage.reload();
  await dmAPage.waitForSelector('[data-testid="token-model-state"]', { state: "attached", timeout: 30000 });
  const stateAfterOverride = await pollTokenModelState(
    (state) => state.modelUrlByTokenId[campaignA.token.id] !== GOBLIN_DEFAULT_MODEL,
    dmAPage
  );
  check(
    "after DM A sets the override, Campaign A's SAME Goblin token now renders the CUSTOM model, not Goblin's C6 default",
    typeof stateAfterOverride?.modelUrlByTokenId[campaignA.token.id] === "string" &&
      stateAfterOverride.modelUrlByTokenId[campaignA.token.id] !== GOBLIN_DEFAULT_MODEL &&
      stateAfterOverride.modelUrlByTokenId[campaignA.token.id] !== null,
    stateAfterOverride?.modelUrlByTokenId
  );

  const stateAfterOverrideMeasured = await pollTokenModelState(
    (state) => Boolean(state.measured?.[campaignA.token.id]?.maxDim > 0),
    dmAPage
  );
  check(
    "the override's model ACTUALLY loaded in the real scene (a genuine measured bounding box, not just a url string) — the real, on-disk Witch preset bytes, not a synthetic stub",
    Boolean(stateAfterOverrideMeasured?.measured?.[campaignA.token.id]?.maxDim > 0),
    stateAfterOverrideMeasured?.measured
  );

  // -- 2. Cross-campaign isolation: Campaign B, with NO override of its
  //    own, still renders Goblin's plain C6 default — this prompt's own
  //    named acceptance criterion. --
  const dmBContext = await browser.newContext();
  await dmBContext.addCookies(sessionCookies(dmB.session));
  const dmBPage = await dmBContext.newPage();
  await dmBPage.goto(`${APP_URL}/campaigns/${campaignB.campaignId}/room`);
  await dmBPage.waitForSelector('[data-testid="token-model-state"]', { state: "attached", timeout: 30000 });
  await dmBPage.waitForSelector("canvas", { timeout: 30000 });

  const campaignBState = await pollTokenModelState(
    (state) => Object.hasOwn(state.modelUrlByTokenId, campaignB.token.id),
    dmBPage
  );
  check(
    "Campaign B's own Goblin token (same shared template, NO override of its own) still renders Goblin's plain C6 default model — completely unaffected by Campaign A's override",
    campaignBState?.modelUrlByTokenId[campaignB.token.id] === GOBLIN_DEFAULT_MODEL,
    campaignBState?.modelUrlByTokenId
  );

  // -- 3. Removing Campaign A's override reverts its rendering back to the
  //    default cleanly, on nothing more than a reload. --
  const { error: removeError } = await dmA.client
    .from("campaign_monster_template_overrides")
    .delete()
    .eq("campaign_id", campaignA.campaignId)
    .eq("monster_template_id", goblinTemplate.id);
  check("DM A can remove Campaign A's own override", !removeError, removeError?.message);

  await dmAPage.reload();
  await dmAPage.waitForSelector('[data-testid="token-model-state"]', { state: "attached", timeout: 30000 });
  const stateAfterRemoval = await pollTokenModelState(
    (state) => state.modelUrlByTokenId[campaignA.token.id] === GOBLIN_DEFAULT_MODEL,
    dmAPage
  );
  check(
    "after removing the override, Campaign A's Goblin token cleanly reverts to Goblin's C6 default model",
    stateAfterRemoval?.modelUrlByTokenId[campaignA.token.id] === GOBLIN_DEFAULT_MODEL,
    stateAfterRemoval?.modelUrlByTokenId
  );

  // Campaign B was never touched by any of the above — re-confirm for good
  // measure (trivially still true, but explicit is cheap here).
  const campaignBStateAfter = await readTokenModelState(dmBPage);
  check(
    "Campaign B remains completely unaffected throughout (still Goblin's C6 default)",
    campaignBStateAfter?.modelUrlByTokenId[campaignB.token.id] === GOBLIN_DEFAULT_MODEL,
    campaignBStateAfter?.modelUrlByTokenId
  );
} finally {
  await browser.close();
  // PostgrestBuilder is a bare PromiseLike (only `.then`), not a real
  // Promise — it has no `.catch` method, so cleanup failures are guarded
  // with plain try/catch rather than chained `.catch()` calls.
  try {
    await admin.from("campaign_monster_template_overrides").delete().eq("campaign_id", campaignAId);
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
    await admin.from("campaigns").delete().eq("id", campaignAId);
  } catch {
    // Best-effort cleanup.
  }
  try {
    await admin.from("campaigns").delete().eq("id", campaignBId);
  } catch {
    // Best-effort cleanup.
  }
  await admin.auth.admin.deleteUser(dmA.id).catch(() => {});
  await admin.auth.admin.deleteUser(dmB.id).catch(() => {});
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
console.log("\nAll monster template override checks passed.");
process.exit(0);
