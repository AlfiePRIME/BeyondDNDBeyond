import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@/data-access";
import { AVATAR_PRESETS } from "@/app/account/avatar-presets";
import { resolveAvatarUrl } from "./avatar-url";

/**
 * Stubs both the avatars storage bucket (signed URL) and the
 * model_orientation table (forward-direction offset) resolveAvatarUrl
 * reads. `orientationResult` defaults to `null` (no stored row — the
 * getForwardOffsetDeg().maybeSingle() "not found" shape), matching every
 * avatar predating this feature.
 */
function stubClient(
  storageResult: { signedUrl: string } | Error,
  orientationResult: { forward_offset_deg: number } | null | Error = null
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
          eq: () => ({
            maybeSingle: async () =>
              orientationResult instanceof Error
                ? { data: null, error: orientationResult }
                : { data: orientationResult, error: null },
          }),
        }),
      };
    },
  } as unknown as SupabaseClient;
}

describe("resolveAvatarUrl", () => {
  it("resolves a preset to its static manifest file with no stored offset (default 0)", async () => {
    const preset = AVATAR_PRESETS[0];
    await expect(resolveAvatarUrl(stubClient(new Error("unused")), "preset", preset.id)).resolves.toEqual({
      url: preset.file,
      forwardOffsetDeg: 0,
    });
  });

  it("threads a preset's stored forward-direction offset through", async () => {
    const preset = AVATAR_PRESETS[0];
    const supabase = stubClient(new Error("unused"), { forward_offset_deg: 90 });
    await expect(resolveAvatarUrl(supabase, "preset", preset.id)).resolves.toEqual({
      url: preset.file,
      forwardOffsetDeg: 90,
    });
  });

  it("resolves an unknown preset id to no avatar instead of throwing", async () => {
    await expect(resolveAvatarUrl(stubClient(new Error("unused")), "preset", "nope")).resolves.toEqual({
      url: null,
      forwardOffsetDeg: 0,
    });
  });

  it("resolves a custom avatar to a signed storage URL with no stored offset (default 0)", async () => {
    const supabase = stubClient({ signedUrl: "http://localhost:8000/signed/avatar.glb?token=abc" });
    await expect(resolveAvatarUrl(supabase, "custom", "user-1/avatar.glb")).resolves.toEqual({
      url: "http://localhost:8000/signed/avatar.glb?token=abc",
      forwardOffsetDeg: 0,
    });
  });

  it("threads a custom avatar's stored forward-direction offset through", async () => {
    const supabase = stubClient(
      { signedUrl: "http://localhost:8000/signed/avatar.glb?token=abc" },
      { forward_offset_deg: 45 }
    );
    await expect(resolveAvatarUrl(supabase, "custom", "user-1/avatar.glb")).resolves.toEqual({
      url: "http://localhost:8000/signed/avatar.glb?token=abc",
      forwardOffsetDeg: 45,
    });
  });

  it("degrades a failed signing to no avatar instead of throwing", async () => {
    await expect(
      resolveAvatarUrl(stubClient(new Error("boom")), "custom", "user-1/avatar.glb")
    ).resolves.toEqual({ url: null, forwardOffsetDeg: 0 });
  });

  it("degrades a failed offset lookup to 0 instead of throwing (the avatar itself still resolves)", async () => {
    const supabase = stubClient(
      { signedUrl: "http://localhost:8000/signed/avatar.glb?token=abc" },
      new Error("boom")
    );
    await expect(resolveAvatarUrl(supabase, "custom", "user-1/avatar.glb")).resolves.toEqual({
      url: "http://localhost:8000/signed/avatar.glb?token=abc",
      forwardOffsetDeg: 0,
    });
  });

  it("resolves no selection to no avatar (scene renders the placeholder)", async () => {
    await expect(resolveAvatarUrl(stubClient(new Error("unused")), null, null)).resolves.toEqual({
      url: null,
      forwardOffsetDeg: 0,
    });
  });
});
