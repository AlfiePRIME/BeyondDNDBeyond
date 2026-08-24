#!/usr/bin/env node
// Realtime load test (Prompt 2).
//
// Opens several simulated concurrent clients against a scratch Supabase
// Realtime broadcast channel and measures round-trip message latency.
// Needs the self-hosted Supabase stack running (see supabase/ directory) —
// this is plumbing only for now: Prompt 16 builds the real event-bus this
// will eventually be pointed at, formalized per-campaign channel.
//
// Usage: node scripts/perf/realtime-load.mjs

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

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
const CHANNEL_NAME = `perf-load-test-${Date.now()}`;
const PINGS_PER_CLIENT = 5;

function makeClient() {
  return createClient(supabaseUrl, anonKey, {
    realtime: { params: { eventsPerSecond: 20 } },
  });
}

async function subscribeAndCollect(client, latencies) {
  const channel = client.channel(CHANNEL_NAME, { config: { broadcast: { self: true } } });

  channel.on("broadcast", { event: "ping" }, (payload) => {
    const sentAt = payload.payload.sentAt;
    latencies.push(Date.now() - sentAt);
  });

  await new Promise((resolve, reject) => {
    channel.subscribe((status) => {
      if (status === "SUBSCRIBED") resolve();
      if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        reject(new Error(`Channel subscribe failed: ${status}`));
      }
    });
  });

  return channel;
}

const latencies = [];
const clients = Array.from({ length: CLIENT_COUNT }, () => makeClient());
const channels = [];

try {
  console.log(`Connecting ${CLIENT_COUNT} concurrent realtime clients to ${supabaseUrl} ...`);
  for (const client of clients) {
    channels.push(await subscribeAndCollect(client, latencies));
  }

  console.log(`Sending ${PINGS_PER_CLIENT} pings per client ...`);
  for (let i = 0; i < PINGS_PER_CLIENT; i++) {
    for (const channel of channels) {
      await channel.send({
        type: "broadcast",
        event: "ping",
        payload: { sentAt: Date.now() },
      });
    }
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
  for (const channel of channels) {
    await channel.unsubscribe();
  }
}

process.exit(process.exitCode ?? 0);
