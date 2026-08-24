import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_GLB_BYTES, validateGlbFile } from "./validate-glb";
import { AVATAR_PRESETS } from "@/app/account/avatar-presets";

function presetFile(id: string): File {
  const buffer = readFileSync(join(process.cwd(), "public", "avatars", "presets", `${id}.glb`));
  return new File([new Uint8Array(buffer)], `${id}.glb`, { type: "model/gltf-binary" });
}

describe("validateGlbFile", () => {
  it("accepts every generated preset .glb", async () => {
    for (const preset of AVATAR_PRESETS) {
      expect(await validateGlbFile(presetFile(preset.id), "avatars")).toEqual({ ok: true });
    }
  });

  it("rejects a non-glb file by type", async () => {
    const file = new File(["not a model"], "avatar.png", { type: "image/png" });
    const result = await validateGlbFile(file, "avatars");
    expect(result).toMatchObject({ ok: false, reason: "type" });
  });

  it("rejects an oversized file by size, before reading its contents", async () => {
    const file = new File([new Uint8Array(MAX_GLB_BYTES + 1)], "big.glb");
    const result = await validateGlbFile(file, "avatars");
    expect(result).toMatchObject({ ok: false, reason: "size" });
  });

  it("rejects a .glb-named file with garbage contents as unparseable", async () => {
    const file = new File(["definitely not gltf"], "fake.glb");
    const result = await validateGlbFile(file, "avatars");
    expect(result).toMatchObject({ ok: false, reason: "parse" });
  });

  it("rejects a truncated .glb as unparseable", async () => {
    const buffer = readFileSync(
      join(process.cwd(), "public", "avatars", "presets", `${AVATAR_PRESETS[0].id}.glb`)
    );
    const truncated = new File([new Uint8Array(buffer).slice(0, 100)], "truncated.glb");
    expect(await validateGlbFile(truncated, "avatars")).toMatchObject({ ok: false, reason: "parse" });
  });

  it("gives distinct human-readable messages for each rejection", async () => {
    const type = await validateGlbFile(new File([""], "a.txt", { type: "text/plain" }), "avatars");
    const size = await validateGlbFile(new File([new Uint8Array(MAX_GLB_BYTES + 1)], "b.glb"), "avatars");
    const parse = await validateGlbFile(new File(["junk"], "c.glb"), "avatars");
    const messages = [type, size, parse].map((r) => (r.ok ? "" : r.message));
    expect(new Set(messages).size).toBe(3);
    expect(messages.every((m) => m.length > 0)).toBe(true);
  });

  it("names the caller's subject in type and size messages", async () => {
    const type = await validateGlbFile(new File([""], "a.txt", { type: "text/plain" }), "map assets");
    const size = await validateGlbFile(new File([new Uint8Array(MAX_GLB_BYTES + 1)], "b.glb"), "map assets");
    for (const result of [type, size]) {
      expect(result.ok ? "" : result.message).toContain("map assets");
    }
  });
});
