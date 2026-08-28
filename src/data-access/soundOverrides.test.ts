import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSoundOverride, getSoundOverridePublicUrl, listSoundOverrides, setSoundOverride, deleteSoundOverride } from "./soundOverrides";

/** Minimal stub covering exactly the sound_overrides query shapes this
 * module issues — the appSettings.test.ts/profiles.test.ts stubClient
 * convention. */
function tableStubClient(options: {
  selectAllRows?: Array<Record<string, unknown>>;
  singleRow?: Record<string, unknown> | null;
  onUpsert?: (payload: Record<string, unknown>) => void;
  onDelete?: (soundKey: string) => void;
}): SupabaseClient {
  return {
    from: (table: string) => {
      if (table !== "sound_overrides") throw new Error(`unexpected table in stub: ${table}`);
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: options.singleRow ?? null, error: null }),
          }),
          // listSoundOverrides calls select() with no further chaining.
          then: (resolve: (result: { data: unknown; error: null }) => void) =>
            resolve({ data: options.selectAllRows ?? [], error: null }),
        }),
        upsert: (payload: Record<string, unknown>) => {
          options.onUpsert?.(payload);
          return {
            select: () => ({
              single: async () => ({ data: { ...payload }, error: null }),
            }),
          };
        },
        delete: () => ({
          eq: (_column: string, value: string) => {
            options.onDelete?.(value);
            return Promise.resolve({ error: null });
          },
        }),
      };
    },
  } as unknown as SupabaseClient;
}

describe("getSoundOverride", () => {
  it("returns null when no override row exists for this key (the 'use the baked default' case)", async () => {
    const client = tableStubClient({ singleRow: null });
    await expect(getSoundOverride(client, "dice_impact")).resolves.toBeNull();
  });

  it("returns the override row when one exists", async () => {
    const row = { sound_key: "dice_impact", storage_ref: "dice_impact/abc.mp3", updated_at: "2026-01-01T00:00:00Z" };
    const client = tableStubClient({ singleRow: row });
    await expect(getSoundOverride(client, "dice_impact")).resolves.toEqual(row);
  });
});

describe("listSoundOverrides", () => {
  it("returns an empty array when nothing has ever been overridden", async () => {
    const client = tableStubClient({ selectAllRows: [] });
    await expect(listSoundOverrides(client)).resolves.toEqual([]);
  });
});

describe("getSoundOverridePublicUrl", () => {
  it("builds a plain public URL via the storage client's own getPublicUrl (no network call, no auth)", () => {
    const getPublicUrl = vi.fn((path: string) => ({
      data: { publicUrl: `https://example.supabase.co/storage/v1/object/public/sound-overrides/${path}` },
    }));
    const client = {
      storage: {
        from: (bucket: string) => {
          expect(bucket).toBe("sound-overrides");
          return { getPublicUrl };
        },
      },
    } as unknown as SupabaseClient;

    const url = getSoundOverridePublicUrl(client, "dice_impact/abc.mp3");
    expect(url).toBe("https://example.supabase.co/storage/v1/object/public/sound-overrides/dice_impact/abc.mp3");
    expect(getPublicUrl).toHaveBeenCalledWith("dice_impact/abc.mp3");
  });
});

describe("setSoundOverride", () => {
  it("uploads to a fresh, uniquely-named path under the key's own folder and upserts the row keyed on sound_key", async () => {
    let uploadedPath = "";
    let uploadedOptions: Record<string, unknown> = {};
    let upsertPayload: Record<string, unknown> = {};
    let upsertOptions: Record<string, unknown> = {};
    const client = {
      storage: {
        from: (bucket: string) => {
          expect(bucket).toBe("sound-overrides");
          return {
            upload: async (path: string, _file: File, options: Record<string, unknown>) => {
              uploadedPath = path;
              uploadedOptions = options;
              return { data: { path }, error: null };
            },
          };
        },
      },
      from: (table: string) => {
        if (table !== "sound_overrides") throw new Error(`unexpected table in stub: ${table}`);
        return {
          upsert: (payload: Record<string, unknown>, options: Record<string, unknown>) => {
            upsertPayload = payload;
            upsertOptions = options;
            return {
              select: () => ({
                single: async () => ({ data: { ...payload }, error: null }),
              }),
            };
          },
        };
      },
    } as unknown as SupabaseClient;

    const file = new File([new Uint8Array([1, 2, 3])], "replacement.mp3", { type: "audio/mpeg" });
    const result = await setSoundOverride(client, "dice_impact", file);

    expect(uploadedPath).toMatch(/^dice_impact\/[0-9a-f-]{36}\.mp3$/);
    expect(uploadedOptions).toMatchObject({ contentType: "audio/mpeg", upsert: false });
    expect(upsertPayload.sound_key).toBe("dice_impact");
    expect(upsertPayload.storage_ref).toBe(uploadedPath);
    expect(typeof upsertPayload.updated_at).toBe("string");
    expect(upsertOptions).toEqual({ onConflict: "sound_key" });
    expect(result.sound_key).toBe("dice_impact");
  });

  it("throws when the storage upload itself fails (e.g. a non-admin rejected by RLS) without touching the table", async () => {
    let tableTouched = false;
    const client = {
      storage: {
        from: () => ({
          upload: async () => ({ data: null, error: new Error("new row violates row-level security policy") }),
        }),
      },
      from: () => {
        tableTouched = true;
        return {};
      },
    } as unknown as SupabaseClient;

    const file = new File([new Uint8Array([1])], "x.mp3", { type: "audio/mpeg" });
    await expect(setSoundOverride(client, "dice_impact", file)).rejects.toThrow();
    expect(tableTouched).toBe(false);
  });
});

describe("deleteSoundOverride", () => {
  it("deletes the row for exactly the given key", async () => {
    let deletedKey = "";
    const client = tableStubClient({ onDelete: (key) => (deletedKey = key) });
    await deleteSoundOverride(client, "rain_loop");
    expect(deletedKey).toBe("rain_loop");
  });
});
