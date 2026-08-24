import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_AVATAR_BYTES, validateAvatarGlb } from "./validate-glb";
import { AVATAR_PRESETS } from "./avatar-presets";

function presetFile(id: string): File {
  const buffer = readFileSync(join(process.cwd(), "public", "avatars", "presets", `${id}.glb`));
  return new File([new Uint8Array(buffer)], `${id}.glb`, { type: "model/gltf-binary" });
}

describe("validateAvatarGlb", () => {
  it("accepts every generated preset .glb", async () => {
    for (const preset of AVATAR_PRESETS) {
      expect(await validateAvatarGlb(presetFile(preset.id))).toEqual({ ok: true });
    }
  });

  it("rejects a non-glb file by type", async () => {
    const file = new File(["not a model"], "avatar.png", { type: "image/png" });
    const result = await validateAvatarGlb(file);
    expect(result).toMatchObject({ ok: false, reason: "type" });
  });

  it("rejects an oversized file by size, before reading its contents", async () => {
    const file = new File([new Uint8Array(MAX_AVATAR_BYTES + 1)], "big.glb");
    const result = await validateAvatarGlb(file);
    expect(result).toMatchObject({ ok: false, reason: "size" });
  });

  it("rejects a .glb-named file with garbage contents as unparseable", async () => {
    const file = new File(["definitely not gltf"], "fake.glb");
    const result = await validateAvatarGlb(file);
    expect(result).toMatchObject({ ok: false, reason: "parse" });
  });

  it("rejects a truncated .glb as unparseable", async () => {
    const buffer = readFileSync(
      join(process.cwd(), "public", "avatars", "presets", `${AVATAR_PRESETS[0].id}.glb`)
    );
    const truncated = new File([new Uint8Array(buffer).slice(0, 100)], "truncated.glb");
    expect(await validateAvatarGlb(truncated)).toMatchObject({ ok: false, reason: "parse" });
  });

  it("gives distinct human-readable messages for each rejection", async () => {
    const type = await validateAvatarGlb(new File([""], "a.txt", { type: "text/plain" }));
    const size = await validateAvatarGlb(new File([new Uint8Array(MAX_AVATAR_BYTES + 1)], "b.glb"));
    const parse = await validateAvatarGlb(new File(["junk"], "c.glb"));
    const messages = [type, size, parse].map((r) => (r.ok ? "" : r.message));
    expect(new Set(messages).size).toBe(3);
    expect(messages.every((m) => m.length > 0)).toBe(true);
  });
});
