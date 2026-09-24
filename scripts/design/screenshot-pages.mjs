#!/usr/bin/env node
// Design-review screenshots: seeds a throwaway DM + player campaign (a
// character, a small map with two tokens) and screenshots the main pages
// from both roles, collecting console errors. Cleans up after itself.
//
// Usage: APP_URL=http://localhost:5871 OUT=/some/dir [PAGES=/,/campaigns/CID]
//        [VW=1440 VH=900] node scripts/design/screenshot-pages.mjs
// PAGES placeholders: CID (campaign), MID (map), CHID (character).
// Signed-out pages (login, signup) are shot once, before the role passes.
// START_COMBAT=1 starts an encounter (as the DM) so the combat UI shows.
// CLICKS=testid1,testid2 clicks each data-testid in turn after a page loads
// (when present) and takes an extra screenshot after each click.
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { GPU_LAUNCH_ARGS } from "../db/lib/browser.mjs";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const APP_URL = process.env.APP_URL ?? "http://localhost:3000";
const OUT = process.env.OUT ?? join(rootDir, ".design-screenshots");
mkdirSync(OUT, { recursive: true });

function loadEnv(path) {
  const env = {};
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return env;
  }
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq !== -1) env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
  return env;
}
const env = { ...loadEnv(join(rootDir, ".env")), ...loadEnv(join(rootDir, "supabase", ".env")), ...process.env };
const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL;
const admin = createClient(supabaseUrl, env.SUPABASE_SERVICE_ROLE_KEY ?? env.SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const COOKIE_NAME = `sb-${new URL(supabaseUrl).hostname.split(".")[0]}-auth-token`;
function sessionCookies(session) {
  const value = "base64-" + Buffer.from(JSON.stringify(session)).toString("base64url");
  if (value.length <= 3180) return [{ name: COOKIE_NAME, value, url: APP_URL }];
  const cookies = [];
  for (let i = 0; i * 3180 < value.length; i++) {
    cookies.push({ name: `${COOKIE_NAME}.${i}`, value: value.slice(i * 3180, (i + 1) * 3180), url: APP_URL });
  }
  return cookies;
}
async function makeUser(label) {
  const email = `design-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  await admin.from("profiles").insert({ id: data.user.id, display_name: label === "dm" ? "Morgan (DM)" : "Riley" });
  const client = createClient(supabaseUrl, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: signIn } = await client.auth.signInWithPassword({ email, password });
  return { id: data.user.id, session: signIn.session };
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const dm = await makeUser("dm");
const player = await makeUser("player");
const campaignId = crypto.randomUUID();
const mapId = crypto.randomUUID();
const charId = crypto.randomUUID();
const browser = await chromium.launch({ args: GPU_LAUNCH_ARGS });
const errors = [];
try {
  await admin.from("campaigns").insert({ id: campaignId, name: "The Sunken Crypt", creator: dm.id });
  await admin.from("campaign_members").insert([
    { campaign_id: campaignId, user_id: dm.id, role: "dm" },
    { campaign_id: campaignId, user_id: player.id, role: "player" },
  ]);
  await admin.from("characters").insert({
    id: charId, campaign_id: campaignId, owner_id: player.id, name: "Aria Duskrunner", race: "Elf", class: "Ranger",
    level: 3, strength: 12, dexterity: 17, constitution: 13, intelligence: 10, wisdom: 15, charisma: 8,
    current_hp: 18, max_hp: 24, temp_hp: 4, armor_class: 15, speed: 30,
    proficiencies: ["Perception", "Stealth", "Survival"], inventory: [{ name: "Longbow", quantity: 1 }], spells: [],
  });
  await admin.from("campaign_maps").insert({ id: mapId, campaign_id: campaignId, name: "Crypt entrance", grid_width: 12, grid_height: 10 });
  await admin.from("map_tokens").insert([
    { id: crypto.randomUUID(), map_id: mapId, character_id: charId, x: 2, y: 2, elevation: 0, allegiance: "party" },
    { id: crypto.randomUUID(), map_id: mapId, npc_name: "Skeleton", x: 7, y: 6, elevation: 0, allegiance: "hostile" },
  ]);
  await admin.from("campaigns").update({ live_map: mapId }).eq("id", campaignId);
  if (env.START_COMBAT) {
    const dmClient = createClient(supabaseUrl, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { headers: { Authorization: `Bearer ${dm.session.access_token}` } },
    });
    const { error } = await dmClient.rpc("start_combat", { p_campaign_id: campaignId });
    if (error) throw error;
    // Scoped to THIS test campaign's encounter only — never touch other rows.
    const { data: encounter, error: encounterError } = await admin
      .from("combat_encounters")
      .select("id")
      .eq("campaign_id", campaignId)
      .is("ended_at", null)
      .single();
    if (encounterError) throw encounterError;
    const { data: combatants } = await admin
      .from("combat_combatants")
      .select("id, npc_name")
      .eq("encounter_id", encounter.id);
    for (const c of combatants ?? []) {
      await admin
        .from("combat_combatants")
        .update({ initiative: c.npc_name ? 12 : 17 })
        .eq("id", c.id)
        .eq("encounter_id", encounter.id);
    }
  }

  const pages = (
    process.env.PAGES ??
    [
      "/",
      "/campaigns",
      "/campaigns/CID",
      "/campaigns/CID/characters/new",
      "/campaigns/CID/characters/CHID",
      "/campaigns/CID/maps",
      "/campaigns/CID/maps/MID/edit",
      "/campaigns/CID/party",
      "/campaigns/CID/npcs",
      "/account",
      "/campaigns/CID/room",
    ].join(",")
  )
    .split(",")
    .map((p) => p.replaceAll("CHID", charId).replaceAll("MID", mapId).replaceAll("CID", campaignId));

  {
    const context = await browser.newContext({
      viewport: { width: Number(env.VW ?? 1440), height: Number(env.VH ?? 900) },
    });
    const page = await context.newPage();
    for (const path of (process.env.SIGNED_OUT_PAGES ?? "/login,/signup").split(",").filter(Boolean)) {
      await page.goto(APP_URL + path, { waitUntil: "load", timeout: 90000 });
      await sleep(2000);
      await page.screenshot({ path: join(OUT, `signed-out${path.replace(/[/?=&]+/g, "_")}.png`), fullPage: true });
    }
    await context.close();
  }

  for (const [user, role] of [[dm, "dm"], [player, "player"]]) {
    const context = await browser.newContext({
      viewport: { width: Number(env.VW ?? 1440), height: Number(env.VH ?? 900) },
    });
    await context.addCookies(sessionCookies(user.session));
    const page = await context.newPage();
    page.on("console", (m) => m.type() === "error" && errors.push(`[${role}] ${page.url()} :: ${m.text().slice(0, 300)}`));
    page.on("pageerror", (e) => errors.push(`[${role}] PAGEERROR ${page.url()} :: ${e.message.slice(0, 300)}`));
    for (const path of pages) {
      const name = `${role}${path
        .replace(campaignId, "C")
        .replace(mapId, "M")
        .replace(charId, "CH")
        .replace(/[/?=&]+/g, "_")}`;
      const fullscreen = path.endsWith("/room") || path.endsWith("/edit");
      try {
        await page.goto(APP_URL + path, { waitUntil: "load", timeout: 90000 });
        await sleep(fullscreen ? 9000 : 2500);
        await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: !fullscreen });
        console.log("shot", name);
        for (const testId of (env.CLICKS ?? "").split(",").filter(Boolean)) {
          const target = page.locator(`[data-testid="${testId}"]`);
          if (!(await target.isVisible().catch(() => false))) continue;
          await target.click();
          await sleep(1200);
          await page.screenshot({ path: join(OUT, `${name}__${testId}.png`), fullPage: !fullscreen });
        }
      } catch (err) {
        console.log("FAIL", name, err.message.slice(0, 200));
      }
    }
    await context.close();
  }
} finally {
  await browser.close();
  writeFileSync(join(OUT, "errors.txt"), errors.join("\n"));
  await admin.from("campaigns").delete().eq("id", campaignId);
  await admin.auth.admin.deleteUser(dm.id);
  await admin.auth.admin.deleteUser(player.id);
}
console.log(`errors: ${errors.length} (see ${join(OUT, "errors.txt")})`);
