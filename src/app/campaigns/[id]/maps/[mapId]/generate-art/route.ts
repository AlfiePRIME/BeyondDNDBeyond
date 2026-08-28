import { NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/data-access/supabase-server";
import { getMap, getRawMapArtConfig, isDM, isMapArtConfigured, listMapCells } from "@/data-access";
import {
  ComfyUiGenerationError,
  ComfyUiTimeoutError,
  ComfyUiUnreachableError,
  ComfyUiWorkflowRejectedError,
  generateMapArt,
} from "@/image-ai";
import { renderMapArtControlImage } from "../../lib/controlImage";
import { encodeRgbPng } from "../../lib/png";
import { buildMapArtPrompt } from "../../lib/mapArtPrompt";
import { DEFAULT_CELL, overlayFromRows } from "../edit/lib/cellGrid";

// Same auth/gating shape as generate-area/route.ts (E1's own sibling
// feature): server Supabase client for auth, RLS + explicit DM gate, then
// delegate to the dedicated generation module (@/image-ai here,
// @/ai for generate-area) — never a direct ComfyUI call from this file
// itself (see eslint.config.mjs's image-ai boundary).
//
// Unlike generate-area, this returns the generated PNG directly in the JSON
// response (as a data: URL) rather than persisting anything — nothing is
// written to Storage or the map_art table until the DM explicitly accepts,
// which happens entirely client-side (MapEditor.tsx uploads the accepted
// Blob straight to the map-art bucket and writes the map_art row under the
// DM's own session, the same direct-from-client pattern
// uploadMapReferenceImageFile/setMapReferenceImage already use) — this route
// only ever produces a preview.

const MAX_STYLE_PROMPT_CHARS = 500;

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
      { ok: false, message: "You must be signed in to generate map art." },
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
      { ok: false, message: "Only the DM can generate map art." },
      { status: 403 }
    );
  }

  const map = await getMap(supabase, mapId);
  if (!map || map.campaign_id !== campaignId) {
    return NextResponse.json({ ok: false, message: "Map not found." }, { status: 404 });
  }

  if (!(await isMapArtConfigured())) {
    return NextResponse.json(
      { ok: false, message: "Map art generation isn't configured on this server." },
      { status: 503 }
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, message: "Malformed request." }, { status: 400 });
  }
  const { stylePrompt } = (body ?? {}) as { stylePrompt?: unknown };
  if (stylePrompt !== undefined && typeof stylePrompt !== "string") {
    return NextResponse.json({ ok: false, message: "stylePrompt must be a string." }, { status: 400 });
  }
  if (typeof stylePrompt === "string" && stylePrompt.length > MAX_STYLE_PROMPT_CHARS) {
    return NextResponse.json(
      { ok: false, message: `Keep the style prompt under ${MAX_STYLE_PROMPT_CHARS} characters.` },
      { status: 400 }
    );
  }

  // The DM's own service-role-backed read of the REAL host URL/style-prompt
  // default — isMapArtConfigured() above only ever answers a boolean, never
  // the values a real generation call needs. See getRawMapArtConfig's own
  // doc comment for why a DM who isn't the app admin can still reach this.
  const config = await getRawMapArtConfig();
  if (!config?.hostUrl) {
    return NextResponse.json(
      { ok: false, message: "Map art generation isn't configured on this server." },
      { status: 503 }
    );
  }

  // A blank DM prompt falls back to the admin's own default style
  // (app_settings.comfyui_style_prompt, E2); buildMapArtPrompt's own generic
  // closing line is the last resort if BOTH are blank.
  const dmStyle = typeof stylePrompt === "string" ? stylePrompt.trim() : "";
  const resolvedStyleNote = dmStyle || config.stylePrompt?.trim() || undefined;

  const cells = await listMapCells(supabase, mapId);
  const overlay = overlayFromRows(cells);
  const control = renderMapArtControlImage(map.grid_width, map.grid_height, overlay);
  const controlImagePng = encodeRgbPng(control.width, control.height, control.rgb);
  const prompt = buildMapArtPrompt(map.grid_width, map.grid_height, overlay, DEFAULT_CELL, resolvedStyleNote);

  try {
    const result = await generateMapArt({
      hostUrl: config.hostUrl,
      controlImagePng,
      width: control.width,
      height: control.height,
      prompt,
    });
    return NextResponse.json({
      ok: true,
      image: {
        dataUrl: `data:image/png;base64,${result.png.toString("base64")}`,
        width: result.width,
        height: result.height,
      },
      stylePrompt: resolvedStyleNote ?? "",
    });
  } catch (err) {
    if (err instanceof ComfyUiUnreachableError) {
      return NextResponse.json(
        { ok: false, message: `Could not reach the ComfyUI server: ${err.message}` },
        { status: 503 }
      );
    }
    if (err instanceof ComfyUiTimeoutError) {
      return NextResponse.json(
        { ok: false, message: `Map art generation timed out: ${err.message}` },
        { status: 504 }
      );
    }
    if (err instanceof ComfyUiWorkflowRejectedError || err instanceof ComfyUiGenerationError) {
      return NextResponse.json(
        { ok: false, message: `Map art generation failed: ${err.message}` },
        { status: 502 }
      );
    }
    return NextResponse.json(
      { ok: false, message: "Couldn't generate map art — try again." },
      { status: 502 }
    );
  }
}
