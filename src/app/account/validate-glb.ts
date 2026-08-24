// Custom-avatar upload validation. Prompt 25 (custom map assets) is expected
// to extract this into a shared module — keep it free of avatar-specific
// assumptions beyond the size limit.

// 10MB: a low-poly character model is typically well under 5MB even with
// generous headroom, and anything bigger would drag down table load times.
// Mirrored by the avatars bucket's server-side file_size_limit.
export const MAX_AVATAR_BYTES = 10 * 1024 * 1024;

export type GlbValidationResult =
  | { ok: true }
  | { ok: false; reason: "type" | "size" | "parse"; message: string };

const GLB_MAGIC = 0x46546c67; // "glTF"

/**
 * Checks that a candidate upload is a binary glTF model: .glb extension /
 * MIME, under the size limit, and actually parses (GLB container header
 * plus a full three.js GLTFLoader parse — not just a magic-bytes sniff).
 */
export async function validateAvatarGlb(file: File): Promise<GlbValidationResult> {
  const looksLikeGlb = file.name.toLowerCase().endsWith(".glb") || file.type === "model/gltf-binary";
  if (!looksLikeGlb) {
    return {
      ok: false,
      reason: "type",
      message: "That file isn't a .glb model — avatars must be binary glTF (.glb).",
    };
  }

  if (file.size > MAX_AVATAR_BYTES) {
    return {
      ok: false,
      reason: "size",
      message: `That file is too big — avatars must be under ${MAX_AVATAR_BYTES / (1024 * 1024)}MB.`,
    };
  }

  const parseFailure: GlbValidationResult = {
    ok: false,
    reason: "parse",
    message: "That file couldn't be read as a glTF model — it may be corrupt or not really a .glb.",
  };

  const buffer = await file.arrayBuffer();
  if (buffer.byteLength < 12) return parseFailure;
  const header = new DataView(buffer);
  if (header.getUint32(0, true) !== GLB_MAGIC) return parseFailure;
  if (header.getUint32(4, true) !== 2) return parseFailure;
  if (header.getUint32(8, true) !== buffer.byteLength) return parseFailure;

  const { GLTFLoader } = await import("three/examples/jsm/loaders/GLTFLoader.js");
  try {
    await new Promise((resolve, reject) => {
      new GLTFLoader().parse(buffer, "", resolve, reject);
    });
  } catch {
    return parseFailure;
  }

  return { ok: true };
}
