import { Box3, Vector3 } from "three";
import { fitSizeForUrl } from "./PlacedObject";

/**
 * "Objects so tokens can stand on top of them" (a generalization of
 * crossingSurface.ts's bridge/stairs-only lift): the project owner's own
 * explicit choice, when asked, was to auto-measure a standable object's
 * real stand-on height from its own model geometry rather than have a DM
 * type a number in. crossingSurface.ts can do this with a small hardcoded
 * SURFACE_HEIGHT_BY_URL table because there are only ever three known
 * presets to measure once, by hand, at generation time — but a DM may mark
 * ANY asset (a built-in preset OR an arbitrary campaign upload) standable,
 * so there is no fixed table to write ahead of time. This module is the
 * real, live measurement crossingSurface.ts's own doc comment describes as
 * "computed once, by hand" — done instead by CODE, at runtime, the first
 * time any client needs it (GameRoom.tsx's own lazy-measure-then-cache
 * effect; see model_orientation.standable_surface_height's own doc comment,
 * 0105_standable_surface_height.sql, for where the result is cached so this
 * only ever runs once per asset, not once per render).
 *
 * The technique itself is NOT new: PlacedObject.tsx's own PropModel and
 * SeatAvatar.tsx's own AvatarModel already measure a loaded model's real
 * Box3 bounding box, live, to fit it to its cell/avatar-height — this
 * module applies the IDENTICAL math (fitSizeForUrl's own scale formula,
 * "how far above the model's own rebased-to-zero base does its top face
 * sit, once scaled the same way a real render of this url would scale it")
 * to derive a "how tall does this object stand" number instead of "how big
 * should I draw this object". The one real difference: PropModel measures
 * INSIDE a mounted react-three-fiber scene (a `useGLTF` hook, tied to
 * Suspense/render), which only ever happens for an object actually visible
 * in the CURRENT client's own loaded map — no help for "cache this globally
 * so every future client, on every future map, skips remeasuring the same
 * asset". This module instead loads and measures OFF the scene graph
 * entirely (a bare three.js GLTFLoader — the exact technique
 * validate-glb.ts and every scripts/assets/generate-*.mjs preset generator
 * already use, just running in the browser instead of a Node script), so
 * GameRoom.tsx can call it directly from a plain effect and persist the
 * result, independent of whether that specific object happens to be
 * on-screen for THIS client at THIS moment.
 */
export async function measureStandableSurfaceHeight(url: string): Promise<number> {
  // Dynamic import (validate-glb.ts's own precedent): keeps three.js's
  // GLTFLoader out of the initial client bundle for every session that
  // never actually needs to measure anything this way.
  const { GLTFLoader } = await import("three/examples/jsm/loaders/GLTFLoader.js");
  const gltf = await new GLTFLoader().loadAsync(url);
  const box = new Box3().setFromObject(gltf.scene);
  const size = box.getSize(new Vector3());
  const maxDim = Math.max(size.x, size.y, size.z);
  // fitSizeForUrl(url), not a bare PLACED_OBJECT_SIZE constant: a standable
  // object that happens to ALSO be a wall-family preset (WALL_FIT_TARGET_BY_URL)
  // must be measured against the SAME fit target its own real render
  // actually uses, or this module's own number would silently disagree with
  // PropModel's — the exact "one unified code path, not two that could
  // disagree" this feature's own design brief calls for, extended to the
  // measurement step itself, not just the final additive formula.
  const scale = maxDim > 1e-3 ? fitSizeForUrl(url) / maxDim : 1;
  // Unlike the bridge's own hand-picked deck-mesh measurement (crossingSurface.ts's
  // BRIDGE_DECK_TOP_RAW_Y — a specific inner mesh, not the whole model,
  // since the bridge's handrails reach well above its actual walkable
  // deck), there is no way to identify "which mesh is the real walkable
  // surface" for an arbitrary DM-uploaded asset with no known internal
  // structure. The whole model's own topmost point (size.y, since
  // PropModel/AvatarModel both already rebase a loaded model's own minimum
  // to local y=0 the same way this measurement implicitly does by using
  // Box3's size rather than its raw max) is used instead — correct for a
  // solid prop with nothing decorative jutting up past its own main mass
  // (a crate, a table, a plinth — the overwhelming common case), and a
  // documented, deliberate simplification (not a bug) for a shape with tall
  // thin ornamentation above its own real usable top.
  return size.y * scale;
}
