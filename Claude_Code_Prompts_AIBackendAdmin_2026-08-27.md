# Multi-Provider AI Backend & Admin Settings — Prompt Plan (2026-08-27)

Four prompts, strictly sequential: D1 → D2 → D3 → D4.

**Sequencing note:** the Chat & Summary track's still-unbuilt B6 (auto-triggered
AI session summary) also uses src/ai. If this track's D1-D4 land before B6 is
built, B6 can be written provider-agnostic from the start instead of needing a
rework later. The Weather & Enemies track's C5 (global enemy template
library) needs this track's D1 (specifically its admin role) to have already
landed before C5 starts — D1 should run before C5, full stop, not just be
"coordinated" with it.

---

## D1 — Global settings data model + admin role

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: AI Backend & Admin D1

## Context
Confirmed via research: zero existing admin/global-role concept anywhere in
this codebase (grepped migrations, data-access, and application code — the
only role concept anywhere is campaign_members.role ('dm'|'player'), scoped
per-campaign, enforced by a unique partial index for exactly one DM per
campaign). No database-backed settings/config table exists anywhere — all
configuration today is environment variables read directly via process.env
(ANTHROPIC_API_KEY, SUPABASE_SERVICE_ROLE_KEY, the two NEXT_PUBLIC_* Supabase
vars). No server-side privileged/elevated-access check exists anywhere in real
application code — the service-role key is only ever used in scripts/db/*.mjs
test/ops scripts, never in a route handler, server action, or middleware. Read
src/data-access/profiles.ts's getProfile and upsertProfile in full — per
existing convention, every gated page already calls getProfile (or an
equivalent auth-and-profile check) inline near the top of its own render path,
so this is the natural, already-broadly-called place to add the admin
auto-grant check, rather than inventing a new dedicated "on login" hook that
doesn't cleanly exist anywhere in this app's current architecture (there is no
centralized post-authentication callback today — proxy.ts's middleware only
refreshes the session, it doesn't run per-user application logic). The
auto-grant needs to fire on every effective use of a signed-in session, not
only first-time profile creation, since realistically the project owner will
set ADMIN_EMAIL for an account that already exists. Per the project owner:
settings are deployment-wide (not per-campaign), database-backed (so the
settings UI in D2 can actually edit them live, no redeploy),
and the first admin is granted via an env-var-declared admin email.

**Important downstream constraint to design around now**: D3/D4 (later in
this same track) need every ordinary user — not just admins — to be able to
ask "is AI configured at all right now" (to decide whether to show a
Generate button), without being able to read the actual configured secrets.
Under the RLS this prompt is about to add, a normal user's own session cannot
read app_settings at all. Design app_settings and its access path so that gap
doesn't happen — see the Task below.

## Task
Add a migration introducing: (a) profiles.is_admin boolean not null default
false; (b) a new app_settings table holding AI provider configuration as a
single row (this is deployment-wide, not per-campaign or multi-row) —
active_provider text check (in 'anthropic','openai','ollama') default
'anthropic', openai_api_key text nullable, ollama_host_url text nullable,
ollama_model text nullable. Anthropic's own key stays exactly where it is
today (the ANTHROPIC_API_KEY env var) — don't move it into this table unless
you find a strong reason to treat all three providers identically, in which
case document that choice explicitly. Add a public.is_app_admin() SQL helper
mirroring the existing public.is_campaign_dm() pattern. RLS on app_settings:
SELECT and UPDATE restricted to is_app_admin() = true — this deliberately
means an ordinary user's own session cannot read the row at all, including
the boolean-shaped "is something configured" question; D3 is responsible for
building the separate, narrow, non-RLS'd path that answers that question
without exposing secrets (this prompt only needs to make sure app_settings
itself doesn't accidentally become world-readable to work around that — it
should not). No INSERT/DELETE policy needed if you seed the single row
directly in the migration itself.

Add the admin auto-grant check inside getProfile() itself (the natural,
already-broadly-called place per the Context note above), not a new
dedicated login hook: every time a profile is fetched for a signed-in user
whose email matches the ADMIN_EMAIL environment variable and who doesn't
already have is_admin set, set it to true. This must be idempotent and
grant-only: cheap and safe to run on every single call (a simple boolean
check before doing anything, so an already-admin user's calls are a true
no-op), and it must never revoke is_admin from someone who already has it,
even if ADMIN_EMAIL changes later or is unset entirely.

## Acceptance Criteria
- On a fresh install with ADMIN_EMAIL set, the matching user gets
  is_admin = true automatically on signup/first login.
- A user who already had an account BEFORE ADMIN_EMAIL was ever set also
  gets is_admin = true the next time they log in — verify this specific
  case explicitly, it's the realistic path or this whole mechanism doesn't
  actually work for its intended purpose.
- No other user is ever auto-granted is_admin, regardless of their email.
- A non-admin cannot read or write app_settings — verify via a direct
  authenticated API call, not just a UI check.
- An admin can read and write app_settings.
- Changing or removing ADMIN_EMAIL after the fact does not strip is_admin
  from a user who already has it.
- Running the profile-completion flow again for an already-admin user is a
  safe no-op (doesn't error, doesn't re-grant something already granted in a
  way that causes duplicate side effects).
- yarn lint / yarn tsc --noEmit / yarn test pass; a real check (Playwright or
  direct API) covers: fresh signup matching ADMIN_EMAIL becomes admin,
  fresh signup NOT matching it does not, and a non-admin's direct API
  attempt to read/write app_settings is rejected by RLS.

## Dependencies
None.

## Notes
No UI in this prompt — that's D2. This is schema, the auto-grant mechanism,
and RLS only. Keep app_settings to a single row; don't build multi-row/
multi-environment config unless something concrete requires it.
```

---

## D2 — Admin settings UI

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: AI Backend & Admin D2

## Context
Depends on D1. Per the project owner: a page-level access gate, matching how
every DM-only page in this app already self-checks today (there is no shared
"protected layout" component in this codebase, and this prompt does not
introduce one either — read how an existing DM-gated page does its own inline
session-then-role check and follow that same shape).

## Task
Add a new /admin route: check the session, then check is_admin from the
user's profile, redirect (to the Lobby or an appropriate "not authorized"
state) if either fails — a plain inline check on this one page, matching
existing convention exactly. Build a form showing and editing app_settings:
a provider selector (Anthropic / OpenAI / Ollama), an OpenAI API key field
(masked like a password field; never redisplay a previously-saved key's
actual value, only whether one is currently set, e.g. "•••• (set)" with a
way to replace it), an Ollama host URL field, an Ollama model name field.
Saving writes through D1's RLS-protected update path.

## Acceptance Criteria
- A non-admin visiting /admin is redirected/blocked — verified server-side,
  not just a hidden link.
- An admin can view current settings without ever seeing a previously-saved
  API key's plaintext value.
- Saving changes actually persists them — verify via a direct query against
  app_settings, not just a UI success toast.
- yarn lint / yarn tsc --noEmit / yarn test pass; a real Playwright check
  covers: non-admin blocked, admin views and edits settings, changes persist
  and are reflected on reload.

## Dependencies
D1.

## Notes
Keep this to the provider/settings form only — no broader admin dashboard
or unrelated management features, since none were requested.
```

---

## D3 — Provider abstraction in src/ai

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: AI Backend & Admin D3

## Context
Depends on D1 (reads its settings at runtime). Read src/ai/generateDraft.ts
and src/ai/generateMapArea.ts in full — both import @anthropic-ai/sdk
directly; generateMapArea.ts already reuses generateDraft.ts's own MODEL/
MAX_PROMPT_CHARS/isAiConfigured rather than duplicating them, which is the
existing internal-reuse convention to follow. Read eslint.config.mjs's
boundaries/elements and dependency rules — src/ai is a first-class boundaries
element and the only module allowed to import @anthropic-ai/sdk, enforced
with an explicit disallow rule and message. generateDraft.ts's
generateNarrativeDraft accepts an optional transport parameter (injecting
transport.fetch) specifically to make it testable without real network calls
— preserve this seam.

**The real access-control problem this prompt must solve**: D1's RLS
restricts app_settings to admins only, but isAiConfigured() is called from
ordinary page-level code (maps/[mapId]/edit/page.tsx, lore pages, npcs/page.tsx)
to decide whether ANY user — not just admins — sees a Generate button. Under
a normal user's own RLS-scoped session, that read is blocked, which would
silently break the Generate button for every non-admin DM. This is a real
regression versus today's behavior (isAiConfigured() currently just reads an
env var, no auth involved at all) if left unaddressed.

## Task
Introduce a common internal interface inside src/ai (e.g. a function shape
like generateText({system, prompt, maxTokens}) => Promise<string>), with
three implementations: the existing Anthropic path (refactored to fit the
interface, behavior and output unchanged), a new OpenAI implementation
(calling its chat-completions endpoint — decide whether to add the openai
npm package or use a plain fetch call, and document why), and a new Ollama
implementation (a plain fetch to the configured ollama_host_url's own
generate/chat endpoint — no SDK needed for this one). Give this
implementation TWO different timeouts, not one — conflating them would break
real usage: a short reachability check (a few seconds) purely to fail fast
with a clear "can't reach Ollama at this host" error when the URL is wrong or
the service is down, separate from a much longer, generous timeout on the
actual generation request itself (local inference on modest hardware can
legitimately take tens of seconds to a few minutes — a short timeout applied
to the real generation call would incorrectly kill genuine, working
responses). Pick a real generation timeout and document your reasoning;
don't default to the same short value used for the reachability check.

Rebuild isAiConfigured() specifically to solve the access-control problem
above: it must use a narrow, server-side-only Supabase client (the same
service-role credential pattern already used throughout this project's own
scripts/db/*.mjs scripts, now for the first time inside real application
code — this is a deliberate, novel exception, document why it's necessary:
Postgres/RLS has no visibility into the Node process's own ANTHROPIC_API_KEY
env var, so part of this check can only ever happen in application code, and
a non-admin still legitimately needs a yes/no answer without ever seeing the
underlying secrets) to read app_settings' active_provider and a
presence-only check of whichever field that provider needs. This function
must return ONLY a boolean to its caller — never the row itself, never any
secret value, regardless of who's calling it. Everywhere else in src/ai
(the actual generation calls) continues to run in whatever request context
it already runs in today; only this specific boolean check needs the
elevated read.

Add an ESLint boundaries disallow rule for any new SDK package the same way
@anthropic-ai/sdk is restricted today, so src/ai remains the sole choke point
for every provider.

## Acceptance Criteria
- Switching the active provider (via D2's UI, or directly in app_settings for
  testing) changes which backend a real generateText call actually uses.
- A non-admin DM still sees accurate Generate-button availability via
  isAiConfigured() — verify this specific case with a real non-admin session,
  since this is the regression this prompt exists to prevent.
- isAiConfigured()'s elevated read never leaks a secret value to its own
  caller — it returns a boolean only, verified by inspecting what the
  function actually returns, not just that the button renders correctly.
- An unreachable Ollama host (wrong URL, service down) fails fast with a
  clear, specific error via the short reachability check — not an indefinite
  hang.
- A slow-but-working Ollama generation (a real local model genuinely taking
  tens of seconds) is NOT killed early by the reachability check's short
  timeout — verify the longer generation timeout is what actually applies to
  a real generation call.
- Each of the three providers can genuinely complete a real generation
  request end to end when properly configured. If you cannot reach a live
  Ollama instance or a real OpenAI key in this environment, use this
  codebase's existing transport-injection pattern to test that provider's
  request-building/response-parsing logic instead, and say plainly in your
  report which providers were tested live vs. via injected transport.
- isAiConfigured() correctly reflects the ACTIVE provider's own specific
  readiness, not just Anthropic's env var.
- No module outside src/ai imports any AI SDK directly — lint-enforced for
  every provider, not just Anthropic.
- yarn lint / yarn tsc --noEmit / yarn test pass.

## Dependencies
D1.

## Notes
Preserve the transport-injection seam across all three providers, not just
Anthropic, so both existing and new tests can keep using it without hitting
real network calls.
```

---

## D4 — Wire existing consumers to the new abstraction

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: AI Backend & Admin D4

## Context
Depends on D3. Confirmed via research: six files import @/ai today —
src/app/campaigns/[id]/generate-draft/route.ts, src/app/campaigns/[id]/maps/
[mapId]/generate-area/route.ts (the two real generation call sites), and four
page-level isAiConfigured() checks (maps/[mapId]/edit/page.tsx, lore/new/
page.tsx, lore/[pageId]/page.tsx, npcs/page.tsx) that only decide whether to
render a generate button. Re-confirm this exact list against current code
before starting, since other work may have touched these files since this
research was done.

## Task
Update every one of these call sites to work correctly against D3's provider-
agnostic abstraction. Most should need no change at all if D3's interface is a
clean drop-in replacement for the old Anthropic-only functions — read each one
and only touch what actually needs it (for example, any error handling that
assumes a specific Anthropic error shape or message).

## Acceptance Criteria
- All six existing AI-generation entry points continue working exactly as
  before when Anthropic remains the active provider — a real regression
  check (exercise at least the two real generation routes end to end), not
  just a code-reading pass.
- Switching the active provider and re-testing at least one real entry point
  (generate-draft) confirms it now genuinely uses the newly-selected
  provider, not a cached/stale Anthropic call.
- yarn lint / yarn tsc --noEmit / yarn test pass.

## Dependencies
D3.

## Notes
This should be a small, mostly-verification prompt if D3's abstraction is
clean. If several call sites need substantial rework, that's a signal D3's
interface wasn't actually clean — flag that plainly rather than pushing
through messy per-call-site patches.
```
