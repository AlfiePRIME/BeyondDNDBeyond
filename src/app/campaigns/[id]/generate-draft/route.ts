import { NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/data-access/supabase-server";
import { isDM } from "@/data-access";
import { generateNarrativeDraft, isAiConfigured, MAX_PROMPT_CHARS, type DraftKind } from "@/ai";

// Same server-only-heavy-work-behind-a-small-HTTP-interface shape as the
// character import's parse route: auth via the server Supabase client,
// membership via RLS, then delegate. The Anthropic call lives here (never in
// the browser) so ANTHROPIC_API_KEY stays server-side.

function isDraftKind(value: unknown): value is DraftKind {
  return value === "npc" || value === "lore";
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: campaignId } = await params;

  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json(
      { ok: false, message: "You must be signed in to generate a draft." },
      { status: 401 }
    );
  }

  // RLS hides campaigns you're not a member of — same 404 reasoning as the
  // parse route.
  const { data: campaign, error } = await supabase
    .from("campaigns")
    .select("id")
    .eq("id", campaignId)
    .maybeSingle();
  if (error) throw error;
  if (!campaign) {
    return NextResponse.json({ ok: false, message: "Campaign not found." }, { status: 404 });
  }

  // Both consuming editors (NPC roster, lore pages) are DM-only, and each
  // generation spends real API credit — so unlike the parse route this one
  // is DM-gated, not just member-gated.
  if (!(await isDM(supabase, campaignId, user.id))) {
    return NextResponse.json(
      { ok: false, message: "Only the DM can generate drafts." },
      { status: 403 }
    );
  }

  if (!isAiConfigured()) {
    // The UI hides the generate action when unconfigured, so this only
    // guards direct calls.
    return NextResponse.json(
      { ok: false, message: "AI drafting isn't configured on this server." },
      { status: 503 }
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, message: "Malformed request." }, { status: 400 });
  }
  const { prompt, kind } = (body ?? {}) as { prompt?: unknown; kind?: unknown };
  if (typeof prompt !== "string" || !prompt.trim() || !isDraftKind(kind)) {
    return NextResponse.json(
      { ok: false, message: "A prompt and a draft kind are required." },
      { status: 400 }
    );
  }
  if (prompt.length > MAX_PROMPT_CHARS) {
    return NextResponse.json(
      { ok: false, message: `Keep the prompt under ${MAX_PROMPT_CHARS} characters.` },
      { status: 400 }
    );
  }

  try {
    const draft = await generateNarrativeDraft(prompt, kind);
    return NextResponse.json({ ok: true, draft });
  } catch {
    return NextResponse.json(
      { ok: false, message: "Couldn't generate a draft — try again." },
      { status: 502 }
    );
  }
}
