import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  getDiceTrayPreference,
  getDiceTrayPreferencesForCampaign,
  setDiceTrayPreference,
  DEFAULT_DICE_TRAY_PREFERENCE,
} from "./diceTrayPreference";

/** Minimal stub covering exactly the query shapes diceTrayPreference.ts
 * issues against campaign_members — not a general-purpose Supabase mock,
 * the same scope as seatOffsets.test.ts's own stubClient. */
function stubClient(options: {
  maybeSingleResult?: {
    data: { dice_tray_source: unknown; dice_tray_asset_id: unknown } | null;
    error: Error | null;
  };
  notResult?: {
    data: { user_id: string; dice_tray_source: unknown; dice_tray_asset_id: unknown }[] | null;
    error: Error | null;
  };
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

describe("getDiceTrayPreference", () => {
  it("returns the default (procedural tray) when the member has never chosen one", async () => {
    const supabase = stubClient({
      maybeSingleResult: { data: { dice_tray_source: null, dice_tray_asset_id: null }, error: null },
    });
    await expect(getDiceTrayPreference(supabase, "campaign-1", "user-1")).resolves.toEqual(
      DEFAULT_DICE_TRAY_PREFERENCE
    );
  });

  it("returns the default when the row itself doesn't come back (no data)", async () => {
    const supabase = stubClient({ maybeSingleResult: { data: null, error: null } });
    await expect(getDiceTrayPreference(supabase, "campaign-1", "user-1")).resolves.toEqual(
      DEFAULT_DICE_TRAY_PREFERENCE
    );
  });

  it("returns the stored custom preference when one exists", async () => {
    const supabase = stubClient({
      maybeSingleResult: {
        data: { dice_tray_source: "custom", dice_tray_asset_id: "asset-1" },
        error: null,
      },
    });
    await expect(getDiceTrayPreference(supabase, "campaign-1", "user-1")).resolves.toEqual({
      source: "custom",
      assetId: "asset-1",
    });
  });

  it("propagates a real query error rather than silently defaulting", async () => {
    const supabase = stubClient({ maybeSingleResult: { data: null, error: new Error("db down") } });
    await expect(getDiceTrayPreference(supabase, "campaign-1", "user-1")).rejects.toThrow("db down");
  });
});

describe("getDiceTrayPreferencesForCampaign", () => {
  it("builds a user_id-to-preference map from the returned rows", async () => {
    const supabase = stubClient({
      notResult: {
        data: [
          { user_id: "user-1", dice_tray_source: "custom", dice_tray_asset_id: "asset-1" },
          { user_id: "user-2", dice_tray_source: "custom", dice_tray_asset_id: "asset-2" },
        ],
        error: null,
      },
    });
    const result = await getDiceTrayPreferencesForCampaign(supabase, "campaign-1");
    expect(result).toEqual(
      new Map([
        ["user-1", { source: "custom", assetId: "asset-1" }],
        ["user-2", { source: "custom", assetId: "asset-2" }],
      ])
    );
  });

  it("excludes members with no stored preference via the not-null filter", async () => {
    let filtered: { column: string; op: string; value: unknown } | null = null;
    const supabase = stubClient({
      onNot: (column, op, value) => (filtered = { column, op, value }),
      notResult: { data: [], error: null },
    });
    await getDiceTrayPreferencesForCampaign(supabase, "campaign-1");
    expect(filtered).toEqual({ column: "dice_tray_source", op: "is", value: null });
  });

  it("returns an empty map when nobody has chosen a tray model", async () => {
    const supabase = stubClient({ notResult: { data: [], error: null } });
    await expect(getDiceTrayPreferencesForCampaign(supabase, "campaign-1")).resolves.toEqual(new Map());
  });

  it("propagates a real query error", async () => {
    const supabase = stubClient({ notResult: { data: null, error: new Error("db down") } });
    await expect(getDiceTrayPreferencesForCampaign(supabase, "campaign-1")).rejects.toThrow("db down");
  });
});

describe("setDiceTrayPreference", () => {
  it("updates the caller's own row with the given custom preference", async () => {
    let updated: unknown = null;
    const supabase = stubClient({ onUpdate: (row) => (updated = row), updateCount: 1 });
    await setDiceTrayPreference(supabase, "campaign-1", "user-1", {
      source: "custom",
      assetId: "asset-1",
    });
    expect(updated).toMatchObject({ dice_tray_source: "custom", dice_tray_asset_id: "asset-1" });
  });

  it("can clear a stored preference back to the default by passing null (writes NULL/NULL, not the literal 'default')", async () => {
    let updated: unknown = null;
    const supabase = stubClient({ onUpdate: (row) => (updated = row), updateCount: 1 });
    await setDiceTrayPreference(supabase, "campaign-1", "user-1", null);
    expect(updated).toMatchObject({ dice_tray_source: null, dice_tray_asset_id: null });
  });

  it("also writes NULL/NULL for an explicit { source: 'default' } preference", async () => {
    let updated: unknown = null;
    const supabase = stubClient({ onUpdate: (row) => (updated = row), updateCount: 1 });
    await setDiceTrayPreference(supabase, "campaign-1", "user-1", { source: "default", assetId: null });
    expect(updated).toMatchObject({ dice_tray_source: null, dice_tray_asset_id: null });
  });

  it("rejects a 'custom' preference with no assetId before ever reaching the database", async () => {
    const supabase = stubClient({ updateCount: 1 });
    await expect(
      setDiceTrayPreference(supabase, "campaign-1", "user-1", { source: "custom", assetId: null })
    ).rejects.toThrow(/must include an assetId/);
  });

  it("rejects a 'default' preference that still carries an assetId", async () => {
    const supabase = stubClient({ updateCount: 1 });
    await expect(
      setDiceTrayPreference(supabase, "campaign-1", "user-1", { source: "default", assetId: "asset-1" })
    ).rejects.toThrow(/must not include an assetId/);
  });

  it("throws when zero rows are affected (no such membership, or RLS blocked someone else's row)", async () => {
    const supabase = stubClient({ updateCount: 0 });
    await expect(
      setDiceTrayPreference(supabase, "campaign-1", "not-a-member", { source: "custom", assetId: "asset-1" })
    ).rejects.toThrow(/not be a member/);
  });

  it("propagates a real write error", async () => {
    const supabase = stubClient({ updateError: new Error("db down") });
    await expect(setDiceTrayPreference(supabase, "campaign-1", "user-1", null)).rejects.toThrow("db down");
  });
});
