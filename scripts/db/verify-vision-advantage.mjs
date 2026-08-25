#!/usr/bin/env node
// Vision-driven advantage/disadvantage verification (Prompt 59 acceptance
// criteria).
//
// Seeds a campaign whose live map is a 30x1 corridor (bright cells x 0-8,
// dark cells x 10-29) with attacker Alice (PC, no darkvision, at x 0), a
// target PC Bob (x 2, bright), a "Bright Goblin" NPC (x 3, bright), and a
// "Dark Lurker" NPC (x 20, deep in darkness), then drives the roll Route
// Handler over real HTTP with signed-in session cookies (the
// verify-dice-rolls.mjs arrangement) and checks, against the SERVER-side
// perception computation: attacking a target the attacker cannot perceive
// applies disadvantage automatically with a stated reason, while the same
// attack against a bright-lit target in range does not; a manually-selected
// mode still works and combines with the automatic sources rather than
// being silently overridden (manual advantage vs an unperceived target
// cancels to a FLAT roll, with both reasons stated); a missing/unresolvable
// target token — or no live map at all — falls back gracefully to no
// auto-modes, never an error; with combat active, a blinded target grants
// automatic advantage and an invisible target automatic disadvantage (the
// generic attacksAgainstHave* catalog flags, reported under the condition's
// display name); a blinded-AND-unperceived target cancels to flat with both
// reasons; and a blinded ATTACKER gets disadvantage for free through the
// same "target not perceived" check (their vision-blocked tier is "none"
// everywhere), with the reasons persisted in the stored roll_log breakdown.
//
// Needs the local Supabase stack; starts `yarn dev` itself (and polls
// /api/health) if :3000 isn't already serving.
// Usage: node scripts/db/verify-vision-advantage.mjs

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const APP_URL = "http://localhost:3000";

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

// The @supabase/ssr cookie format: sb-<host>-auth-token = "base64-" +
// base64url(JSON session), chunked at 3180 chars into name.0, name.1, ...
const COOKIE_NAME = `sb-${new URL(supabaseUrl).hostname.split(".")[0]}-auth-token`;
const MAX_CHUNK = 3180;

function sessionCookieHeader(session) {
  const value = "base64-" + Buffer.from(JSON.stringify(session)).toString("base64url");
  if (value.length <= MAX_CHUNK) return `${COOKIE_NAME}=${value}`;
  const chunks = [];
  for (let i = 0; i * MAX_CHUNK < value.length; i++) {
    chunks.push(`${COOKIE_NAME}.${i}=${value.slice(i * MAX_CHUNK, (i + 1) * MAX_CHUNK)}`);
  }
  return chunks.join("; ");
}

async function makeTestUser(label) {
  const email = `vision-advantage-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `Vision Adv ${label}` });
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: signIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  return { id: data.user.id, client, cookie: sessionCookieHeader(signIn.session) };
}

async function postRoll(user, campaignId, body) {
  const response = await fetch(`${APP_URL}/campaigns/${campaignId}/roll`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: user.cookie },
    body: JSON.stringify(body),
  });
  const json = await response.json().catch(() => null);
  return { status: response.status, body: json };
}

await ensureDevServer();

const dm = await makeTestUser("dm");
const alice = await makeTestUser("alice");
const bob = await makeTestUser("bob");

try {
  const campaignId = crypto.randomUUID();
  await admin.from("campaigns").insert({ id: campaignId, name: "Vision advantage test", creator: dm.id });
  await admin.from("campaign_members").insert([
    { campaign_id: campaignId, user_id: dm.id, role: "dm" },
    { campaign_id: campaignId, user_id: alice.id, role: "player" },
    { campaign_id: campaignId, user_id: bob.id, role: "player" },
  ]);

  const aliceCharacterId = crypto.randomUUID();
  const bobCharacterId = crypto.randomUUID();
  const baseCharacter = (id, ownerId, name) => ({
    id,
    campaign_id: campaignId,
    owner_id: ownerId,
    name,
    race: "Human",
    class: "Fighter",
    level: 1,
    strength: 16,
    dexterity: 14,
    constitution: 13,
    intelligence: 10,
    wisdom: 12,
    charisma: 8,
    current_hp: 20,
    max_hp: 20,
    armor_class: 15,
    speed: 30,
    darkvision_feet: null, // Alice's perception is pure light-based below.
    proficiencies: [],
    inventory: [],
    spells: [],
  });
  await admin.from("characters").insert([
    baseCharacter(aliceCharacterId, alice.id, "Alice PC"),
    baseCharacter(bobCharacterId, bob.id, "Bob PC"),
  ]);

  // The corridor: 30x1, bright by sparse default up to x 9, dark x 10-29.
  const mapId = crypto.randomUUID();
  await admin.from("campaign_maps").insert({
    id: mapId,
    campaign_id: campaignId,
    name: "Advantage corridor",
    grid_width: 30,
    grid_height: 1,
  });
  const cellRows = [];
  for (let x = 10; x < 30; x++) {
    cellRows.push({ map_id: mapId, x, y: 0, elevation: 0, terrain_type: "normal", light_level: "dark" });
  }
  await admin.from("map_cells").insert(cellRows);

  const aliceTokenId = crypto.randomUUID();
  const bobTokenId = crypto.randomUUID();
  const goblinTokenId = crypto.randomUUID();
  const lurkerTokenId = crypto.randomUUID();
  await admin.from("map_tokens").insert([
    { id: aliceTokenId, map_id: mapId, character_id: aliceCharacterId, x: 0, y: 0, elevation: 0, allegiance: "party" },
    { id: bobTokenId, map_id: mapId, character_id: bobCharacterId, x: 2, y: 0, elevation: 0, allegiance: "party" },
    { id: goblinTokenId, map_id: mapId, npc_name: "Bright Goblin", x: 3, y: 0, elevation: 0, allegiance: "hostile" },
    { id: lurkerTokenId, map_id: mapId, npc_name: "Dark Lurker", x: 20, y: 0, elevation: 0, allegiance: "hostile" },
  ]);
  await admin.from("campaigns").update({ live_map: mapId }).eq("id", campaignId);

  const attackBody = (overrides) => ({
    kind: "attack",
    characterId: aliceCharacterId,
    attackKind: "melee",
    damageNotation: "1d6",
    targetAc: 99, // Unreachable so damage application never muddies the checks.
    ...overrides,
  });

  function attackFacts(roll) {
    const breakdown = roll.body?.roll?.breakdown;
    return {
      ok: roll.status === 200 && !!roll.body?.ok,
      mode: breakdown?.mode,
      dice: breakdown?.d20Rolls?.length,
      adv: breakdown?.attack?.advantageSources,
      dis: breakdown?.attack?.disadvantageSources,
      id: roll.body?.roll?.id,
    };
  }

  // -- 1. An unperceivable target (deep darkness, no darkvision, no light)
  //    gets automatic disadvantage, with the reason stated. --
  const dark = attackFacts(
    await postRoll(alice, campaignId, attackBody({ targetTokenId: lurkerTokenId, targetName: "Dark Lurker" }))
  );
  check(
    "attacking a target the attacker cannot perceive rolls disadvantage automatically (two dice)",
    dark.ok && dark.mode === "disadvantage" && dark.dice === 2,
    JSON.stringify(dark)
  );
  check(
    'the disadvantage reason "target not perceived" is stated in the breakdown',
    Array.isArray(dark.dis) && dark.dis.includes("target not perceived") && dark.adv?.length === 0,
    JSON.stringify({ adv: dark.adv, dis: dark.dis })
  );

  // -- 2. The SAME attack against a bright-lit target in plain view: no
  //    auto-disadvantage. --
  const bright = attackFacts(
    await postRoll(alice, campaignId, attackBody({ targetTokenId: goblinTokenId, targetName: "Bright Goblin" }))
  );
  check(
    "the same attack against a bright-lit, perceivable target rolls flat (one die, no sources)",
    bright.ok && bright.mode === "normal" && bright.dice === 1 && bright.adv?.length === 0 && bright.dis?.length === 0,
    JSON.stringify(bright)
  );

  // -- 3. The manual toggle still works, and is recorded as the source. --
  const manual = attackFacts(
    await postRoll(
      alice,
      campaignId,
      attackBody({ targetTokenId: goblinTokenId, targetName: "Bright Goblin", mode: "advantage" })
    )
  );
  check(
    'manually-selected advantage still rolls advantage, sourced "manually selected"',
    manual.ok && manual.mode === "advantage" && manual.dice === 2 && manual.adv?.includes("manually selected"),
    JSON.stringify(manual)
  );

  // -- 4. Manual advantage AGAINST an unperceived target: one advantage
  //    source + one disadvantage source cancel to a FLAT roll (SRD), with
  //    both reasons stated — not a silent override in either direction. --
  const canceled = attackFacts(
    await postRoll(
      alice,
      campaignId,
      attackBody({ targetTokenId: lurkerTokenId, targetName: "Dark Lurker", mode: "advantage" })
    )
  );
  check(
    "manual advantage vs an unperceived target cancels to a flat roll (one die, normal)",
    canceled.ok && canceled.mode === "normal" && canceled.dice === 1,
    JSON.stringify(canceled)
  );
  check(
    "the canceled roll states BOTH reasons",
    canceled.adv?.includes("manually selected") && canceled.dis?.includes("target not perceived"),
    JSON.stringify({ adv: canceled.adv, dis: canceled.dis })
  );

  // -- 5. Graceful fallback when there is nothing to compute perception
  //    from: no target token sent, an unresolvable token id, and no live
  //    map at all — the roll succeeds with no auto-modes, never an error. --
  const untargeted = attackFacts(
    await postRoll(alice, campaignId, attackBody({ targetName: "Dark Lurker" }))
  );
  check(
    "an attack with no target token still succeeds with no auto-modes",
    untargeted.ok && untargeted.mode === "normal" && untargeted.adv?.length === 0 && untargeted.dis?.length === 0,
    JSON.stringify(untargeted)
  );
  const bogusToken = attackFacts(
    await postRoll(alice, campaignId, attackBody({ targetTokenId: crypto.randomUUID(), targetName: "Ghost" }))
  );
  check(
    "an unresolvable target token id falls back to no auto-modes, not an error",
    bogusToken.ok && bogusToken.mode === "normal" && bogusToken.dis?.length === 0,
    JSON.stringify(bogusToken)
  );
  await admin.from("campaigns").update({ live_map: null }).eq("id", campaignId);
  const noMap = attackFacts(
    await postRoll(alice, campaignId, attackBody({ targetTokenId: lurkerTokenId, targetName: "Dark Lurker" }))
  );
  check(
    "with NO live map, the same dark-target attack succeeds with no auto-disadvantage",
    noMap.ok && noMap.mode === "normal" && noMap.dis?.length === 0,
    JSON.stringify(noMap)
  );
  await admin.from("campaigns").update({ live_map: mapId }).eq("id", campaignId);

  // -- 6. Target-condition flags need combat (conditions only exist for
  //    active combatants). Bob's combatant sorts first so ALICE is never
  //    the current combatant and the economy gate stays out of the way. --
  const encounterId = crypto.randomUUID();
  await admin.from("combat_encounters").insert({ id: encounterId, campaign_id: campaignId });
  const combatantRows = [
    { encounter_id: encounterId, token_id: bobTokenId, character_id: bobCharacterId, initiative: 20 },
    { encounter_id: encounterId, token_id: goblinTokenId, npc_name: "Bright Goblin", initiative: 15 },
    { encounter_id: encounterId, token_id: lurkerTokenId, npc_name: "Dark Lurker", initiative: 10 },
    { encounter_id: encounterId, token_id: aliceTokenId, character_id: aliceCharacterId, initiative: 1 },
  ];
  const { data: combatants } = await admin.from("combat_combatants").insert(combatantRows).select();
  const combatantByToken = new Map(combatants.map((row) => [row.token_id, row]));

  // Blinded Bob (attacksAgainstHaveAdvantage): automatic advantage, named.
  await admin.from("combatant_conditions").insert({
    combatant_id: combatantByToken.get(bobTokenId).id,
    condition_key: "blinded",
  });
  const vsBlinded = attackFacts(
    await postRoll(
      alice,
      campaignId,
      attackBody({ targetTokenId: bobTokenId, targetCharacterId: bobCharacterId, targetName: "Bob PC" })
    )
  );
  check(
    "attacking a blinded target rolls advantage automatically (two dice)",
    vsBlinded.ok && vsBlinded.mode === "advantage" && vsBlinded.dice === 2,
    JSON.stringify(vsBlinded)
  );
  check(
    "the advantage reason names the condition via its catalog display name",
    vsBlinded.adv?.includes("target has Blinded (advantage against)") && vsBlinded.dis?.length === 0,
    JSON.stringify({ adv: vsBlinded.adv, dis: vsBlinded.dis })
  );
  const { data: storedBlinded } = await admin.from("roll_log").select().eq("id", vsBlinded.id).maybeSingle();
  check(
    "the stated reasons are persisted in the stored roll_log breakdown",
    storedBlinded?.breakdown?.attack?.advantageSources?.includes("target has Blinded (advantage against)"),
    JSON.stringify(storedBlinded?.breakdown?.attack?.advantageSources)
  );

  // Invisible Goblin (attacksAgainstHaveDisadvantage): automatic
  // disadvantage, even though it stands in bright light.
  await admin.from("combatant_conditions").insert({
    combatant_id: combatantByToken.get(goblinTokenId).id,
    condition_key: "invisible",
  });
  const vsInvisible = attackFacts(
    await postRoll(alice, campaignId, attackBody({ targetTokenId: goblinTokenId, targetName: "Bright Goblin" }))
  );
  check(
    "attacking an invisible target rolls disadvantage automatically, named after the condition",
    vsInvisible.ok &&
      vsInvisible.mode === "disadvantage" &&
      vsInvisible.dice === 2 &&
      vsInvisible.dis?.includes("target has Invisible (disadvantage against)"),
    JSON.stringify(vsInvisible)
  );

  // -- 7. A blinded AND unperceived target: the condition's advantage and
  //    the visibility disadvantage co-occur and cancel to flat, both stated. --
  await admin.from("map_tokens").update({ x: 21 }).eq("id", bobTokenId);
  const blindedUnseen = attackFacts(
    await postRoll(
      alice,
      campaignId,
      attackBody({ targetTokenId: bobTokenId, targetCharacterId: bobCharacterId, targetName: "Bob PC" })
    )
  );
  check(
    "a blinded-AND-unperceived target cancels to a flat roll with both reasons stated",
    blindedUnseen.ok &&
      blindedUnseen.mode === "normal" &&
      blindedUnseen.dice === 1 &&
      blindedUnseen.adv?.includes("target has Blinded (advantage against)") &&
      blindedUnseen.dis?.includes("target not perceived"),
    JSON.stringify(blindedUnseen)
  );
  await admin.from("map_tokens").update({ x: 2 }).eq("id", bobTokenId);

  // -- 8. Manual disadvantage AGAINST an advantage-flagged target also
  //    cancels — the manual pick combines, it is never silently dropped. --
  const manualVsFlag = attackFacts(
    await postRoll(
      alice,
      campaignId,
      attackBody({
        targetTokenId: bobTokenId,
        targetCharacterId: bobCharacterId,
        targetName: "Bob PC",
        mode: "disadvantage",
      })
    )
  );
  check(
    "manual disadvantage vs a blinded target cancels to flat with both reasons stated",
    manualVsFlag.ok &&
      manualVsFlag.mode === "normal" &&
      manualVsFlag.dice === 1 &&
      manualVsFlag.adv?.includes("target has Blinded (advantage against)") &&
      manualVsFlag.dis?.includes("manually selected"),
    JSON.stringify(manualVsFlag)
  );

  // -- 9. A blinded ATTACKER: no separate rule anywhere — the vision-blocked
  //    observer's tier is "none" for EVERY cell, so the same perception
  //    check yields "target not perceived" against even the bright,
  //    adjacent Goblin (whose own Invisible flag rides along as a second
  //    disadvantage source — sources never stack, still one disadvantage). --
  await admin.from("combatant_conditions").insert({
    combatant_id: combatantByToken.get(aliceTokenId).id,
    condition_key: "blinded",
  });
  const blindAttacker = attackFacts(
    await postRoll(alice, campaignId, attackBody({ targetTokenId: goblinTokenId, targetName: "Bright Goblin" }))
  );
  check(
    'a blinded attacker gets "target not perceived" for free, even against a bright adjacent target',
    blindAttacker.ok &&
      blindAttacker.mode === "disadvantage" &&
      blindAttacker.dice === 2 &&
      blindAttacker.dis?.includes("target not perceived"),
    JSON.stringify(blindAttacker)
  );
} finally {
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
console.log("\nAll vision-advantage checks passed.");
process.exit(0);
