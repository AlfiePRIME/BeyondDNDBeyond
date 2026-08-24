#!/usr/bin/env node
// Avatar storage verification (Prompt 13). The avatars bucket's access
// model: any authenticated user can read any avatar, but only the owner
// can write under their own {user_id}/ prefix — and the bucket itself
// enforces the size and MIME limits server-side.
//
// Usage: node scripts/db/verify-avatar-storage.mjs

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

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
function check(label, condition) {
  if (condition) {
    console.log(`PASS  ${label}`);
  } else {
    console.error(`FAIL  ${label}`);
    failures++;
  }
}

async function makeTestUser(label) {
  const email = `avatar-storage-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `Avatar Test ${label}` });
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  return { id: data.user.id, client };
}

const owner = await makeTestUser("owner");
const other = await makeTestUser("other");
const glb = readFileSync(join(rootDir, "public", "avatars", "presets", "vanguard.glb"));

try {
  const path = `${owner.id}/avatar.glb`;
  const uploadOpts = { contentType: "model/gltf-binary", upsert: true };

  const { error: uploadError } = await owner.client.storage.from("avatars").upload(path, glb, uploadOpts);
  check("owner can upload under their own path", !uploadError);

  const { error: replaceError } = await owner.client.storage.from("avatars").upload(path, glb, uploadOpts);
  check("owner can replace their own avatar", !replaceError);

  const { data: downloaded, error: downloadError } = await other.client.storage.from("avatars").download(path);
  const downloadedSize = downloaded ? (await downloaded.arrayBuffer()).byteLength : 0;
  check("another authenticated user can download it intact", !downloadError && downloadedSize === glb.length);

  const { error: crossError } = await other.client.storage
    .from("avatars")
    .upload(`${owner.id}/intruder.glb`, glb, uploadOpts);
  check("a user cannot upload under someone else's path", !!crossError);

  const { error: mimeError } = await owner.client.storage
    .from("avatars")
    .upload(`${owner.id}/notes.txt`, Buffer.from("hello"), { contentType: "text/plain" });
  check("the bucket rejects non-glTF MIME types", !!mimeError);

  const oversized = Buffer.alloc(10 * 1024 * 1024 + 1024);
  glb.copy(oversized);
  const { error: sizeError } = await owner.client.storage
    .from("avatars")
    .upload(`${owner.id}/huge.glb`, oversized, uploadOpts);
  check("the bucket rejects files over the 10MB limit", !!sizeError);

  const { error: deleteError } = await owner.client.storage.from("avatars").remove([path]);
  check("owner can delete their own avatar", !deleteError);

  const { error: profileError } = await owner.client
    .from("profiles")
    .update({ avatar_source: "custom", avatar_ref: path })
    .eq("id", owner.id);
  check("profile accepts a custom avatar selection", !profileError);

  const { error: orphanRefError } = await owner.client
    .from("profiles")
    .update({ avatar_source: null, avatar_ref: path })
    .eq("id", owner.id);
  check("profile rejects an avatar_ref without a source", !!orphanRefError);

  const { error: badSourceError } = await owner.client
    .from("profiles")
    .update({ avatar_source: "gravatar", avatar_ref: path })
    .eq("id", owner.id);
  check("profile rejects an unknown avatar_source", !!badSourceError);
} finally {
  await admin.storage.from("avatars").remove([`${owner.id}/avatar.glb`, `${owner.id}/huge.glb`]);
  await admin.auth.admin.deleteUser(owner.id);
  await admin.auth.admin.deleteUser(other.id);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll avatar storage checks passed.");
