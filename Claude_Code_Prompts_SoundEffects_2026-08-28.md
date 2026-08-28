# Sound Effects — Prompt Plan (2026-08-28)

Nine prompts. SP1 first (foundation everything else depends on), then SP2-SP9
may run in parallel — several touch `GameRoom.tsx`, so expect some merge
conflicts to resolve by hand, matching how this session's last parallel batch
(weather/stairs/pawn-customization/panel-dock) was merged.

**Defaults chosen for this plan** (per the project owner's own explicit
answers): audio is produced via an ffmpeg-based generation script that bakes
one canonical default sound file per trigger type (matching this project's
existing `generate-*.mjs` precedent for procedural 3D presets) — NOT live
in-browser synthesis, and NOT externally-sourced samples. Every baked sound is
individually replaceable later via a new admin settings section (upload a
real file per sound key, reset to default). A master volume/mute control is
included from the start, persisted per-user via `profiles.ui_preferences`
(the same jsonb column already extended twice this session for panel
layout/dock state). Playback is per-client-local only — every trigger this
plan defines is already independently observable by each connected browser
from data/events it already subscribes to, matching the existing
Droplets/WeatherParticles/CloudLayer precedent; no new realtime broadcast
infrastructure is needed anywhere in this batch.

**Research already done, feeding directly into the prompts below** (do not
re-derive from scratch — verify it's still accurate, then build):
- No audio infrastructure exists anywhere in this codebase today (confirmed
  by exhaustive grep) — this is genuinely greenfield.
- `ffmpeg` is installed in this environment (confirmed via `ffmpeg -version`)
  and its `lavfi` filters (`anoisesrc`, `sine`, `aevalsrc`) can synthesize
  real audio without any external samples or additional dependencies.
- Rain/wind/fire ambient loops and short percussive impacts (dice, hits,
  movement) are realistic candidates for convincing procedural synthesis. A
  door creak and a death sound are the two weakest candidates — ship an
  honest best-effort for these two, since the admin-override system (SP2)
  gives the project owner a real path to replace them with something better
  later without any further engineering work.
- Token movement (`useTokenSlide.ts`), map transitions (`GameRoom.tsx`'s
  transition flow), combat hits and death (`roll_log` and `characters`
  realtime subscriptions) are all clean, already-observable trigger points
  needing no new plumbing. Pit falls resolve DM-only server-side and are NOT
  themselves observable by other clients — SP7 must trigger off an
  already-synced downstream signal instead. Dice impacts have no existing
  per-collision event source at all (Rapier is driven with no
  `EventQueue`/`ActiveEvents` configured) — SP8 is genuinely the riskiest,
  newest-ground prompt in this batch.
- The existing deterministic lightning mechanism
  (`src/ui-components/lightning.ts`'s `computeLightningFlash(seed, nowMs)`,
  proven zero cross-client skew) is directly reusable for a synced thunder
  sound with zero new plumbing — every client already evaluates the same
  flash decision independently and instantly.

---

## SP1 — Core audio infrastructure: sound manager, volume/mute, baked defaults

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: Sound Effects SP1

## Context
No audio infrastructure exists anywhere in this codebase today (confirmed by
exhaustive search — zero AudioContext/`<audio>`/audio-file/audio-npm-package
references anywhere in src/ or public/). This prompt builds the shared
foundation every other Sound Effects prompt (SP2-SP9) depends on. Read
src/data-access/profiles.ts's existing PanelLayoutEntry/ui_preferences shape
in full (extended twice already this session for panel layout and panel
dock state) — the exact same per-user, debounced, cross-tab-synced jsonb
convention should be followed for the new master volume/mute setting, not a
new table or a new persistence mechanism. Also read scripts/assets/
generate-monster-presets.mjs or generate-building-presets.mjs in full as the
established convention for a procedural-asset-generation script committed
alongside its own generated output (not regenerated at runtime).

## Task
Build a client-side sound-manager module (e.g. src/audio/soundManager.ts)
using the Web Audio API directly (AudioContext + a GainNode graph for real
volume control) exposing: a function to play a one-shot sound by a fixed key
(with optional pooled/randomized variant selection for keys that have
multiple files), and functions to start/stop a named looping ambient channel
with a smooth crossfade in/out (reuse the fade-to-fully-silent discipline
Droplets.tsx already established for its own fade-out, applied to gain
instead of shader alpha — never let a stopped loop's audio node linger
audibly). Define ONE central registry (a single exported const/enum) of
every sound key this whole plan will ever use: dice_impact, pit_fall,
hit_normal (a pool of at least 3 distinct files), hit_critical, hit_miss,
token_move, door_transition, death, rain_loop, wind_loop, thunder, fire_loop
— every other prompt in this batch (and SP2's admin override system) must
import keys from this registry, never invent ad-hoc names.

Add a master volume (0-1) and mute (boolean) setting to profiles.ui_preferences
(extend the existing jsonb shape, exactly like panelLayout/dock state already
are — same debounce, same cross-tab live sync, no new migration). Every
playback/loop call in the sound manager must respect this setting live (an
already-playing loop's actual gain updates immediately when volume changes,
not just future sounds). Give this control a real, reachable home in the UI
— read the current Game Room layout (the DM's book, the top bar, or wherever
fits cleanest once you see it) and place a simple volume slider + mute
toggle there; this isn't prescribed, use your judgment.

Build an ffmpeg-based generation script (e.g.
scripts/assets/generate-sound-effects.mjs) that synthesizes ONE canonical
default audio file per registry key using ffmpeg's lavfi filters
(anoisesrc/sine/aevalsrc, confirmed available in this environment) — a short
percussive click/thock for dice_impact, a whoosh+thud for pit_fall, three
distinct short percussive/whoosh variants for hit_normal plus one sharper
variant for hit_critical and one duller/deflected-sounding one for
hit_miss, a soft footstep/scrape for token_move, a short creak for
door_transition (an honest best-effort — this and death are the two weakest
candidates for convincing synthesis, both replaceable later via SP2), a
short somber tone for death, and three ambient loops (rain_loop, wind_loop,
fire_loop as filtered/shaped noise, a well-established and genuinely
convincing procedural-audio technique) plus a short thunder crack/rumble
one-shot. Document the exact ffmpeg command used for each file directly in
the script's own comments so a human can hand-tune them later. Actually run
the script and commit the real generated files under public/sounds/
(mirroring this project's existing public/assets/ convention) — confirm
every file is real, non-zero-byte, playable audio, not a stub.

## Acceptance Criteria
- playSound/startLoop/stopLoop are real and produce genuine scheduled Web
  Audio API playback when triggered in a real browser session — verify via a
  real Playwright check reading the actual AudioContext/GainNode state (a
  headless browser can create and drive a real AudioContext even without
  literal sound output; verify state, not audible sound).
- Master volume/mute persists per-user via profiles.ui_preferences exactly
  matching the panel-layout convention (debounced write, live cross-tab
  sync via the existing subscription mechanism).
- Setting volume to 0 or mute=true measurably drops the real underlying
  GainNode's gain value to (near) zero, verified directly, not just that the
  preference was saved.
- generate-sound-effects.mjs runs successfully and produces real, non-empty,
  playable files in public/sounds/ for every registry key.
- yarn lint / yarn tsc --noEmit / yarn test pass; a real Playwright check
  covers volume/mute persistence, live gain updates on an active loop, and
  the sound manager's real playback/loop state.

## Dependencies
None.

## Notes
Get the sound-key registry and the manager's public API shape right here —
every other prompt in this batch imports from it. Keep the generation
script's ffmpeg commands well-commented; they're meant to be human-tunable
later, not a black box.
```

---

## SP2 — Admin sound override system

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: Sound Effects SP2

## Context
Depends on SP1 (the sound-key registry and baked default files). Read
supabase/migrations/0072_app_settings_admin.sql (is_app_admin(), the
admin-role pattern) and the Map Art Generation track's storage/RLS posture
(supabase/migrations/0077_map_art.sql's map-art bucket — admin/DM-writable,
but readable by anyone who can already see the thing it's attached to) as
the precedent to mirror: this is NOT the DM-only reference-image bucket's
posture, since every connected client (not just the DM, not just admins)
needs to actually fetch and play these files during real gameplay. Read
src/app/admin/AdminSettingsForm.tsx and its own upload-handling precedent
(if E2/E4's ComfyUI or map-art settings sections give one) before building
a new UI section.

## Task
Add a migration for a new table holding one row per sound-key override (the
key set comes from SP1's registry — store it as a plain text column with a
CHECK constraint against the known key list, not a foreign key, since the
registry is a code-level constant, not a database table): the storage
reference for the replacement file, and an updated-at timestamp. RLS:
SELECT open to any authenticated user (every client must be able to resolve
overrides), INSERT/UPDATE/DELETE restricted to is_app_admin(). Add a new
storage bucket for these uploads: admin-write only, publicly readable
(matching every-client-needs-this, unlike the DM-only reference-image
bucket). Extend the existing /admin settings page with a new "Sound
Effects" section: one row per sound key (generated from SP1's registry, not
a second hardcoded list), each with a "play current" preview button, a
file-upload control to replace it, and a "reset to default" action that
removes the override row so playback falls back to SP1's baked file.

Update SP1's playSound/startLoop functions so they check for an admin
override first (a live pointer — re-resolved fresh, not cached forever,
matching this session's established live-pointer convention from monster
template overrides and map art) and fall back to the baked default only
when no override row exists for that key.

## Acceptance Criteria
- An admin can upload a replacement file for any sound key via /admin, and a
  real subsequent playback (in a real Playwright session, verified via the
  sound manager's own state) uses the new file, not the baked default.
- "Reset to default" removes the override and playback reverts to SP1's
  baked file.
- A non-admin cannot create/update/delete an override — verified via a real
  direct RLS check, not just a hidden UI control.
- A real non-admin PLAYER's session correctly plays an admin-set override
  during actual gameplay (the override resolution must work for every
  authenticated user, not just admins, even though only admins can WRITE
  overrides).
- yarn lint / yarn tsc --noEmit / yarn test pass; a real Playwright check
  covers upload, reset, RLS denial for a non-admin write, and a real
  non-admin player's session correctly resolving an admin-set override.

## Dependencies
SP1.

## Notes
Keep this fully optional/additive — every sound key must keep working
correctly using ONLY SP1's baked defaults when no override has ever been
set, with zero configuration required.
```

---

## SP3 — Token movement sound

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: Sound Effects SP3

## Context
Depends on SP1. Read src/scene-3d/useTokenSlide.ts and its consumer in
src/scene-3d/MapSurface.tsx's TokenMarker in full before making any change —
confirm the exact current phase-transition shape yourself (this research is
from earlier in the session; other work may have touched this file since).
The hook already transitions to a "sliding" phase when a move starts and
fires an existing onSettled callback when it completes.

## Task
Play the token_move sound key once when a token's slide phase transitions
to "sliding" (the start of a real move) — not once per animation frame, not
on every render. Read the hook's actual state machine carefully to find the
correct one-time trigger point rather than guessing.

## Acceptance Criteria
- A real move (click-select the token directly on the 3D table, then click
  a reachable destination cell — the exact gesture MapPlan P11/P12
  established, not the Tokens-panel MOVE button) triggers the sound exactly
  once per move.
- No sound fires on render/reload for a token that isn't actually moving.
- No regression to the actual slide/tween animation.
- yarn lint / yarn tsc --noEmit / yarn test pass; a real Playwright check
  reads the sound manager's own play-call log (add a small debug hook to
  SP1's manager if one doesn't already exist, following this project's
  hidden-debug-mirror convention) to confirm exactly one trigger per move.

## Dependencies
SP1.

## Notes
Small and focused — don't touch the slide/tween logic itself.
```

---

## SP4 — Map transition (door) sound

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: Sound Effects SP4

## Context
Depends on SP1. Read GameRoom.tsx's map-transition flow in full — the
per-viewer independent map transition feature (MapPlan P9). Confirm the
current exact function names yourself (this research is from earlier in the
session — re-verify against current code, since GameRoom.tsx has been
touched by many other prompts since).

## Task
Play the door_transition sound key at the moment a pawn's cross-map
transition is actually executed/confirmed, for every connected client that
observes the transition happen (the mover's own client and any other
connected client watching), not just whoever triggered/confirmed it.

## Acceptance Criteria
- A real DM-confirmed map transition triggers the sound on the DM's own
  client AND independently on a separate connected player's client.
- No regression to the transition flow itself (map loads correctly, tokens
  land correctly on the new map).
- yarn lint / yarn tsc --noEmit / yarn test pass; a real two-client
  Playwright check confirms both clients' sound managers log the trigger.

## Dependencies
SP1.

## Notes
Small.
```

---

## SP5 — Combat hit sounds, varied

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: Sound Effects SP5

## Context
Depends on SP1. Read src/data-access/rolls.ts's resolveAttackDamage and
resolveNpcAttackDamage in full, plus subscribeToRollLog and its existing
consumers (DiceLogPanel.tsx, DmBookActivityPage.tsx) — every connected
client already receives every roll_log row live via this existing
subscription, with zero new plumbing needed. Confirm the row's own shape:
its `critical` flag, `total`, and `breakdown.attack`'s applied/instantDeath/
deathSaveFailureAdded fields are enough to distinguish hit vs. miss vs.
critical without any new data.

## Task
In the roll_log subscription's own handler, detect a new attack-roll row
(read the row shape to determine how attack rolls are distinguished from
other roll kinds already in this table) and play: a randomly-picked
hit_normal variant on an ordinary hit, hit_critical on a critical hit, or
hit_miss on a miss. Every already-connected client (not just the roller)
must hear this, matching the subscription's existing "every client sees
every roll" behavior.

## Acceptance Criteria
- A real attack roll — tested for hit, miss, and critical separately —
  triggers the correct sound category on every connected client.
- Repeated ordinary hits genuinely vary which hit_normal file plays (real
  randomization observed across multiple triggers, not always the same
  file).
- No regression to DiceLogPanel/DmBookActivityPage's own rendering of these
  rows.
- yarn lint / yarn tsc --noEmit / yarn test pass; a real two-client
  Playwright check covers hit/miss/crit, and confirms variation across
  repeated hits.

## Dependencies
SP1.

## Notes
Medium — the "varied" requirement is real pooling/randomization logic, not
just wiring one sound to one event.
```

---

## SP6 — Death sound

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: Sound Effects SP6

## Context
Depends on SP1. Read src/data-access/characters.ts's subscribeToCharacterChanges
and its consumer in GameRoom.tsx in full. characters.is_dead is write-once
(never cleared once set true, per its own existing doc comment) and already
realtime-subscribed — zero new plumbing needed, but the trigger must diff
old-vs-new state, not just check the current value, to avoid re-firing on
every page load for an already-dead character.

## Task
In the character-changes subscription's own update handler, compare the
incoming row's is_dead against the PREVIOUSLY held value for that same
character (client-side state the subscription handler already has access
to, or a small addition to track it if not) and play the death sound only
on a genuine false-to-true transition observed live — never on initial
load/reload of an already-dead character, and never more than once per
actual death.

## Acceptance Criteria
- A real character death (driven through the actual death-save mechanic to
  its dead state) triggers the sound exactly once, live, on every connected
  client.
- Reloading the page for an already-dead character does NOT replay the
  sound.
- A second, different character dying afterward still correctly triggers
  its own sound (no "already fired once, never again" over-suppression
  across different characters).
- yarn lint / yarn tsc --noEmit / yarn test pass; a real Playwright check
  covers the live-trigger case and the no-replay-on-reload case explicitly,
  plus the second-character case.

## Dependencies
SP1.

## Notes
Small, but the diff-not-check-current-value distinction is the one real
subtlety here — get it wrong and every reload of a session with any dead
character replays the sound for everyone.
```

---

## SP7 — Pit fall sound

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: Sound Effects SP7

## Context
Depends on SP1. Read GameRoom.tsx's pit-fall resolution logic in full
(resolveVisiblePitFall and the surrounding concealed-pit save-roll branch,
around the token-move handler). Confirmed by research: this resolution runs
ONLY on the DM's own connected client (the same "DM-client-resolves-
authoritatively" pattern the weather-tick mechanical-damage feature also
uses) — it is NOT itself observable by other connected clients. However,
every real downstream effect it produces IS already synced and observable
by every client: a moveMapToken write (a position revert on a successful
save), an upsertMapCells write (the pit terrain becoming revealed on a
failed save), an apply_hp_delta write, and a roll_log insert (a dexterity
save roll, likely immediately followed by a damage roll on failure).

## Task
Trigger the pit_fall sound off one of these ALREADY-SYNCED downstream
signals — read each candidate's actual reliability (does it fire ONLY on a
genuine fall, with no false positives from unrelated ordinary dexterity
saves or ordinary terrain edits?) and pick whichever is least ambiguous
(likely: a map_cells terrain flip to the pit terrain type occurring under a
specific token's own current position, or a dexterity-save roll_log row
immediately correlated with that same token's HP dropping) — do NOT hook
into the DM-only resolution code path directly, since that would mean only
the DM ever hears this sound.

## Acceptance Criteria
- A real pit fall (a token stepping onto a concealed pit and failing its
  save) triggers the sound on BOTH the DM's own client AND a separate
  connected player's client — this cross-client behavior is the specific
  thing to verify, since a naive DM-only-code-path hook would fail exactly
  this check.
- A successful save (no fall) does NOT trigger the sound, on any client.
- An ordinary, unrelated dexterity save (not pit-related) does NOT
  falsely trigger the sound.
- yarn lint / yarn tsc --noEmit / yarn test pass; a real two-client
  Playwright check covers both the fall case and the successful-save case.

## Dependencies
SP1.

## Notes
The real design work here is picking the right already-synced signal —
get this wrong and non-DM players silently never hear it, exactly the class
of visibility bug this session's own player-visibility fixes (#98, the
monster-template-override visibility gap) already had to catch once before.
```

---

## SP8 — Dice impact sounds

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: Sound Effects SP8

## Context
Depends on SP1. Read src/scene-3d/diceAnimator.ts, useDiceTumble.ts, and
DiceTumble.tsx in full. Confirmed by research: physics runs on
@dimforge/rapier3d-compat (a raw imperative API, not @react-three/rapier),
world.step() is called with no EventQueue, and no collider anywhere sets
.setActiveEvents(...) — so no real per-collision callback exists today, even
though Rapier itself supports one. diceAnimator.ts's own settle-check logic
already reads linvel/angvel every frame internally, but only as a one-shot
"has it gone quiet yet" check — this value never reaches React today.

## Task
Investigate and choose ONE of two real approaches, based on genuine testing
in this app's actual multi-tray (per-member personal dice trays) real-time
context, not assumption:
(a) Wire up Rapier's real collision-event API — set
.setActiveEvents(ActiveEvents.COLLISION_EVENTS) on the die bodies and the
tray floor/walls, drive world.step() with a real EventQueue, drain genuine
contact-started events each frame, and thread them out through
useDiceTumble as a new callback.
(b) Approximate impacts from frame-to-frame linear/angular velocity deltas
already computed inside the existing settle-check logic — a sudden large
velocity drop indicates a real collision without needing the engine's own
event system at all.
Implement whichever proves more reliable and performant under real testing
with multiple simultaneous personal trays active (this app's own established
multi-tray precedent). Play a randomly-varied dice_impact sound (pooled, like
SP5's hit-sound approach) on each detected impact during the tumble — not
only once when the die fully settles — but rate-limit/debounce so a single
die's most chaotic initial bounce doesn't fire dozens of sounds a second
(pick and justify a sensible minimum interval between impact sounds for one
die).

Respect this app's existing private-roll visibility rules (Track D-adjacent
private dice roll feature, if it has shipped by the time this prompt runs —
check current code) — a private roll's impact sounds must only be audible to
whoever can actually see that roll, never leaking to other players.

## Acceptance Criteria
- A real dice roll produces multiple distinct impact sounds during the
  tumble (not just one at the very end), for every client that can actually
  see that specific roll/tray.
- No excessive/machine-gun sound spam during a single die's most chaotic
  bounce phase — a real, observable rate limit is in effect.
- A private roll's impact sounds are NOT audible to a player who cannot see
  that roll, verified explicitly with a real two-client check.
- No regression to the existing dice tumble animation, printed
  numbers/pips, or result-reconciliation logic — re-run the existing dice
  verify scripts as a real regression check.
- No meaningful frame-time regression from the added collision-detection or
  velocity-sampling logic — benchmark this the same way the rain effect was
  benchmarked (a real frame-time comparison script, roll active vs. not).
- yarn lint / yarn tsc --noEmit / yarn test pass; a real Playwright check
  confirms multiple, rate-limited impact sounds during one real roll, and
  the private-roll visibility case.

## Dependencies
SP1.

## Notes
This is the largest, riskiest prompt in the batch — budget real research and
iteration time on the Rapier collision-event question specifically, and
don't be afraid to fall back to the velocity-approximation approach if real
collision events prove unreliable, noisy, or too costly under multi-tray
load. If neither approach holds up well under real testing, say so plainly
and report the real tradeoffs rather than shipping something broken or
spammy.
```

---

## SP9 — Weather ambience: rain, wind, thunder, fire

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: Sound Effects SP9

## Context
Depends on SP1. Read src/scene-3d/GameTableScene.tsx's resolveSceneFog
function in full as the exact pure-function pattern to mirror (a small,
pure function of the weather kind, callable both inside the R3F tree and
from GameRoom.tsx's own debug mirrors). Also read src/ui-components/
lightning.ts's computeLightningFlash(seed, nowMs) in full — this is already
evaluated independently and instantly by every connected client from the
same shared campaign-derived seed and current time (proven zero cross-client
skew earlier this session) — directly reusable for a synced thunder sound
with ZERO new plumbing. Also read Droplets.tsx's own fade-to-fully-transparent
discipline on every stop path (the recent storm-switch stale-overlay bug fix)
as the precedent to avoid repeating for audio — no loop channel may ever be
left audibly stuck after becoming inactive.

Per the project owner's full, final request (given across two messages —
read both, don't miss the second): rain sound whenever weather is 'rain' or
'thunderstorm'; wind sound for 'fog', 'thunderstorm', 'acid_storm', AND
'firestorm'; thunder as a one-shot synced to the existing lightning flash
during 'thunderstorm'; and a NEW fire ambient loop for 'firestorm'
specifically — meaning 'firestorm' needs BOTH wind AND fire playing
together, and 'thunderstorm' needs BOTH rain AND wind playing together.
'cloudy' and 'clear' get no weather audio.

## Task
Build resolveWeatherAudio(weatherKind) returning exactly which loop channels
(rain/wind/fire) should be active for each of the 7 current weather kinds —
confirm this exact matrix against the paragraph above before implementing:
clear (none), fog (wind), cloudy (none), rain (rain), thunderstorm (rain +
wind), firestorm (wind + fire), acid_storm (wind). Wire this into SP1's
loop-channel API so weather-kind changes smoothly crossfade the active
channel set in/out — no channel ever snaps on/off or persists stuck after
becoming inactive.

Hook a thunder one-shot into the SAME computeLightningFlash evaluation every
client already runs for the visual flash (find where GameTableScene.tsx or
LightningFlash.tsx currently calls this function and add the audio trigger
alongside the existing visual one) — every client independently and
instantly triggers thunder from the same deterministic computation, with no
new broadcast/sync mechanism.

## Acceptance Criteria
- Each of the 7 weather kinds activates exactly the documented combination
  of loop channels, verified via a real per-kind check reading the sound
  manager's own active-loop-channel debug state (cycle through all 7 kinds
  including revisits, mirroring verify-weather-clouds.mjs's own convention).
- Switching between weather kinds crossfades cleanly — checking channel
  state immediately after each transition shows no stuck/leftover active
  channel that should have stopped.
- A real lightning flash during thunderstorm triggers the thunder sound on
  the SAME evaluation every connected client already computes for the
  visual flash — verified identically (within the same tolerance as the
  visual flash's own proven zero-skew behavior) on two independent clients.
- firestorm correctly activates BOTH wind and fire simultaneously;
  thunderstorm correctly activates BOTH rain and wind simultaneously —
  explicitly verified as real dual-channel cases, not just "at least one
  channel active."
- yarn lint / yarn tsc --noEmit / yarn test pass; real benchmark evidence
  (matching the rain/cloud frame-time benchmark precedent) that the added
  audio-loop logic causes no meaningful frame-time regression.

## Dependencies
SP1.

## Notes
Double-check the final channel matrix before implementing — the request
arrived in two separate messages and it's easy to miss that firestorm now
needs wind AND fire together, not just fire alone. This is medium-large
given the multi-channel crossfade logic, but Droplets.tsx's own fade
discipline is a strong, already-proven precedent to reuse rather than
inventing crossfade logic from scratch.
```
