#!/usr/bin/env node
// Weather & Enemies C6 verification: default distinct 3D appearance per
// monster_templates row (migration 0074), and MapSurface.tsx's token-model
// rendering split.
//
// Checks, in order:
//   1. DB, read-only: every one of C5's 8 real seeded templates
//      (Goblin/Zombie/Trader/Guard/High Guard/Daemon/Demon/Witch) has a
//      non-null default_asset_id, pointing at a DISTINCT preset
//      asset_library row (no two templates share one model) whose .glb
//      file genuinely exists on disk.
//   2. A real browser, signed in as a DM, with two tokens placed side by
//      side on a live map: one backed by a monster_stat_block whose
//      template_id links to the real Goblin template, one backed by a
//      hand-authored FREEFORM stat block (template_id null, exactly what
//      createMonsterStatBlock has always produced). The templated token's
//      resolved modelUrl (mirrored into GameRoom's own hidden
//      token-model-state debug div — the same "mirror the ACTUAL render
//      decision" precedent as visionDebug/selectionDebug) is Goblin's own
//      preset path, AND a genuine measured bounding box (a real loaded
//      model, not just a truthy url string) is reported for it. The
//      freeform token's modelUrl is null, and it reports no measurement at
//      all — MapSurface's unchanged flat-disc fallback, zero regression.
//   3. The live-pointer-vs-copy split this prompt's own Context/Task is
//      explicit about: an EPHEMERAL, admin-only test template (never one of
//      the real 8 shared seeded rows, to avoid any risk of interfering with
//      other concurrently-running verify scripts against this same shared
//      dev DB — 0066's own "other concurrent agents may apply migrations
//      directly to the shared dev DB during testing" precedent) is created,
//      linked to a stat block/token, confirmed to render its FIRST model —
//      then the ephemeral template's default_asset_id is changed (an admin
//      action) and, on nothing more than a page reload (no re-copy, no new
//      stat block, no new token), the SAME token picks up the NEW model.
//      This is the concrete, reproducible proof that default_asset_id is a
//      live pointer read fresh at render time, completely independent of
//      the one-time HP/AC/attacks stat copy C5 already covers.
//
// Needs the local/shared Supabase stack; starts this worktree's own
// `yarn dev` on a fixed, non-default port if it isn't already serving —
// never APP_URL's usual :3000 default, which on this machine is a live
// production server, not a fresh build of this worktree's own changes
// (this project's own hard-won lesson).
// Usage: node scripts/db/verify-monster-template-visuals.mjs
//        MONSTER_TEMPLATE_VISUALS_APP_PORT=4300 node scripts/db/verify-monster-template-visuals.mjs

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { GPU_LAUNCH_ARGS } from "./lib/browser.mjs";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const APP_PORT = Number(process.env.MONSTER_TEMPLATE_VISUALS_APP_PORT ?? 4208);
const APP_URL = `http://localhost:${APP_PORT}`;

// The real seeded content this migration links a model to — see
// 0073_monster_templates.sql/0074_monster_template_visuals.sql.
const EXPECTED_TEMPLATE_MODELS = {
  Goblin: "/assets/presets/goblin.glb",
  Zombie: "/assets/presets/zombie.glb",
  Trader: "/assets/presets/trader.glb",
  Guard: "/assets/presets/guard.glb",
  "High Guard": "/assets/presets/high-guard.glb",
  Daemon: "/assets/presets/daemon.glb",
  Demon: "/assets/presets/demon.glb",
  Witch: "/assets/presets/witch.glb",
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

// The @supabase/ssr cookie format — verify-npc-stat-blocks.mjs/
// verify-monster-templates.mjs's own established pattern for this app.
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
  const email = `monster-visuals-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `Visuals ${label}` });
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

await ensureDevServer();

const dm = await makeTestUser("dm");
const browser = await chromium.launch({ args: GPU_LAUNCH_ARGS });

// Ephemeral, admin-only test template — see this script's own top comment
// for why it's never one of the real 8 shared seeded rows.
let ephemeralTemplateId = null;
let ephemeralStatBlockId = null;

try {
  // -- 1. DB, read-only: every one of the real 8 templates has a distinct,
  //    real, on-disk model. --
  const { data: templates, error: templatesError } = await admin.from("monster_templates").select();
  if (templatesError) throw new Error(`reading monster_templates: ${templatesError.message}`);
  const byName = Object.fromEntries(templates.map((row) => [row.name, row]));

  const { data: assets, error: assetsError } = await admin.from("asset_library").select();
  if (assetsError) throw new Error(`reading asset_library: ${assetsError.message}`);
  const assetById = Object.fromEntries(assets.map((row) => [row.id, row]));

  const assetIdsUsed = new Set();
  for (const [name, expectedModelRef] of Object.entries(EXPECTED_TEMPLATE_MODELS)) {
    const template = byName[name];
    check(`${name}'s monster_templates row exists (from C5's own seed)`, !!template, { name });
    if (!template) continue;
    check(`${name} has a non-null default_asset_id`, !!template.default_asset_id, template);
    const asset = template.default_asset_id ? assetById[template.default_asset_id] : null;
    check(
      `${name}'s default_asset_id resolves to a real preset asset_library row with the expected model`,
      asset?.source_type === "preset" && asset?.model_ref === expectedModelRef,
      { asset, expectedModelRef }
    );
    check(
      `${name}'s linked .glb file actually exists on disk (public${expectedModelRef})`,
      existsSync(join(rootDir, "public", expectedModelRef)),
      join(rootDir, "public", expectedModelRef)
    );
    if (template.default_asset_id) assetIdsUsed.add(template.default_asset_id);
  }
  check(
    "all 8 templates use 8 DISTINCT models — no two templates share one asset (not a re-tinted duplicate)",
    assetIdsUsed.size === Object.keys(EXPECTED_TEMPLATE_MODELS).length,
    [...assetIdsUsed]
  );

  // -- 2. Real browser: two tokens placed side by side, one templated, one
  //    freeform — only the templated one shows a distinct model. --
  const campaignId = crypto.randomUUID();
  await admin.from("campaigns").insert({ id: campaignId, name: "Monster visuals test", creator: dm.id });
  await admin.from("campaign_members").insert({ campaign_id: campaignId, user_id: dm.id, role: "dm" });
  const mapId = crypto.randomUUID();
  await admin.from("campaign_maps").insert({
    id: mapId,
    campaign_id: campaignId,
    name: "Visuals test map",
    grid_width: 10,
    grid_height: 1,
  });
  await admin.from("campaigns").update({ live_map: mapId }).eq("id", campaignId);

  const goblinTemplate = byName.Goblin;

  // Mirrors createMonsterStatBlockFromTemplate's own insert shape exactly
  // (data-access/monsterStatBlocks.ts) via the DM's own real, RLS-
  // authorized client — the C5 verify script's own "genuine authorization/
  // data check, deliberately not a fragile pixel-perfect canvas click"
  // precedent, applied to the NEW template_id column this prompt adds.
  const { data: templatedStatBlock, error: templatedStatBlockError } = await dm.client
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
  check(
    "the DM can create a campaign stat block linked to the Goblin template (template_id set)",
    !templatedStatBlockError && templatedStatBlock?.template_id === goblinTemplate.id,
    { error: templatedStatBlockError?.message, row: templatedStatBlock }
  );

  // Mirrors createMonsterStatBlock's own insert shape exactly — a
  // hand-authored, freeform block with no template involved at all.
  const { data: freeformStatBlock, error: freeformStatBlockError } = await dm.client
    .from("monster_stat_blocks")
    .insert({
      campaign_id: campaignId,
      name: "Freeform Bandit",
      max_hp: 11,
      armor_class: 12,
      passive_perception: 10,
      attacks: [],
    })
    .select()
    .single();
  check(
    "the DM can create an ordinary freeform stat block with no template_id at all",
    !freeformStatBlockError && freeformStatBlock?.template_id === null,
    { error: freeformStatBlockError?.message, row: freeformStatBlock }
  );

  // Two tokens, side by side (x=1 and x=2) — mirrors placeNpcToken's own
  // insert shape (mapTokens.ts) via the DM's real client.
  const { data: templatedToken, error: templatedTokenError } = await dm.client
    .from("map_tokens")
    .insert({
      map_id: mapId,
      npc_name: templatedStatBlock.name,
      monster_stat_block_id: templatedStatBlock.id,
      x: 1,
      y: 0,
      elevation: 0,
      allegiance: templatedStatBlock.default_allegiance,
    })
    .select()
    .single();
  check("placing the templated (Goblin) token succeeds", !templatedTokenError, templatedTokenError?.message);

  const { data: freeformToken, error: freeformTokenError } = await dm.client
    .from("map_tokens")
    .insert({
      map_id: mapId,
      npc_name: freeformStatBlock.name,
      monster_stat_block_id: freeformStatBlock.id,
      x: 2,
      y: 0,
      elevation: 0,
      allegiance: freeformStatBlock.default_allegiance,
    })
    .select()
    .single();
  check("placing the freeform token succeeds", !freeformTokenError, freeformTokenError?.message);

  const dmContext = await browser.newContext();
  await dmContext.addCookies(sessionCookies(dm.session));
  const dmPage = await dmContext.newPage();
  await dmPage.goto(`${APP_URL}/campaigns/${campaignId}/room`);
  await dmPage.waitForSelector('[data-testid="token-model-state"]', { state: "attached", timeout: 30000 });
  await dmPage.waitForSelector("canvas", { timeout: 30000 });

  const stateAfterBothTokens = await pollTokenModelState(
    (state) =>
      Object.hasOwn(state.modelUrlByTokenId, templatedToken.id) &&
      Object.hasOwn(state.modelUrlByTokenId, freeformToken.id),
    dmPage
  );
  check(
    "the templated (Goblin) token resolves to Goblin's own generated model, not the flat disc",
    stateAfterBothTokens?.modelUrlByTokenId[templatedToken.id] === "/assets/presets/goblin.glb",
    stateAfterBothTokens?.modelUrlByTokenId
  );
  check(
    "the freeform token resolves to no model at all (null) — the unchanged flat allegiance disc",
    stateAfterBothTokens?.modelUrlByTokenId[freeformToken.id] === null,
    stateAfterBothTokens?.modelUrlByTokenId
  );

  const stateAfterMeasure = await pollTokenModelState(
    (state) => Boolean(state.measured?.[templatedToken.id]?.maxDim > 0),
    dmPage
  );
  check(
    "the templated token's model ACTUALLY loaded in the real scene (a genuine measured bounding box, not just a url string)",
    Boolean(stateAfterMeasure?.measured?.[templatedToken.id]?.maxDim > 0),
    stateAfterMeasure?.measured
  );
  // Give the freeform token's own (non-existent) model load every chance to
  // fire before asserting its permanent absence — same settle-then-assert
  // shape as the positive poll above, just checking for a negative.
  await sleep(1500);
  const finalState = await readTokenModelState(dmPage);
  check(
    "the freeform token reports NO measurement at all — it never renders a model to measure",
    finalState !== null && !Object.hasOwn(finalState.measured ?? {}, freeformToken.id),
    finalState?.measured
  );

  // -- 3. The live-pointer-vs-copy split: an ephemeral, admin-only test
  //    template (never one of the real 8 shared rows) whose
  //    default_asset_id changes AFTER a token already exists — the SAME
  //    token picks up the new model on nothing more than a reload, with no
  //    re-copy of stats and no new stat block/token. --
  const zombieTemplate = byName.Zombie;
  const { data: ephemeralTemplate, error: ephemeralTemplateError } = await admin
    .from("monster_templates")
    .insert({
      name: `C6 Verify Widget ${Date.now()}`,
      default_allegiance: "hostile",
      max_hp: 5,
      armor_class: 10,
      passive_perception: 8,
      attacks: [],
      default_asset_id: goblinTemplate.default_asset_id,
    })
    .select()
    .single();
  if (ephemeralTemplateError) throw new Error(`creating ephemeral test template: ${ephemeralTemplateError.message}`);
  ephemeralTemplateId = ephemeralTemplate.id;

  const { data: ephemeralStatBlock, error: ephemeralStatBlockError } = await dm.client
    .from("monster_stat_blocks")
    .insert({
      campaign_id: campaignId,
      template_id: ephemeralTemplate.id,
      name: ephemeralTemplate.name,
      max_hp: ephemeralTemplate.max_hp,
      armor_class: ephemeralTemplate.armor_class,
      passive_perception: ephemeralTemplate.passive_perception,
      attacks: ephemeralTemplate.attacks,
      default_allegiance: ephemeralTemplate.default_allegiance,
    })
    .select()
    .single();
  if (ephemeralStatBlockError) throw new Error(`creating ephemeral stat block: ${ephemeralStatBlockError.message}`);
  ephemeralStatBlockId = ephemeralStatBlock.id;

  const { data: ephemeralToken, error: ephemeralTokenError } = await dm.client
    .from("map_tokens")
    .insert({
      map_id: mapId,
      npc_name: ephemeralStatBlock.name,
      monster_stat_block_id: ephemeralStatBlock.id,
      x: 3,
      y: 0,
      elevation: 0,
      allegiance: ephemeralStatBlock.default_allegiance,
    })
    .select()
    .single();
  if (ephemeralTokenError) throw new Error(`placing ephemeral token: ${ephemeralTokenError.message}`);

  await dmPage.reload();
  await dmPage.waitForSelector('[data-testid="token-model-state"]', { state: "attached", timeout: 30000 });
  const stateBeforeSwap = await pollTokenModelState(
    (state) => Object.hasOwn(state.modelUrlByTokenId, ephemeralToken.id),
    dmPage
  );
  check(
    "the ephemeral template's token starts out rendering its FIRST linked model (Goblin's)",
    stateBeforeSwap?.modelUrlByTokenId[ephemeralToken.id] === "/assets/presets/goblin.glb",
    stateBeforeSwap?.modelUrlByTokenId
  );

  // An admin action on the TEMPLATE — nothing about the campaign's own
  // stat block or token is touched at all.
  const { error: swapError } = await admin
    .from("monster_templates")
    .update({ default_asset_id: zombieTemplate.default_asset_id })
    .eq("id", ephemeralTemplate.id);
  if (swapError) throw new Error(`swapping ephemeral template's default_asset_id: ${swapError.message}`);

  await dmPage.reload();
  await dmPage.waitForSelector('[data-testid="token-model-state"]', { state: "attached", timeout: 30000 });
  const stateAfterSwap = await pollTokenModelState(
    (state) => state.modelUrlByTokenId[ephemeralToken.id] === "/assets/presets/zombie.glb",
    dmPage
  );
  check(
    "after the admin changes the template's default_asset_id, the SAME already-placed token picks up the NEW model on nothing more than a reload — a live pointer, not a value copied at creation time",
    stateAfterSwap?.modelUrlByTokenId[ephemeralToken.id] === "/assets/presets/zombie.glb",
    stateAfterSwap?.modelUrlByTokenId
  );
  const { data: ephemeralStatBlockAfterSwap } = await admin
    .from("monster_stat_blocks")
    .select()
    .eq("id", ephemeralStatBlock.id)
    .single();
  check(
    "the campaign's own stat block row itself is completely untouched by the template's visual change (max_hp/armor_class/etc. unchanged — the C5 stat copy stays frozen)",
    ephemeralStatBlockAfterSwap?.max_hp === ephemeralTemplate.max_hp &&
      ephemeralStatBlockAfterSwap?.armor_class === ephemeralTemplate.armor_class,
    ephemeralStatBlockAfterSwap
  );
} finally {
  await browser.close();
  // PostgrestBuilder is a bare PromiseLike (only `.then`), not a real
  // Promise — it has no `.catch` method, so cleanup failures are guarded
  // with plain try/catch rather than chained `.catch()` calls.
  if (ephemeralStatBlockId) {
    try {
      await admin.from("monster_stat_blocks").delete().eq("id", ephemeralStatBlockId);
    } catch {
      // Best-effort cleanup.
    }
  }
  if (ephemeralTemplateId) {
    try {
      await admin.from("monster_templates").delete().eq("id", ephemeralTemplateId);
    } catch {
      // Best-effort cleanup.
    }
  }
  await admin.auth.admin.deleteUser(dm.id).catch(() => {});
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
console.log("\nAll monster template visual checks passed.");
process.exit(0);
