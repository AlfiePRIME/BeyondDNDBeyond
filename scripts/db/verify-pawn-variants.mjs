#!/usr/bin/env node
// Pawn variant follow-up: race-based default pawn body shapes, and the
// expanded account pawn-color preset row.
//
// Part 1 — pawnBodyTypeForRace's WIRING (the pure mapping itself is unit-
// tested in src/scene-3d/pawnBodyType.test.ts): four PC characters of
// different races (Human/standard, Halfling/small, Dwarf/bulky, Elf/
// slender) plus one bare NPC token, all with no custom model, loaded into
// a real Game Room. Reads the hidden token-model-state mirror's new
// bodyTypeByTokenId field (the C6/C7 "sourced straight from tableMap, a
// real Playwright check against genuine render input" precedent applied
// to build instead of model/color) to confirm each token resolved to the
// EXPECTED body type, and that a token WITH a model (this same NPC's
// stat-block-linked preset, reused as a stand-in for "any modelUrl token")
// always reports "standard" regardless of anything — the shape is fully
// ignored once a model takes over.
//
// Part 2 — the expanded PawnColorPicker preset row on /account: confirms
// the swatch count actually grew, that a genuinely NEW (post-expansion)
// preset saves correctly to profiles.default_pawn_color, and that none of
// the presets collide with the hostile/neutral allegiance hues.
//
// Needs the local Supabase stack; starts this worktree's own `yarn dev` on
// a fixed, isolated port if it isn't already serving.
// Usage: node scripts/db/verify-pawn-variants.mjs

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { GPU_LAUNCH_ARGS } from "./lib/browser.mjs";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = Number(process.env.PAWN_VARIANTS_PORT ?? 4341);
const APP_URL = `http://localhost:${PORT}`;

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
    console.error(`FAIL  ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
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
  console.log(`dev server not running on :${PORT} — starting this worktree's own…`);
  devServer = spawn("yarn", ["dev", "-p", String(PORT)], { cwd: rootDir, stdio: "ignore", detached: true });
  for (let i = 0; i < 120; i++) {
    await sleep(1000);
    if (await healthOk()) return;
  }
  throw new Error(`dev server did not become healthy on :${PORT} within 120s`);
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
  const email = `pawn-variants-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `PawnVariants ${label}` });
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: signIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  return { id: data.user.id, client, session: signIn.session };
}

async function readMirror(page, testid) {
  const text = await page.textContent(`[data-testid="${testid}"]`);
  return JSON.parse(text);
}

await ensureDevServer();

const dm = await makeTestUser("dm");
const browser = await chromium.launch({ args: GPU_LAUNCH_ARGS });

try {
  // ── Part 1: race-based body type wiring, in a real Game Room. ──
  const campaignId = crypto.randomUUID();
  await admin.from("campaigns").insert({ id: campaignId, name: "Pawn variants test", creator: dm.id });
  await admin.from("campaign_members").insert([{ campaign_id: campaignId, user_id: dm.id, role: "dm" }]);

  const baseCharacter = (id, name, race, overrides = {}) => ({
    id,
    campaign_id: campaignId,
    owner_id: dm.id,
    name,
    race,
    class: "Fighter",
    level: 1,
    strength: 10,
    dexterity: 10,
    constitution: 10,
    intelligence: 10,
    wisdom: 10,
    charisma: 10,
    current_hp: 10,
    max_hp: 10,
    armor_class: 10,
    speed: 30,
    proficiencies: [],
    inventory: [],
    spells: [],
    ...overrides,
  });

  const humanId = crypto.randomUUID();
  const halflingId = crypto.randomUUID();
  const dwarfId = crypto.randomUUID();
  const elfId = crypto.randomUUID();
  await admin.from("characters").insert([
    baseCharacter(humanId, "Standard Human", "Human"),
    baseCharacter(halflingId, "Small Halfling", "Lightfoot Halfling"),
    baseCharacter(dwarfId, "Bulky Dwarf", "Hill Dwarf"),
    baseCharacter(elfId, "Slender Elf", "Wood Elf"),
  ]);

  const mapId = crypto.randomUUID();
  await admin.from("campaign_maps").insert({
    id: mapId,
    campaign_id: campaignId,
    name: "Pawn variants map",
    grid_width: 6,
    grid_height: 6,
  });
  await admin.from("campaigns").update({ live_map: mapId }).eq("id", campaignId);

  const { data: goblinTemplate } = await admin
    .from("monster_templates")
    .select()
    .eq("name", "Goblin")
    .single();

  const humanTokenId = crypto.randomUUID();
  const halflingTokenId = crypto.randomUUID();
  const dwarfTokenId = crypto.randomUUID();
  const elfTokenId = crypto.randomUUID();
  const modeledTokenId = crypto.randomUUID();
  await admin.from("map_tokens").insert([
    { id: humanTokenId, map_id: mapId, character_id: humanId, x: 0, y: 0, elevation: 0, allegiance: "party" },
    { id: halflingTokenId, map_id: mapId, character_id: halflingId, x: 1, y: 0, elevation: 0, allegiance: "party" },
    { id: dwarfTokenId, map_id: mapId, character_id: dwarfId, x: 2, y: 0, elevation: 0, allegiance: "party" },
    { id: elfTokenId, map_id: mapId, character_id: elfId, x: 3, y: 0, elevation: 0, allegiance: "party" },
    {
      id: modeledTokenId,
      map_id: mapId,
      npc_name: goblinTemplate.name,
      monster_stat_block_id: null,
      x: 4,
      y: 0,
      elevation: 0,
      allegiance: "hostile",
    },
  ]);
  // A monster_stat_block linked to the Goblin template gives this NPC a
  // real modelUrl — the "shape is fully ignored once a model takes over"
  // half of this check.
  const { data: goblinStatBlock } = await admin
    .from("monster_stat_blocks")
    .insert({
      campaign_id: campaignId,
      name: "Goblin",
      max_hp: 7,
      armor_class: 15,
      attacks: [],
      template_id: goblinTemplate.id,
    })
    .select()
    .single();
  await admin.from("map_tokens").update({ monster_stat_block_id: goblinStatBlock.id }).eq("id", modeledTokenId);

  const dmContext = await browser.newContext();
  await dmContext.addCookies(sessionCookies(dm.session));
  const dmRoom = await dmContext.newPage();
  await dmRoom.goto(`${APP_URL}/campaigns/${campaignId}/room`);
  await dmRoom.waitForSelector('[data-testid="token-model-state"]', { state: "attached", timeout: 60000 });
  // Wait for the modeled token's own async .glb load/measurement so its
  // modelUrl (and thus its "standard, model wins" body type) is settled.
  await dmRoom.waitForFunction(
    (tokenId) => {
      const el = document.querySelector('[data-testid="token-model-state"]');
      if (!el) return false;
      const state = JSON.parse(el.textContent ?? "{}");
      return Boolean(state.measured?.[tokenId]);
    },
    modeledTokenId,
    { timeout: 30000 }
  );

  const tokenModelState = await readMirror(dmRoom, "token-model-state");
  check(
    "a Human PC's bare-disc token resolves the 'standard' body type",
    tokenModelState.bodyTypeByTokenId[humanTokenId] === "standard",
    tokenModelState.bodyTypeByTokenId
  );
  check(
    "a Lightfoot Halfling PC's bare-disc token resolves the 'small' body type",
    tokenModelState.bodyTypeByTokenId[halflingTokenId] === "small"
  );
  check(
    "a Hill Dwarf PC's bare-disc token resolves the 'bulky' body type",
    tokenModelState.bodyTypeByTokenId[dwarfTokenId] === "bulky"
  );
  check(
    "a Wood Elf PC's bare-disc token resolves the 'slender' body type",
    tokenModelState.bodyTypeByTokenId[elfTokenId] === "slender"
  );
  check(
    "an NPC token with a real modelUrl reports 'standard' regardless — shape is ignored once a model takes over",
    tokenModelState.modelUrlByTokenId[modeledTokenId] !== null &&
      tokenModelState.bodyTypeByTokenId[modeledTokenId] === "standard",
    { modelUrl: tokenModelState.modelUrlByTokenId[modeledTokenId], bodyType: tokenModelState.bodyTypeByTokenId[modeledTokenId] }
  );

  // Dock every floating panel so the screenshot below actually shows the
  // table instead of the panel stack covering it (a real, confirmed issue
  // in this same Game Room UI — see this session's own click-to-attack
  // verify script for the first diagnosis).
  for (const panelId of [
    "combat",
    "opportunityAttack",
    "quickActions",
    "diceLog",
    "handout",
    "diceTray",
    "hp",
    "liveObjects",
    "chatLog",
    "tokens",
    "map",
  ]) {
    await dmRoom.click(`[data-testid="close-toggle-${panelId}"]`, { timeout: 1000 }).catch(() => undefined);
  }
  await sleep(300);
  await dmRoom.screenshot({
    path: "/tmp/claude-1000/-home-alfie/fda45a16-d7f7-41e9-92d5-1ed5b73bb4cb/scratchpad/pawn-variants-screenshot.png",
  });
  await dmContext.close();

  // ── Part 2: the expanded account pawn-color preset row. ──
  const accountContext = await browser.newContext();
  await accountContext.addCookies(sessionCookies(dm.session));
  const accountPage = await accountContext.newPage();
  await accountPage.goto(`${APP_URL}/account`);
  await accountPage.getByTestId("pawn-color-custom-input").waitFor({ state: "attached", timeout: 20000 });

  const presetButtons = accountPage.locator('[aria-label^="Use "][aria-label$=" as your pawn color"]');
  const presetCount = await presetButtons.count();
  check(
    "the account pawn-color picker now offers a genuinely wider preset spread (>= 12, up from the original 6)",
    presetCount >= 12,
    `${presetCount} presets`
  );

  const presetHexes = [];
  for (let i = 0; i < presetCount; i++) {
    const label = await presetButtons.nth(i).getAttribute("aria-label");
    const match = /^Use (#[0-9a-fA-F]{6}) as your pawn color$/.exec(label ?? "");
    if (match) presetHexes.push(match[1].toLowerCase());
  }
  check(
    "none of the new presets collide with the hostile (#ff3b3b) or neutral (#ff9a3c) allegiance hues",
    !presetHexes.includes("#ff3b3b") && !presetHexes.includes("#ff9a3c"),
    presetHexes
  );

  const NEW_PRESET = "#6c5ce7";
  await accountPage.locator(`[aria-label="Use ${NEW_PRESET} as your pawn color"]`).click();
  await accountPage.getByTestId("pawn-color-saved").waitFor({ timeout: 10000 });
  const { data: savedProfile } = await admin.from("profiles").select().eq("id", dm.id).single();
  check(
    "clicking a genuinely NEW (post-expansion) preset actually saves to profiles.default_pawn_color",
    savedProfile.default_pawn_color?.toLowerCase() === NEW_PRESET,
    savedProfile.default_pawn_color
  );

  await accountContext.close();
} finally {
  await browser.close();
  await admin.auth.admin.deleteUser(dm.id);
  if (devServer) {
    try {
      process.kill(-devServer.pid);
    } catch {
      // Already gone.
    }
  }
}

console.log(
  "\nScreenshot saved to /tmp/claude-1000/-home-alfie/fda45a16-d7f7-41e9-92d5-1ed5b73bb4cb/scratchpad/pawn-variants-screenshot.png for visual review."
);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll pawn variant checks passed.");
process.exit(0);
