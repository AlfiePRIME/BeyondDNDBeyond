# ai

LLM text generation behind a small typed interface — every call to the Anthropic API goes
through this module; no other module (and never the browser) talks to it directly. Module
boundary registered in `eslint.config.mjs` alongside the original five from Prompt 2, with
the same two enforcement rules: only this module may import `@anthropic-ai/sdk`, and other
modules import the barrel (`@/ai`), not internal files.

**This is the app's one deliberate exception to being fully self-hosted.** Everything else
runs on the local Supabase stack; this module calls the external Anthropic API and needs its
own credential, `ANTHROPIC_API_KEY` (see `.env.example`). The key is optional — with it
unset, `isAiConfigured()` is false and every AI-assisted surface hides itself with an
explanation instead of erroring. The key lives only in the server process's environment:
client components receive a boolean derived from `isAiConfigured()` in a Server Component
and call a Route Handler; nothing key-shaped ever reaches a client bundle.

As of Prompt 37, `generateDraft.ts`:

- `isAiConfigured()` — whether `ANTHROPIC_API_KEY` is set. Server-side only.
- `generateNarrativeDraft(prompt, kind)` — a short editable draft from a DM's
  plain-language brief, `kind: "npc" | "lore"` selecting a per-kind system prompt (an NPC
  draft reads like a roster description, a lore draft like a wiki entry). Runs on
  `claude-haiku-4-5-20251001` — the fast/cheap tier is the right fit for short creative
  drafts a DM is actively waiting on. Consumed by the DM-gated Route Handler at
  `src/app/campaigns/[id]/generate-draft/route.ts`, whose UI (the NPC roster and lore-page
  editors) shows the result as pre-filled, fully editable, not-yet-saved form content —
  the same review-before-save shape as the D&D Beyond import.

Testability without a key: the network call is injectable — `generateNarrativeDraft`
accepts a custom `fetch` (unit tests substitute a canned Messages API response), and the
underlying SDK honors `ANTHROPIC_BASE_URL`, so an end-to-end run can point the server at a
local fake. `buildDraftRequest`/`extractDraftText` are exported for direct unit testing of
prompt construction and response handling.

Prompt 38 (map-content generation) should extend this module rather than creating a second
API client.
