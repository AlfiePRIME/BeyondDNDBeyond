import { describe, expect, it } from "vitest";
import { CLASSES } from "./classes";
import { SUBCLASSES } from "./subclasses";
import { FEATURE_DESCRIPTIONS, featureDescription } from "./featureDescriptions";

describe("FEATURE_DESCRIPTIONS", () => {
  it("covers every base-class and subclass feature name with a nonempty blurb", () => {
    const names = new Set<string>();
    for (const klass of CLASSES) for (const f of klass.features) names.add(f.name);
    for (const subclass of SUBCLASSES) for (const f of subclass.features) names.add(f.name);
    for (const name of names) {
      expect(FEATURE_DESCRIPTIONS[name], `missing description for "${name}"`).toBeTruthy();
      expect(FEATURE_DESCRIPTIONS[name].length).toBeGreaterThan(10);
    }
  });

  it("falls back to a generic line for an unrecognized name", () => {
    expect(featureDescription("Totally Made Up Feature")).toContain("Totally Made Up Feature");
  });
});
