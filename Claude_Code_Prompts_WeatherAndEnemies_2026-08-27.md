# Weather Effects & Enemy Library — Prompt Plan (2026-08-27)

Seven prompts. C1 is foundational for C2/C3/C4 (all layer their actual visual
effects on top of C1's shared weather-state plumbing). C5 is foundational for
C6/C7 (the enemy template library, then default visuals, then per-campaign
custom overrides). The two halves (weather vs. enemies) are otherwise fully
independent of each other and can run in parallel.

**Cross-track sequencing requirement:** run the AI Backend & Admin track's D1
(global settings + admin role) BEFORE this track's C5. C5's global enemy
template list needs a real `is_app_admin()` write-gate from day one — no
placeholder/temporary gate on a shared, cross-campaign-visible table.

**Recommended execution order:** C1 → (C2, C5 in parallel, with C5 only
starting once Track D's D1 has landed) → (C3, C4, C6 in parallel) → C7.

---

## C1 — Weather data model + DM controls

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: Weather & Enemies C1

## Context
Read the existing day/night toggle in full — it's the direct architectural
precedent for this feature: supabase/migrations/0041_day_night_mode.sql (a
plain campaigns column, no new RLS policy needed since the existing
"members can update their campaigns" policy already covers it),
src/data-access/campaigns.ts's setDayNightMode (DM-only check, zero-rows-
affected guard), src/scene-3d/GameTableScene.tsx's DAY_NIGHT_PRESETS object
and how it's applied via a plain <fog attach="fog"> element and light
components, and wherever the DM's book exposes its Day/Night page. Confirm: no
fog/rain/weather/particle-effect concept exists anywhere else in this codebase
today.

## Task
Add a new weather concept alongside day/night, following the exact same
pattern: a plain campaigns.weather_kind text column (check constraint: 'clear'
| 'fog' | 'rain' | 'thunderstorm' | 'firestorm' | 'acid_storm', default
'clear') and a campaigns.weather_mechanical boolean (default false, only
meaningful for firestorm/acid_storm — later prompts use this). No new RLS
policy needed. Add setWeather(supabase, campaignId, kind, mechanical) to
campaigns.ts mirroring setDayNightMode's shape exactly. Add a Weather page (or
section of the existing Day/Night page — your call once you see the book's
layout) to the DM's book with controls to pick the current weather; sync rides
the existing subscribeToCampaignChanges. For THIS prompt, only make 'clear' and
'fog' actually render something — fog extends the existing <fog> mechanism:
decide and document how day/night's own fog values and weather's fog values
compose when both are active at once (e.g. weather's fog, when set to 'fog',
overrides the day/night preset's own fog near/far/color; when weather is
'clear', day/night's own fog stands unchanged). Add a hidden
data-testid="weather-state" mirror div in GameRoom.tsx matching the existing
day-night-state precedent, so Playwright can read the applied state without
pixel-diffing WebGL output.

## Acceptance Criteria
- DM-only control to set the campaign's current weather; a non-DM cannot
  change it (RLS-enforced).
- The chosen weather syncs live to every connected client, not just the
  DM's own.
- Selecting 'fog' visibly changes the scene's fog to a distinct, foggier
  look than either day or night's own default fog.
- Selecting 'clear' behaves identically to today (zero visual change) —
  verify no regression to the existing day/night rendering.
- Day/night and weather compose sensibly with no fighting over fog values —
  document and test the exact composition rule you chose.
- yarn lint / yarn tsc --noEmit / yarn test pass; a real Playwright check
  covers setting weather as the DM, confirming a second connected client
  sees it live, and confirming 'clear' vs 'fog' actually differ visually
  (via the hidden state mirror plus a real fog-value read, not a screenshot
  diff).

## Dependencies
None.

## Notes
This prompt is pure plumbing plus the simplest possible visual (fog) — rain,
thunder, and fantasy weather are separate prompts that build their actual
effects on top of the weather_kind value this prompt introduces. Don't try to
build any of those here.
```

---

## C2 — Rain via Droplets

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: Weather & Enemies C2

## Context
Depends on C1. Read src/ui-components/canvasui/Glitch.tsx and VHS.tsx in full
— these are this project's own local ports of components from the open-source
"Canvas UI" library (github.com/DavidHDev/canvas-ui), sharing a consistent
source/content/output canvas-triple architecture: a WebGL shader wraps
arbitrary HTML content captured onto a canvas. The upstream library's own
"Droplets" component (documented at canvasui.dev/docs/components/droplets) is
a screen-space WebGL shader effect simulating rain running down glass with
refraction of whatever's behind it, exposing options including intensity
(0-1.25), speed, drop width/length, refraction strength, blur, vignette
darkening, tint color/strength, and interactive pointer-wipe. This is the
exact effect the project owner asked for by name — port it into
src/ui-components/canvasui/Droplets.tsx following the SAME integration
pattern as the existing four components (Glitch, VHS, Peel, ForceField) —
this is copied/adapted source code matching how those were integrated, not a
new npm dependency.

## Task
**Start with a short technical spike before committing to the full build**:
Glitch.tsx/VHS.tsx capture *static HTML* onto a canvas (via the experimental
Canvas 2D `drawElementImage()`-style approach) and feed that into their own
WebGL shader. Droplets needs to wrap the Game Room's own R3F `<Canvas>` — a
second, continuously-updating WebGL surface, not static HTML — and re-compare
that every frame inside Droplets' own shader. Capturing one live WebGL
canvas's output into another WebGL context has real, different technical
constraints from capturing static HTML (canvas tainting, whether
`preserveDrawingBuffer` is enabled on the underlying renderer, capture timing
relative to each frame). Before writing the full component, spend up to
roughly the first fifth of this prompt's effort confirming a live capture
of the Game Room's actual `<Canvas>` output actually reaches Droplets' shader
correctly (a simple visible proof, e.g. render the captured frame directly
without any rain effect yet, and confirm it visibly matches the live scene
with no lag/tearing). If that path turns out to be significantly harder than
Glitch/VHS's own static-HTML capture, document exactly why and use whichever
fallback is simplest to get genuinely working (e.g. reading the R3F
renderer's own `domElement`/WebGL context directly rather than going through
Glitch's DOM-capture path) — report this decision plainly rather than
shipping a broken or silently-degraded capture.

Once capture is confirmed working, add Droplets.tsx to the canvasui component
family and mount it in GameRoom.tsx as an always-present overlay that is only
visually active when weather_kind is 'rain' (leave 'thunderstorm' for the next
prompt, which reuses this same component). Wire a single reasonable default
intensity/speed — this prompt does not need a fine-tuning UI for all of the
upstream component's options, a plain on/off via C1's weather picker is
enough.

## Acceptance Criteria
- Selecting "rain" shows real rain-on-glass refraction over the Game Room
  view — an actual WebGL shader effect visible in a screenshot, not a
  placeholder or a simple CSS animation.
- Every connected client sees the same effect when weather is 'rain'.
- Switching to a different weather or 'clear' removes it cleanly.
- The captured background genuinely tracks the live 3D scene frame-to-frame
  (no visible lag, freezing, or tearing between what's happening in the
  scene and what Droplets is refracting).
- No measurable regression to the underlying 3D scene's interactivity —
  clicking cells, dragging chairs, opening panels all still work normally
  with rain active (the overlay must not capture pointer events meant for
  the scene beneath it, aside from Droplets' own optional interactive wipe
  feature, which should be left off for this prompt unless it's clearly
  harmless).
- **Real measured performance, not an assumption**: follow this project's own
  established precedent from the dice-physics work (which benchmarked actual
  ms/frame to empirically set MAX_PHYSICS_DICE_PER_ROLL rather than trusting
  an estimate) — measure real frame time with rain off vs. rain on in the
  Game Room and report the actual numbers. If the overlay measurably degrades
  frame time, say so and document the impact rather than asserting "no
  regression" without evidence.
- yarn lint / yarn tsc --noEmit / yarn test pass; a real Playwright check
  with two connected clients confirms rain is visible to both when active
  and gone when weather changes, and confirms normal Game Room interactions
  still work with rain on.

## Dependencies
C1.

## Notes
Get the actual visual refraction effect genuinely working before considering
this done — a fallback/placeholder animation would miss the entire point of
using this specific component. The spike above exists because this is the
one piece of this whole batch with a real chance of not working the way the
precedent components suggest — don't skip it to save time.
```

---

## C3 — Thunderstorm

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: Weather & Enemies C3

## Context
Depends on C1 (weather state) and C2 (the Droplets rain component, reused
here). Read GameTableScene.tsx's lighting setup (the DAY_NIGHT_PRESETS'
directional/ambient lights) to understand what a temporary bright flash would
need to layer on top of. Check the whole codebase for any existing
audio-playback precedent (grep for `<audio` or Web Audio API usage) before
assuming one exists.

## Task
When weather_kind is 'thunderstorm', render C2's Droplets rain effect (same as
plain rain) plus a randomized lightning flash: a brief, bright overexposure of
the scene (either a temporary intensity spike on the existing directional/
ambient lights, or a full-screen white flash overlay — pick whichever looks
more convincing once rendered) firing at randomized intervals. Lightning must
be synchronized across every connected client — the DM and every player must
see the SAME flash at the SAME time, not independently randomized per client
(broadcast each flash event via the existing realtime channel, or derive flash
timing from a shared, deterministic seed/clock — your call on which is
simpler given what's already in place). If no audio-playback precedent exists
anywhere in this codebase, ship this as visual-only — do not introduce a new
audio system just for a thunder sound in this prompt.

## Acceptance Criteria
- Selecting "thunderstorm" shows rain (via C2) plus periodic lightning
  flashes.
- Flashes are visually distinct and clearly readable, not a subtle flicker.
- Two connected clients see the exact same flash at the exact same moment —
  verify this with a real two-client Playwright check, not just single-
  client visual inspection.
- Switching away from thunderstorm stops both the rain and the flashes.

## Dependencies
C1, C2.

## Notes
An out-of-sync flash between the DM's screen and a player's would look
broken during a shared dramatic moment — this synchronization is the one
thing in this prompt worth real care, everything else is straightforward.
```

---

## C4 — Fantasy weather (firestorm, acid storm) with optional periodic damage

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: Weather & Enemies C4

## Context
Depends on C1. Per the project owner: the DM chooses, per activation, whether
firestorm/acid storm is cosmetic-only or deals real periodic damage. Read
src/data-access/characters.ts's applyHpDelta (NOT combat-scoped, the correct
primitive to reuse here) and src/data-access/conditions.ts's applyCondition/
removeCondition (combat-scoped only, cannot be reused outside an active
encounter). Confirm: no periodic/tick mechanism, and no server-side scheduler/
cron/background-job system of any kind, exists anywhere in this app — the only
existing setInterval in room/scene code is whiteboard stroke-flush batching,
which is unrelated to gameplay and not a pattern to copy. There IS a real,
directly relevant precedent for "who resolves an authoritative outcome":
step-on triggers and concealed-pit fall damage both resolve via whichever
DM client is currently present and connected (the DM's own client is treated
as the authority for that resolution) — this is the established model to
follow here too, not a novel invention.

## Task
Add two new weather_kind values already reserved by C1's check constraint:
'firestorm' and 'acid_storm', each with its own distinct visual effect
(embers/fire-glow particles for firestorm; a green-tinted corrosive haze or
precipitation for acid storm — reuse C2's Droplets component with a different
tint/color configuration if that reads well for acid rain, or build a simple
from-scratch particle effect if not; your call once you see both rendered).
The DM's weather control (from C1) gains a weather_mechanical toggle that's
only enabled/relevant for these two weather kinds (grayed out for
clear/fog/rain/thunderstorm). When mechanical is on, the DM's own connected
client runs the periodic timer and writes each tick's damage authoritatively
— matching the existing DM-client-resolves model used for step-on
triggers/pit falls, not a new invention — applying a small HP delta via the
real applyHpDelta to every character currently placed as a token on the live
map, once per a fixed interval you choose and document (there's no existing
precedent dictating the interval itself — pick something sensible for a live
session, such as once per real-world minute, and state your reasoning). Show
a clear on-screen indicator so players understand why their HP is changing.
Ensure turning the weather off, or toggling mechanical back off, stops the
timer immediately and cleanly with no lingering/duplicate effects.

**Explicitly accept and document this known v1 limitation**: because
resolution depends on the DM's own client being connected (matching existing
precedent, and consistent with the fact this app has no server-side
scheduler at all), if the DM disconnects or closes their tab while mechanical
weather is active, damage ticking pauses until they reconnect — it does not
silently continue via some other mechanism, and it does not "catch up" missed
ticks on reconnect. State this plainly in your final report as an accepted
tradeoff, not something you attempted to solve with new infrastructure (a
real server-side scheduler would be new infrastructure well beyond this
prompt's scope).

## Acceptance Criteria
- Firestorm and acid storm each render a real, distinct visual effect.
- The mechanical toggle only appears/applies for these two weather kinds.
- With mechanical on AND the DM connected, characters' HP genuinely
  decreases over time — verify actual character rows change via a direct
  query, not just a UI message.
- Damage is applied exactly once per interval, authoritatively — not
  independently per connected client (verify with two clients connected:
  damage isn't doubled or applied inconsistently between them).
- If the DM disconnects mid-effect, ticking pauses (no error, no double-
  application on reconnect, no other client silently taking over) —
  verify this explicitly rather than leaving it untested.
- Turning off the weather, or toggling mechanical off, stops all further
  damage immediately with nothing left running in the background.
- With mechanical off, the same weather produces zero HP changes.
- yarn lint / yarn tsc --noEmit / yarn test pass; a real Playwright check
  covers: activate mechanical firestorm, observe real HP decreases over at
  least two intervals, then deactivate and confirm damage stops.

## Dependencies
C1.

## Notes
This is the largest and most novel prompt in this batch — there's no existing
"periodic authoritative game-state change" pattern for the TIMING/INTERVAL
part specifically, though the DM-client-as-authority model itself is already
established elsewhere. Budget real design time on making sure the timer can't
double-fire across reconnects/page-reloads, can't leak past the weather
ending, and produces one consistent authoritative outcome rather than each
client computing its own.
```

---

## C5 — Enemy template library

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: Weather & Enemies C5

## Context
Read src/data-access/monsterStatBlocks.ts in full — monster_stat_blocks is
campaign_id-scoped with a minimal schema (name, max_hp, armor_class,
passive_perception, attacks[]) and no template/global concept, no race/type/
description field. Read MonsterPanel.tsx's existing "quick-add from roster"
flow in full. Confirm: no SRD/bestiary data exists anywhere in this codebase
(src/rules-engine/srd/ has classes/races/equipment/spells/skills/conditions,
no monsters). Per the project owner: this is a single SHARED GLOBAL list every
campaign reads from (not copied per-campaign) — the first non-campaign-scoped
content table in this codebase. Note: Track D (a separate, parallel plan) is
introducing a genuine app-wide admin role — if that work has not landed yet by
the time you build this prompt, gate this table's writes with a clear,
clearly-labeled placeholder (e.g. temporarily DM-writable, or read-only via
migration-seeded data only) and flag this explicitly in your report as a
follow-up once the real admin role exists; do not block this prompt on Track D.

## Task
Add a new global monster_templates table (no campaign_id column at all):
name, default_allegiance ('party' | 'hostile' | 'neutral', matching
TOKEN_ALLEGIANCES — the requested creature list mixes hostile types like
goblins/daemons/demons/witches/zombies with neutral/friendly ones like
traders/guards/high guards, so this must be a real per-template field, not a
hardcoded default), max_hp, armor_class, passive_perception, attacks (same
shape monster_stat_blocks already uses), and a short description. RLS: SELECT
open to any authenticated user; INSERT/UPDATE/DELETE per the admin-gating note
above. Author real starter content for goblin, trader, guard, high guard,
daemon, demon, witch, and zombie (plus any other variant clearly implied,
e.g. distinguishing daemon from demon if the SRD or common D&D convention
treats them differently) using the real D&D 5e SRD's open-content monster
stats as the factual basis wherever a direct match exists (goblin and zombie
are real SRD monsters — use their actual stats); for types with no direct SRD
monster equivalent (trader, guard, high guard), author simple, reasonable
NPC-tier stat blocks using the SRD's own NPC statistics conventions as a
guide, not invented numbers. Extend MonsterPanel.tsx's existing quick-add flow
to also offer picking from this new global list, copying a chosen template's
stats into a brand new campaign-scoped monster_stat_blocks row (the template
itself is never mutated by this — it's a copy, not a live link).

## Acceptance Criteria
- The global template list contains real, distinct stat blocks for every
  requested creature type, with real SRD-sourced or SRD-convention-based
  numbers, not placeholders.
- A DM can add any template to their own campaign via the existing quick-add
  flow, producing an independent, freely-editable per-campaign copy.
- Editing a campaign's own copy never mutates the global template or
  affects any other campaign.
- Whatever write-gate you implement for the global table is real and
  enforced server-side (RLS), not just UI-hidden — even if it's a
  placeholder pending Track D.
- yarn lint / yarn tsc --noEmit / yarn test pass; a real Playwright check
  covers browsing the template list, adding one to a campaign, confirming
  it's independently editable, and confirming the global template is
  unchanged afterward.

## Dependencies
None directly. Its write-gating should be revisited once Track D's admin
role lands, if it hasn't already by the time this runs.

## Notes
This is content-authoring work as much as engineering — get real numbers
right, since a DM will actually use these at their table.
```

---

## C6 — Default distinct appearance per template

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: Weather & Enemies C6

## Context
Depends on C5. Confirmed: every NPC token today renders as a flat allegiance-
colored disc (src/scene-3d/MapSurface.tsx, ALLEGIANCE_COLOR) — zero visual
distinction by creature type, no monster models or art pipeline exists
anywhere. Read the existing procedural-asset-generation convention (the
Node-script pattern already used for wall variants, map presets, and this
batch's own A8a building presets — generated geometry, not hand-authored or
downloaded art) before building anything.

## Task
Following that exact generator-script convention, generate a simple but
genuinely distinct default 3D shape for each of C5's templates — real
silhouette/proportion/color differences per template, sufficient to read at a
glance from across the table (not just re-tinting one identical shape). Add
each generated model to the existing asset_library via the same migration
pattern other generated presets use, and add a default_asset_id column on
monster_templates referencing it. Extend token rendering (MapSurface.tsx) so
an NPC token backed by a monster_stat_block that itself links back to a
monster_template (a new nullable template reference on monster_stat_blocks,
set when C5's quick-add flow copies a template) renders using that template's
model instead of the flat colored disc. Any NPC/monster stat block with no
template link (freeform, hand-authored by the DM) must continue rendering
exactly as today — the flat colored disc is the correct, unchanged fallback
for that case.

**Be explicit about which parts of a copied template stay linked and which
don't** — this is intentional, not an inconsistency with C5: C5's copy of a
template's STATS (HP, AC, attacks, etc.) into a campaign's own
monster_stat_blocks row is a one-time, fully independent copy that never
re-syncs, exactly as C5 describes. This prompt's template reference is
separate and serves ONLY visual rendering — it's a live pointer, so if a
template's own default_asset_id is ever changed later (e.g. by an admin), any
campaign already using that template picks up the new default appearance
automatically, while that same campaign's own copied stats remain completely
untouched. State this split plainly in your own report so it's clear it was a
deliberate choice.

## Acceptance Criteria
- Every C5 template has a real, visually distinct generated model.
- Placing a monster copied from the template library shows that distinct
  model on the table, not a flat disc.
- A freeform, non-template monster stat block still renders exactly as
  today (flat allegiance-colored disc) — verify zero regression here
  explicitly.
- yarn lint / yarn tsc --noEmit / yarn test pass; a real Playwright check
  places one templated monster and one freeform monster side by side and
  confirms only the templated one shows a distinct model.

## Dependencies
C5.

## Notes
Keep each model simple, matching the building presets' own low-poly,
dependency-free style — "recognizably different at a glance," not detailed
art.
```

---

## C7 — Custom model upload + per-campaign override

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: Weather & Enemies C7

## Context
Depends on C5, C6. Per the project owner: a DM should be able to upload a
replacement model for any template, but the override must be scoped to their
own campaign only — it must never change how that template looks in anyone
else's campaign. Read the existing custom-asset upload flow (uploadMapAssetFile
/createCustomAsset in src/data-access/assets.ts) and any other existing
DM-uploaded-custom-model precedent in this app (e.g. custom avatar models,
custom dice tray models) as the pattern for "a user uploads a model file and
it becomes usable in their own scope."

## Task
Add a new campaign-scoped table (e.g. campaign_monster_template_overrides:
campaign_id, monster_template_id, custom_asset_id), letting a DM upload a
model (reusing the existing upload/storage pattern exactly — same validation,
size limits, storage bucket conventions, nothing parallel/new) and link it to
override a specific template's appearance within their own campaign only.
Extend C6's token-rendering lookup so it checks for a campaign-specific
override first, falling back to the template's own default_asset_id (from C6)
if the current campaign has no override for that template.

## Acceptance Criteria
- A DM can upload a custom model and assign it as an override for a specific
  template.
- Within that DM's own campaign, monsters copied from that template now
  render with the custom model.
- A different campaign with no override for that template still shows C6's
  default model, unaffected.
- Removing an override reverts that campaign's rendering to the default
  cleanly.
- yarn lint / yarn tsc --noEmit / yarn test pass; a real Playwright check
  covers uploading an override in one campaign, confirming it renders there,
  and confirming a second campaign is unaffected.

## Dependencies
C5, C6.

## Notes
Reuse the existing upload/storage pattern exactly — no parallel upload
mechanism.
```
