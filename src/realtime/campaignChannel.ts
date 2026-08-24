import type { SupabaseClient } from "@/data-access";

export interface CampaignChannelIdentity {
  userId: string;
  displayName?: string | null;
}

export interface CampaignPresenceMember {
  userId: string;
  displayName: string | null;
}

/**
 * `connecting` — the initial join hasn't reached SUBSCRIBED yet (nothing to resync from, so no
 * "reconnecting" indicator or `onReconnect` firing applies here).
 * `connected` — subscribed and current.
 * `reconnecting` — was connected, the underlying socket/channel dropped, and it's mid-retry.
 */
export type CampaignConnectionState = "connecting" | "connected" | "reconnecting";

export interface CampaignChannel {
  /** Broadcasts `payload` under `event` to every other subscriber of this campaign's channel. */
  publish<T>(event: string, payload: T): Promise<void>;
  /** Registers `handler` for `event` on this channel; call the returned function to stop listening. */
  subscribe<T>(event: string, handler: (payload: T) => void): () => void;
  /** Registers `handler` for presence changes — called immediately with the current snapshot, then again on every join/leave. */
  onPresenceChange(handler: (members: CampaignPresenceMember[]) => void): () => void;
  getPresentMembers(): CampaignPresenceMember[];
  /**
   * Registers `handler` to run after this channel recovers from an unexpected connection drop —
   * NOT after the initial join, since a fresh caller has no prior state to resync. Presence
   * resyncs itself automatically (re-tracked, snapshot re-received) and needs no handler here;
   * this is for feature modules with their own authoritative state (map, tokens, combat, HP, ...)
   * that need to refetch after reconnecting. Returns an unsubscribe function.
   */
  onReconnect(handler: () => void | Promise<void>): () => void;
  getConnectionState(): CampaignConnectionState;
  /** Registers `handler` for connection-state changes — called immediately with the current state, then again on every change. */
  onConnectionStateChange(handler: (state: CampaignConnectionState) => void): () => void;
  /** Leaves the channel and releases its socket subscription — call on unmount. */
  leave(): Promise<void>;
}

type RealtimeChannelHandle = ReturnType<SupabaseClient["channel"]>;
type PresenceTrackPayload = { display_name: string | null };

// realtime-js dedups by topic per client (supabase.channel(topic) hands back
// the SAME channel object if one for that topic already exists on this
// client) and refuses to add presence listeners to an already-joined
// channel. A caller that leaves and immediately rejoins the same campaign
// — React StrictMode's double-effect in dev, or a fast unmount/remount in
// prod — would otherwise race: leave()'s untrack()/removeChannel() are
// still in flight when the new join's supabase.channel() call hands back
// that same not-yet-removed channel. Serializing join-after-leave per topic
// here closes that race for every caller, not just one.
const pendingLeaves = new Map<string, Promise<void>>();

/**
 * Joins the single Realtime channel for one campaign — presence plus a
 * typed broadcast pub/sub — scoped by campaignId so concurrent campaigns
 * never cross-talk. Every live-synced feature (map state, tokens,
 * initiative, dice rolls, the activity log, ...) should call this rather
 * than opening its own raw supabase.channel(...).
 */
export function joinCampaignChannel(
  supabase: SupabaseClient,
  campaignId: string,
  identity: CampaignChannelIdentity
): CampaignChannel {
  const topic = `campaign:${campaignId}`;
  const priorLeave = pendingLeaves.get(topic) ?? Promise.resolve();

  const eventHandlers = new Map<string, Set<(payload: unknown) => void>>();
  const presenceHandlers = new Set<(members: CampaignPresenceMember[]) => void>();
  const reconnectHandlers = new Set<() => void | Promise<void>>();
  const connectionStateHandlers = new Set<(state: CampaignConnectionState) => void>();
  const onChannelReady: Array<(channel: RealtimeChannelHandle) => void> = [];
  let channelRef: RealtimeChannelHandle | null = null;

  // Reached SUBSCRIBED at least once — distinguishes "still doing the initial join" (any
  // CHANNEL_ERROR/TIMED_OUT here is just part of connecting, not a drop) from "was connected and
  // dropped" (same statuses now mean reconnecting). onReconnect only fires for the latter.
  let hasConnectedOnce = false;
  let connectionState: CampaignConnectionState = "connecting";

  function setConnectionState(next: CampaignConnectionState): void {
    if (connectionState === next) return;
    connectionState = next;
    for (const handler of connectionStateHandlers) handler(connectionState);
  }

  function withChannel(fn: (channel: RealtimeChannelHandle) => void): void {
    if (channelRef) fn(channelRef);
    else onChannelReady.push(fn);
  }

  function getPresentMembers(): CampaignPresenceMember[] {
    if (!channelRef) return [];
    const state = channelRef.presenceState<PresenceTrackPayload>();
    return Object.entries(state).map(([userId, presences]) => ({
      userId,
      displayName: presences[0]?.display_name ?? null,
    }));
  }

  // publish() awaits this so a caller can send right after joinCampaignChannel()
  // without separately tracking subscribe status itself.
  let markReady: () => void;
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });

  priorLeave.catch(() => undefined).then(() => {
    const channel = supabase.channel(topic, { config: { presence: { key: identity.userId } } });
    channelRef = channel;

    channel.on("presence", { event: "sync" }, () => {
      const members = getPresentMembers();
      for (const handler of presenceHandlers) handler(members);
    });

    for (const fn of onChannelReady.splice(0)) fn(channel);

    // realtime-js/Phoenix already reconnects the socket with backoff and rejoins this same
    // channel object automatically once it reopens — resending the original join push replays
    // this very callback with SUBSCRIBED again, and channel.on() bindings registered above
    // (broadcast, presence sync) survive the drop since the channel is never torn down, only
    // this callback's SUBSCRIBED/CHANNEL_ERROR/TIMED_OUT statuses need watching here to know
    // which state we're in and to re-track presence (which SUBSCRIBED already does below).
    channel.subscribe(async (status) => {
      if (status === "SUBSCRIBED") {
        await channel.track({ display_name: identity.displayName ?? null } satisfies PresenceTrackPayload);
        const isRecovery = hasConnectedOnce && connectionState === "reconnecting";
        hasConnectedOnce = true;
        setConnectionState("connected");
        markReady();
        if (isRecovery) {
          for (const handler of reconnectHandlers) {
            Promise.resolve()
              .then(() => handler())
              .catch((error: unknown) => {
                console.error("[realtime] onReconnect handler threw", error);
              });
          }
        }
      } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        if (hasConnectedOnce) setConnectionState("reconnecting");
      }
    });
  });

  return {
    async publish<T>(event: string, payload: T): Promise<void> {
      await ready;
      await channelRef!.send({ type: "broadcast", event, payload });
    },
    subscribe<T>(event: string, handler: (payload: T) => void): () => void {
      let handlers = eventHandlers.get(event);
      if (!handlers) {
        handlers = new Set();
        eventHandlers.set(event, handlers);
        // One real channel binding per event name, fanned out to every
        // subscriber — RealtimeChannel has no public API to remove a single
        // binding, so unsubscribe below just drops the handler locally.
        withChannel((channel) => {
          channel.on("broadcast", { event }, (message) => {
            for (const h of eventHandlers.get(event) ?? []) h(message.payload);
          });
        });
      }
      handlers.add(handler as (payload: unknown) => void);
      return () => {
        eventHandlers.get(event)?.delete(handler as (payload: unknown) => void);
      };
    },
    onPresenceChange(handler: (members: CampaignPresenceMember[]) => void): () => void {
      presenceHandlers.add(handler);
      handler(getPresentMembers());
      return () => {
        presenceHandlers.delete(handler);
      };
    },
    getPresentMembers,
    onReconnect(handler: () => void | Promise<void>): () => void {
      reconnectHandlers.add(handler);
      return () => {
        reconnectHandlers.delete(handler);
      };
    },
    getConnectionState(): CampaignConnectionState {
      return connectionState;
    },
    onConnectionStateChange(handler: (state: CampaignConnectionState) => void): () => void {
      connectionStateHandlers.add(handler);
      handler(connectionState);
      return () => {
        connectionStateHandlers.delete(handler);
      };
    },
    async leave(): Promise<void> {
      presenceHandlers.clear();
      eventHandlers.clear();
      reconnectHandlers.clear();
      connectionStateHandlers.clear();
      const donePromise = (async () => {
        if (!channelRef) {
          await new Promise<void>((resolve) => onChannelReady.push(() => resolve()));
        }
        await channelRef!.untrack();
        await supabase.removeChannel(channelRef!);
      })();
      pendingLeaves.set(topic, donePromise.catch(() => undefined));
      try {
        await donePromise;
      } finally {
        pendingLeaves.delete(topic);
      }
    },
  };
}
