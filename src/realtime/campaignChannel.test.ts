import { describe, expect, it, vi } from "vitest";
import { joinCampaignChannel } from "./campaignChannel";
import type { SupabaseClient } from "@/data-access";

// A minimal stand-in for the RealtimeChannel surface joinCampaignChannel() touches — just enough
// to drive the SUBSCRIBED/CHANNEL_ERROR/TIMED_OUT status callback that drop/recovery detection is
// built on, without a real Supabase client (this module never imports @supabase/supabase-js
// itself, so there's nothing real to construct here anyway).
class FakeRealtimeChannel {
  statusCallback: ((status: string) => void) | null = null;
  removed = false;

  on() {
    return this;
  }

  subscribe(callback: (status: string) => void) {
    this.statusCallback = callback;
    return this;
  }

  async track() {
    return "ok" as const;
  }

  async untrack() {
    return "ok" as const;
  }

  presenceState() {
    return {};
  }

  async send() {
    return "ok" as const;
  }

  emitStatus(status: string) {
    this.statusCallback?.(status);
  }
}

function createFakeSupabase() {
  const channels: FakeRealtimeChannel[] = [];
  const fakeSupabase = {
    channel: () => {
      const channel = new FakeRealtimeChannel();
      channels.push(channel);
      return channel;
    },
    removeChannel: async (channel: FakeRealtimeChannel) => {
      channel.removed = true;
      return "ok" as const;
    },
  };
  return { supabase: fakeSupabase as unknown as SupabaseClient, channels };
}

async function flushMicrotasks(times = 5) {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

describe("joinCampaignChannel reconnection", () => {
  it("fires onReconnect on recovery from a drop, not on the initial connect", async () => {
    const { supabase, channels } = createFakeSupabase();
    const channel = joinCampaignChannel(supabase, "campaign-1", { userId: "u1" });
    await flushMicrotasks();
    const fake = channels[0]!;

    // A handler unrelated to presence — stands in for a future feature module (map/tokens/combat)
    // refetching its own authoritative state after a reconnect.
    const refetchMapState = vi.fn();
    channel.onReconnect(refetchMapState);

    fake.emitStatus("SUBSCRIBED");
    await flushMicrotasks();
    expect(refetchMapState).not.toHaveBeenCalled();
    expect(channel.getConnectionState()).toBe("connected");

    fake.emitStatus("CHANNEL_ERROR");
    expect(channel.getConnectionState()).toBe("reconnecting");
    expect(refetchMapState).not.toHaveBeenCalled();

    fake.emitStatus("SUBSCRIBED");
    await flushMicrotasks();
    expect(refetchMapState).toHaveBeenCalledTimes(1);
    expect(channel.getConnectionState()).toBe("connected");

    await channel.leave();
  });

  it("stops firing onReconnect once unsubscribed", async () => {
    const { supabase, channels } = createFakeSupabase();
    const channel = joinCampaignChannel(supabase, "campaign-2", { userId: "u1" });
    await flushMicrotasks();
    const fake = channels[0]!;

    const handler = vi.fn();
    const unsubscribe = channel.onReconnect(handler);

    fake.emitStatus("SUBSCRIBED");
    await flushMicrotasks();
    unsubscribe();

    fake.emitStatus("TIMED_OUT");
    fake.emitStatus("SUBSCRIBED");
    await flushMicrotasks();

    expect(handler).not.toHaveBeenCalled();

    await channel.leave();
  });

  it("reports connecting, then connected, then reconnecting via onConnectionStateChange", async () => {
    const { supabase, channels } = createFakeSupabase();
    const channel = joinCampaignChannel(supabase, "campaign-3", { userId: "u1" });
    await flushMicrotasks();
    const fake = channels[0]!;

    const states: string[] = [];
    channel.onConnectionStateChange((state) => states.push(state));
    expect(states).toEqual(["connecting"]);

    fake.emitStatus("SUBSCRIBED");
    await flushMicrotasks();
    expect(states).toEqual(["connecting", "connected"]);

    fake.emitStatus("CHANNEL_ERROR");
    expect(states).toEqual(["connecting", "connected", "reconnecting"]);

    fake.emitStatus("SUBSCRIBED");
    await flushMicrotasks();
    expect(states).toEqual(["connecting", "connected", "reconnecting", "connected"]);

    await channel.leave();
  });
});
