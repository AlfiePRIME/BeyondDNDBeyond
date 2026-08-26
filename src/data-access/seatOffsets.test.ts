import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSeatOffset, getSeatOffsetsForCampaign, setSeatOffset } from "./seatOffsets";

/** Minimal stub covering exactly the query shapes seatOffsets.ts issues
 * against campaign_members — not a general-purpose Supabase mock, the same
 * scope as modelOrientation.test.ts's own stubClient. */
function stubClient(options: {
  maybeSingleResult?: { data: { seat_offset: unknown } | null; error: Error | null };
  notResult?: { data: { user_id: string; seat_offset: unknown }[] | null; error: Error | null };
  onNot?: (column: string, op: string, value: unknown) => void;
  onUpdate?: (row: unknown) => void;
  updateError?: Error;
  updateCount?: number | null;
}): SupabaseClient {
  return {
    from: (table: string) => {
      if (table !== "campaign_members") throw new Error(`unexpected table in stub: ${table}`);
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => options.maybeSingleResult ?? { data: null, error: null },
            }),
            not: (column: string, op: string, value: unknown) => {
              options.onNot?.(column, op, value);
              return options.notResult ?? { data: [], error: null };
            },
          }),
        }),
        update: (row: unknown) => {
          options.onUpdate?.(row);
          return {
            eq: () => ({
              eq: async () => ({
                error: options.updateError ?? null,
                count: options.updateCount ?? 1,
              }),
            }),
          };
        },
      };
    },
  } as unknown as SupabaseClient;
}

describe("getSeatOffset", () => {
  it("returns null when the member has never stored an override", async () => {
    const supabase = stubClient({ maybeSingleResult: { data: { seat_offset: null }, error: null } });
    await expect(getSeatOffset(supabase, "campaign-1", "user-1")).resolves.toBeNull();
  });

  it("returns null when the row itself doesn't come back (no data)", async () => {
    const supabase = stubClient({ maybeSingleResult: { data: null, error: null } });
    await expect(getSeatOffset(supabase, "campaign-1", "user-1")).resolves.toBeNull();
  });

  it("returns the stored offset when one exists", async () => {
    const offset = { dx: 0.5, dz: -0.25, dRotationY: 0.1 };
    const supabase = stubClient({ maybeSingleResult: { data: { seat_offset: offset }, error: null } });
    await expect(getSeatOffset(supabase, "campaign-1", "user-1")).resolves.toEqual(offset);
  });

  it("propagates a real query error rather than silently defaulting", async () => {
    const supabase = stubClient({ maybeSingleResult: { data: null, error: new Error("db down") } });
    await expect(getSeatOffset(supabase, "campaign-1", "user-1")).rejects.toThrow("db down");
  });
});

describe("getSeatOffsetsForCampaign", () => {
  it("builds a user_id-to-offset map from the returned rows", async () => {
    const supabase = stubClient({
      notResult: {
        data: [
          { user_id: "user-1", seat_offset: { dx: 1, dz: 0, dRotationY: 0 } },
          { user_id: "user-2", seat_offset: { dx: -1, dz: 2, dRotationY: 0.4 } },
        ],
        error: null,
      },
    });
    const result = await getSeatOffsetsForCampaign(supabase, "campaign-1");
    expect(result).toEqual(
      new Map([
        ["user-1", { dx: 1, dz: 0, dRotationY: 0 }],
        ["user-2", { dx: -1, dz: 2, dRotationY: 0.4 }],
      ])
    );
  });

  it("excludes members with no stored override via the not-null filter", async () => {
    let filtered: { column: string; op: string; value: unknown } | null = null;
    const supabase = stubClient({
      onNot: (column, op, value) => (filtered = { column, op, value }),
      notResult: { data: [], error: null },
    });
    await getSeatOffsetsForCampaign(supabase, "campaign-1");
    expect(filtered).toEqual({ column: "seat_offset", op: "is", value: null });
  });

  it("returns an empty map when nobody has moved their chair", async () => {
    const supabase = stubClient({ notResult: { data: [], error: null } });
    await expect(getSeatOffsetsForCampaign(supabase, "campaign-1")).resolves.toEqual(new Map());
  });

  it("propagates a real query error", async () => {
    const supabase = stubClient({ notResult: { data: null, error: new Error("db down") } });
    await expect(getSeatOffsetsForCampaign(supabase, "campaign-1")).rejects.toThrow("db down");
  });
});

describe("setSeatOffset", () => {
  it("updates the caller's own row with the given offset", async () => {
    let updated: unknown = null;
    const supabase = stubClient({ onUpdate: (row) => (updated = row), updateCount: 1 });
    const offset = { dx: 0.3, dz: 0.1, dRotationY: -0.2 };
    await setSeatOffset(supabase, "campaign-1", "user-1", offset);
    expect(updated).toMatchObject({ seat_offset: offset });
  });

  it("can clear a stored offset back to the default by passing null", async () => {
    let updated: unknown = null;
    const supabase = stubClient({ onUpdate: (row) => (updated = row), updateCount: 1 });
    await setSeatOffset(supabase, "campaign-1", "user-1", null);
    expect(updated).toMatchObject({ seat_offset: null });
  });

  it("throws when zero rows are affected (no such membership, or RLS blocked someone else's row)", async () => {
    const supabase = stubClient({ updateCount: 0 });
    await expect(
      setSeatOffset(supabase, "campaign-1", "not-a-member", { dx: 0, dz: 0, dRotationY: 0 })
    ).rejects.toThrow(/not be a member/);
  });

  it("propagates a real write error", async () => {
    const supabase = stubClient({ updateError: new Error("db down") });
    await expect(
      setSeatOffset(supabase, "campaign-1", "user-1", { dx: 0, dz: 0, dRotationY: 0 })
    ).rejects.toThrow("db down");
  });
});
