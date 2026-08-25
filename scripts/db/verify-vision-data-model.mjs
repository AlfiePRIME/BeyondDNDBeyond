#!/usr/bin/env node
// Vision data model verification (Prompt 55 acceptance criteria).
//
// Seeds a campaign (DM + two players + a stranger) with a live map, a
// placed object, and a PC token, then checks: characters.darkvision_feet
// initializes from the REAL SRD race catalog (loaded from src/ via vite,
// not a reimplementation) under the wizard's subrace-overrides-race
// precedence — Drow 120 over Elf 60, Dwarf 60, Human null — is queryable,
// and is patchable by the owner like any other stat; a DM can paint a
// cell's light_level (bright/dim/dark) and it persists under exactly
// terrain_type's authorization (member reads on the live map, member
// writes match zero rows, the CHECK rejects garbage); a light source can
// be created anchored to a fixed cell, to a placed object, and to a token
// (three separate creates), the exactly-one-anchor CHECK rejects zero or
// two anchors, writes are DM-only while members read the live map's
// lights, and deleting an anchor object cascades its light away;
// map_objects.blocks_line_of_sight defaults false and round-trips a DM
// toggle (nothing reads it yet — by design, so a round-trip is the whole
// observable surface); and map_seen_cells upserts on the unique
// constraint (re-seeing a cell updates its one row, moving seen_at, never
// duplicating), is readable/writable by its OWNING member even when the
// map is no longer live (membership-based policy, not can_read_map), and
// is fully invisible to ANOTHER member of the same campaign in every
// direction — the deliberate privacy exception to the usual
// everyone-sees-everything posture.
//
// Needs the local Supabase stack (no dev server, no browser — this is a
// schema/CRUD prompt; the paint/wizard UI funnels into exactly these
// writes).
// Usage: node scripts/db/verify-vision-data-model.mjs

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { createServer } from "vite";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

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

async function makeTestUser(label) {
  const email = `vision-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `Vision ${label}` });
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  return { id: data.user.id, client };
}

// The REAL SRD catalog, resolved the way the build resolves it — so the
// darkvision values checked below are the ones the wizard actually reads.
const vite = await createServer({
  root: rootDir,
  configFile: false,
  server: { middlewareMode: true },
  appType: "custom",
  logLevel: "silent",
  optimizeDeps: { noDiscovery: true },
});
const { RACES } = await vite.ssrLoadModule("/src/rules-engine/srd/races.ts");

// The wizard's precedence rule exactly (CharacterWizard.tsx):
// subrace?.darkvisionFeet ?? race?.darkvisionFeet ?? null.
const wizardDarkvision = (raceName, subraceName) => {
  const race = RACES.find((r) => r.name === raceName);
  const subrace = race?.subraces?.find((s) => s.name === subraceName) ?? null;
  return subrace?.darkvisionFeet ?? race?.darkvisionFeet ?? null;
};

const dm = await makeTestUser("dm");
const alice = await makeTestUser("alice");
const bob = await makeTestUser("bob");
const stranger = await makeTestUser("stranger");

try {
  const campaignId = crypto.randomUUID();
  await admin.from("campaigns").insert({ id: campaignId, name: "Vision test", creator: dm.id });
  await admin.from("campaign_members").insert([
    { campaign_id: campaignId, user_id: dm.id, role: "dm" },
    { campaign_id: campaignId, user_id: alice.id, role: "player" },
    { campaign_id: campaignId, user_id: bob.id, role: "player" },
  ]);

  // ── 1. darkvision_feet: initialized from the real catalog through the
  //    wizard's precedence rule, stored, queryable, and patchable. ──

  const baseCharacter = (ownerId, name, raceName, darkvisionFeet) => ({
    id: crypto.randomUUID(),
    campaign_id: campaignId,
    owner_id: ownerId,
    name,
    race: raceName,
    class: "Fighter",
    level: 1,
    strength: 15,
    dexterity: 14,
    constitution: 13,
    intelligence: 12,
    wisdom: 10,
    charisma: 8,
    current_hp: 12,
    max_hp: 12,
    armor_class: 12,
    speed: 30,
    darkvision_feet: darkvisionFeet,
    proficiencies: [],
    inventory: [],
    spells: [],
  });

  const drowDarkvision = wizardDarkvision("Elf", "Drow");
  const dwarfDarkvision = wizardDarkvision("Dwarf", undefined);
  const humanDarkvision = wizardDarkvision("Human", undefined);
  check(
    "the SRD catalog gives the expected precedence inputs (Drow 120 over Elf 60, Dwarf 60, Human null)",
    drowDarkvision === 120 && dwarfDarkvision === 60 && humanDarkvision === null,
    JSON.stringify({ drowDarkvision, dwarfDarkvision, humanDarkvision })
  );

  const drow = baseCharacter(alice.id, "Vision Drow", "Drow", drowDarkvision);
  const dwarf = baseCharacter(alice.id, "Vision Dwarf", "Dwarf", dwarfDarkvision);
  const human = baseCharacter(bob.id, "Vision Human", "Human", humanDarkvision);
  const { error: drowError } = await alice.client.from("characters").insert(drow);
  const { error: dwarfError } = await alice.client.from("characters").insert(dwarf);
  const { error: humanError } = await bob.client.from("characters").insert(human);
  check(
    "players create characters carrying the wizard-initialized darkvision value",
    !drowError && !dwarfError && !humanError,
    drowError?.message ?? dwarfError?.message ?? humanError?.message
  );

  const { data: storedCharacters } = await admin
    .from("characters")
    .select("id, darkvision_feet")
    .in("id", [drow.id, dwarf.id, human.id]);
  const storedDarkvision = new Map((storedCharacters ?? []).map((row) => [row.id, row.darkvision_feet]));
  check(
    "a race+subrace that both define darkvision stores the subrace override (Drow: 120)",
    storedDarkvision.get(drow.id) === 120
  );
  check("a plain darkvision race stores its range (Dwarf: 60)", storedDarkvision.get(dwarf.id) === 60);
  check("a non-darkvision race stays null (Human)", storedDarkvision.get(human.id) === null);

  const { data: queried } = await alice.client
    .from("characters")
    .select("name, darkvision_feet")
    .eq("campaign_id", campaignId)
    .not("darkvision_feet", "is", null);
  check(
    "darkvision is queryable as a real column (filter on it returns exactly the darkvision-capable PCs)",
    (queried ?? []).length === 2 && queried.every((row) => row.darkvision_feet >= 60),
    JSON.stringify(queried)
  );

  const { data: patched, error: patchError } = await bob.client
    .from("characters")
    .update({ darkvision_feet: 60 })
    .eq("id", human.id)
    .select("darkvision_feet")
    .single();
  check(
    "the owner patches darkvision like any other stat (a magic item grants the Human 60 ft)",
    !patchError && patched?.darkvision_feet === 60,
    patchError?.message
  );
  await admin.from("characters").update({ darkvision_feet: null }).eq("id", human.id);

  // ── 2. A live map with a placed object and a token, for everything
  //    below. ──

  const mapId = crypto.randomUUID();
  await dm.client.from("campaign_maps").insert({
    id: mapId,
    campaign_id: campaignId,
    name: "The Lit Map",
    grid_width: 10,
    grid_height: 10,
  });
  await admin.from("campaigns").update({ live_map: mapId }).eq("id", campaignId);

  const assetId = crypto.randomUUID();
  await admin.from("asset_library").insert({
    id: assetId,
    name: "Vision Brazier",
    source_type: "preset",
    model_ref: "/assets/presets/crate.glb",
  });
  const objectId = crypto.randomUUID();
  const { data: createdObject, error: objectError } = await dm.client
    .from("map_objects")
    .insert({ id: objectId, map_id: mapId, asset_id: assetId, x: 4, y: 4, elevation: 0, rotation: 0 })
    .select()
    .single();
  check("DM places an object (the brazier a light will attach to)", !objectError, objectError?.message);

  const tokenId = crypto.randomUUID();
  const { error: tokenError } = await alice.client.from("map_tokens").insert({
    id: tokenId,
    map_id: mapId,
    character_id: drow.id,
    x: 1,
    y: 1,
    elevation: 0,
    allegiance: "party",
  });
  check("the Drow's owner places its token (the carrier a light will attach to)", !tokenError, tokenError?.message);

  // ── 3. light_level: painted per cell with exactly terrain_type's
  //    authorization. ──

  const { error: paintError } = await dm.client.from("map_cells").upsert(
    [
      { map_id: mapId, x: 0, y: 0, elevation: 0, terrain_type: "normal", light_level: "dark" },
      { map_id: mapId, x: 1, y: 0, elevation: 1, terrain_type: "difficult", light_level: "dim" },
    ],
    { onConflict: "map_id,x,y" }
  );
  check("DM paints light levels alongside terrain in the same upsert", !paintError, paintError?.message);

  // A single-row insert that genuinely omits the column (a batch upsert
  // can't — PostgREST null-fills missing keys across a bulk payload, which
  // is why the app's upsertMapCells rows always carry light_level).
  const { error: defaultCellError } = await dm.client
    .from("map_cells")
    .insert({ map_id: mapId, x: 2, y: 0, elevation: 0, terrain_type: "normal" });
  check("a cell written without a light level takes the DB default", !defaultCellError, defaultCellError?.message);

  const { data: paintedCells } = await admin
    .from("map_cells")
    .select("x, light_level")
    .eq("map_id", mapId)
    .eq("y", 0)
    .order("x");
  check(
    "painted light levels persist and an unpainted cell defaults to bright",
    paintedCells?.length === 3 &&
      paintedCells[0].light_level === "dark" &&
      paintedCells[1].light_level === "dim" &&
      paintedCells[2].light_level === "bright",
    JSON.stringify(paintedCells)
  );

  const { data: memberCells } = await alice.client.from("map_cells").select("x, light_level").eq("map_id", mapId);
  check("a member reads the live map's light levels (same read rule as terrain)", (memberCells ?? []).length === 3);

  const { error: memberPaintError, count: memberPaintCount } = await alice.client
    .from("map_cells")
    .update({ light_level: "bright" }, { count: "exact" })
    .eq("map_id", mapId)
    .eq("x", 0)
    .eq("y", 0);
  check(
    "a member cannot paint light (zero rows under RLS, same write rule as terrain)",
    !memberPaintError && (memberPaintCount ?? 0) === 0,
    memberPaintError?.message
  );

  const { error: badLightError } = await dm.client
    .from("map_cells")
    .upsert([{ map_id: mapId, x: 3, y: 0, elevation: 0, terrain_type: "normal", light_level: "blinding" }], {
      onConflict: "map_id,x,y",
    });
  check("the CHECK rejects a light level outside bright/dim/dark", !!badLightError, "insert unexpectedly succeeded");

  // ── 4. light_sources: three anchors, the XOR CHECK, sibling RLS,
  //    cascade. ──

  const { data: fixedLight, error: fixedError } = await dm.client
    .from("light_sources")
    .insert({ map_id: mapId, radius_feet: 20, brightness: "bright", x: 5, y: 5 })
    .select()
    .single();
  check("a light source anchors to a fixed cell", !fixedError && fixedLight?.x === 5, fixedError?.message);

  const { data: objectLight, error: objectLightError } = await dm.client
    .from("light_sources")
    .insert({ map_id: mapId, radius_feet: 30, brightness: "dim", object_id: objectId })
    .select()
    .single();
  check(
    "a light source anchors to a placed object",
    !objectLightError && objectLight?.object_id === objectId && objectLight?.x === null,
    objectLightError?.message
  );

  const { data: tokenLight, error: tokenLightError } = await dm.client
    .from("light_sources")
    .insert({ map_id: mapId, radius_feet: 40, brightness: "bright", token_id: tokenId })
    .select()
    .single();
  check(
    "a light source anchors to a token",
    !tokenLightError && tokenLight?.token_id === tokenId,
    tokenLightError?.message
  );

  const { error: noAnchorError } = await dm.client
    .from("light_sources")
    .insert({ map_id: mapId, radius_feet: 20, brightness: "bright" });
  check("the CHECK rejects a light with no anchor at all", !!noAnchorError, "insert unexpectedly succeeded");

  const { error: twoAnchorError } = await dm.client
    .from("light_sources")
    .insert({ map_id: mapId, radius_feet: 20, brightness: "bright", x: 1, y: 1, object_id: objectId });
  check("the CHECK rejects a light with two anchors set", !!twoAnchorError, "insert unexpectedly succeeded");

  const { error: halfCellError } = await dm.client
    .from("light_sources")
    .insert({ map_id: mapId, radius_feet: 20, brightness: "bright", x: 1 });
  check("the CHECK rejects a half-set fixed position (x without y)", !!halfCellError, "insert unexpectedly succeeded");

  const { data: updatedLight, error: updateLightError } = await dm.client
    .from("light_sources")
    .update({ radius_feet: 60, brightness: "dim" })
    .eq("id", fixedLight.id)
    .select()
    .single();
  check(
    "DM edits a light's radius/brightness in place",
    !updateLightError && updatedLight?.radius_feet === 60 && updatedLight?.brightness === "dim",
    updateLightError?.message
  );

  const { data: memberLights } = await alice.client.from("light_sources").select().eq("map_id", mapId);
  check("a member reads the live map's light sources (can_read_map, the map_objects rule)", (memberLights ?? []).length === 3);

  const { data: strangerLights } = await stranger.client.from("light_sources").select().eq("map_id", mapId);
  check("a non-member reads no light sources", (strangerLights ?? []).length === 0);

  const { error: memberLightError } = await alice.client
    .from("light_sources")
    .insert({ map_id: mapId, radius_feet: 10, brightness: "dim", x: 2, y: 2 });
  check("a member cannot create a light source (DM-only writes, the map_objects rule)", !!memberLightError);

  await dm.client.from("map_objects").delete().eq("id", objectId);
  const { data: lightsAfterObjectDelete } = await admin.from("light_sources").select("id").eq("map_id", mapId);
  check(
    "deleting the anchor object cascades its light away (the other two lights survive)",
    (lightsAfterObjectDelete ?? []).length === 2 &&
      !lightsAfterObjectDelete.some((row) => row.id === objectLight.id)
  );

  // ── 5. blocks_line_of_sight: defaults false, DM toggles, round-trips.
  //    Nothing reads it anywhere yet (by design — grep the codebase for a
  //    consumer and find only the authoring toggle), so the round-trip IS
  //    the observable surface. ──

  check("a placed object's blocks_line_of_sight defaults to false", createdObject?.blocks_line_of_sight === false);

  const object2Id = crypto.randomUUID();
  await dm.client
    .from("map_objects")
    .insert({ id: object2Id, map_id: mapId, asset_id: assetId, x: 6, y: 6, elevation: 0, rotation: 0 });
  const { data: losToggled, error: losError } = await dm.client
    .from("map_objects")
    .update({ blocks_line_of_sight: true })
    .eq("id", object2Id)
    .select("blocks_line_of_sight")
    .single();
  check("DM toggles the flag on and it round-trips", !losError && losToggled?.blocks_line_of_sight === true, losError?.message);

  const { error: memberLosError, count: memberLosCount } = await alice.client
    .from("map_objects")
    .update({ blocks_line_of_sight: false }, { count: "exact" })
    .eq("id", object2Id);
  check(
    "a member cannot toggle it (the existing DM-only object write rule)",
    !memberLosError && (memberLosCount ?? 0) === 0,
    memberLosError?.message
  );

  // ── 6. map_seen_cells: private per-player memory. ──

  const seenCell = (x, y, light) => ({
    map_id: mapId,
    user_id: alice.id,
    x,
    y,
    terrain_type: "normal",
    elevation: 0,
    light_level: light,
    seen_at: new Date().toISOString(),
  });

  const { error: seenInsertError } = await alice.client
    .from("map_seen_cells")
    .upsert([seenCell(0, 0, "dark"), seenCell(1, 0, "dim")], { onConflict: "map_id,user_id,x,y" });
  check("a member records their own seen cells", !seenInsertError, seenInsertError?.message);

  const { data: firstSeen } = await admin
    .from("map_seen_cells")
    .select("id, seen_at, light_level")
    .eq("map_id", mapId)
    .eq("user_id", alice.id)
    .eq("x", 0)
    .eq("y", 0)
    .single();

  await new Promise((resolve) => setTimeout(resolve, 20));
  const { error: reseenError } = await alice.client
    .from("map_seen_cells")
    .upsert([seenCell(0, 0, "bright")], { onConflict: "map_id,user_id,x,y" });
  const { data: reseenRows } = await admin
    .from("map_seen_cells")
    .select("id, seen_at, light_level")
    .eq("map_id", mapId)
    .eq("user_id", alice.id)
    .eq("x", 0)
    .eq("y", 0);
  check(
    "re-seeing a cell updates the one existing row (same id, new snapshot + seen_at) — no duplicate",
    !reseenError &&
      reseenRows?.length === 1 &&
      reseenRows[0].id === firstSeen.id &&
      reseenRows[0].light_level === "bright" &&
      reseenRows[0].seen_at > firstSeen.seen_at,
    reseenError?.message ?? JSON.stringify(reseenRows)
  );

  const { data: aliceSeen } = await alice.client.from("map_seen_cells").select().eq("map_id", mapId);
  check("the owning member reads their own memory (two cells)", (aliceSeen ?? []).length === 2);

  const { data: bobReadsAlice } = await bob.client.from("map_seen_cells").select().eq("map_id", mapId);
  check(
    "another member of the SAME campaign reads none of it — the deliberate privacy exception",
    (bobReadsAlice ?? []).length === 0,
    JSON.stringify(bobReadsAlice)
  );

  const { error: bobForgesError } = await bob.client
    .from("map_seen_cells")
    .insert({ ...seenCell(5, 5, "bright"), user_id: alice.id });
  check("another member cannot forge rows under someone else's user_id", !!bobForgesError);

  const { error: bobUpdatesError, count: bobUpdatesCount } = await bob.client
    .from("map_seen_cells")
    .update({ light_level: "dark" }, { count: "exact" })
    .eq("map_id", mapId)
    .eq("user_id", alice.id);
  check(
    "another member cannot update someone else's memory (zero rows under RLS)",
    !bobUpdatesError && (bobUpdatesCount ?? 0) === 0,
    bobUpdatesError?.message
  );

  const { error: strangerSeenError } = await stranger.client
    .from("map_seen_cells")
    .insert({ ...seenCell(5, 5, "bright"), user_id: stranger.id });
  check("a non-member cannot record seen cells at all (membership gate)", !!strangerSeenError);

  // Membership, not can_read_map: memory persists past the live-map switch.
  await admin.from("campaigns").update({ live_map: null }).eq("id", campaignId);
  const { data: aliceSeenAfterSwitch } = await alice.client.from("map_seen_cells").select().eq("map_id", mapId);
  const { error: recordAfterSwitchError } = await alice.client
    .from("map_seen_cells")
    .upsert([seenCell(2, 0, "bright")], { onConflict: "map_id,user_id,x,y" });
  check(
    "a member's memory of a map survives it no longer being live (readable AND writable)",
    (aliceSeenAfterSwitch ?? []).length === 2 && !recordAfterSwitchError,
    recordAfterSwitchError?.message
  );

  // Cascade sanity: the campaign takes maps, lights, and memory with it.
  await admin.from("campaigns").delete().eq("id", campaignId);
  const { data: lightsAfter } = await admin.from("light_sources").select("id").eq("map_id", mapId);
  const { data: seenAfter } = await admin.from("map_seen_cells").select("id").eq("map_id", mapId);
  check("cascade delete removes light_sources", (lightsAfter ?? []).length === 0);
  check("cascade delete removes map_seen_cells", (seenAfter ?? []).length === 0);

  await admin.from("asset_library").delete().eq("id", assetId);
} finally {
  await vite.close();
  await admin.auth.admin.deleteUser(dm.id);
  await admin.auth.admin.deleteUser(alice.id);
  await admin.auth.admin.deleteUser(bob.id);
  await admin.auth.admin.deleteUser(stranger.id);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll vision data model checks passed.");
process.exit(0);
