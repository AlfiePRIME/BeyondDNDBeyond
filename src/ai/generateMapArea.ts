import Anthropic from "@anthropic-ai/sdk";
import type { TerrainType } from "@/rules-engine";
import { isAiConfigured, MAX_PROMPT_CHARS, MODEL } from "./generateDraft";

/** An asset the model may place, reduced to the two fields it needs: the id
 * it must echo back and the name it reasons about. */
export interface AreaAsset {
  id: string;
  name: string;
}

export interface AreaRegionSize {
  width: number;
  height: number;
}

/** One generated cell in region-relative coordinates (0..width-1, 0..height-1).
 * The model's output is sparse — an unlisted cell means flat normal ground. */
export interface GeneratedAreaCell {
  x: number;
  y: number;
  elevation: number;
  terrain: TerrainType;
}

export interface GeneratedAreaObject {
  assetId: string;
  x: number;
  y: number;
  elevation: number;
  rotation: number;
}

/** A validated draft, still region-relative — callers translate to absolute
 * grid coordinates before building MapCell/map_objects payloads. */
export interface GeneratedArea {
  cells: GeneratedAreaCell[];
  objects: GeneratedAreaObject[];
}

/** Region size cap: keeps one generation reviewable and the structured
 * response comfortably inside one non-streaming completion. */
export const MAX_AREA_CELLS = 400;

// Mirrors the editor's sculpting bound (MAX_ELEVATION in the map editor's
// cellGrid) — not a schema constraint, but a draft shouldn't exceed what the
// editor's own tools can produce.
const MAX_AREA_ELEVATION = 10;

const VALID_ROTATIONS = [0, 90, 180, 270];

const MAX_AREA_TOKENS = 16000;

const AREA_TOOL_NAME = "propose_map_area";

/** Exported for unit tests — the exact request body sent to the Messages API.
 * Structured output via forced tool use: the schema-constrained tool input is
 * far more reliable than parsing JSON out of prose. */
export function buildAreaRequest(
  prompt: string,
  region: AreaRegionSize,
  assets: readonly AreaAsset[],
  feedback?: string
): Anthropic.MessageCreateParamsNonStreaming {
  const assetLines =
    assets.length > 0
      ? assets.map((asset) => `- id: ${asset.id} · name: ${asset.name}`).join("\n")
      : "(none — return an empty objects array)";
  const system = [
    "You are a map-prep assistant for a Dungeons & Dragons 5e virtual tabletop.",
    `The DM selected a ${region.width}x${region.height} cell region of their map and will`,
    "describe what it should contain. Propose the region's terrain and object placements",
    `by calling the ${AREA_TOOL_NAME} tool.`,
    "",
    "Coordinates are region-relative: x from 0 to " +
      `${region.width - 1}, y from 0 to ${region.height - 1}.`,
    "Rules:",
    "- cells is sparse: only list cells that differ from flat normal ground",
    "  (elevation 0, terrain \"normal\"). Never list a coordinate twice.",
    `- elevation is an integer from 0 to ${MAX_AREA_ELEVATION} (one step is 5 ft).`,
    '- terrain is "normal" or "difficult" (rubble, swamp, undergrowth...).',
    "- objects may ONLY use asset_id values from the palette below, echoed exactly.",
    "  Do not invent assets; if nothing in the palette fits, place fewer objects.",
    "- at most one object per cell, and an object's elevation must exactly equal the",
    "  elevation of the cell it stands on (0 if that cell isn't listed in cells).",
    "- rotation is 0, 90, 180, or 270 degrees.",
    "Make the layout evocative and playable: vary elevation and terrain where the brief",
    "suggests it, and place objects deliberately rather than uniformly.",
    "",
    "Available asset palette:",
    assetLines,
  ].join("\n");

  const userContent = feedback
    ? `${prompt}\n\nYour previous proposal was rejected: ${feedback}\nProduce a corrected proposal that follows every rule.`
    : prompt;

  return {
    model: MODEL,
    max_tokens: MAX_AREA_TOKENS,
    system,
    messages: [{ role: "user", content: userContent }],
    tools: [
      {
        name: AREA_TOOL_NAME,
        description:
          "Propose the generated content for the selected map region: sparse per-cell terrain/elevation plus object placements from the campaign's asset palette.",
        strict: true,
        input_schema: {
          type: "object",
          additionalProperties: false,
          required: ["cells", "objects"],
          properties: {
            cells: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["x", "y", "elevation", "terrain"],
                properties: {
                  x: { type: "integer" },
                  y: { type: "integer" },
                  elevation: { type: "integer" },
                  terrain: { type: "string", enum: ["normal", "difficult"] },
                },
              },
            },
            objects: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["asset_id", "x", "y", "elevation", "rotation"],
                properties: {
                  asset_id: { type: "string" },
                  x: { type: "integer" },
                  y: { type: "integer" },
                  elevation: { type: "integer" },
                  rotation: { type: "integer", enum: VALID_ROTATIONS },
                },
              },
            },
          },
        },
      },
    ],
    tool_choice: { type: "tool", name: AREA_TOOL_NAME },
  };
}

/** Exported for unit tests — pulls the structured draft out of an API
 * response. Returns unknown: the shape is only trusted after validation. */
export function extractAreaDraft(message: Anthropic.Message): unknown {
  const block = message.content.find(
    (candidate): candidate is Anthropic.ToolUseBlock =>
      candidate.type === "tool_use" && candidate.name === AREA_TOOL_NAME
  );
  if (!block) {
    throw new Error("The model returned no structured area draft.");
  }
  return block.input;
}

export type AreaValidation =
  | { ok: true; area: GeneratedArea }
  | { ok: false; reason: string };

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

/**
 * The server-side gate between the model's output and anything a DM ever
 * sees: every coordinate, terrain type, elevation, asset reference, and
 * cell/object consistency rule is re-checked here against the region and the
 * campaign's real palette — nothing from the model is trusted, including the
 * shape itself (strict tool use is belt; this is braces).
 *
 * `occupiedCells` (region-relative "x,y" keys) marks cells a pre-existing
 * live object already sits on — the model is never told about these (they'd
 * bloat the prompt for a rare case), so an object landing there isn't a
 * mistake worth retrying over, just a proposal that no longer fits: it's
 * dropped from the returned area rather than failing validation.
 */
export function validateGeneratedArea(
  draft: unknown,
  region: AreaRegionSize,
  assets: readonly AreaAsset[],
  occupiedCells?: ReadonlySet<string>
): AreaValidation {
  const problems: string[] = [];
  const record = draft as { cells?: unknown; objects?: unknown } | null;
  if (!record || typeof record !== "object" || !Array.isArray(record.cells) || !Array.isArray(record.objects)) {
    return { ok: false, reason: "draft is not an object with cells and objects arrays" };
  }

  const assetIds = new Set(assets.map((asset) => asset.id));
  const elevationByCell = new Map<string, number>();
  const cells: GeneratedAreaCell[] = [];
  for (const raw of record.cells) {
    const cell = raw as { x?: unknown; y?: unknown; elevation?: unknown; terrain?: unknown };
    if (!isInteger(cell.x) || !isInteger(cell.y)) {
      problems.push("a cell has non-integer coordinates");
      continue;
    }
    const at = `cell (${cell.x},${cell.y})`;
    if (cell.x < 0 || cell.x >= region.width || cell.y < 0 || cell.y >= region.height) {
      problems.push(`${at} is outside the ${region.width}x${region.height} region`);
      continue;
    }
    if (!isInteger(cell.elevation) || cell.elevation < 0 || cell.elevation > MAX_AREA_ELEVATION) {
      problems.push(`${at} elevation must be an integer from 0 to ${MAX_AREA_ELEVATION}`);
      continue;
    }
    if (cell.terrain !== "normal" && cell.terrain !== "difficult") {
      problems.push(`${at} terrain must be "normal" or "difficult"`);
      continue;
    }
    const key = `${cell.x},${cell.y}`;
    if (elevationByCell.has(key)) {
      problems.push(`${at} is listed more than once`);
      continue;
    }
    elevationByCell.set(key, cell.elevation);
    cells.push({ x: cell.x, y: cell.y, elevation: cell.elevation, terrain: cell.terrain });
  }

  const objects: GeneratedAreaObject[] = [];
  const occupied = new Set<string>();
  for (const raw of record.objects) {
    const object = raw as {
      asset_id?: unknown;
      x?: unknown;
      y?: unknown;
      elevation?: unknown;
      rotation?: unknown;
    };
    if (!isInteger(object.x) || !isInteger(object.y)) {
      problems.push("an object has non-integer coordinates");
      continue;
    }
    const at = `object at (${object.x},${object.y})`;
    if (object.x < 0 || object.x >= region.width || object.y < 0 || object.y >= region.height) {
      problems.push(`${at} is outside the ${region.width}x${region.height} region`);
      continue;
    }
    if (typeof object.asset_id !== "string" || !assetIds.has(object.asset_id)) {
      problems.push(`${at} references an asset that is not in the campaign palette`);
      continue;
    }
    const groundElevation = elevationByCell.get(`${object.x},${object.y}`) ?? 0;
    if (!isInteger(object.elevation) || object.elevation !== groundElevation) {
      problems.push(
        `${at} elevation must equal its cell's generated elevation (${groundElevation})`
      );
      continue;
    }
    if (!isInteger(object.rotation) || !VALID_ROTATIONS.includes(object.rotation)) {
      problems.push(`${at} rotation must be 0, 90, 180, or 270`);
      continue;
    }
    const key = `${object.x},${object.y}`;
    if (occupied.has(key)) {
      problems.push(`${at} shares a cell with another object`);
      continue;
    }
    if (occupiedCells?.has(key)) {
      // Not a model mistake — it can't see existing objects — so this
      // proposal is quietly dropped rather than counted as a validation
      // failure worth retrying.
      continue;
    }
    occupied.add(key);
    objects.push({
      assetId: object.asset_id,
      x: object.x,
      y: object.y,
      elevation: object.elevation,
      rotation: object.rotation,
    });
  }

  if (problems.length > 0) {
    return { ok: false, reason: problems.slice(0, 5).join("; ") };
  }
  return { ok: true, area: { cells, objects } };
}

/** Thrown when the model failed validation twice — callers surface this as a
 * clear generation-failed message rather than any partial draft. */
export class AreaGenerationError extends Error {}

/**
 * Generate a structured map-area draft for a DM-selected region, constrained
 * to the campaign's real asset palette. The model works in region-relative
 * coordinates; the result is validated server-side before being returned.
 * On a validation failure the call retries exactly once, feeding the
 * validation errors back to the model; a second failure throws
 * AreaGenerationError. Same injectable-fetch testing seam as
 * generateNarrativeDraft.
 */
export async function generateMapArea(
  prompt: string,
  region: AreaRegionSize,
  assets: readonly AreaAsset[],
  transport?: { fetch?: typeof fetch },
  occupiedCells?: ReadonlySet<string>
): Promise<GeneratedArea> {
  if (!isAiConfigured()) {
    throw new Error("ANTHROPIC_API_KEY is not configured.");
  }
  const trimmed = prompt.trim().slice(0, MAX_PROMPT_CHARS);
  if (!trimmed) {
    throw new Error("A prompt is required to generate an area.");
  }
  if (
    !isInteger(region.width) ||
    !isInteger(region.height) ||
    region.width < 1 ||
    region.height < 1 ||
    region.width * region.height > MAX_AREA_CELLS
  ) {
    throw new Error(`The region must be between 1 and ${MAX_AREA_CELLS} cells.`);
  }

  const client = new Anthropic({ fetch: transport?.fetch });
  const first = await client.messages.create(buildAreaRequest(trimmed, region, assets));
  const firstResult = validateGeneratedArea(extractAreaDraft(first), region, assets, occupiedCells);
  if (firstResult.ok) return firstResult.area;

  const second = await client.messages.create(
    buildAreaRequest(trimmed, region, assets, firstResult.reason)
  );
  const secondResult = validateGeneratedArea(extractAreaDraft(second), region, assets, occupiedCells);
  if (secondResult.ok) return secondResult.area;

  throw new AreaGenerationError(
    `The model produced an invalid draft twice: ${secondResult.reason}`
  );
}
