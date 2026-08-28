import { NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/data-access/supabase-server";
import { getMap, isDM, listAssetsForCampaign, listMapObjects } from "@/data-access";
import {
  AreaGenerationError,
  generateMapArea,
  isAnthropicConfigured,
  MAX_AREA_CELLS,
  MAX_PROMPT_CHARS,
} from "@/ai";

// Same auth/gating shape as the generate-draft route (Prompt 37): server
// Supabase client for auth, RLS + explicit DM gate, then delegate to @/ai.
// Additionally map-scoped: the region must fit the actual map's grid, and
// the palette the model may draw from is re-fetched here — validation inside
// generateMapArea checks the model's output against this same list, never
// against anything the client (or the model) claims.

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; mapId: string }> }
) {
  const { id: campaignId, mapId } = await params;

  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json(
      { ok: false, message: "You must be signed in to generate an area." },
      { status: 401 }
    );
  }

  const { data: campaign, error } = await supabase
    .from("campaigns")
    .select("id")
    .eq("id", campaignId)
    .maybeSingle();
  if (error) throw error;
  if (!campaign) {
    return NextResponse.json({ ok: false, message: "Campaign not found." }, { status: 404 });
  }

  if (!(await isDM(supabase, campaignId, user.id))) {
    return NextResponse.json(
      { ok: false, message: "Only the DM can generate map areas." },
      { status: 403 }
    );
  }

  if (!isAnthropicConfigured()) {
    return NextResponse.json(
      { ok: false, message: "AI generation isn't configured on this server." },
      { status: 503 }
    );
  }

  const map = await getMap(supabase, mapId);
  if (!map || map.campaign_id !== campaignId) {
    return NextResponse.json({ ok: false, message: "Map not found." }, { status: 404 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, message: "Malformed request." }, { status: 400 });
  }
  const { prompt, x, y, width, height } = (body ?? {}) as {
    prompt?: unknown;
    x?: unknown;
    y?: unknown;
    width?: unknown;
    height?: unknown;
  };
  if (typeof prompt !== "string" || !prompt.trim()) {
    return NextResponse.json(
      { ok: false, message: "Describe what the area should contain." },
      { status: 400 }
    );
  }
  if (prompt.length > MAX_PROMPT_CHARS) {
    return NextResponse.json(
      { ok: false, message: `Keep the prompt under ${MAX_PROMPT_CHARS} characters.` },
      { status: 400 }
    );
  }
  if (
    !isInteger(x) ||
    !isInteger(y) ||
    !isInteger(width) ||
    !isInteger(height) ||
    width < 1 ||
    height < 1 ||
    x < 0 ||
    y < 0 ||
    x + width > map.grid_width ||
    y + height > map.grid_height
  ) {
    return NextResponse.json(
      { ok: false, message: "The selected region must fit inside the map grid." },
      { status: 400 }
    );
  }
  if (width * height > MAX_AREA_CELLS) {
    return NextResponse.json(
      { ok: false, message: `Select a region of at most ${MAX_AREA_CELLS} cells.` },
      { status: 400 }
    );
  }

  const [assets, existingObjects] = await Promise.all([
    listAssetsForCampaign(supabase, campaignId),
    listMapObjects(supabase, mapId),
  ]);

  // The model is never told about existing objects (not worth the prompt
  // weight for a rare case) — a proposal landing on one of these cells isn't
  // a mistake it could fix by retrying, so generateMapArea drops it from the
  // result instead of failing validation over it.
  const occupiedCells = new Set(
    existingObjects
      .filter((object) => object.x >= x && object.x < x + width && object.y >= y && object.y < y + height)
      .map((object) => `${object.x - x},${object.y - y}`)
  );

  try {
    const area = await generateMapArea(
      prompt,
      { width, height },
      assets.map((asset) => ({ id: asset.id, name: asset.name })),
      undefined,
      occupiedCells
    );
    return NextResponse.json({ ok: true, area });
  } catch (err) {
    if (err instanceof AreaGenerationError) {
      return NextResponse.json(
        {
          ok: false,
          message:
            "The AI couldn't produce a valid draft for this region — nothing was changed. Try rewording the description or generating again.",
        },
        { status: 502 }
      );
    }
    return NextResponse.json(
      { ok: false, message: "Couldn't generate the area — try again." },
      { status: 502 }
    );
  }
}
