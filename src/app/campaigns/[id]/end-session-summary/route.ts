import { NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/data-access/supabase-server";
import {
  isDM,
  listCampaignMembers,
  listChatMessagesInRange,
  listInteractionEventsInRange,
  listRollLogInRange,
  type InteractionEvent,
  type RollLogEntry,
} from "@/data-access";
import {
  generateSessionSummary,
  isAnthropicConfigured,
  SessionSummaryGenerationError,
  type SessionSummaryEventInput,
} from "@/ai";
import { parseChatFormatting } from "@/ui-components";
import { damageText, rollHeadline } from "../roll/format";

// Chat & Summary B6: generates (never saves) an end-of-session summary
// preview. Same auth/DM-gating shape as generate-draft/generate-area's own
// Route Handlers — server Supabase client for auth, RLS + explicit DM gate,
// then delegate to @/ai — but this route ALSO does the gathering: reading
// the campaign's open session window and everything that happened inside
// it, server-side, using the DM's own authenticated (RLS-scoped) client,
// rather than trusting anything the browser claims about session content.
//
// Saving is deliberately NOT this route's job: createSessionLogEntry,
// createSessionSummaryHighlights, and endSession are all ordinary
// data-access calls a DM's browser client can already make directly under
// their own existing RLS (the same pattern SessionLog.tsx's manual recap
// flow and StartSessionControl's startSession call already use) — the only
// reason a server round-trip exists at all here is to keep ANTHROPIC_API_KEY
// server-side. The client calls this route once for a preview, lets the DM
// edit it, and on confirm writes everything directly, exactly like every
// other AI-drafted content in this app (generateNarrativeDraft/
// generateMapArea) is reviewed before its own, separate save action.

const ACTION_VERBS: Record<string, string> = {
  step_on_trigger: "stepped on",
  click_trigger: "triggered",
  item_taken: "took",
  curse_narrative: "triggered a curse via",
  blessing_narrative: "triggered a blessing via",
};

function actionVerb(actionType: string): string {
  return ACTION_VERBS[actionType] ?? actionType.replace(/_/g, " ");
}

// Mirrors DmBookActivityPage's own targetLabel — kept as a small local copy
// rather than an import: that component is a "use client" file and doesn't
// export this helper, and the logic is a few lines that read the same way
// here as they do on the DM's live Activity feed, which is the point (the
// AI's structured highlights and the raw feed describe the same events the
// same way).
function targetLabel(event: InteractionEvent): string {
  if (event.tag) return `"${event.tag}"`;
  return event.map_object_id ? "an untagged object" : "a concealed pit";
}

function isDamageRoll(roll: RollLogEntry): boolean {
  return roll.breakdown.type === "d20" && Boolean(roll.breakdown.attack?.damage);
}

/** Raw chat bodies still carry B2's "&"-formatting codes verbatim (chat.ts's
 * own storage contract) — irrelevant styling noise for a narrative summary,
 * not narrative content, so this strips them by reusing B2's own tested
 * parser rather than a second ad hoc regex. */
function plainChatText(raw: string): string {
  return parseChatFormatting(raw)
    .map((span) => span.text)
    .join("");
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: campaignId } = await params;

  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json(
      { ok: false, message: "You must be signed in to generate a session summary." },
      { status: 401 }
    );
  }

  const { data: campaign, error } = await supabase
    .from("campaigns")
    .select("id, name, session_started_at")
    .eq("id", campaignId)
    .maybeSingle();
  if (error) throw error;
  if (!campaign) {
    return NextResponse.json({ ok: false, message: "Campaign not found." }, { status: 404 });
  }

  if (!(await isDM(supabase, campaignId, user.id))) {
    return NextResponse.json(
      { ok: false, message: "Only the DM can generate an end-of-session summary." },
      { status: 403 }
    );
  }

  const endedAt = new Date();
  // A null session_started_at at this point means either a pre-B6 session
  // that was already active before this migration ran (no recorded start to
  // recover) or a genuine edge case where End Session was pressed with no
  // open window at all — either way, the graceful fallback is an empty
  // window (an explicitly-empty summary, never an error) rather than
  // guessing at an arbitrary lookback period that could pull in an unrelated
  // prior session's chat.
  const startedAt = campaign.session_started_at ? new Date(campaign.session_started_at) : endedAt;
  const startIso = startedAt.toISOString();
  const endIso = endedAt.toISOString();

  const [chatRows, interactionRows, rollRows, members] = await Promise.all([
    listChatMessagesInRange(supabase, campaignId, startIso, endIso),
    listInteractionEventsInRange(supabase, campaignId, startIso, endIso),
    listRollLogInRange(supabase, campaignId, startIso, endIso),
    listCampaignMembers(supabase, campaignId),
  ]);

  const nameById = new Map(members.map((member) => [member.user_id, member.display_name]));
  const actorName = (id: string | null) => (id ? (nameById.get(id) ?? "Someone") : "Someone");

  const chat = chatRows.map((row) => ({
    senderName: actorName(row.sender_user_id),
    body: plainChatText(row.body),
    createdAt: row.created_at,
  }));

  const events: SessionSummaryEventInput[] = [
    ...interactionRows.map((row) => ({
      category: "interaction" as const,
      line: `${actorName(row.actor_user_id)} ${actionVerb(row.action_type)} ${targetLabel(row)}`,
      createdAt: row.created_at,
    })),
    ...rollRows.filter(isDamageRoll).map((row) => {
      const attack = row.breakdown.type === "d20" ? row.breakdown.attack : undefined;
      const detail = attack ? damageText(attack) : null;
      return {
        category: "damage" as const,
        line: `${actorName(row.roller_user_id)}: ${rollHeadline(row)}${detail ? ` — ${detail}` : ""}`,
        createdAt: row.created_at,
      };
    }),
  ];

  const window = { campaignName: campaign.name, startedAt: startIso, endedAt: endIso, chat, events };
  const windowIsEmpty = chat.length === 0 && events.length === 0;

  // Both the empty-window case and an unconfigured server return the SAME
  // graceful shape: no error, an explicitly-empty draft the DM can still
  // write by hand in the preview/edit screen — ending a session must always
  // be possible, AI-configured or not, matching every other AI-assisted
  // surface in this app (GenerateDraftControl's own "AI drafting is off —
  // everything else works without it").
  if (windowIsEmpty || !isAnthropicConfigured()) {
    return NextResponse.json({
      ok: true,
      narrative: "",
      highlights: [],
      aiGenerated: false,
      windowStartedAt: startIso,
      windowEndedAt: endIso,
    });
  }

  try {
    const summary = await generateSessionSummary(window);
    return NextResponse.json({
      ok: true,
      narrative: summary.narrative,
      highlights: summary.highlights,
      aiGenerated: true,
      windowStartedAt: startIso,
      windowEndedAt: endIso,
    });
  } catch (err) {
    if (err instanceof SessionSummaryGenerationError) {
      return NextResponse.json(
        {
          ok: false,
          message: "The AI couldn't produce a valid session summary — write one manually below.",
        },
        { status: 502 }
      );
    }
    return NextResponse.json(
      { ok: false, message: "Couldn't generate a session summary — try again, or write one manually below." },
      { status: 502 }
    );
  }
}
