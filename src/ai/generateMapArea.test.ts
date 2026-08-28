import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import {
  AreaGenerationError,
  buildAreaRequest,
  extractAreaDraft,
  generateMapArea,
  MAX_AREA_CELLS,
  validateGeneratedArea,
  type AreaAsset,
  type AreaRegionSize,
} from "./generateMapArea";

const ORIGINAL_KEY = process.env.ANTHROPIC_API_KEY;

afterEach(() => {
  if (ORIGINAL_KEY === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = ORIGINAL_KEY;
});

const REGION: AreaRegionSize = { width: 4, height: 3 };

const ASSETS: AreaAsset[] = [
  { id: "asset-tree", name: "Dead tree" },
  { id: "asset-chest", name: "Treasure chest" },
];

function toolUseMessage(input: unknown): Anthropic.Message {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-5",
    content: [
      { type: "tool_use", id: "toolu_test", name: "propose_map_area", input },
    ],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 20 },
  } as Anthropic.Message;
}

const VALID_DRAFT = {
  cells: [
    { x: 0, y: 0, elevation: 2, terrain: "normal" },
    { x: 3, y: 2, elevation: 0, terrain: "difficult" },
  ],
  objects: [
    { asset_id: "asset-tree", x: 0, y: 0, elevation: 2, rotation: 90 },
    { asset_id: "asset-chest", x: 1, y: 1, elevation: 0, rotation: 0 },
  ],
};

describe("buildAreaRequest", () => {
  it("forces the structured tool with a strict schema on the Sonnet model", () => {
    const request = buildAreaRequest("a ruined library", REGION, ASSETS);
    expect(request.model).toBe("claude-sonnet-5");
    expect(request.tool_choice).toEqual({ type: "tool", name: "propose_map_area" });
    const tool = request.tools?.[0] as Anthropic.Tool;
    expect(tool.name).toBe("propose_map_area");
    expect(tool.strict).toBe(true);
    expect(tool.input_schema.additionalProperties).toBe(false);
    expect(tool.input_schema.required).toEqual(["cells", "objects"]);
  });

  it("tells the model the region-relative bounds and the palette id/name pairs", () => {
    const request = buildAreaRequest("a swampy clearing", REGION, ASSETS);
    const system = String(request.system);
    expect(system).toContain("4x3");
    expect(system).toContain("x from 0 to 3");
    expect(system).toContain("y from 0 to 2");
    expect(system).toContain("asset-tree");
    expect(system).toContain("Dead tree");
    expect(system).toContain("asset-chest");
    expect(request.messages).toEqual([{ role: "user", content: "a swampy clearing" }]);
  });

  it("tells the model to place no objects when the palette is empty", () => {
    const request = buildAreaRequest("a bare cave", REGION, []);
    expect(String(request.system)).toContain("empty objects array");
  });

  it("feeds validation errors back on the retry attempt", () => {
    const request = buildAreaRequest("a crypt", REGION, ASSETS, "cell (9,9) is outside");
    const content = String(request.messages[0].content);
    expect(content).toContain("a crypt");
    expect(content).toContain("cell (9,9) is outside");
    expect(content).toContain("rejected");
  });
});

describe("extractAreaDraft", () => {
  it("returns the forced tool call's input", () => {
    expect(extractAreaDraft(toolUseMessage(VALID_DRAFT))).toEqual(VALID_DRAFT);
  });

  it("throws when the response has no tool_use block", () => {
    const message = {
      ...toolUseMessage(VALID_DRAFT),
      content: [{ type: "text", text: "sorry", citations: null }],
    } as Anthropic.Message;
    expect(() => extractAreaDraft(message)).toThrow(/no structured area draft/);
  });
});

describe("validateGeneratedArea", () => {
  it("accepts a fully valid draft", () => {
    const result = validateGeneratedArea(VALID_DRAFT, REGION, ASSETS);
    expect(result).toEqual({
      ok: true,
      area: {
        cells: [
          { x: 0, y: 0, elevation: 2, terrain: "normal" },
          { x: 3, y: 2, elevation: 0, terrain: "difficult" },
        ],
        objects: [
          { assetId: "asset-tree", x: 0, y: 0, elevation: 2, rotation: 90 },
          { assetId: "asset-chest", x: 1, y: 1, elevation: 0, rotation: 0 },
        ],
      },
    });
  });

  it("accepts void terrain — the model may carve irregular room shapes", () => {
    const result = validateGeneratedArea(
      { cells: [{ x: 2, y: 1, elevation: 0, terrain: "void" }], objects: [] },
      REGION,
      ASSETS
    );
    expect(result).toEqual({
      ok: true,
      area: { cells: [{ x: 2, y: 1, elevation: 0, terrain: "void" }], objects: [] },
    });
  });

  it("rejects an object standing on a void cell — no floor, no object", () => {
    const result = validateGeneratedArea(
      {
        cells: [{ x: 1, y: 1, elevation: 0, terrain: "void" }],
        objects: [{ asset_id: "asset-tree", x: 1, y: 1, elevation: 0, rotation: 0 }],
      },
      REGION,
      ASSETS
    );
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.reason).toContain("void cell");
  });

  it("rejects a draft that isn't the expected shape", () => {
    expect(validateGeneratedArea(null, REGION, ASSETS).ok).toBe(false);
    expect(validateGeneratedArea("nope", REGION, ASSETS).ok).toBe(false);
    expect(validateGeneratedArea({ cells: [] }, REGION, ASSETS).ok).toBe(false);
  });

  it("rejects out-of-bounds cells", () => {
    const result = validateGeneratedArea(
      { cells: [{ x: 4, y: 0, elevation: 0, terrain: "normal" }], objects: [] },
      REGION,
      ASSETS
    );
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.reason).toContain("outside the 4x3 region");
  });

  it("rejects invalid terrain, non-integer or out-of-range elevation, and duplicate cells", () => {
    const bad = (cells: unknown[]) =>
      validateGeneratedArea({ cells, objects: [] }, REGION, ASSETS).ok;
    expect(bad([{ x: 0, y: 0, elevation: 0, terrain: "lava" }])).toBe(false);
    expect(bad([{ x: 0, y: 0, elevation: 1.5, terrain: "normal" }])).toBe(false);
    expect(bad([{ x: 0, y: 0, elevation: -3, terrain: "normal" }])).toBe(false);
    expect(bad([{ x: 0, y: 0, elevation: 4000, terrain: "normal" }])).toBe(false);
    expect(
      bad([
        { x: 0, y: 0, elevation: 1, terrain: "normal" },
        { x: 0, y: 0, elevation: 2, terrain: "normal" },
      ])
    ).toBe(false);
  });

  it("rejects objects referencing assets outside the campaign palette", () => {
    const result = validateGeneratedArea(
      {
        cells: [],
        objects: [{ asset_id: "asset-invented", x: 0, y: 0, elevation: 0, rotation: 0 }],
      },
      REGION,
      ASSETS
    );
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.reason).toContain("not in the campaign palette");
  });

  it("rejects out-of-bounds objects and invalid rotations", () => {
    const bad = (objects: unknown[]) =>
      validateGeneratedArea({ cells: [], objects }, REGION, ASSETS).ok;
    expect(bad([{ asset_id: "asset-tree", x: -1, y: 0, elevation: 0, rotation: 0 }])).toBe(false);
    expect(bad([{ asset_id: "asset-tree", x: 0, y: 3, elevation: 0, rotation: 0 }])).toBe(false);
    expect(bad([{ asset_id: "asset-tree", x: 0, y: 0, elevation: 0, rotation: 45 }])).toBe(false);
  });

  it("rejects an object whose elevation disagrees with its cell's generated ground", () => {
    const result = validateGeneratedArea(
      {
        cells: [{ x: 1, y: 1, elevation: 3, terrain: "normal" }],
        objects: [{ asset_id: "asset-tree", x: 1, y: 1, elevation: 0, rotation: 0 }],
      },
      REGION,
      ASSETS
    );
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.reason).toContain("elevation must equal");
  });

  it("treats an unlisted cell as ground elevation 0 for object consistency", () => {
    const result = validateGeneratedArea(
      {
        cells: [],
        objects: [{ asset_id: "asset-tree", x: 2, y: 2, elevation: 0, rotation: 180 }],
      },
      REGION,
      ASSETS
    );
    expect(result.ok).toBe(true);
  });

  it("drops (not rejects) an object landing on a cell a pre-existing live object already occupies", () => {
    const result = validateGeneratedArea(
      {
        cells: [],
        objects: [
          { asset_id: "asset-tree", x: 0, y: 0, elevation: 0, rotation: 0 },
          { asset_id: "asset-chest", x: 1, y: 1, elevation: 0, rotation: 0 },
        ],
      },
      REGION,
      ASSETS,
      new Set(["0,0"])
    );
    expect(result).toMatchObject({ ok: true });
    if (result.ok) {
      expect(result.area.objects).toEqual([
        { assetId: "asset-chest", x: 1, y: 1, elevation: 0, rotation: 0 },
      ]);
    }
  });

  it("rejects two objects sharing a cell", () => {
    const result = validateGeneratedArea(
      {
        cells: [],
        objects: [
          { asset_id: "asset-tree", x: 0, y: 0, elevation: 0, rotation: 0 },
          { asset_id: "asset-chest", x: 0, y: 0, elevation: 0, rotation: 0 },
        ],
      },
      REGION,
      ASSETS
    );
    expect(result.ok).toBe(false);
  });
});

describe("generateMapArea", () => {
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
  });

  function fakeTransport(responses: unknown[]): {
    fetch: typeof fetch;
    requests: { body: Record<string, unknown> }[];
  } {
    const requests: { body: Record<string, unknown> }[] = [];
    const transport: typeof fetch = async (_input, init) => {
      requests.push({ body: JSON.parse(String(init?.body)) });
      const draft = responses[Math.min(requests.length - 1, responses.length - 1)];
      return new Response(JSON.stringify(toolUseMessage(draft)), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    return { fetch: transport, requests };
  }

  it("throws without a configured key", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    await expect(generateMapArea("a crypt", REGION, ASSETS)).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });

  it("rejects an empty prompt and an oversized region without calling the API", async () => {
    let called = false;
    const spy: typeof fetch = async () => {
      called = true;
      throw new Error("should not be called");
    };
    await expect(generateMapArea("  ", REGION, ASSETS, { fetch: spy })).rejects.toThrow(
      /prompt is required/
    );
    await expect(
      generateMapArea("a crypt", { width: 30, height: 30 }, ASSETS, { fetch: spy })
    ).rejects.toThrow(new RegExp(String(MAX_AREA_CELLS)));
    expect(called).toBe(false);
  });

  it("returns a validated area on the first attempt", async () => {
    const { fetch: transport, requests } = fakeTransport([VALID_DRAFT]);
    const area = await generateMapArea("a ruined library", REGION, ASSETS, { fetch: transport });
    expect(area.cells).toHaveLength(2);
    expect(area.objects.map((object) => object.assetId)).toEqual(["asset-tree", "asset-chest"]);
    expect(requests).toHaveLength(1);
  });

  it("retries exactly once with the validation errors as feedback", async () => {
    const invalid = {
      cells: [],
      objects: [{ asset_id: "asset-invented", x: 0, y: 0, elevation: 0, rotation: 0 }],
    };
    const { fetch: transport, requests } = fakeTransport([invalid, VALID_DRAFT]);
    const area = await generateMapArea("a ruined library", REGION, ASSETS, { fetch: transport });
    expect(area.objects).toHaveLength(2);
    expect(requests).toHaveLength(2);
    const retryContent = String(
      (requests[1].body.messages as { content: string }[])[0].content
    );
    expect(retryContent).toContain("not in the campaign palette");
  });

  it("passes occupiedCells through to validation on both the first and retry attempt", async () => {
    const overlapping = {
      cells: [],
      objects: [{ asset_id: "asset-tree", x: 0, y: 0, elevation: 0, rotation: 0 }],
    };
    const { fetch: transport, requests } = fakeTransport([overlapping]);
    const area = await generateMapArea(
      "a ruined library",
      REGION,
      ASSETS,
      { fetch: transport },
      new Set(["0,0"])
    );
    expect(area.objects).toHaveLength(0);
    expect(requests).toHaveLength(1);
  });

  it("throws AreaGenerationError when the retry also fails validation", async () => {
    const invalid = {
      cells: [{ x: 99, y: 99, elevation: 0, terrain: "normal" }],
      objects: [],
    };
    const { fetch: transport, requests } = fakeTransport([invalid, invalid]);
    await expect(
      generateMapArea("a ruined library", REGION, ASSETS, { fetch: transport })
    ).rejects.toThrow(AreaGenerationError);
    expect(requests).toHaveLength(2);
  });
});
