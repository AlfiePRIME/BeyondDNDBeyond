#!/usr/bin/env node
// Realtime load test (Prompt 2, formalized in Prompt 16).
//
// Opens several simulated concurrent clients, each joining the same
// campaign-shaped channel through the real src/realtime event-bus
// (joinCampaignChannel), and measures round-trip broadcast latency across
// them. Needs the self-hosted Supabase stack running (see supabase/
// directory).
//
// campaignChannel.ts has no runtime imports of its own (its SupabaseClient
// parameter is a type-only import, erased at parse time) — Node's built-in
// TypeScript type-stripping (stable since Node 23.6) can load it directly,
// so this script exercises the actual module rather than a re-implementation
// of its shape.
//
// Usage: node scripts/perf/realtime-load.mjs

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { joinCampaignChannel } from "../../src/realtime/campaignChannel.ts";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const budgets = JSON.parse(readFileSync(join(rootDir, "perf-budgets.json"), "utf8"));

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

const env = { ...loadEnv(join(rootDir, ".env")), ...process.env };
const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!supabaseUrl || !anonKey) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY in .env");
  process.exit(1);
}

const CLIENT_COUNT = budgets.realtimeLoad.concurrentClients;
const CAMPAIGN_ID = crypto.randomUUID();
const PING_EVENT = "perf:ping";
const PINGS_PER_CLIENT = 5;

function makeClient(label) {
  const supabase = createClient(supabaseUrl, anonKey, {
    realtime: { params: { eventsPerSecond: 20 } },
  });
  return joinCampaignChannel(supabase, CAMPAIGN_ID, { userId: crypto.randomUUID(), displayName: label });
}

const latencies = [];
const channels = Array.from({ length: CLIENT_COUNT }, (_, i) => makeClient(`perf-client-${i}`));

for (const channel of channels) {
  channel.subscribe(PING_EVENT, (payload) => {
    latencies.push(Date.now() - payload.sentAt);
  });
}

try {
  console.log(`Joining ${CLIENT_COUNT} concurrent campaign-channel clients against ${supabaseUrl} ...`);
  // publish() awaits each channel's own subscribe+presence-track before
  // sending, so this first (unsubscribed-to) broadcast absorbs connection
  // time up front and keeps it out of the timed ping loop below.
  await Promise.all(channels.map((channel) => channel.publish("perf:connect", {})));

  console.log(`Sending ${PINGS_PER_CLIENT} pings per client ...`);
  for (let i = 0; i < PINGS_PER_CLIENT; i++) {
    await Promise.all(channels.map((channel) => channel.publish(PING_EVENT, { sentAt: Date.now() })));
    await new Promise((r) => setTimeout(r, 50));
  }

  // Give in-flight broadcasts time to arrive.
  await new Promise((r) => setTimeout(r, 1000));

  if (latencies.length === 0) {
    console.error("FAIL: no broadcast messages were received — check the Supabase stack is running.");
    process.exitCode = 1;
  } else {
    const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;
    const max = Math.max(...latencies);
    const budgetMs = budgets.realtimeLoad.maxAvgLatencyMs;

    console.log(`Received ${latencies.length} broadcasts across ${CLIENT_COUNT} clients.`);
    console.log(`Average latency: ${avg.toFixed(1)} ms (budget: ${budgetMs} ms), max: ${max} ms`);

    if (avg > budgetMs) {
      console.error(`FAIL: average latency ${avg.toFixed(1)} ms exceeds budget ${budgetMs} ms.`);
      process.exitCode = 1;
    } else {
      console.log("PASS");
    }
  }
} finally {
  await Promise.all(channels.map((channel) => channel.leave()));
}

process.exit(process.exitCode ?? 0);
