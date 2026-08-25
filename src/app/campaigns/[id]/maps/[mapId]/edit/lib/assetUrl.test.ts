import { describe, expect, it } from "vitest";
import type { MapAsset, SupabaseClient } from "@/data-access";
import { resolvePaletteAssets } from "./assetUrl";

/**
 * Stubs both the map-assets storage bucket (signed URL) and the
 * model_orientation table (batched forward-direction offset lookup)
 * resolvePaletteAssets reads. `orientationRows` defaults to `[]` (no stored
 * rows), matching every asset predating this feature.
 */
function stubClient(
  storageResult: { signedUrl: string } | Error,
  orientationRows: { model_url: string; forward_offset_deg: number }[] | Error = []
): SupabaseClient {
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
        select: () => ({
          in: async () =>
            orientationRows instanceof Error
              ? { data: null, error: orientationRows }
              : { data: orientationRows, error: null },
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
  it("resolves a preset's url straight from model_ref with no stored offset (default 0)", async () => {
    const [resolved] = await resolvePaletteAssets(stubClient(new Error("unused")), [
      preset("/assets/presets/torch.glb"),
    ]);
    expect(resolved.url).toBe("/assets/presets/torch.glb");
    expect(resolved.forwardOffsetDeg).toBe(0);
  });

  it("threads a preset's stored forward-direction offset through, keyed by model_ref", async () => {
    const supabase = stubClient(new Error("unused"), [
      { model_url: "/assets/presets/torch.glb", forward_offset_deg: 90 },
    ]);
    const [resolved] = await resolvePaletteAssets(supabase, [preset("/assets/presets/torch.glb")]);
    expect(resolved.forwardOffsetDeg).toBe(90);
  });

  it("resolves a custom asset to a signed storage URL with no stored offset (default 0)", async () => {
    const supabase = stubClient({ signedUrl: "http://localhost:8000/signed/crate.glb?token=abc" });
    const [resolved] = await resolvePaletteAssets(supabase, [custom("campaign-1/crate.glb")]);
    expect(resolved.url).toBe("http://localhost:8000/signed/crate.glb?token=abc");
    expect(resolved.forwardOffsetDeg).toBe(0);
  });

  it("threads a custom asset's stored offset through, keyed by model_ref (not the ephemeral signed url)", async () => {
    const supabase = stubClient({ signedUrl: "http://localhost:8000/signed/crate.glb?token=abc" }, [
      { model_url: "campaign-1/crate.glb", forward_offset_deg: 45 },
    ]);
    const [resolved] = await resolvePaletteAssets(supabase, [custom("campaign-1/crate.glb")]);
    expect(resolved.url).toBe("http://localhost:8000/signed/crate.glb?token=abc");
    expect(resolved.forwardOffsetDeg).toBe(45);
  });

  it("degrades a failed signing to a null url, but still carries the resolved offset", async () => {
    const supabase = stubClient(new Error("boom"), [
      { model_url: "campaign-1/crate.glb", forward_offset_deg: 45 },
    ]);
    const [resolved] = await resolvePaletteAssets(supabase, [custom("campaign-1/crate.glb")]);
    expect(resolved.url).toBeNull();
    expect(resolved.forwardOffsetDeg).toBe(45);
  });

  it("degrades a failed batched offset lookup to 0 for every asset instead of throwing", async () => {
    const supabase = stubClient(
      { signedUrl: "http://localhost:8000/signed/crate.glb?token=abc" },
      new Error("boom")
    );
    const [resolvedPreset, resolvedCustom] = await resolvePaletteAssets(supabase, [
      preset("/assets/presets/torch.glb"),
      custom("campaign-1/crate.glb"),
    ]);
    expect(resolvedPreset.forwardOffsetDeg).toBe(0);
    expect(resolvedCustom.forwardOffsetDeg).toBe(0);
    expect(resolvedCustom.url).toBe("http://localhost:8000/signed/crate.glb?token=abc");
  });

  it("resolves an empty asset list to an empty list without querying orientation at all", async () => {
    await expect(resolvePaletteAssets(stubClient(new Error("unused")), [])).resolves.toEqual([]);
  });
});
