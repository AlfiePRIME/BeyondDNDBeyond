#!/usr/bin/env node
// Guided initiative phase (migration 0123): starting combat opens a
// party-vs-enemies roster on every client; a player rolls their own d20
// (stored with its natural roll), anyone still waiting after 15 seconds is
// rolled for by the DM's client, and round 1 then starts on its own at the
// top of the order.
//
// Only touches rows this script creates, all removed at the end.
//
// Usage: APP_URL=http://localhost:5871 node scripts/db/verify-initiative-phase.mjs

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { GPU_LAUNCH_ARGS } from "./lib/browser.mjs";

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
  console.log("dev server not running — starting yarn dev…");
  devServer = spawn("yarn", ["dev"], { cwd: rootDir, stdio: "ignore", detached: true });
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
  const email = `initiative-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `Init ${label}` });
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: signIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  return { id: data.user.id, session: signIn.session };
}

await ensureDevServer();

const dm = await makeTestUser("dm");
const player = await makeTestUser("player");
const campaignId = crypto.randomUUID();
const mapId = crypto.randomUUID();
const characterId = crypto.randomUUID();
await admin.from("campaigns").insert({ id: campaignId, name: `Initiative ${Date.now()}`, creator: dm.id });
await admin.from("campaign_members").insert([
  { campaign_id: campaignId, user_id: dm.id, role: "dm" },
  { campaign_id: campaignId, user_id: player.id, role: "player" },
]);
await admin.from("characters").insert({
  id: characterId, campaign_id: campaignId, owner_id: player.id, name: "Ilyra Swift", race: "Elf", class: "Rogue",
  level: 3, strength: 10, dexterity: 18, constitution: 12, intelligence: 12, wisdom: 10, charisma: 10,
  current_hp: 20, max_hp: 20, armor_class: 14, speed: 30, proficiencies: [], inventory: [], spells: [],
});
await admin.from("campaign_maps").insert({ id: mapId, campaign_id: campaignId, name: "Arena", grid_width: 8, grid_height: 8 });
await admin.from("map_tokens").insert([
  { id: crypto.randomUUID(), map_id: mapId, character_id: characterId, x: 1, y: 1, elevation: 0, allegiance: "party" },
  { id: crypto.randomUUID(), map_id: mapId, npc_name: "Goblin Cutter", x: 5, y: 5, elevation: 0, allegiance: "hostile" },
  { id: crypto.randomUUID(), map_id: mapId, npc_name: "Goblin Archer", x: 6, y: 5, elevation: 0, allegiance: "hostile" },
]);
await admin.from("campaigns").update({ live_map: mapId }).eq("id", campaignId);

async function encounterState() {
  const { data: encounter } = await admin
    .from("combat_encounters").select().eq("campaign_id", campaignId).is("ended_at", null).maybeSingle();
  if (!encounter) return null;
  const { data: combatants } = await admin
    .from("combat_combatants").select().eq("encounter_id", encounter.id)
    .order("initiative", { ascending: false, nullsFirst: false }).order("created_at").order("id");
  return { encounter, combatants };
}

const browser = await chromium.launch({ args: GPU_LAUNCH_ARGS });
try {
  const open = async (user) => {
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    await context.addCookies(sessionCookies(user.session));
    const page = await context.newPage();
    await page.goto(`${APP_URL}/campaigns/${campaignId}/room`);
    await page.waitForSelector('[data-testid="token-selection-state"]', { state: "attached", timeout: 60000 });
    return page;
  };
  const dmPage = await open(dm);
  const playerPage = await open(player);
  await sleep(1500);

  await dmPage.getByTestId("start-combat-button").click();
  const rosterOnDm = await dmPage.getByTestId("initiative-roster").waitFor({ timeout: 15000 }).then(() => true).catch(() => false);
  check("starting combat opens the initiative roster for the DM", rosterOnDm);
  const rosterOnPlayer = await playerPage.getByTestId("initiative-roster").waitFor({ timeout: 15000 }).then(() => true).catch(() => false);
  check("…and for the player", rosterOnPlayer);

  let state = await encounterState();
  check("the encounter is in the initiative phase", state?.encounter.phase === "initiative", state?.encounter.phase);
  const pc = state.combatants.find((c) => c.character_id === characterId);
  const goblins = state.combatants.filter((c) => c.npc_name);

  const rosterText = (await playerPage.getByTestId("initiative-roster").textContent()) ?? "";
  check("the roster lines the party up against the enemies", rosterText.includes("The party") && rosterText.includes("The enemies") && rosterText.includes("Ilyra Swift") && rosterText.includes("Goblin Cutter"), rosterText.slice(0, 200));
  check("the player can roll for their own character", await playerPage.getByTestId(`initiative-roll-${pc.id}`).isVisible());
  check("the player can't roll for the goblins", (await playerPage.getByTestId(`initiative-roll-${goblins[0].id}`).count()) === 0);

  await playerPage.getByTestId(`initiative-roll-${pc.id}`).click();
  await playerPage.getByTestId(`initiative-total-${pc.id}`).waitFor({ timeout: 15000 }).catch(() => undefined);
  state = await encounterState();
  const rolledPc = state.combatants.find((c) => c.id === pc.id);
  check("the player's roll stores total and natural d20 (+4 DEX)", rolledPc.initiative_roll >= 1 && rolledPc.initiative === rolledPc.initiative_roll + 4, rolledPc);
  const dmSeesIt = await dmPage.getByTestId(`initiative-total-${pc.id}`).waitFor({ timeout: 10000 }).then(() => true).catch(() => false);
  check("the DM's roster shows the player's result", dmSeesIt);
  check("the goblins are still waiting before the countdown ends", state.combatants.filter((c) => c.npc_name).every((c) => c.initiative === null));

  // Countdown: the DM's client rolls for the goblins at 15s, then round 1
  // begins ~3.5s after everyone's in.
  let begun = null;
  for (let i = 0; i < 60 && !begun; i++) {
    await sleep(1000);
    const s = await encounterState();
    if (s?.encounter.phase === "active") begun = s;
  }
  check("after the countdown the goblins were rolled for automatically", begun?.combatants.every((c) => c.initiative !== null && c.initiative_roll !== null), begun?.combatants);
  check("round 1 began on its own", begun?.encounter.phase === "active" && begun?.encounter.round_number === 1);
  check(
    "the turn is on the highest initiative",
    begun && begun.encounter.current_combatant_id === begun.combatants[0].id,
    begun && { current: begun.encounter.current_combatant_id, top: begun.combatants[0] }
  );
  const rosterGone = await playerPage.getByTestId("initiative-roster").waitFor({ state: "detached", timeout: 10000 }).then(() => true).catch(() => false);
  check("the roster closes on the player's screen when the fight starts", rosterGone);
  
} finally {
  await browser.close();
  await admin.from("campaigns").delete().eq("id", campaignId);
  await admin.auth.admin.deleteUser(dm.id);
  await admin.auth.admin.deleteUser(player.id);
  if (devServer) {
    try {
      process.kill(-devServer.pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
}

console.log(failures === 0 ? "\nAll initiative-phase checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
