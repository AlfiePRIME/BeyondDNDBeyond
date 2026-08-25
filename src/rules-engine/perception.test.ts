import { describe, expect, it } from "vitest";
import {
  computeVisibilityTier,
  computeVisibilityTiers,
  effectiveLightLevel,
  type ComputeVisibilityTierParams,
  type ObserverVision,
  type ResolvedLightSource,
} from "./perception";

const origin = { x: 0, y: 0 };

function normalVision(): ObserverVision {
  return { darkvisionFeet: null, visionBlocked: false };
}

function darkvision(feet: number): ObserverVision {
  return { darkvisionFeet: feet, visionBlocked: false };
}

function params(overrides: Partial<ComputeVisibilityTierParams>): ComputeVisibilityTierParams {
  return {
    observerPosition: origin,
    vision: normalVision(),
    cellPosition: origin,
    cellAmbientLight: "bright",
    lightSources: [],
    ...overrides,
  };
}

// A cell N cells due east of the origin — gridDistanceFeet(origin, at(n)) === n * 5.
function at(cells: number) {
  return { x: cells, y: 0 };
}

describe("computeVisibilityTier — bright light", () => {
  it("is full for normal vision", () => {
    expect(computeVisibilityTier(params({ cellAmbientLight: "bright" }))).toBe("full");
  });

  it("is full for darkvision too, at any range (bright light is never demoted)", () => {
    expect(
      computeVisibilityTier(
        params({ cellAmbientLight: "bright", vision: darkvision(60), cellPosition: at(100) })
      )
    ).toBe("full");
    // Even a 0 ft darkvision range doesn't matter — bright light needs no darkvision at all.
    expect(
      computeVisibilityTier(
        params({ cellAmbientLight: "bright", vision: darkvision(0), cellPosition: at(100) })
      )
    ).toBe("full");
  });
});

describe("computeVisibilityTier — dim light", () => {
  it("is dim for normal vision", () => {
    expect(computeVisibilityTier(params({ cellAmbientLight: "dim" }))).toBe("dim");
  });

  it("is full for darkvision when the cell is within range", () => {
    expect(
      computeVisibilityTier(
        params({ cellAmbientLight: "dim", vision: darkvision(60), cellPosition: at(10) })
      )
    ).toBe("full");
    // Exactly at the darkvision boundary counts as within range.
    expect(
      computeVisibilityTier(
        params({ cellAmbientLight: "dim", vision: darkvision(30), cellPosition: at(6) })
      )
    ).toBe("full");
  });

  it("is dim for darkvision when the cell is outside range — darkvision doesn't help beyond its own radius", () => {
    expect(
      computeVisibilityTier(
        params({ cellAmbientLight: "dim", vision: darkvision(30), cellPosition: at(7) })
      )
    ).toBe("dim");
  });
});

describe("computeVisibilityTier — darkness", () => {
  it("is none for normal vision", () => {
    expect(computeVisibilityTier(params({ cellAmbientLight: "dark" }))).toBe("none");
  });

  it("is full for darkvision when the cell is within range (the deliberate darkness-as-full simplification)", () => {
    expect(
      computeVisibilityTier(
        params({ cellAmbientLight: "dark", vision: darkvision(60), cellPosition: at(10) })
      )
    ).toBe("full");
    expect(
      computeVisibilityTier(
        params({ cellAmbientLight: "dark", vision: darkvision(30), cellPosition: at(6) })
      )
    ).toBe("full");
  });

  it("is none for darkvision when the cell is outside range", () => {
    expect(
      computeVisibilityTier(
        params({ cellAmbientLight: "dark", vision: darkvision(30), cellPosition: at(7) })
      )
    ).toBe("none");
  });
});

describe("effectiveLightLevel — light sources", () => {
  const dimTorch: ResolvedLightSource = { position: at(2), radiusFeet: 20, brightness: "dim" };
  const brightLantern: ResolvedLightSource = {
    position: at(2),
    radiusFeet: 20,
    brightness: "bright",
  };

  it("upgrades an otherwise-dark cell to dim via a dim light source", () => {
    expect(effectiveLightLevel(at(2), "dark", [dimTorch])).toBe("dim");
  });

  it("upgrades an otherwise-dark cell to bright via a bright light source", () => {
    expect(effectiveLightLevel(at(2), "dark", [brightLantern])).toBe("bright");
  });

  it("upgrades an otherwise-dim cell to bright via a bright light source", () => {
    expect(effectiveLightLevel(at(2), "dim", [brightLantern])).toBe("bright");
  });

  it("never darkens a cell below its own ambient value", () => {
    // A dim source reaching an already-bright cell can't demote it.
    expect(effectiveLightLevel(at(2), "bright", [dimTorch])).toBe("bright");
  });

  it("contributes nothing when the cell is outside the source's radius", () => {
    const farCell = { x: 2, y: 100 }; // way past the 20 ft radius from (2,0)
    expect(effectiveLightLevel(farCell, "dark", [brightLantern])).toBe("dark");
  });

  it("treats the radius boundary itself as within range", () => {
    // radiusFeet 20 = 4 cells; a cell exactly 4 cells away is still lit.
    const boundaryCell = { x: 6, y: 0 }; // 4 cells from (2,0)
    expect(effectiveLightLevel(boundaryCell, "dark", [brightLantern])).toBe("bright");
    const justOutside = { x: 7, y: 0 }; // 5 cells from (2,0) = 25 ft > 20 ft radius
    expect(effectiveLightLevel(justOutside, "dark", [brightLantern])).toBe("dark");
  });

  it("takes the brightest overlapping contribution, not the closest or last source", () => {
    // Cell at(2) is 1 cell (5 ft) from nearDim and 4 cells (20 ft) from
    // farBright — nearDim is strictly closer, and both sources reach the
    // cell (5 ft <= 20 ft, 20 ft <= 30 ft). The brighter, farther source
    // still wins, whichever order the sources are listed in.
    const nearDim: ResolvedLightSource = { position: at(1), radiusFeet: 20, brightness: "dim" };
    const farBright: ResolvedLightSource = {
      position: at(6),
      radiusFeet: 30,
      brightness: "bright",
    };
    expect(effectiveLightLevel(at(2), "dark", [nearDim, farBright])).toBe("bright");
    expect(effectiveLightLevel(at(2), "dark", [farBright, nearDim])).toBe("bright");
  });
});

describe("computeVisibilityTier — light sources feed into the tier computation", () => {
  it("a light source brightening a dark cell to dim within darkvision range still resolves via the normal dim rule", () => {
    const dimTorch: ResolvedLightSource = { position: at(5), radiusFeet: 20, brightness: "dim" };
    // Normal vision sees the torch-lit dark cell as dim, not none.
    expect(
      computeVisibilityTier(
        params({ cellAmbientLight: "dark", cellPosition: at(5), lightSources: [dimTorch] })
      )
    ).toBe("dim");
  });

  it("a light source brightening a dark cell to bright is full for everyone in range of the light itself", () => {
    const lantern: ResolvedLightSource = { position: at(5), radiusFeet: 20, brightness: "bright" };
    expect(
      computeVisibilityTier(
        params({ cellAmbientLight: "dark", cellPosition: at(5), lightSources: [lantern] })
      )
    ).toBe("full");
  });
});

describe("computeVisibilityTier — vision-blocked override", () => {
  it("is none regardless of light or range when vision is blocked (the blinded case)", () => {
    const blocked: ObserverVision = { darkvisionFeet: 60, visionBlocked: true };
    expect(
      computeVisibilityTier(
        params({ cellAmbientLight: "bright", vision: blocked, cellPosition: origin })
      )
    ).toBe("none");
  });

  it("stays none even with a bright light source right on top of the observer", () => {
    const blocked: ObserverVision = { darkvisionFeet: 120, visionBlocked: true };
    const lantern: ResolvedLightSource = { position: origin, radiusFeet: 30, brightness: "bright" };
    expect(
      computeVisibilityTier(
        params({
          cellAmbientLight: "dark",
          vision: blocked,
          cellPosition: origin,
          lightSources: [lantern],
        })
      )
    ).toBe("none");
  });

  it("is genuinely generic: an unrelated, made-up boolean source produces identical behavior", () => {
    // The function has zero knowledge of condition names — it only ever
    // reads the plain `visionBlocked` boolean the caller hands it. Prove
    // it by deriving that boolean from something that is NOT "blinded" at
    // all, and confirming the outcome is identical to the blinded case
    // above: the mechanism is the boolean, not a hardcoded condition key.
    interface MadeUpConditionEffects {
      grantsTrueSight: boolean;
      causesTemporaryVisionLoss: boolean; // stands in for a hypothetical non-blinded condition
    }
    const eyeAcidSplashEffects: MadeUpConditionEffects = {
      grantsTrueSight: false,
      causesTemporaryVisionLoss: true,
    };
    const visionFromMadeUpCondition: ObserverVision = {
      darkvisionFeet: 60,
      visionBlocked: eyeAcidSplashEffects.causesTemporaryVisionLoss,
    };
    expect(
      computeVisibilityTier(
        params({ cellAmbientLight: "bright", vision: visionFromMadeUpCondition, cellPosition: origin })
      )
    ).toBe("none");
  });
});

describe("computeVisibilityTiers", () => {
  it("resolves one observer against many cells, preserving input order and ids", () => {
    const cells = [
      { id: "0,0", position: at(0), ambientLight: "bright" as const },
      { id: "token-goblin", position: at(10), ambientLight: "dark" as const },
      { id: "3,0", position: at(3), ambientLight: "dim" as const },
    ];
    expect(
      computeVisibilityTiers({
        observerPosition: origin,
        vision: darkvision(30),
        lightSources: [],
        cells,
      })
    ).toEqual([
      { id: "0,0", tier: "full" }, // bright
      { id: "token-goblin", tier: "none" }, // dark, 50 ft > 30 ft darkvision
      { id: "3,0", tier: "full" }, // dim, 15 ft <= 30 ft darkvision
    ]);
  });

  it("returns an empty array for no cells", () => {
    expect(
      computeVisibilityTiers({
        observerPosition: origin,
        vision: normalVision(),
        lightSources: [],
        cells: [],
      })
    ).toEqual([]);
  });

  it("applies the vision-blocked override uniformly across every cell", () => {
    const blocked: ObserverVision = { darkvisionFeet: 60, visionBlocked: true };
    const cells = [
      { id: "a", position: at(0), ambientLight: "bright" as const },
      { id: "b", position: at(1), ambientLight: "dim" as const },
      { id: "c", position: at(2), ambientLight: "dark" as const },
    ];
    expect(
      computeVisibilityTiers({ observerPosition: origin, vision: blocked, lightSources: [], cells })
    ).toEqual([
      { id: "a", tier: "none" },
      { id: "b", tier: "none" },
      { id: "c", tier: "none" },
    ]);
  });
});

it("perception.ts never hardcodes a condition key — the vision-blocked mechanism is a plain boolean", async () => {
  const fs = await import("node:fs/promises");
  const source = await fs.readFile(new URL("./perception.ts", import.meta.url), "utf-8");
  for (const conditionKey of [
    "blinded",
    "charmed",
    "deafened",
    "frightened",
    "grappled",
    "incapacitated",
    "invisible",
    "paralyzed",
    "petrified",
    "poisoned",
    "prone",
    "restrained",
    "stunned",
    "unconscious",
  ]) {
    expect(source).not.toContain(`"${conditionKey}"`);
  }
});
