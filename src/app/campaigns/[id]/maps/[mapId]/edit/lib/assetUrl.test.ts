import { describe, expect, it } from "vitest";
import type { MapAsset, SupabaseClient } from "@/data-access";
import { resolvePaletteAssets } from "./assetUrl";

/**
 * Stubs both the map-assets storage bucket (signed URL) and model_orientation
 * — TWO INDEPENDENT queries against that same table (getForwardOffsetsForUrls,
 * getStandableSurfaceHeightsForUrls — see resolvePaletteAssets' own doc
 * comment for why they're deliberately separate, not one combined read),
 * distinguished here by which columns each one's own `.select(...)` call
 * names, so either can be made to fail independently of the other —
 * `offsetError`/`standableError` are separate knobs for exactly that.
 * `rows` defaults to `[]` (no stored rows), matching every asset predating
 * both features.
 */
function stubClient(
  storageResult: { signedUrl: string } | Error,
  options: {
    rows?: { model_url: string; forward_offset_deg: number; standable_surface_height: number | null }[];
    offsetError?: Error;
    standableError?: Error;
  } = {}
): SupabaseClient {
  const { rows = [], offsetError, standableError } = options;
  return {
    storage: {
      from: () => ({
        createSignedUrl: async () =>
          storageResult instanceof Error
            ? { data: null, error: storageResult }
            : { data: storageResult, error: null },
      }),
    },
    from: (table: string) => {
      if (table !== "model_orientation") throw new Error(`unexpected table in stub: ${table}`);
      return {
        select: (columns: string) => ({
          in: async () => {
            if (columns.includes("standable_surface_height")) {
              if (standableError) return { data: null, error: standableError };
              return {
                data: rows.map(({ model_url, standable_surface_height }) => ({ model_url, standable_surface_height })),
                error: null,
              };
            }
            if (offsetError) return { data: null, error: offsetError };
            return {
              data: rows.map(({ model_url, forward_offset_deg }) => ({ model_url, forward_offset_deg })),
              error: null,
            };
          },
        }),
      };
    },
  } as unknown as SupabaseClient;
}

function preset(modelRef: string): MapAsset {
  return {
    id: `preset-${modelRef}`,
    name: "Torch",
    source_type: "preset",
    model_ref: modelRef,
    campaign_id: null,
    created_at: "",
  };
}

function custom(modelRef: string): MapAsset {
  return {
    id: `custom-${modelRef}`,
    name: "Crate",
    source_type: "custom",
    model_ref: modelRef,
    campaign_id: "campaign-1",
    created_at: "",
  };
}

describe("resolvePaletteAssets", () => {
  it("resolves a preset's url straight from model_ref with no stored offset (default 0) or standable height (null)", async () => {
    const [resolved] = await resolvePaletteAssets(stubClient(new Error("unused")), [
      preset("/assets/presets/torch.glb"),
    ]);
    expect(resolved.url).toBe("/assets/presets/torch.glb");
    expect(resolved.forwardOffsetDeg).toBe(0);
    expect(resolved.standSurfaceHeight).toBeNull();
  });

  it("threads a preset's stored forward-direction offset through, keyed by model_ref", async () => {
    const supabase = stubClient(new Error("unused"), {
      rows: [{ model_url: "/assets/presets/torch.glb", forward_offset_deg: 90, standable_surface_height: null }],
    });
    const [resolved] = await resolvePaletteAssets(supabase, [preset("/assets/presets/torch.glb")]);
    expect(resolved.forwardOffsetDeg).toBe(90);
    expect(resolved.standSurfaceHeight).toBeNull();
  });

  it("threads a preset's stored, measured standable surface height through, keyed by model_ref", async () => {
    const supabase = stubClient(new Error("unused"), {
      rows: [{ model_url: "/assets/presets/torch.glb", forward_offset_deg: 0, standable_surface_height: 0.31 }],
    });
    const [resolved] = await resolvePaletteAssets(supabase, [preset("/assets/presets/torch.glb")]);
    expect(resolved.standSurfaceHeight).toBe(0.31);
  });

  it("resolves a custom asset to a signed storage URL with no stored offset (default 0) or standable height (null)", async () => {
    const supabase = stubClient({ signedUrl: "http://localhost:8000/signed/crate.glb?token=abc" });
    const [resolved] = await resolvePaletteAssets(supabase, [custom("campaign-1/crate.glb")]);
    expect(resolved.url).toBe("http://localhost:8000/signed/crate.glb?token=abc");
    expect(resolved.forwardOffsetDeg).toBe(0);
    expect(resolved.standSurfaceHeight).toBeNull();
  });

  it("threads a custom asset's stored offset AND standable height through, keyed by model_ref (not the ephemeral signed url)", async () => {
    const supabase = stubClient(
      { signedUrl: "http://localhost:8000/signed/crate.glb?token=abc" },
      { rows: [{ model_url: "campaign-1/crate.glb", forward_offset_deg: 45, standable_surface_height: 0.18 }] }
    );
    const [resolved] = await resolvePaletteAssets(supabase, [custom("campaign-1/crate.glb")]);
    expect(resolved.url).toBe("http://localhost:8000/signed/crate.glb?token=abc");
    expect(resolved.forwardOffsetDeg).toBe(45);
    expect(resolved.standSurfaceHeight).toBe(0.18);
  });

  it("degrades a failed signing to a null url, but still carries the resolved offset and standable height", async () => {
    const supabase = stubClient(new Error("boom"), {
      rows: [{ model_url: "campaign-1/crate.glb", forward_offset_deg: 45, standable_surface_height: 0.18 }],
    });
    const [resolved] = await resolvePaletteAssets(supabase, [custom("campaign-1/crate.glb")]);
    expect(resolved.url).toBeNull();
    expect(resolved.forwardOffsetDeg).toBe(45);
    expect(resolved.standSurfaceHeight).toBe(0.18);
  });

  it("degrades a failed batched offset lookup to 0 for every asset instead of throwing", async () => {
    const supabase = stubClient(
      { signedUrl: "http://localhost:8000/signed/crate.glb?token=abc" },
      { offsetError: new Error("boom") }
    );
    const [resolvedPreset, resolvedCustom] = await resolvePaletteAssets(supabase, [
      preset("/assets/presets/torch.glb"),
      custom("campaign-1/crate.glb"),
    ]);
    expect(resolvedPreset.forwardOffsetDeg).toBe(0);
    expect(resolvedCustom.forwardOffsetDeg).toBe(0);
    expect(resolvedCustom.url).toBe("http://localhost:8000/signed/crate.glb?token=abc");
  });

  it("degrades a failed batched standable-height lookup to null for every asset instead of throwing", async () => {
    const supabase = stubClient(
      { signedUrl: "http://localhost:8000/signed/crate.glb?token=abc" },
      { standableError: new Error("column does not exist yet") }
    );
    const [resolvedPreset, resolvedCustom] = await resolvePaletteAssets(supabase, [
      preset("/assets/presets/torch.glb"),
      custom("campaign-1/crate.glb"),
    ]);
    expect(resolvedPreset.standSurfaceHeight).toBeNull();
    expect(resolvedCustom.standSurfaceHeight).toBeNull();
  });

  it("REGRESSION GUARD: a failed standable-height lookup (e.g. a pending, not-yet-applied migration) never blanks out the completely unrelated, already-working forward-offset lookup — the two queries are truly independent, not one combined read", async () => {
    const supabase = stubClient(
      { signedUrl: "http://localhost:8000/signed/crate.glb?token=abc" },
      {
        rows: [{ model_url: "/assets/presets/torch.glb", forward_offset_deg: 90, standable_surface_height: 0.5 }],
        standableError: new Error("column does not exist yet"),
      }
    );
    const [resolved] = await resolvePaletteAssets(supabase, [preset("/assets/presets/torch.glb")]);
    expect(resolved.forwardOffsetDeg).toBe(90);
    expect(resolved.standSurfaceHeight).toBeNull();
  });

  it("resolves an empty asset list to an empty list without querying orientation at all", async () => {
    await expect(resolvePaletteAssets(stubClient(new Error("unused")), [])).resolves.toEqual([]);
  });
});
