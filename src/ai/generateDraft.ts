import { generateText } from "./generateText";
import { isAiConfigured } from "./activeProvider";
import { ANTHROPIC_TEXT_MODEL } from "./providers/anthropic";

/** Which editor the draft is for — picks the system prompt and prose shape. */
export type DraftKind = "npc" | "lore";

// Re-exported so generateMapArea.ts/generateSessionSummary.ts's own direct
// (structured, forced-tool-use) Anthropic calls keep using the same model
// constant they always have — see providers/anthropic.ts for the constant
// itself and this directory's README for why those two call sites stay
// Anthropic-only rather than going through generateText().
export const MODEL = ANTHROPIC_TEXT_MODEL;

// Re-exported: AI Backend & Admin D3 rebuilt isAiConfigured() to check
// app_settings' active_provider via a narrow service-role read (see
// activeProvider.ts's own header comment for the full access-control
// story) instead of just reading ANTHROPIC_API_KEY — every existing
// consumer of `isAiConfigured` from "@/ai" or "./generateDraft" keeps
// working unchanged, now `Promise<boolean>` instead of `boolean`.
export { isAiConfigured };

const MAX_DRAFT_TOKENS = 1024;

export const MAX_PROMPT_CHARS = 500;

const SYSTEM_PROMPTS: Record<DraftKind, string> = {
  npc: [
    "You are a prep assistant for a Dungeons & Dragons 5e campaign.",
    "The DM will give you a short brief for a non-player character; write the",
    "description field of their NPC roster entry. Two or three short paragraphs",
    "of evocative, table-usable prose: appearance and manner, how they speak and",
    "act, and any hook or secret the brief implies. Plain prose only — no",
    "markdown headings, no stat blocks, no bullet lists, and no preamble like",
    '"Here is your NPC". Do not invent a name if the brief doesn\'t give one;',
    'refer to them by role (e.g. "the dockworker") instead.',
  ].join(" "),
  lore: [
    "You are a prep assistant for a Dungeons & Dragons 5e campaign.",
    "The DM will give you a short brief for a page in their campaign's lore",
    "wiki; write the body of that page. Two to four short paragraphs in an",
    "in-world encyclopedia tone: what the place, faction, event, or thing is,",
    "its history or significance, and a rumor or unresolved thread the DM can",
    "pull on later. Plain prose only — no markdown headings, no bullet lists,",
    'and no preamble like "Here is your lore page".',
  ].join(" "),
};

/**
 * Generate a short editable draft (an NPC description or a lore-page body)
 * from the DM's plain-language brief. Requires the active provider to be
 * configured — callers should gate on isAiConfigured() first. Behavior and
 * output are unchanged from before D3 when Anthropic is the active
 * provider (the default): same system prompts, same MAX_DRAFT_TOKENS, same
 * MAX_PROMPT_CHARS truncation. Which backend actually runs the generation
 * is now decided by generateText() (see that file) based on
 * app_settings.active_provider, rather than always being Anthropic.
 *
 * `transport.fetch` is the same injectable seam as before D3: whichever
 * provider ends up handling the call routes every HTTP request through it,
 * so both unit tests and end-to-end runs can substitute a fake response
 * without a real key, real network access, or a real chosen provider.
 */
export async function generateNarrativeDraft(
  prompt: string,
  kind: DraftKind,
  transport?: { fetch?: typeof fetch }
): Promise<string> {
  if (!(await isAiConfigured())) {
    throw new Error("AI generation is not configured.");
  }
  const trimmed = prompt.trim();
  if (!trimmed) {
    throw new Error("A prompt is required to generate a draft.");
  }
  return generateText(
    {
      system: SYSTEM_PROMPTS[kind],
      prompt: trimmed.slice(0, MAX_PROMPT_CHARS),
      maxTokens: MAX_DRAFT_TOKENS,
    },
    transport
  );
}
