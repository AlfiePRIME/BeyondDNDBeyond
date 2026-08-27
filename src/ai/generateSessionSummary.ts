import Anthropic from "@anthropic-ai/sdk";
import { isAiConfigured } from "./generateDraft";

/**
 * Chat & Summary B6: the end-of-session AI summary generator. Extends this
 * module's existing pattern (generateDraft's isAiConfigured gate and
 * injectable-fetch testing seam, generateMapArea's forced-tool-use +
 * validate + retry-once shape) rather than reusing either directly — the
 * input here is a full session's chat transcript plus mechanical event log,
 * not a short DM-authored brief (generateDraft's MAX_PROMPT_CHARS-bounded
 * use case) or a schema-only fill-in task (generateMapArea's region grid).
 *
 * Model choice: Sonnet, not this module's usual Haiku. generateDraft and
 * generateMapArea are both short/fast/schema-constrained tasks a DM is
 * actively waiting on in a modal; this call synthesizes a much larger and
 * more heterogeneous input (player banter, DM narration, and a mechanical
 * event log, all interleaved and out of the model's control) into coherent,
 * table-readable narrative prose that correlates against a structured
 * highlight list — closer to real creative synthesis than fill-in-the-schema
 * work, and it happens once per session end rather than in a tight
 * interactive loop, so the latency/cost step-up from Haiku is easily worth
 * the quality gain.
 *
 * One call, not two: a single forced tool-use call asks for BOTH the
 * narrative paragraph and the structured highlights in one schema, the same
 * "structured output via forced tool use is more reliable than parsing JSON
 * out of prose" reasoning generateMapArea's own README section documents —
 * Claude's tool-use handles a mixed schema (one long free-text field
 * alongside a structured array) natively; it is not "parsing JSON out of
 * prose" just because one field happens to be prose. Two independent calls
 * (one for the narrative, one for the highlights) were considered and
 * rejected: without sharing the same reasoning pass, they can drift out of
 * sync (the narrative describing a hit the highlights list omits, or vice
 * versa), and always cost double the latency and API spend for a
 * once-per-session action where that tradeoff never pays off. If real-world
 * output quality ever proves this wrong, split it — this module's own
 * generateMapArea-style validate-and-retry-once structure below already
 * isolates "the call" from "the caller", so switching to two calls later
 * doesn't reshape anything above this module.
 */
export const SESSION_SUMMARY_MODEL = "claude-sonnet-5";

// Well under the ~16K non-streaming SDK-timeout ceiling (generateMapArea's
// own MAX_AREA_TOKENS is 16000 for a much larger structured payload) — a
// narrative recap of a few paragraphs plus a bounded highlight list needs
// nowhere near Sonnet 5's 128K output ceiling, and staying non-streaming
// keeps this call as simple as generateDraft/generateMapArea's.
const MAX_SUMMARY_TOKENS = 4096;

const SUMMARY_TOOL_NAME = "record_session_summary";

/** Caps how many highlights are kept from a single generation — a session
 * recap is meant to be skimmable, not a re-transcription of every roll. */
const MAX_HIGHLIGHTS = 40;

/** Caps how many transcript lines are fed to the model — generous for a
 * single table's session (see capTranscriptLines below for what happens
 * past this), and a hard bound on prompt size/cost regardless of how chatty
 * or eventful one session gets. */
const MAX_TRANSCRIPT_LINES = 600;

export const SESSION_SUMMARY_HIGHLIGHT_KINDS = ["damage", "interaction", "other"] as const;

export type SessionSummaryHighlightKind = (typeof SESSION_SUMMARY_HIGHLIGHT_KINDS)[number];

/** One chat message, already resolved to a display name and stripped of
 * B2's "&"-formatting codes (irrelevant styling noise for a narrative
 * summary, not narrative content) — callers build this from listChatMessages
 * results, not raw ChatMessage rows. */
export interface SessionSummaryChatInput {
  senderName: string;
  body: string;
  createdAt: string;
}

/** One mechanical event line — a damage-dealing roll or an interaction_event
 * (trigger/pickup) — already rendered to a single human-readable sentence by
 * the caller (reusing the same rollHeadline/damageText/action-verb
 * conventions the DM's live Activity page, B5, already uses), so this module
 * never needs its own copy of that formatting logic. */
export interface SessionSummaryEventInput {
  category: "damage" | "interaction";
  line: string;
  createdAt: string;
}

export interface SessionSummaryWindow {
  campaignName: string;
  /** ISO timestamps — purely for the model's own sense of session length in
   * the prompt; the actual DB window enforcement happens entirely in the
   * caller's range queries before this input is ever built. */
  startedAt: string;
  endedAt: string;
  chat: SessionSummaryChatInput[];
  events: SessionSummaryEventInput[];
}

export interface SessionSummaryHighlightDraft {
  category: SessionSummaryHighlightKind;
  headline: string;
}

export interface GeneratedSessionSummary {
  narrative: string;
  highlights: SessionSummaryHighlightDraft[];
}

function isEmptyWindow(window: SessionSummaryWindow): boolean {
  return window.chat.length === 0 && window.events.length === 0;
}

function timeLabel(iso: string): string {
  // HH:MM is plenty of resolution for the model's own sense of pacing within
  // one session; the exact date/timezone doesn't matter for a same-session
  // transcript.
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "??:??" : date.toISOString().slice(11, 16);
}

interface TranscriptLine {
  at: string;
  text: string;
}

/**
 * Keeps the transcript's first and last halves when it exceeds the cap,
 * with an explicit omission marker in between — preserves how the session
 * opened and how it ended (the two spans most likely to matter for a
 * recap's shape) rather than an arbitrary head-only or tail-only truncation.
 */
function capTranscriptLines(lines: TranscriptLine[], max: number): TranscriptLine[] {
  if (lines.length <= max) return lines;
  const head = Math.ceil(max / 2);
  const tail = Math.floor(max / 2);
  const omitted = lines.length - head - tail;
  return [
    ...lines.slice(0, head),
    { at: lines[head].at, text: `… ${omitted} earlier line${omitted === 1 ? "" : "s"} omitted …` },
    ...lines.slice(lines.length - tail),
  ];
}

function buildTranscript(window: SessionSummaryWindow): string {
  const lines: TranscriptLine[] = [
    ...window.chat.map((message) => ({
      at: message.createdAt,
      text: `${timeLabel(message.createdAt)} ${message.senderName} (chat): ${message.body}`,
    })),
    ...window.events.map((event) => ({
      at: event.createdAt,
      text: `${timeLabel(event.createdAt)} ${event.category}: ${event.line}`,
    })),
  ].sort((a, b) => a.at.localeCompare(b.at));

  return capTranscriptLines(lines, MAX_TRANSCRIPT_LINES)
    .map((line) => line.text)
    .join("\n");
}

const SYSTEM_PROMPT = [
  "You are a prep assistant for a Dungeons & Dragons 5e campaign, writing the",
  "end-of-session recap immediately after the DM ends a session.",
  "You are given the campaign's name and a chronological transcript",
  "interleaving player/DM chat messages with short mechanical event lines",
  `(damage dealt, and objects triggered or items taken). Call the ${SUMMARY_TOOL_NAME}`,
  "tool with:",
  "- narrative: two to four short paragraphs of plain prose recapping what",
  "  happened this session, written for the whole party to read afterward.",
  "  Table-usable, in-world-flavored prose — no markdown headings, no bullet",
  '  lists, and no preamble like "Here is your recap".',
  "- highlights: a list of short, one-line mechanical highlights pulled from",
  "  the transcript — who damaged what (and how much, when notable), and who",
  '  triggered or took what. Each highlight has a category ("damage",',
  '  "interaction", or "other" for anything narratively significant that',
  "  isn't either) and a headline (a single plain sentence, no markdown).",
  "  Keep the list focused on what's actually notable — skip routine or",
  "  trivial rolls rather than listing every single die. An empty list is",
  "  correct when nothing mechanical stood out.",
].join(" ");

/** Exported for unit tests — the exact request body sent to the Messages
 * API. Structured output via forced tool use, the generateMapArea
 * precedent: far more reliable than parsing JSON out of prose, and handles
 * a mixed schema (one prose field alongside a structured array) natively. */
export function buildSessionSummaryRequest(
  window: SessionSummaryWindow,
  feedback?: string
): Anthropic.MessageCreateParamsNonStreaming {
  const transcript = buildTranscript(window);
  const userContent = [
    `Campaign: ${window.campaignName}`,
    `Session window: ${window.startedAt} to ${window.endedAt}`,
    "",
    "Transcript (chronological):",
    transcript || "(no chat or activity recorded this session)",
  ].join("\n");

  return {
    model: SESSION_SUMMARY_MODEL,
    max_tokens: MAX_SUMMARY_TOKENS,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: feedback
          ? `${userContent}\n\nYour previous proposal was rejected: ${feedback}\nProduce a corrected proposal that follows every rule.`
          : userContent,
      },
    ],
    tools: [
      {
        name: SUMMARY_TOOL_NAME,
        description:
          "Record the end-of-session summary: a narrative recap paragraph plus a structured list of mechanical highlights.",
        strict: true,
        input_schema: {
          type: "object",
          additionalProperties: false,
          required: ["narrative", "highlights"],
          properties: {
            narrative: { type: "string" },
            highlights: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["category", "headline"],
                properties: {
                  category: { type: "string", enum: [...SESSION_SUMMARY_HIGHLIGHT_KINDS] },
                  headline: { type: "string" },
                },
              },
            },
          },
        },
      },
    ],
    tool_choice: { type: "tool", name: SUMMARY_TOOL_NAME },
  };
}

/** Exported for unit tests — pulls the structured draft out of an API
 * response. Returns unknown: the shape is only trusted after validation. */
export function extractSessionSummaryDraft(message: Anthropic.Message): unknown {
  const block = message.content.find(
    (candidate): candidate is Anthropic.ToolUseBlock =>
      candidate.type === "tool_use" && candidate.name === SUMMARY_TOOL_NAME
  );
  if (!block) {
    throw new Error("The model returned no structured session summary.");
  }
  return block.input;
}

export type SessionSummaryValidation =
  | { ok: true; summary: GeneratedSessionSummary }
  | { ok: false; reason: string };

/**
 * The server-side gate between the model's output and anything a DM ever
 * sees — nothing from the model is trusted, including the shape itself
 * (strict tool use is belt; this is braces), matching
 * validateGeneratedArea's own posture in this module.
 */
export function validateGeneratedSessionSummary(draft: unknown): SessionSummaryValidation {
  const record = draft as { narrative?: unknown; highlights?: unknown } | null;
  if (!record || typeof record !== "object" || typeof record.narrative !== "string" || !Array.isArray(record.highlights)) {
    return { ok: false, reason: "draft is not an object with a narrative string and a highlights array" };
  }

  const narrative = record.narrative.trim();
  if (!narrative) {
    return { ok: false, reason: "narrative must not be empty" };
  }

  const problems: string[] = [];
  const highlights: SessionSummaryHighlightDraft[] = [];
  for (const raw of record.highlights.slice(0, MAX_HIGHLIGHTS)) {
    const item = raw as { category?: unknown; headline?: unknown };
    if (!SESSION_SUMMARY_HIGHLIGHT_KINDS.includes(item.category as SessionSummaryHighlightKind)) {
      problems.push("a highlight has an invalid category");
      continue;
    }
    if (typeof item.headline !== "string" || !item.headline.trim()) {
      problems.push("a highlight is missing a headline");
      continue;
    }
    highlights.push({
      category: item.category as SessionSummaryHighlightKind,
      headline: item.headline.trim().slice(0, 300),
    });
  }

  if (problems.length > 0) {
    return { ok: false, reason: problems.slice(0, 5).join("; ") };
  }
  return { ok: true, summary: { narrative, highlights } };
}

/** Thrown when the model failed validation twice — the AreaGenerationError
 * precedent: callers surface this as a clear generation-failed message, and
 * (per this prompt's own Notes) the DM can always fall back to writing the
 * narrative by hand in the same preview/edit screen rather than being
 * blocked from ending the session. */
export class SessionSummaryGenerationError extends Error {}

/**
 * Generates a two-part end-of-session summary (narrative recap + structured
 * highlights) for one session's full start-to-end window. Requires
 * ANTHROPIC_API_KEY — callers should gate on isAiConfigured() first, same as
 * every other generator in this module — EXCEPT for a session with no chat
 * and no activity at all: that case returns an explicitly-empty summary
 * immediately, without an API call, regardless of whether AI is configured
 * (there is nothing to summarize either way, and this is the "completes
 * gracefully, not an error" case this prompt's Acceptance Criteria call
 * out). On a validation failure the call retries exactly once, feeding the
 * validation errors back to the model; a second failure throws
 * SessionSummaryGenerationError. Same injectable-fetch testing seam as
 * generateNarrativeDraft/generateMapArea.
 */
export async function generateSessionSummary(
  window: SessionSummaryWindow,
  transport?: { fetch?: typeof fetch }
): Promise<GeneratedSessionSummary> {
  if (isEmptyWindow(window)) {
    return { narrative: "", highlights: [] };
  }
  if (!isAiConfigured()) {
    throw new Error("ANTHROPIC_API_KEY is not configured.");
  }

  const client = new Anthropic({ fetch: transport?.fetch });
  const first = await client.messages.create(buildSessionSummaryRequest(window));
  const firstResult = validateGeneratedSessionSummary(extractSessionSummaryDraft(first));
  if (firstResult.ok) return firstResult.summary;

  const second = await client.messages.create(buildSessionSummaryRequest(window, firstResult.reason));
  const secondResult = validateGeneratedSessionSummary(extractSessionSummaryDraft(second));
  if (secondResult.ok) return secondResult.summary;

  throw new SessionSummaryGenerationError(
    `The model produced an invalid session summary twice: ${secondResult.reason}`
  );
}
