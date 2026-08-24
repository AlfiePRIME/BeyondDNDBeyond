import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@/data-access";
import { AVATAR_PRESETS } from "@/app/account/avatar-presets";
import { resolveAvatarUrl } from "./avatar-url";

function stubStorageClient(result: { signedUrl: string } | Error): SupabaseClient {
  return {
    storage: {
      from: () => ({
        createSignedUrl: async () =>
          result instanceof Error ? { data: null, error: result } : { data: result, error: null },
      }),
    },
  } as unknown as SupabaseClient;
}

describe("resolveAvatarUrl", () => {
  it("resolves a preset to its static manifest file", async () => {
    const preset = AVATAR_PRESETS[0];
    await expect(resolveAvatarUrl(stubStorageClient(new Error("unused")), "preset", preset.id)).resolves.toBe(
      preset.file
    );
  });

  it("resolves an unknown preset id to null instead of throwing", async () => {
    await expect(resolveAvatarUrl(stubStorageClient(new Error("unused")), "preset", "nope")).resolves.toBeNull();
  });

  it("resolves a custom avatar to a signed storage URL", async () => {
    const supabase = stubStorageClient({ signedUrl: "http://localhost:8000/signed/avatar.glb?token=abc" });
    await expect(resolveAvatarUrl(supabase, "custom", "user-1/avatar.glb")).resolves.toBe(
      "http://localhost:8000/signed/avatar.glb?token=abc"
    );
  });

  it("degrades a failed signing to null instead of throwing", async () => {
    await expect(
      resolveAvatarUrl(stubStorageClient(new Error("boom")), "custom", "user-1/avatar.glb")
    ).resolves.toBeNull();
  });

  it("resolves no selection to null (scene renders the placeholder)", async () => {
    await expect(resolveAvatarUrl(stubStorageClient(new Error("unused")), null, null)).resolves.toBeNull();
  });
});
