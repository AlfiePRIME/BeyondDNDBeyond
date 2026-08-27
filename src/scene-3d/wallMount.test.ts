import { describe, expect, it } from "vitest";
import { resolveWallMountOffset, WALL_MOUNT_FACES, WALL_MOUNT_OFFSET } from "./wallMount";

describe("resolveWallMountOffset", () => {
  it("faces 0 and 180 point in exactly opposite directions off an unrotated host", () => {
    const front = resolveWallMountOffset({ rotation: 0 }, 0);
    const back = resolveWallMountOffset({ rotation: 0 }, 180);
    expect(front.rotationDeg).toBe(0);
    expect(back.rotationDeg).toBe(180);
    expect(front.offsetX).toBeCloseTo(-back.offsetX, 10);
    expect(front.offsetZ).toBeCloseTo(-back.offsetZ, 10);
    // Rotation 0 -> local +Z, this app's own "south" convention (matches
    // MapSurface.tsx's WATER_FLOW_Y_ROTATION doc comment): offsetX ~ 0,
    // offsetZ ~ +WALL_MOUNT_OFFSET.
    expect(front.offsetX).toBeCloseTo(0, 10);
    expect(front.offsetZ).toBeCloseTo(WALL_MOUNT_OFFSET, 10);
    expect(back.offsetX).toBeCloseTo(0, 10);
    expect(back.offsetZ).toBeCloseTo(-WALL_MOUNT_OFFSET, 10);
  });

  it("both faces sit exactly WALL_MOUNT_OFFSET from center, for any host rotation", () => {
    for (const hostRotation of [0, 37, 90, 180, 270, -45]) {
      for (const faceDeg of WALL_MOUNT_FACES) {
        const { offsetX, offsetZ } = resolveWallMountOffset({ rotation: hostRotation }, faceDeg);
        const distance = Math.sqrt(offsetX * offsetX + offsetZ * offsetZ);
        expect(distance).toBeCloseTo(WALL_MOUNT_OFFSET, 10);
      }
    }
  });

  it("tracks the host's CURRENT rotation — re-rotating the host changes the resolved facing", () => {
    const at0 = resolveWallMountOffset({ rotation: 0 }, 0);
    const at90 = resolveWallMountOffset({ rotation: 90 }, 0);
    expect(at90.rotationDeg).toBe(90);
    expect(at90.offsetX).toBeCloseTo(WALL_MOUNT_OFFSET, 10);
    expect(at90.offsetZ).toBeCloseTo(0, 10);
    expect(at90.offsetX).not.toBeCloseTo(at0.offsetX, 5);
  });

  it("rotationDeg is always host.rotation + faceDeg", () => {
    expect(resolveWallMountOffset({ rotation: 45 }, 180).rotationDeg).toBe(225);
  });
});
