import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  getForwardOffsetDeg,
  getForwardOffsetsForUrls,
  getStandableSurfaceHeightsForUrls,
  setForwardOffsetDeg,
  setStandableSurfaceHeight,
} from "./modelOrientation";

/** Minimal stub covering exactly the query shapes modelOrientation.ts
 * issues against the model_orientation table — not a general-purpose
 * Supabase mock. */
function stubClient(options: {
  maybeSingleResult?: { data: { forward_offset_deg: number } | null; error: Error | null };
  inResult?: {
    data:
      | { model_url: string; forward_offset_deg: number; standable_surface_height?: number | null }[]
      | null;
    error: Error | null;
  };
  onIn?: (urls: readonly string[]) => void;
  onUpsert?: (row: unknown) => void;
  upsertError?: Error;
}): SupabaseClient {
  return {
    from: (table: string) => {
      if (table !== "model_orientation") throw new Error(`unexpected table in stub: ${table}`);
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => options.maybeSingleResult ?? { data: null, error: null },
          }),
          in: async (_column: string, urls: readonly string[]) => {
            options.onIn?.(urls);
            return options.inResult ?? { data: [], error: null };
          },
        }),
        upsert: async (row: unknown) => {
          options.onUpsert?.(row);
          return { error: options.upsertError ?? null };
        },
      };
    },
  } as unknown as SupabaseClient;
}

describe("getForwardOffsetDeg", () => {
  it("defaults to 0 when no row exists for the model url", async () => {
    const supabase = stubClient({ maybeSingleResult: { data: null, error: null } });
    await expect(getForwardOffsetDeg(supabase, "/assets/presets/torch.glb")).resolves.toBe(0);
  });

  it("returns the stored offset when a row exists", async () => {
    const supabase = stubClient({ maybeSingleResult: { data: { forward_offset_deg: 135 }, error: null } });
    await expect(getForwardOffsetDeg(supabase, "campaign-1/crate.glb")).resolves.toBe(135);
  });

  it("propagates a real query error rather than silently defaulting", async () => {
    const supabase = stubClient({ maybeSingleResult: { data: null, error: new Error("db down") } });
    await expect(getForwardOffsetDeg(supabase, "campaign-1/crate.glb")).rejects.toThrow("db down");
  });
});

describe("getForwardOffsetsForUrls", () => {
  it("returns an empty map for an empty input without querying at all", async () => {
    let queried = false;
    const supabase = stubClient({ onIn: () => (queried = true) });
    await expect(getForwardOffsetsForUrls(supabase, [])).resolves.toEqual(new Map());
    expect(queried).toBe(false);
  });

  it("dedupes duplicate urls before querying", async () => {
    let seenUrls: readonly string[] = [];
    const supabase = stubClient({ onIn: (urls) => (seenUrls = urls) });
    await getForwardOffsetsForUrls(supabase, ["a.glb", "a.glb", "b.glb"]);
    expect(seenUrls).toHaveLength(2);
    expect(new Set(seenUrls)).toEqual(new Set(["a.glb", "b.glb"]));
  });

  it("builds a url-to-offset map from the returned rows", async () => {
    const supabase = stubClient({
      inResult: {
        data: [
          { model_url: "a.glb", forward_offset_deg: 90 },
          { model_url: "b.glb", forward_offset_deg: 0 },
        ],
        error: null,
      },
    });
    await expect(getForwardOffsetsForUrls(supabase, ["a.glb", "b.glb", "c.glb"])).resolves.toEqual(
      new Map([
        ["a.glb", 90],
        ["b.glb", 0],
      ])
    );
  });

  it("propagates a real query error", async () => {
    const supabase = stubClient({ inResult: { data: null, error: new Error("db down") } });
    await expect(getForwardOffsetsForUrls(supabase, ["a.glb"])).rejects.toThrow("db down");
  });
});

describe("setForwardOffsetDeg", () => {
  it("upserts (not inserts) the model_url/forward_offset_deg row", async () => {
    let upserted: unknown = null;
    const supabase = stubClient({ onUpsert: (row) => (upserted = row) });
    await setForwardOffsetDeg(supabase, "user-1/avatar.glb", 180);
    expect(upserted).toMatchObject({ model_url: "user-1/avatar.glb", forward_offset_deg: 180 });
  });

  it("propagates a real write error", async () => {
    const supabase = stubClient({ upsertError: new Error("db down") });
    await expect(setForwardOffsetDeg(supabase, "user-1/avatar.glb", 180)).rejects.toThrow("db down");
  });
});

describe("getStandableSurfaceHeightsForUrls", () => {
  it("returns an empty map for an empty input without querying at all", async () => {
    let queried = false;
    const supabase = stubClient({ onIn: () => (queried = true) });
    await expect(getStandableSurfaceHeightsForUrls(supabase, [])).resolves.toEqual(new Map());
    expect(queried).toBe(false);
  });

  it("dedupes duplicate urls before querying", async () => {
    let seenUrls: readonly string[] = [];
    const supabase = stubClient({ onIn: (urls) => (seenUrls = urls) });
    await getStandableSurfaceHeightsForUrls(supabase, ["a.glb", "a.glb", "b.glb"]);
    expect(seenUrls).toHaveLength(2);
    expect(new Set(seenUrls)).toEqual(new Set(["a.glb", "b.glb"]));
  });

  it("builds a url-to-height map from the returned rows, omitting any row that hasn't been measured yet (null)", async () => {
    const supabase = stubClient({
      inResult: {
        data: [
          { model_url: "a.glb", forward_offset_deg: 90, standable_surface_height: 0.31 },
          { model_url: "b.glb", forward_offset_deg: 0, standable_surface_height: null },
        ],
        error: null,
      },
    });
    await expect(getStandableSurfaceHeightsForUrls(supabase, ["a.glb", "b.glb", "c.glb"])).resolves.toEqual(
      new Map([["a.glb", 0.31]])
    );
  });

  it("propagates a real query error", async () => {
    const supabase = stubClient({ inResult: { data: null, error: new Error("db down") } });
    await expect(getStandableSurfaceHeightsForUrls(supabase, ["a.glb"])).rejects.toThrow("db down");
  });
});

describe("setStandableSurfaceHeight", () => {
  it("upserts the model_url/standable_surface_height row without touching forward_offset_deg", async () => {
    let upserted: unknown = null;
    const supabase = stubClient({ onUpsert: (row) => (upserted = row) });
    await setStandableSurfaceHeight(supabase, "campaign-1/crate.glb", 0.27);
    expect(upserted).toMatchObject({ model_url: "campaign-1/crate.glb", standable_surface_height: 0.27 });
    expect(upserted).not.toHaveProperty("forward_offset_deg");
  });

  it("propagates a real write error", async () => {
    const supabase = stubClient({ upsertError: new Error("db down") });
    await expect(setStandableSurfaceHeight(supabase, "campaign-1/crate.glb", 0.27)).rejects.toThrow(
      "db down"
    );
  });
});
