# Claude Code Prompt Plan — BeyondDNDBeyond

**Project:** BeyondDNDBeyond — a remote-play 3D virtual tabletop for D&D 5e, for a small private friend group (some players remote, e.g. Scotland).

**Stack decisions locked in for this plan:**
- Next.js (App Router) + TypeScript, React Three Fiber (Three.js) for the 3D table
- Self-hosted Supabase (Postgres, Auth, Realtime, Storage) via Docker Compose, deployed behind the existing Nginx Proxy Manager reverse proxy
- Full 5e SRD rules automation (modifiers, saves, spell slots, attack bonuses, passive scores, advantage/disadvantage, concentration, death saves, action economy, difficult terrain)
- Discrete stepped-elevation grid, grid-snapped tokens and map objects
- In-app DM map builder: built-in preset asset library + custom glTF upload, interactive POIs, map organization (folders/thumbnails), duplication/templates, undo/redo, multi-floor map transitions, a measuring tool, and an editor-only reference image underlay
- A Campaign Creator narrative layer: NPC roster, world/lore pages, session log & handouts, private DM notes & house rules — plus optional LLM-assisted drafting for narrative content and for generating map room/area layouts from a plain-language description (always a reviewable draft, never auto-committed)
- Combat mode with initiative, HP, conditions (including exhaustion), integrated dice roller, contextual quick actions, opportunity attacks, a DM rule-override control, and a DM-configurable action-economy strictness toggle
- Per-player vision/perception system: light level + darkvision + condition overrides (blinded, etc.), enforced client-side, with Hide/Stealth for both players and NPCs, retained "seen cell" memory, and schema laid now for a future full line-of-sight upgrade — DM view always bypasses it
- An open Lobby landing page after login showing who's currently online; once more than two people are present, anyone can start a session — pressing Start makes them that campaign's DM and moves the group into the Game Room together
- DM role is per-campaign and can be transferred between members at any time (via the lobby start flow, in-game handoff, or the Account page)
- Player 3D avatars (built-in presets + custom upload), rendered seated at the table
- An Account page for profile, cross-campaign character library, and campaign management
- Best-effort D&D Beyond PDF character import with a mandatory review/edit step
- Strict module boundaries (rules engine / data access / realtime / 3D scene / UI components) plus a performance-testing harness (bundle size, 3D frame-time, Lighthouse, realtime load), established early and respected by every later prompt
- Realtime reconnection/session resilience built early so every later realtime feature inherits it
- UI built on CanvasUI (WebGL/canvas effects library) plus an in-repo shared component library, seeded with design tokens ported verbatim from the AlfiePrime Hub project (`/home/alfie/git/sex/hub`) — deep-purple/near-black neon CRT theme
- For prompts that are primarily UI/visual design work, consider running that Claude Code session with the Fable model, per the project owner's preference for design-led sessions

**Reuse mantra — read this before every prompt:** If something in this codebase already does a job — a component, a data-access function, a validation routine, a calculation, a rendering pattern — reuse and extend it. Don't build a second, parallel version because it's easier than reading the existing one. Every prompt below opens with an explicit "read X first" step for exactly this reason: audit what already exists, make it do the job well if it's not quite there yet, and only build genuinely new code for what's genuinely missing. Several prompts call this out explicitly where the temptation to duplicate is obvious (e.g. avatar upload vs. map asset upload both validating glTF files, or the two AI-assisted generation prompts sharing one LLM integration) — treat those as examples of the general rule, not the only places it applies.

**Local path:** `/home/alfie/git/BeyondDNDBeyond`

Run these prompts in order with Claude Code. Each is self-contained — paste one at a time, let it complete, then move to the next.

---

## Scope Table

| # | Prompt | Depends on | Complexity |
|---|---|---|---|
| 1 | Project scaffolding | — | Medium |
| 2 | Architecture, modularity & performance-testing foundation | 1 | Medium-Large |
| 3 | Design tokens & component library foundation | 1,2 | Medium |
| 4 | Core DB schema | 1 | Medium |
| 5 | Auth flow | 4 | Medium |
| 6 | Campaign creation + join | 4,5 | Medium |
| 7 | DM role model + handoff | 6 | Medium |
| 8 | Character data model | 6 | Medium |
| 9 | 5e rules engine | 8 | Medium-Large |
| 10 | Character creation flow | 3,8,9 | Large |
| 11 | Character sheet view/edit | 9,10 | Large |
| 12 | Rest mechanic | 8,9 | Medium |
| 13 | Player avatar library & upload | 3,5 | Medium |
| 14 | D&D Beyond PDF character import | 3,8,9 | Large |
| 15 | Account page | 3,5,6,8,10,11,13,14 | Large |
| 16 | Real-time campaign channel | 6 | Medium |
| 17 | Reconnection & session resilience | 16 | Medium |
| 18 | Lobby screen & presence | 6,7,16,17 | Medium |
| 19 | 3D table scene foundation | 2,3,6 | Large |
| 20 | Player seating + camera | 19 | Medium |
| 21 | Render seated avatars at the table | 13,20 | Medium |
| 22 | Session start & DM assignment flow | 6,7,18,21 | Medium |
| 23 | Map & asset data model | 6 | Medium-Large |
| 24 | Built-in preset asset library | 23 | Medium |
| 25 | Custom asset upload pipeline | 3,23,24 | Medium-Large |
| 26 | Map editor — terrain & elevation | 2,3,23 | Large |
| 27 | Map editor — object/POI placement | 24,25,26 | Medium-Large |
| 28 | Interactive POI behavior | 16,26,27 | Large |
| 29 | Map rendering & live switching on tabletop | 2,16,19,20,26,27 | Large |
| 30 | Grid overlay & token placement | 16,29 | Medium |
| 31 | Token movement (elevation & terrain aware) | 9,16,30 | Large |
| 32 | Campaign narrative data model | 6,7 | Medium |
| 33 | NPC roster | 3,7,32 | Medium |
| 34 | World/lore pages | 3,7,32 | Medium |
| 35 | Session log & handouts | 3,16,17,32 | Medium |
| 36 | Private DM notes & house rules | 3,7,32 | Small-Medium |
| 37 | AI-assisted narrative generation | 33,34 | Medium-Large |
| 38 | AI-assisted procedural map content generation | 24,25,26,27,29,37 | Large |
| 39 | Map organization (folders & thumbnails) | 23,26 | Medium |
| 40 | Map duplication & starter templates | 26,27,39 | Medium |
| 41 | Undo/redo in the map editor | 26,27 | Medium |
| 42 | Multi-floor map transitions | 23,29,31 | Medium-Large |
| 43 | Measuring and ruler tool | 29,30 | Small-Medium |
| 44 | Reference image underlay | 3,26 | Small-Medium |
| 45 | Initiative tracker | 3,11,30 | Medium |
| 46 | HP & damage tracking | 11,30,45 | Medium |
| 47 | Conditions tracking (incl. exhaustion) | 45 | Small-Medium |
| 48 | Integrated dice roller (incl. advantage/disadvantage) | 3,11,16,46 | Large |
| 49 | Death saving throws | 46,48 | Medium |
| 50 | Concentration tracking | 9,46,47,48 | Medium |
| 51 | Contextual quick actions panel | 9,11,12,31,45,48 | Large |
| 52 | DM rule-override control | 12,45,48 | Medium |
| 53 | Action economy tracking & DM strictness toggle | 45,51,52 | Medium-Large |
| 54 | Opportunity attacks | 31,53 | Medium |
| 55 | Vision — character vision capability & map lighting data model | 8,23 | Medium |
| 56 | Vision — perception rules engine | 9,47,55 | Medium-Large |
| 57 | Vision — map editor lighting authoring | 26,27,55 | Medium |
| 58 | Vision — per-player rendering & seen-cell memory | 29,30,31,56,57 | Large |
| 59 | Vision-driven advantage and disadvantage | 48,58 | Medium |
| 60 | Vision — Hide/Stealth for players and NPCs | 9,58 | Large |
| 61 | DM NPC/monster tools | 7,30,45,48 | Medium |
| 62 | Self-hosted deployment packaging | all prior | Medium |

---

### Prompt 1: Project scaffolding

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: Foundation

## Context
This is a brand-new, empty git repository with nothing built yet. It will become a Next.js
web app with a self-hosted Supabase backend. Nothing else exists in this repo — you are
laying the foundation every later prompt depends on.

## Task
Initialize a Next.js project with TypeScript and the App Router, plus ESLint, inside this
repository. Set up a clear top-level folder structure that will hold separate modules for UI
components, 3D scene code, game/domain logic, real-time sync, and data-access code (Prompt 2
will formalize the boundaries between them — for now just lay out sensible top-level folders).

Set up a Docker Compose configuration that runs a self-hosted Supabase stack locally
(Postgres, Auth, Realtime, Storage, and Studio). Wire the Next.js app to this local Supabase
instance using environment variables, with a committed .env.example (no real secrets) and a
local .env that is gitignored.

Add a README explaining how to bring up the local dev environment: starting the Supabase
stack via Docker Compose, then starting the Next.js dev server.

## Acceptance Criteria
- Running the documented Docker Compose command brings up Postgres, Auth, Realtime, Storage
  and Studio locally, and Studio is reachable in a browser.
- Running the Next.js dev server serves a placeholder home page in the browser.
- The app's environment configuration successfully connects to the local Supabase instance
  (verify with a trivial query or health check).
- .env is gitignored; .env.example documents every required variable with no real values.

## Dependencies
None — this is the first prompt.

## Notes
Use a self-hosted Supabase setup (the official self-hosting Docker Compose template), not
the hosted cloud product — this app will eventually be deployed behind an existing Nginx
Proxy Manager reverse proxy on the user's own infrastructure (see Prompt 62).
```

---

### Prompt 2: Architecture, modularity & performance-testing foundation

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: Foundation

## Context
Prompt 1 scaffolded the Next.js app and a local self-hosted Supabase instance. Nothing
enforces module boundaries or measures performance yet. This app will grow to include a rules
engine, real-time sync, a 3D scene, and a full map editor — the project owner wants to always
be able to change any one of these without a change in one area silently breaking another, and
wants performance verified continuously rather than checked only at the end.

## Task
Read the folder structure scaffolded in Prompt 1. Establish clear module boundaries as
separate, independently testable areas of the codebase, at minimum: a rules-engine module
(pure game logic, no UI or database dependency), a data-access module (every Supabase
query/mutation goes through this, behind a typed interface — no other module talks to Supabase
directly), a realtime module (wraps Supabase Realtime channels/presence behind a small typed
event-bus), a 3d-scene module (React Three Fiber scene code), and a ui-components module
(shared design-system components). Each module should expose a small, deliberate public
interface rather than other modules reaching into its internals. Add lint rules or another
enforced mechanism that catches an obvious boundary violation (e.g. a UI component importing
the Supabase client directly instead of going through data-access).

Set up a unit test runner wired to run against every module independently.

Set up a performance-testing harness with four checks: a bundle-size budget check that fails
the build if the client JavaScript bundle grows past a defined threshold; a headless 3D render
benchmark that measures frame time for a representative scene and fails if it regresses past a
defined budget; a Lighthouse (or equivalent) check for the app's 2D pages; and a load-testing
script that opens several simulated concurrent clients against a realtime channel and measures
message latency. Document all of this — the module boundaries, how to run the tests, and how
to run the performance checks — in the README.

## Acceptance Criteria
- The five module boundaries described exist as clearly separated areas of the codebase, each
  with its own runnable test suite.
- A deliberate cross-module boundary violation is caught by lint or another automated check,
  not just left to convention.
- The bundle-size, 3D render-benchmark, Lighthouse, and realtime-load checks all run
  successfully against the current (near-empty) app and each produce a baseline number.
- The README documents how to run every test and performance check.

## Dependencies
Prompt 1.

## Notes
This is the contract the rest of the plan is built against — every later prompt should keep
new code inside the correct module and should not regress the performance budgets established
here. Keep the initial budget numbers generous; the point right now is having the harness in
place and a baseline recorded, not hitting a final target on a nearly-empty app. Later prompts
that add meaningfully to bundle size, 3D scene complexity, or realtime traffic should re-run
these checks and note the result. Per the project's reuse mantra, before adding a new
dependency or utility anywhere in this app, check whether an equivalent already exists in one
of these modules.
```

---

### Prompt 3: Design tokens & component library foundation

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: Foundation / UI

## Context
Prompt 1 scaffolded the app; Prompt 2 established a ui-components module boundary. There is no
visual design system yet — no colors, no shared components.

## Task
Read the ui-components module boundary from Prompt 2. Install CanvasUI (the WebGL/canvas
effects component library documented at canvasui.dev, installed via its shadcn-CLI-based
flow) into the project.

Read the color and design-token values defined in the existing AlfiePrime Hub project's token
file at /home/alfie/git/sex/hub/app/frontend/src/lib/theme/tokens.css. Port its color values
(the surface colors, the accent palette, the text colors, and the glow-shadow values) into
this project's own design-tokens file as the starting palette. Copy the values exactly rather
than reinterpreting them, matching how that source file itself documents being a verbatim port
from its own origin — treat these as the locked starting values, not a rough guide.

Using these tokens (and CanvasUI effects where they fit the neon/CRT aesthetic — glows,
scanline-style accents, subtle animated backgrounds), build a small shared component library
inside the ui-components module: at minimum a button, a panel/card, a text input, a modal, a
badge, and a section header. Build a simple internal showcase page listing every component so
later prompts can see what's available. Every later UI-building prompt should reuse these
components and tokens rather than hand-rolling new styles or colors.

## Acceptance Criteria
- CanvasUI is installed and at least one of its effects renders correctly on the showcase
  page.
- A design-tokens file exists whose color values match the source AlfiePrime Hub file exactly.
- The button, panel, input, modal, badge, and section-header components exist, are styled from
  the tokens, and are visible on the showcase page.

## Dependencies
Prompts 1, 2.

## Notes
This ports an existing, distinctive visual identity (neon purple/pink/teal accents on a
near-black background, CRT scanline/glow motifs) as this app's starting theme — begin from
these exact values rather than inventing a new palette. Note for later prompts: a tabletop
game surface has different legibility needs than a dashboard (character sheets, HP numbers,
and map text need to stay readable at a glance), so later UI prompts may need to make small,
deliberate contrast adjustments on top of this base palette rather than applying it
unmodified everywhere — call out any such adjustment explicitly rather than silently drifting
from the tokens. For prompts that are primarily visual/UI design work, consider running that
Claude Code session with the Fable model, per the project owner's preference for design-led
sessions. Per the project's reuse mantra: once this component library exists, no later prompt
should hand-roll a new button/panel/modal/input style — extend what's here if it's not quite
sufficient, rather than building a parallel one-off.
```

---

### Prompt 4: Core database schema

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: Campaigns / Auth foundation

## Context
Prompt 1 set up the Next.js app and a local self-hosted Supabase instance via Docker Compose.
No database schema exists yet beyond Supabase's built-in auth tables.

## Task
Read how the local Supabase instance and its migrations tooling are set up from Prompt 1, and
the data-access module boundary from Prompt 2. Create migrations for the following:
- A profiles table linked one-to-one to Supabase auth users, holding a display name and
  avatar reference.
- A campaigns table (name, creator, created timestamp).
- A campaign_members table linking a user to a campaign with a role field distinguishing
  "dm" from "player", and a joined timestamp. The schema should make it straightforward to
  enforce exactly one "dm" role per campaign at a time (a later prompt will build the
  transfer flow on top of this).

Write Row Level Security policies so that a user can only read or write campaign and
membership data for campaigns they are a member of. Apply the migrations to the local
Supabase instance and confirm the schema is correct. Ensure all queries against these tables
go through the data-access module rather than being called directly from UI code.

## Acceptance Criteria
- All three tables exist with correct columns, types, and foreign keys.
- RLS policies verified: a simulated user who is not a member of a campaign cannot read or
  write that campaign's rows; a member can read rows for their own campaigns.
- Migrations are checked into the repo and can be reapplied cleanly to a fresh database.

## Dependencies
Prompt 1.

## Notes
Keep this schema minimal. Characters, maps, and combat state are separate concerns added by
later prompts as their own migrations.
```

---

### Prompt 5: Authentication flow

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: Auth

## Context
Prompt 4 created the profiles table and RLS policies. There is no sign-up, login, or session
handling in the app yet.

## Task
Read the current app structure and the profiles table schema. Implement sign up, login, and
logout using Supabase Auth's email/password flow. Add route protection so that
unauthenticated users are redirected to a login screen when attempting to reach any page that
requires a session. On a user's first successful login, if their profile row is incomplete
(no display name set), route them through a short profile setup step before continuing, and
write the result to the profiles table.

## Acceptance Criteria
- A new user can sign up, is prompted to set a display name, and lands on the app afterward.
- An existing user can log in and log out.
- Any protected page is unreachable while logged out and redirects to login.
- Profile data written during setup is correctly persisted and readable on next login.

## Dependencies
Prompt 4.
```

---

### Prompt 6: Campaign creation and join flow

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: Campaigns

## Context
Auth is working (Prompt 5) and the campaigns/campaign_members schema exists (Prompt 4). There
is currently no way to create or join a campaign.

## Task
Read the campaigns and campaign_members schema and the auth flow. Build a "create campaign"
flow where a logged-in user names a new campaign and is automatically added as its DM. Have
campaign creation generate a shareable invite code — permanent and multi-use for the life of
the campaign (not single-use or time-limited), visible to the DM at any time so it can be
re-shared. Build a "join campaign" flow where a
different logged-in user enters a valid invite code and is added as a player member. Build a
campaign dashboard listing every campaign the current user belongs to, clearly showing
whether they are the DM or a player in each.

## Acceptance Criteria
- Creating a campaign inserts the campaign row and a campaign_members row with the creator
  as DM.
- Joining via a valid invite code adds a new campaign_members row with role "player"; an
  invalid code is rejected with a clear message.
- The dashboard correctly lists all of a user's campaigns and distinguishes DM vs player
  campaigns.

## Dependencies
Prompts 4, 5.
```

---

### Prompt 7: DM role model and handoff

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: DM role

## Context
Campaigns exist with a creator as default DM (Prompt 6). There is no way yet to move the DM
role to a different member, and no shared, reusable way for other features to check "is this
user the current DM of this campaign".

## Task
Read the campaign_members schema and the campaign dashboard/join flow. Formalize how "current
DM" is tracked and enforced so there is always exactly one DM per campaign. Build the DM
transfer as a shared, reusable function (atomically demoting the current DM to player and
promoting the chosen member) that isn't tied to one single caller — then build a "Transfer DM"
UI action on top of it, visible only to the current DM, for player-initiated handoffs. A later
prompt (22) will call the same underlying transfer function from a different, authorized flow
(starting a session from the lobby), so don't hard-code the transfer logic to only be reachable
from this UI button. Build a shared, reusable helper (e.g. a hook or utility function)
that any part of the app can call to check whether the current user is the DM of a given
campaign, for gating DM-only UI and actions in later prompts.

## Acceptance Criteria
- Only the current DM sees the transfer control.
- Transferring the role correctly updates both members' roles in a single atomic operation —
  there is never a moment with zero or two DMs.
- The reusable "is DM" helper correctly reflects the current state after a transfer (on
  refetch is acceptable at this stage; live sync arrives with Prompt 16).

## Dependencies
Prompt 6.

## Notes
This "is DM" helper will be reused extensively later (the lobby's session-start flow, map
editor, initiative control, NPC tools, the rule-override and action-economy controls, vision
bypass, account page campaign management, and the campaign narrative tools) — keep it clean
and centrally located rather than duplicating the check in each feature, per the project's
reuse mantra.
```

---

### Prompt 8: Character data model

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: Character info

## Context
Campaigns and membership exist (Prompts 4, 6). There is no representation of a player
character yet.

## Task
Read the campaign_members schema and RLS approach used so far. Design and migrate a
characters table: owning player, campaign, name, race, class, level, ability scores, current
and max HP, AC, speed (base movement rate in feet), proficiencies, an inventory of items, and
known spells. Also add a
character_resources table for tracking any limited-use feature a character has — not just
spell slots but things like a racial or class ability usable a fixed number of times per
rest (name, max uses, current uses, and a recharge type distinguishing short rest, long rest,
or daily recovery). Write RLS policies so a character is readable and writable only by its
owning player and by the campaign's current DM.

## Acceptance Criteria
- Schema supports representative test characters (e.g. a fighter and a wizard) including
  inventory items and at least one limited-use resource each.
- RLS confirmed: the owning player and the campaign DM can read/write a character; other
  campaign members cannot.

## Dependencies
Prompt 6.
```

---

### Prompt 9: 5e rules engine

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: Character info / rules

## Context
The character data model exists (Prompt 8) but nothing yet calculates derived values like
modifiers or attack bonuses from it. This module lives in the rules-engine boundary
established in Prompt 2.

## Task
Read the character data model and the rules-engine module boundary. Build a pure TypeScript
module (no UI, fully unit-testable) implementing D&D 5e SRD mechanics: ability modifiers from
ability scores, proficiency bonus by character level, saving throw bonuses, skill check
bonuses, passive scores (passive Perception and other passive skill values, computed as 10
plus the relevant modifier), spell slot tables by class and level, and attack bonus
calculation for melee, ranged, and spell attacks. Include movement cost rules covering both
elevation change (climbing to a higher grid cell costs extra movement per the SRD climbing
rule) and difficult terrain (moving into a difficult-terrain cell, per the map's terrain_type,
costs double movement per SRD) — these two costs can stack. Also define range and type
metadata for actions and spells (melee/ranged/area, range in feet, valid target type) so that
later features can query "what can this character use against a target this many feet away".

Seed a static SRD content dataset alongside this module — races, classes with the per-level
features needed for derived stats, the full SRD spell list (with level, range, target type,
and whether it requires concentration), and starting equipment lists — stored as plain data
files inside the rules-engine module rather than left for a later prompt to invent. Also fix
diagonal grid movement to cost a flat 5 feet per cell (the SRD standard), since range,
movement cost, and the future ruler tool all depend on this being decided once, here.

## Acceptance Criteria
- The seeded SRD dataset covers every core race and class the campaign is expected to use,
  with a full spell list including concentration flags, rather than a token handful of
  examples.
- Unit tests cover: ability modifier calculation, proficiency bonus at multiple levels,
  saving throw and skill bonuses, passive score calculation, the spell slot table for at
  least two different caster classes, movement cost across an elevation change, movement cost
  through difficult terrain, a case where both stack, and a query returning which
  actions/spells are usable at a given range.
- The module has no UI or database dependency — it is pure functions operating on plain data,
  living entirely inside the rules-engine module boundary.

## Dependencies
Prompt 8.

## Notes
Base this only on the D&D 5e SRD (open license) mechanical rules — do not reproduce
closed-license Player's Handbook flavor text or content. This module will be extended by
several later prompts (Prompt 56's perception engine, Prompt 59's advantage/disadvantage,
Prompt 60's Stealth) — read what's here first and add to it rather than building a second
calculation module, per the project's reuse mantra.
```

---

### Prompt 10: Character creation flow

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: Character info

## Context
The character data model (Prompt 8) and rules engine (Prompt 9) exist, but there is no UI to
actually build a new character yet. The shared component library exists (Prompt 3).

## Task
Read the character data model, rules engine, and shared component library. Build a guided,
multi-step character creation flow, using the shared components/tokens rather than hand-rolled
styles: choosing race and class, assigning ability scores, selecting starting equipment and
inventory, and selecting starting spells for casters. Use the rules engine to compute and
display derived stats (modifiers, saves, spell slots, etc.) live as choices are made. On
completion, save the character using the data model from Prompt 8, linked to the creating
player and their campaign.

## Acceptance Criteria
- A full character can be created end to end (test with at least one martial class and one
  caster class), and every derived value shown during creation matches the rules engine's
  output.
- The completed character appears in the campaign's character list/dashboard afterward.
- The flow visually matches the shared design system (Prompt 3) rather than introducing new
  one-off styling.

## Dependencies
Prompts 3, 8, 9.
```

---

### Prompt 11: Character sheet view/edit

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: Character info

## Context
Characters can now be created (Prompt 10) using the rules engine (Prompt 9). There is no full
sheet view for looking at or adjusting a character during play yet.

## Task
Read the character data model, rules engine, creation flow, and shared component library.
Build the full character sheet screen with sections for: core stats (ability scores, saving
throws, skills — all using live rules engine calculations), inventory (add, remove, edit
items), spells (known/prepared spells with slot tracking), and a resource-use section listing
each entry from character_resources with its current/max uses and controls to spend or
manually restore a use. The sheet must be editable in place during play by the owning player,
and viewable (with oversight edit access) by the campaign's current DM. Other players must not
be able to view or edit someone else's sheet.

## Acceptance Criteria
- All derived stats display correctly and recalculate live when underlying values change.
- Spending a resource use decrements current_uses and persists; restoring does the reverse.
- The owning player can edit; the DM can view and edit; other campaign members cannot access
  the sheet at all.

## Dependencies
Prompts 9, 10.

## Notes
DM view/edit access relies on the "is DM" helper built in Prompt 7 — reuse it rather than
re-deriving DM status here.
```

---

### Prompt 12: Rest mechanic

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: Character info / rules

## Context
Character resources and spell slots exist (Prompt 8) and are visible on the sheet (Prompt 11),
but nothing yet resets them — once spent, a resource stays spent.

## Task
Read the character_resources model, the rules engine's spell slot logic, and the character
sheet. Implement short rest and long rest actions, triggerable from the character sheet, that
reset the appropriate resources: short-rest actions reset only resources whose recharge_type
is short_rest (these also reset on a long rest); a long rest additionally resets long_rest and
daily resources, restores spell slots to full, and restores the character's HP to their
maximum, per SRD rest rules. Hit-dice spending during a short rest is out of scope for this
prompt — short rests only reset short-rest resources, they do not restore HP.

## Acceptance Criteria
- Triggering a short rest resets only short-rest resources, leaving long-rest/daily ones
  untouched.
- Triggering a long rest resets all resources including spell slots, and restores HP to the
  character's maximum.
- Changes persist and are immediately reflected on the character sheet.

## Dependencies
Prompts 8, 9.
```

---

### Prompt 13: Player avatar library and upload

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: Character info / 3D table

## Context
Auth and profiles exist (Prompt 5) and the shared design system exists (Prompt 3). Players are
not yet represented visually anywhere in the app — there's no concept of what a player looks
like at the table.

## Task
Read the profiles schema and the shared component library. Design and migrate a table (or
extend profiles) to hold a profile-scoped avatar selection: a reference to the chosen 3D
avatar model, which built-in/custom source it came from, and the storage reference if custom.
Provide a small built-in set of preset 3D avatar models (a handful of simple, low-poly
character models, constructed the same procedurally-generated primitive-mesh way as Prompt
24's built-in map assets, exported to .glb) a player can pick from. Build a custom avatar upload flow accepting a glTF
(.glb) file, validated the same way as the map's custom asset uploads will be (correct file
type, a reasonable size limit, loads without error — see Prompt 25, which this prompt should
mirror even though it runs first). Store uploaded avatars in Supabase Storage referenced from
the player's profile. Build the selection UI (pick a built-in preset, or upload/select a
custom one) using the shared component library.

## Acceptance Criteria
- A player can select a built-in preset avatar and see it saved to their profile.
- A player can upload a valid custom .glb model, have it validated, and select it as their
  avatar; an invalid/oversized file is rejected with a clear error.
- The chosen avatar is stored against the player's profile, not any single campaign, so it
  carries across every campaign they're in.

## Dependencies
Prompts 3, 5.

## Notes
This avatar is not rendered anywhere yet — Prompt 21 renders it seated at the table once the
3D scene and seating exist. Prompt 25 (custom map asset upload) should reuse the same
validation logic this prompt establishes rather than duplicating it, per the project's reuse
mantra — whichever of the two is built second should extract a shared upload-validation
utility.
```

---

### Prompt 14: D&D Beyond PDF character import

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: Character info

## Context
The character data model (Prompt 8), rules engine (Prompt 9), and shared component library
(Prompt 3) exist. Players who already have characters built on D&D Beyond currently have to
re-enter them by hand through the creation flow.

## Task
Read the character data model, rules engine, and character creation/sheet UI. Build an import
flow that accepts a D&D Beyond character PDF export, extracts what it can reliably read from
the PDF's text/layout (name, race, class, level, ability scores, HP, AC, proficiencies,
inventory, known spells where identifiable), and maps it onto this app's character data model.
Because D&D Beyond does not publish a stable machine-readable export format and PDF layouts
can vary between character sheet themes/versions, treat this as best-effort: present the
extracted data to the player as a pre-filled, fully editable draft (reusing the character
creation/sheet UI from Prompts 10 and 11) rather than saving it directly, so they can correct
anything the parser got wrong or missed before it's saved as a real character.

## Acceptance Criteria
- Importing a standard D&D Beyond PDF export produces a pre-filled character draft with a
  clear majority of fields correctly populated for a representative test character.
- Every field is editable before saving, and nothing is saved until the player confirms.
- A PDF that fails to parse meaningfully (wrong file, corrupted, unrecognized layout) fails
  clearly with a message directing the player to build the character manually instead, rather
  than silently producing a broken character.

## Dependencies
Prompts 3, 8, 9.

## Notes
This is inherently approximate given there's no official structured export — do not
over-promise perfect field coverage; the review/edit step is load-bearing, not optional
polish. Reuse Prompts 10/11's existing forms for the review step rather than building a
parallel editing UI.
```

---

### Prompt 15: Account page

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: Account / Campaigns

## Context
Auth/profiles (Prompt 5), campaigns and DM handoff (Prompts 6, 7), characters (Prompt 8),
character creation (Prompt 10), character sheet (Prompt 11), avatar selection (Prompt 13), and
PDF import (Prompt 14) all exist as separate flows reachable only from within a specific
campaign or via direct links. There is no single personal hub for a player to manage their
profile, their characters across every campaign, or their campaigns overall.

## Task
Read the profile, campaign, campaign_members, DM-handoff, character, and avatar systems.
Build an Account page, using the shared component library, with three sections: profile
settings (display name and avatar selection, reusing Prompt 13's picker); a character library
listing every character the player owns across all their campaigns, with entry points to
create a new one (Prompt 10's flow) or import one from a D&D Beyond PDF (Prompt 14's flow);
and a campaign management section listing every campaign the player belongs to with their
role, offering rename/delete actions when they are that campaign's current DM (using the "is
DM" helper from Prompt 7), and a leave-campaign action when they are a player. Deleting a
campaign should cascade at the database level: memberships and characters use ON DELETE
CASCADE foreign keys back to campaigns, so removing the campaign removes them automatically —
characters are not left orphaned or silently surviving in a player's library with no campaign
to belong to. Campaign-scoped tables added by later prompts (maps in Prompt 23, narrative
content in Prompt 32) should follow the same ON DELETE CASCADE convention so this delete
continues to clean up fully as the schema grows.

## Acceptance Criteria
- Profile settings changes save correctly and are reflected elsewhere in the app (e.g.
  campaign member lists, seated avatars once Prompt 21 exists).
- The character library correctly lists every character owned by the current user across all
  their campaigns, with working links to create or import a new one.
- Campaign management correctly shows DM-only actions (rename/delete) only for campaigns
  where the user is currently DM, and a leave action for campaigns where they're a player;
  deleting a campaign the user DMs removes it along with every campaign-scoped table via
  cascading foreign keys, with no orphaned data left behind.

## Dependencies
Prompts 3, 5, 6, 8, 10, 11, 13, 14.
```

---

### Prompt 16: Real-time campaign channel

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: Realtime infrastructure

## Context
Campaigns and membership exist (Prompt 6). Nothing in the app currently updates live between
connected players — everything requires a manual refresh. This work lives inside the realtime
module boundary established in Prompt 2.

## Task
Read how campaigns and membership are structured, and the realtime module boundary. Set up a
Supabase Realtime channel scoped per campaign, with presence tracking so the app knows which
members are currently connected. Build a small, typed internal event-bus pattern wrapping this
channel that later features (map state, token movement, initiative, dice rolls, activity log)
will publish and subscribe to, rather than each feature talking to Realtime directly. As a
minimal visible proof of this working, show an online/offline indicator next to each campaign
member. Run the realtime load-testing script from Prompt 2 against this channel and record the
result as a baseline.

## Acceptance Criteria
- Opening the same campaign in two separate browser sessions shows each user as present to
  the other within a couple of seconds of connecting.
- Closing one session updates the other's presence indicator within a couple of seconds.
- The event-bus wrapper is clearly reusable (not campaign-page-specific) for later features
  to build on, and lives entirely inside the realtime module.
- The Prompt 2 load-testing script runs successfully against this channel and a baseline
  latency number is recorded.

## Dependencies
Prompt 6.

## Notes
This prompt is pure plumbing — no visible game feature beyond the presence indicator — but
almost every later feature (map sync, token movement, combat, dice, POIs, the lobby, handout
reveals) depends on it, so design the event-bus abstraction cleanly rather than ad hoc.
Prompt 17 immediately hardens this channel for real-world dropped connections before anything
else is built on top of it.
```

---

### Prompt 17: Reconnection and session resilience

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: Realtime infrastructure

## Context
The realtime channel and event-bus exist (Prompt 16), tested so far only against stable local
connections. This app's whole purpose is remote play with players on real, sometimes flaky
internet connections (the project owner specifically plays with people in Scotland) — a
dropped wifi connection or a laptop going to sleep is a routine occurrence, not an edge case.

## Task
Read the realtime event-bus from Prompt 16. Implement reconnection handling: detect when a
client's realtime connection drops, attempt to reconnect with backoff, and on successful
reconnection re-fetch and resync the current authoritative state (presence, and whatever
campaign state exists by the time later prompts add it — map, tokens, combat, HP — so this
should be built as a generic "resync on reconnect" mechanism other modules can register with,
not a one-off fix). Show the affected player a clear "reconnecting..." indicator while
disconnected, and confirm when they're back in sync. Extend the Prompt 2 load-testing script
to simulate a dropped connection mid-session and verify the client recovers correctly.

## Acceptance Criteria
- Simulating a network drop on one client shows a clear reconnecting indicator, and on
  reconnection that client's state matches the other connected clients' state exactly.
- The resync mechanism is generic (other modules can hook into it as they're built), not
  specific to presence alone.
- The extended load-testing script demonstrates correct recovery from a simulated drop.

## Dependencies
Prompt 16.
```

---

### Prompt 18: Lobby screen and presence

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: Lobby / Realtime

## Context
Auth (Prompt 5), the campaign dashboard (Prompt 6), and DM role handoff (Prompt 7) exist. The
realtime channel/event-bus pattern (Prompt 16) and reconnection handling (Prompt 17) exist so
far only scoped per campaign. After logging in, a user currently lands straight on their
campaign dashboard with no visibility into who else from the group is currently online and
free to play — there's no shared "everyone's here" moment before a session begins.

## Task
Read the auth flow, campaign dashboard, and the realtime module's channel/event-bus pattern
established in Prompts 16-17. Build a Lobby screen that becomes the default landing page
immediately after login: it shows every currently-connected user across the whole app (not
scoped to any one campaign) with live presence, built using a new app-wide lobby channel that
reuses the same realtime pattern already established rather than inventing a new one. Show a
live count of how many people are currently in the lobby, updating as people log in and out.

This prompt does not yet add a "Start" action — that arrives in Prompt 22, once the Game Room
exists as a real destination to send people to.

## Acceptance Criteria
- After logging in, a user lands on the Lobby by default.
- Every other currently-connected user appears in the lobby with live presence, updating
  within a couple of seconds as people join or leave.
- The lobby correctly reuses the realtime channel/event-bus pattern from Prompts 16-17 rather
  than a separate, one-off implementation.

## Dependencies
Prompts 6, 7, 16, 17.

## Notes
This is a landing/social space, not a campaign feature — keep it free of campaign-specific
logic. Prompt 22 wires an actual "Start" action into this screen once the Game Room, seating,
and avatars exist for it to lead into.
```

---

### Prompt 19: 3D table scene foundation

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: 3D table

## Context
Campaigns exist and can be navigated to (Prompt 6). There is no 3D "Game Room" yet — this
prompt lays the visual foundation that seating, maps, and tokens will all be built on top of.
This work lives inside the 3d-scene module boundary established in Prompt 2.

## Task
Read the campaign routing/dashboard structure and the 3d-scene module boundary. Build a "Game
Room" page for a given campaign using React Three Fiber: set up the Canvas, construct a table
3D model (a simple mesh — a rectangular or oval tabletop with legs is sufficient), add basic
lighting (ambient plus at least one directional light), and a default camera positioned to
look down at the table from above. Run the Prompt 2 headless 3D render benchmark against this
scene and record the result as a baseline.

## Acceptance Criteria
- Navigating to a campaign's Game Room renders a 3D scene containing a visible table with
  reasonable lighting, at an acceptable frame rate on a typical laptop.
- The scene resizes correctly when the browser window is resized.
- The Prompt 2 render benchmark runs successfully against this scene and a baseline frame-time
  number is recorded.

## Dependencies
Prompts 2, 3, 6.
```

---

### Prompt 20: Player seating and camera

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: 3D table

## Context
The Game Room scene with a table exists (Prompt 19). Every player currently sees the same
generic camera angle, and there is no concept of a "seat" at the table.

## Task
Read the Game Room scene and campaign membership. Assign each campaign member a seat position
distributed evenly around the table (the DM's seat can be visually distinguished if useful).
Set the default camera, for each logged-in player, to start at their own assigned seat looking
toward the table. Add a toggle control that switches from seat view into a free orbit/pan/zoom
camera, and back to seat view.

## Acceptance Criteria
- Each player, by default, sees the table from their own assigned seat.
- All connected players see the same consistent seating arrangement (seat assignment is not
  per-client-random).
- The orbit toggle correctly switches camera modes in both directions.

## Dependencies
Prompt 19.
```

---

### Prompt 21: Render seated avatars at the table

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: 3D table / Character info

## Context
Seating and camera exist (Prompt 20). Players can choose a built-in or custom avatar (Prompt
13). Seats currently render as empty positions with no visual occupant.

## Task
Read the seating system and the avatar selection data from Prompt 13. For each connected
player, render their chosen avatar (built-in or custom) at their assigned seat in the 3D
scene, kept in sync so every connected player sees the same avatars in the same seats. Handle
the case where a player hasn't chosen an avatar yet with a sensible default placeholder. Run
the Prompt 2 render benchmark again with a full table of avatars present and compare against
the Prompt 19 baseline.

## Acceptance Criteria
- Every connected player's chosen avatar renders correctly at their assigned seat for all
  other connected players.
- A player without a chosen avatar shows a clear default placeholder rather than an empty seat
  or an error.
- Changing your avatar selection updates what other connected players see within a couple of
  seconds.
- The re-run render benchmark stays within the performance budget from Prompt 2; if it
  regresses past budget, note this clearly rather than silently accepting it.

## Dependencies
Prompts 13, 20.
```

---

### Prompt 22: Session start and DM assignment flow

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: Lobby / DM role

## Context
The Lobby (Prompt 18) shows who is currently online. Campaign creation/join (Prompt 6) and DM
handoff (Prompt 7) exist. The Game Room now exists with seating and rendered avatars (Prompts
19-21), so it's a real destination. The Lobby currently has no way to actually begin a session.

## Task
Read the Lobby screen, campaign dashboard, DM handoff, and the Game Room/seating/avatar
rendering. Add a "Start" control to the Lobby that becomes available once more than two users
are present in the lobby. Pressing Start: presents the pressing user with a picker of their
own campaigns to choose which one to start; assigns that user as the current DM of the chosen
campaign, calling the shared transfer function from Prompt 7 if someone else currently holds
that role for that campaign; and then moves every present lobby user who is a member of the
chosen campaign into that campaign's Game Room together. Lobby users who are not members of
the chosen campaign remain in the lobby with a clear indication that a session has started and
which campaign it's for. If a session for a given campaign is already in progress, disable
Start for that campaign rather than letting it be started twice; if two users press Start for
different campaigns at nearly the same moment, resolve it first-wins and show the second
presser a clear message rather than a silent failure. Add an "End session" control, usable by
the current DM from the Game Room, that marks the campaign's session as no longer in progress
and returns every present member of that campaign to the Lobby — this both lets Start be used
again for that campaign and gives the group an explicit way to wrap up for the night. Also
treat a session as no longer in progress if every member of that campaign disconnects from the
Game Room, so a crash or an abandoned session doesn't permanently lock out Start.

## Acceptance Criteria
- The Start control is disabled/hidden until more than two users are present in the lobby, and
  becomes available once that threshold is met.
- Pressing Start lets the pressing user pick from their own campaigns, correctly assigns them
  as DM of the chosen campaign (transferring the role if needed), and moves every present
  member of that campaign into its Game Room.
- Lobby users who aren't members of the started campaign are not moved, and see a clear
  indicator that a session is in progress and for which campaign.
- Starting an already-in-progress campaign is prevented with a clear message; two
  near-simultaneous Start presses resolve consistently (first request wins) without either
  user seeing a silent failure.
- The DM can end a session from the Game Room, returning all present members to the Lobby and
  re-enabling Start for that campaign; a session with no remaining connected members is also
  treated as ended rather than permanently blocking future starts.

## Dependencies
Prompts 6, 7, 18, 21.

## Notes
This is the primary way a session's DM gets set day to day — whoever starts the session from
the lobby becomes DM for it. The Account page (Prompt 15) and the in-game DM handoff (Prompt 7)
remain available if the group wants to change DM outside of this flow.
```

---

### Prompt 23: Map and asset data model

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: Map builder

## Context
Campaigns exist (Prompt 6). There is no representation yet of a map, its terrain/elevation, or
objects placed on it.

## Task
Read the campaign schema and RLS conventions used so far. Design and migrate: a
campaign_maps table (campaign, name, grid width and height); a map_cells table (map,
x, y, elevation as a discrete integer level, terrain type); a map_objects table (map,
asset reference, grid x, grid y, elevation, rotation, and a flexible field to hold
interactive-behavior configuration for a later prompt); and an asset_library table (name,
source type distinguishing built-in from custom, a reference to the 3D model, and a nullable
campaign reference so built-in assets are global while custom ones are scoped to one
campaign). Add a live_map reference on the campaigns table (nullable, set once a DM selects a
live map in Prompt 29) so which map is currently live is persisted server-side, not just
broadcast — this is what lets a reconnecting or newly-joining client recover the correct live
map instead of guessing. Write RLS so only a campaign's current DM can read/write every map in
their campaign, while other members can only read whichever map is currently referenced by
live_map.

## Acceptance Criteria
- Schema supports creating a small test map (e.g. a 10x10 grid) with a couple of elevation
  steps and at least one placed object referencing a placeholder asset.
- RLS confirmed: DM can read/write every map in their campaign; other members can read only
  the map currently referenced by live_map; non-members cannot read anything.
- Campaign-scoped tables use ON DELETE CASCADE foreign keys back to campaigns, per Prompt 15's
  cascade-delete convention.

## Dependencies
Prompt 6.
```

---

### Prompt 24: Built-in preset asset library

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: Map builder

## Context
The asset_library table exists (Prompt 23) but is empty — there are no assets a DM can place
on a map yet.

## Task
Read the asset_library schema. Construct a small curated set of simple, low-poly 3D assets
suitable for a stylized tabletop scene — for example a torch, chest, door, table, tree, rock,
wall segment, and a set of stairs — as procedurally-generated primitive-based meshes (boxes,
cylinders, cones composed together) exported to .glb, rather than sourcing external art files,
so there are no licensing concerns and no missing-asset dependency. Add them as static assets
in the project and seed the asset_library table with entries marking them as built-in/global,
available to every campaign.

## Acceptance Criteria
- A query against asset_library for any campaign returns the full built-in set.
- Each built-in asset loads correctly as a 3D model in a simple test render.

## Dependencies
Prompt 23.

## Notes
Keep these lightweight/low-poly for performance — this is a stylized tabletop scene, not a
photorealistic render, and it needs to run smoothly for every connected player at once. Check
against the Prompt 2 render-benchmark budget once several are loaded together.
```

---

### Prompt 25: Custom asset upload pipeline

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: Map builder

## Context
Built-in assets exist and load correctly (Prompt 24). There is no way yet for a DM to add
their own custom 3D models. Prompt 13 built an equivalent upload/validation flow for player
avatars.

## Task
Read the asset_library schema, how built-in assets are loaded, and the upload/validation
approach built in Prompt 13. Build a DM-only upload flow that accepts a glTF (.glb) model
file, stores it in Supabase Storage, validates it (correct file type, a reasonable size limit,
and that it loads without error before accepting it), and adds a corresponding asset_library
row scoped to that DM's campaign so the model appears alongside the built-in set in that
campaign's asset palette. Reuse the shared upload-validation logic from Prompt 13 rather than
writing a second, separate implementation, per the project's reuse mantra.

## Acceptance Criteria
- A DM can upload a valid .glb file and see it appear in their campaign's asset palette.
- Invalid or oversized files are rejected with a clear error and are not added to the library.
- An asset uploaded to one campaign is not visible in a different campaign's palette.
- The validation logic is shared with (not duplicated from) Prompt 13's avatar upload flow.

## Dependencies
Prompts 3, 23, 24.
```

---

### Prompt 26: Map editor — terrain and elevation

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: Map builder / elevation

## Context
The map data model exists (Prompt 23), but there is no editor UI yet — a DM cannot actually
build a map.

## Task
Read the campaign_maps and map_cells schema and the shared component library. Build a DM-only
map editor screen with a grid-based terrain tool: clicking or dragging on a cell raises or
lowers its elevation in discrete steps, and a separate control paints a terrain type onto a
cell (including marking a cell as difficult terrain, which the rules engine from Prompt 9
already knows how to cost). Support creating a new named map for the campaign and
editing/re-saving an existing one. Check the editor's interactivity against the Prompt 2
performance budgets since this is a frequently-interacted-with tool.

## Acceptance Criteria
- A DM can create a new map, sculpt a small area with varying elevation (e.g. a raised
  platform a few steps high), paint terrain (including at least one difficult-terrain area)
  across it, save it, and reload it later with the same data intact.
- A non-DM campaign member cannot reach or use the editor.
- Editor interactions (raising/lowering a cell, painting terrain) remain responsive per the
  Prompt 2 performance budget on a map of reasonable size (e.g. 20x20).

## Dependencies
Prompts 2, 3, 23.
```

---

### Prompt 27: Map editor — object and POI placement

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: Map builder

## Context
The terrain/elevation editor exists (Prompt 26) and the asset library (built-in and custom)
exists (Prompts 24, 25). There is no way yet to place objects onto a map.

## Task
Read the terrain editor and the asset_library/map_objects schema. Extend the map editor with
an object placement mode: show a palette of available assets (built-in plus this campaign's
custom uploads), let the DM click or drag an asset onto a specific grid cell so it snaps to
that cell and sits at that cell's current elevation, provide a rotation control for the placed
object, and allow removing or repositioning a placed object.

## Acceptance Criteria
- A DM can place several different objects onto a map, rotate one, move one to a different
  cell, and remove one.
- Placed objects persist correctly tied to their map and reload accurately, including
  position, elevation, and rotation.

## Dependencies
Prompts 24, 25, 26.
```

---

### Prompt 28: Interactive POI behavior

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: Map builder

## Context
Objects can be placed on a map (Prompt 27), and the map_objects table has a flexible field
reserved for interactive behavior (Prompt 23). The realtime channel exists (Prompt 16). No
object currently does anything when interacted with.

## Task
Read the map_objects interactive-config field, the placement editor, and the realtime
event-bus. Design a simple action model for interactive objects covering at least: revealing a
text message, revealing an image, toggling the object's visibility, and toggling a generic
on/off state. In the map editor, let the DM configure a placed object with one of these
actions and its content. During a live session, let the DM (and, if the DM enabled it for that
specific object, any player) trigger the configured action, broadcasting the result to every
connected player through the realtime channel and persisting the triggered state to the
object's row in map_objects (not just the live broadcast), so a client that reconnects or
joins after the trigger sees the current state rather than the object's original untriggered
state.

## Acceptance Criteria
- A DM can configure an object (e.g. a chest) with a reveal-text action and a message, trigger
  it live, and every connected player sees the revealed content appear within a couple of
  seconds.
- A toggle-state action visibly and consistently changes the object's appearance for everyone.
- An object not enabled for player triggering can only be triggered by the DM.

## Dependencies
Prompts 16, 26, 27.
```

---

### Prompt 29: Map rendering and live switching on the tabletop

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: Map builder / 3D table

## Context
The 3D table scene and seating exist (Prompts 19, 20). Maps can be fully built in the editor
including terrain, elevation, and interactive objects (Prompts 26, 27). None of this is
rendered on the actual tabletop yet — the table currently just shows a bare surface.

## Task
Read the 3D scene, the map/cell/object data model, and the realtime channel. Build the actual
tabletop surface rendering: construct 3D geometry from a saved map's per-cell elevation and
terrain data (stepped platforms reflecting each cell's elevation, not a flat plane), and
position that map's placed objects correctly on top of it. Add a DM-only control to select
which of the campaign's saved maps is currently "live" on the table — write the selection to
the campaign's live_map field from Prompt 23 (not just an in-memory broadcast), and broadcast
the change through the realtime channel so every seated player's view updates live, while a
newly-connecting or reconnecting client reads live_map directly to recover the correct map.
Run the Prompt 2 render benchmark against a live map of representative size/complexity.

## Acceptance Criteria
- Selecting a map as live renders its terrain (with correct elevation steps) and its objects
  correctly on the table for the DM.
- Every other connected player's table view updates to match within a couple of seconds of
  the DM's selection.
- Switching to a different saved map updates the whole table live for everyone.
- The render benchmark with a representative live map stays within the Prompt 2 performance
  budget.

## Dependencies
Prompts 2, 16, 19, 20, 26, 27.
```

---

### Prompt 30: Grid overlay and token placement

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: Movement

## Context
The live map renders correctly on the table with terrain and objects (Prompt 29). There is no
visible grid and no concept of a character/NPC token on the table yet.

## Task
Read the live map rendering and the realtime event-bus. Migrate a map_tokens table (map
reference, either a character reference or a placeholder NPC name, grid x/y, elevation, and an
allegiance field distinguishing party/hostile/neutral — PC tokens default to party, DM-created
placeholder tokens default to hostile, and the DM can change any token's allegiance). Add a
visual grid overlay matching the live map's cells, shaded or lined so elevation differences are
readable at a glance. Build a token system on top of this table: every campaign character
automatically has a token available, linked back to that character's sheet; the DM can
additionally create simple placeholder tokens for NPCs/monsters (a name is enough for now —
full monster tooling is Prompt 61). A player can place, move (by re-placement), or remove the
token for their own character; the DM can do the same for any token. Allow placing a token onto
a specific grid cell so it renders at the correct position and sits at that cell's elevation,
with placement synced live to all connected players through the realtime channel.

## Acceptance Criteria
- Every player's character has a token available to place without extra setup, and the
  owning player can place/move/remove it themselves.
- The DM can place, move by re-placement, or remove any token, including placeholder NPCs, and
  can set or change any token's allegiance.
- Tokens visually sit at the correct height matching their current cell's elevation.
- Token placement and movement are synced live to every connected player.

## Dependencies
Prompts 16, 29.
```

---

### Prompt 31: Token movement (elevation and terrain aware)

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: Movement

## Context
Tokens can be placed on the grid (Prompt 30). The rules engine already implements
elevation-aware and difficult-terrain-aware movement cost (Prompt 9) and the realtime channel
exists (Prompt 16). There is no drag-to-move interaction yet — moving a token currently means
removing and re-placing it.

## Task
Read the token placement system, the rules engine's movement cost logic, and the realtime
event-bus. Implement drag-to-move for tokens: movement snaps cell by cell, and the running
movement cost is computed using the rules engine (including the extra cost for crossing an
elevation change and for entering difficult terrain, stacking where both apply), shown live to
the owning player during the drag against their character's speed (from Prompt 8). Since combat
and turn structure don't exist yet at this point in the plan, show the cost/budget readout but
do not hard-block movement outside of combat — Prompt 53's action economy work is what actually
enforces a hard per-turn movement limit once combat exists; for now, flag (rather than block)
any drag that exceeds the character's speed. Broadcast the token's new position to all
connected players in real time as it moves.

## Acceptance Criteria
- Dragging a token moves it cell by cell with a running distance/cost display that correctly
  increases when crossing an elevation change or entering difficult terrain, and correctly
  stacks when both apply to the same move.
- Movement is visible to all other connected players within a couple of seconds.
- Attempting to move further than the character's remaining movement is clearly flagged.

## Dependencies
Prompts 9, 16, 30.
```

---

### Prompt 32: Campaign narrative data model

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: Campaign Creator

## Context
Campaigns exist (Prompt 6) with DM role handoff (Prompt 7), but a campaign is currently just a
name and a member list — there's nowhere to store the narrative content a DM builds a
campaign's world out of: NPCs, locations/lore, quests, session recaps, handouts, or notes.

## Task
Read the campaigns schema and RLS conventions used so far. Design and migrate the tables this
narrative layer needs: an npcs table (campaign, name, description, portrait reference,
relationship notes); a lore_pages table (campaign, title, body content, and references to
other lore_pages it links to, for a simple wiki-style structure); a quests table (campaign,
title, description, status such as active/completed); a session_log table (campaign, date or
session number, recap text); a handouts table (campaign, title, image/document reference,
and whether it has been revealed to players yet); a dm_notes table (campaign, body content,
DM-only); and a house_rules field or table (campaign, body content, visible to all members).
Write RLS so npcs, lore_pages, quests, session_log, and house_rules are writable only by the
current DM and readable by all campaign members; handouts follow the same write rule but are
only readable by players once revealed (always readable by the DM); dm_notes are both
writable and readable only by the current DM.

## Acceptance Criteria
- All tables exist with correct columns, types, and foreign keys back to campaigns.
- RLS confirmed: DM can write everything; players can read npcs/lore_pages/quests/
  session_log/house_rules but not dm_notes; players can only read a handout once it's marked
  revealed.
- A representative test campaign can be populated with at least one row in each table.
- Every table uses an ON DELETE CASCADE foreign key back to campaigns, per Prompt 15's
  cascade-delete convention.

## Dependencies
Prompts 6, 7.
```

---

### Prompt 33: NPC roster

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: Campaign Creator

## Context
The npcs table exists (Prompt 32). There is no UI yet for a DM to actually build or browse
their NPC roster.

## Task
Read the npcs schema and the shared component library. Build a DM-only NPC roster screen:
create, edit, and view NPCs (name, description, portrait image upload, relationship notes to
other NPCs or to player characters), and a browsable list/grid for the campaign's full roster.

## Acceptance Criteria
- A DM can create, edit, and view NPCs with a portrait image and relationship notes.
- The roster lists every NPC in the campaign and stays in sync with edits.
- Non-DM campaign members cannot create or edit NPCs (read access, if any, is decided by
  Prompt 32's RLS, which currently allows players to read this table).

## Dependencies
Prompts 3, 7, 32.
```

---

### Prompt 34: World and lore pages

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: Campaign Creator

## Context
The lore_pages table exists (Prompt 32). There is no UI yet for a DM to write or browse
world-building content.

## Task
Read the lore_pages schema and the shared component library. Build a DM-only lore/world-page
editor: create, edit, and view pages (a title and body content), with the ability to link one
page to another (e.g. a location page linking to the faction that controls it), and a
browsable index of all pages for the campaign, showing their links.

## Acceptance Criteria
- A DM can create, edit, and view lore pages, and link one page to another.
- The index correctly lists every page and reflects links between them.
- Clicking a link navigates to the linked page.

## Dependencies
Prompts 3, 7, 32.
```

---

### Prompt 35: Session log and handouts

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: Campaign Creator

## Context
The session_log and handouts tables exist (Prompt 32). The realtime channel and reconnection
handling exist (Prompts 16, 17). There is no UI yet for either feature.

## Task
Read the session_log/handouts schema and the realtime event-bus. Build a DM-only session log
editor: write a recap entry per session, listed chronologically, readable by all campaign
members. Build a handouts feature: the DM uploads an image or document as a handout, keeps it
hidden until the right moment, and then reveals it live — broadcasting the reveal through the
realtime channel so every connected player sees it appear, similar in spirit to the interactive
POI reveal from Prompt 28.

## Acceptance Criteria
- A DM can write and publish session recap entries, visible to all members in chronological
  order.
- A DM can upload a handout, and it stays hidden from players until explicitly revealed.
- Revealing a handout shows it to every connected player within a couple of seconds.

## Dependencies
Prompts 3, 16, 17, 32.
```

---

### Prompt 36: Private DM notes and house rules

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: Campaign Creator

## Context
The dm_notes and house_rules tables/fields exist (Prompt 32). There is no UI yet for either.

## Task
Read the dm_notes/house_rules schema. Build a DM-only private notes editor (free text, visible
and editable only by the current DM — confirm this against the Prompt 32 RLS rather than
just hiding it in the UI). Build a house rules editor: free text visible to all campaign
members, editable only by the DM, for documenting things like the action-economy strictness
mode already covered by Prompt 53 or any other table-specific agreements.

## Acceptance Criteria
- Private DM notes are genuinely inaccessible to non-DM members at the data layer, not just
  hidden in the UI.
- House rules text is visible to every campaign member and editable only by the current DM.

## Dependencies
Prompts 3, 7, 32.
```

---

### Prompt 37: AI-assisted narrative generation

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: Campaign Creator

## Context
The NPC roster (Prompt 33) and lore pages (Prompt 34) exist as manually-authored content. The
DM has to write every NPC and location description by hand, which is slow during prep.

## Task
Read the NPC roster and lore-page systems. Integrate an LLM text-generation API (e.g. the
Anthropic API) behind a small, isolated service in the data-access/backend layer — never
called directly from the browser, so any API key stays server-side. Add a "Generate a draft"
action to the NPC roster and lore-page editors: the DM types a short plain-language
description of what they want (e.g. "a suspicious dockworker who's secretly a smuggler," or
"an abandoned watchtower overrun with ivy"), and the app calls the LLM to produce a draft NPC
description or lore-page draft, shown to the DM as fully editable pre-filled content — not
saved until the DM confirms, the same review-before-save pattern used by the D&D Beyond
import (Prompt 14). Handle the case where no API key is configured by clearly hiding the
generate action with an explanation, rather than erroring.

## Acceptance Criteria
- Typing a short prompt into the NPC or lore-page generate action produces a coherent,
  on-theme draft that the DM can freely edit before saving.
- Nothing is saved until the DM explicitly confirms the draft.
- With no API key configured, the generate action is clearly hidden/disabled rather than
  causing an error.
- The API key/credential is never exposed to the browser.

## Dependencies
Prompts 33, 34.

## Notes
This is the one piece of the app that isn't self-hosted — it calls an external LLM API and
needs its own credential/environment variable, separate from the self-hosted Supabase stack.
Document this clearly as a deliberate exception. Keep the integration isolated in one small
module so Prompt 38 can reuse it rather than standing up a second API client, per the reuse
mantra.
```

---

### Prompt 38: AI-assisted procedural map content generation

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: Campaign Creator / Map builder

## Context
The LLM integration from Prompt 37 exists. The map editor (terrain — Prompt 26, object
placement — Prompt 27), asset library (Prompts 24, 25), and live map rendering (Prompt 29) all
exist. Building a room or area by hand — sculpting terrain and placing every object
individually — is the slowest part of DM map prep.

## Task
Read the Prompt 37 LLM integration, the map data model, the asset library, and the terrain/
object editors. Add a "Generate area" action to the map editor: the DM first selects a bounded
region of the grid, then describes what they want it to contain in plain language (e.g. "a
ruined library with cobwebs and a treasure chest," or "a swampy clearing with a couple of dead
trees"). The app calls the LLM to produce a structured draft constrained to that region —
terrain type and elevation per cell, and object placements drawn only from assets already in
that campaign's palette (built-in and custom), each with a valid grid position, elevation
matching the generated terrain, and rotation. Render this as a preview overlay in the editor
that the DM can inspect and adjust cell-by-cell or object-by-object using the normal editor
tools, then explicitly accept (merging it into the live map) or discard. Validate the LLM's
output server-side against the campaign's actual asset palette and the selected region's
bounds before ever showing it as a preview — if it references an asset that doesn't exist or
places something out of bounds, retry the generation once, and if it still fails show the DM a
clear generation-failed message rather than rendering an invalid or partial preview.

## Acceptance Criteria
- Describing a room/area produces a structured draft using only assets that already exist in
  the campaign's palette — it never references or invents an asset that isn't available.
- An invalid LLM response (unknown asset, out-of-bounds placement) is caught by server-side
  validation before being shown as a preview; it retries once, then surfaces a clear failure
  message rather than rendering something broken.
- The draft renders as an editable preview, adjustable with the normal terrain/object editor
  tools, before the DM accepts or discards it.
- Discarding leaves the live map completely unchanged; accepting merges exactly what's shown
  in the preview.
- Reuses the Prompt 37 LLM integration rather than standing up a second API client.

## Dependencies
Prompts 24, 25, 26, 27, 29, 37.

## Notes
Bounding the generated region to a DM-selected rectangle keeps a single generation easy to
review rather than producing an entire sprawling map at once — a DM can run it again for the
next room.
```

---

### Prompt 39: Map organization (folders and thumbnails)

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: Map builder

## Context
The campaign_maps schema exists (Prompt 23) and the terrain editor lets a DM create multiple
maps (Prompt 26). As a campaign accumulates many maps (rooms, floors, regions), there's no way
to organize or browse them beyond a flat, unstructured list.

## Task
Read the campaign_maps schema and terrain editor. Add folders/categories a DM can create and
assign maps to (e.g. "Town," "Dungeon Level 1"), and generate or capture a thumbnail per map
(a simple top-down snapshot of its terrain is sufficient). Build a map picker grouped by
folder with thumbnails, replacing any flat unorganized list.

## Acceptance Criteria
- A DM can create folders, assign maps to them, and reassign a map to a different folder.
- The map picker groups maps by folder and shows a recognizable thumbnail per map.
- An unfiled map still appears in a sensible default group rather than being lost.

## Dependencies
Prompts 23, 26.
```

---

### Prompt 40: Map duplication and starter templates

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: Map builder

## Context
Map organization (Prompt 39) and the terrain/object editors (Prompts 26, 27) exist. Building
every map from a blank grid is slow, especially for repeated room shapes.

## Task
Read the map editor and organization system. Add a "duplicate map" action that clones an
existing map (terrain, elevation, and objects) as a new, independently-editable map placed
into the same or a chosen folder. Provide a small built-in set of starter templates (e.g. an
empty room, a corridor, a simple tavern layout) a DM can start a new map from instead of a
blank grid.

## Acceptance Criteria
- Duplicating a map produces an independent copy — editing the copy doesn't affect the
  original.
- Starting a new map from a template produces the expected pre-built layout, immediately
  editable.

## Dependencies
Prompts 26, 27, 39.
```

---

### Prompt 41: Undo/redo in the map editor

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: Map builder

## Context
The terrain and object editors (Prompts 26, 27) exist with no way to reverse a mistake short
of manually fixing it by hand.

## Task
Read the terrain and object placement editors. Add undo/redo covering terrain/elevation edits
and object placement/removal/movement, with a history depth of at least 50 steps, scoped to an
editing session on a given map.

## Acceptance Criteria
- A sequence of terrain and object edits can be undone step by step back toward the start of
  the session and redone forward again, with the map state matching exactly at each step.
- Undo/redo works across both terrain and object edits, not just one or the other.

## Dependencies
Prompts 26, 27.
```

---

### Prompt 42: Multi-floor map transitions

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: Map builder / Movement

## Context
Maps exist as independent entities (Prompt 23), can be built (Prompts 26, 27), and switched
live (Prompt 29). Token movement exists (Prompt 31). Nothing currently lets a token move from
one map to a different, linked one — e.g. stairs leading from a ground-floor map down to a
basement map.

## Task
Read the map data model, live rendering/switching, and token movement. Let a DM designate a
cell on one map as a transition point linked to a specific entry cell on another map. When a
token moves onto a transition cell during play, prompt to move that token (and, at the DM's
discretion, the whole party) to the linked map at its designated entry point, switching the
live map for everyone the same way Prompt 29's map-switching already does. Any token not moved
through the transition (e.g. a party member who stayed behind) remains on its original map at
its last position and is simply absent from the new live map's view — the players controlling
those tokens see the new live map like everyone else once it switches, since there is only one
live map per campaign at a time; note this limitation clearly rather than silently splitting
the table's view.

## Acceptance Criteria
- A DM can link a cell on one map to a specific entry cell on another map.
- A token moving onto the transition cell is offered the move; accepting switches the live map
  for everyone and places the token at the correct entry point.
- The DM can choose to move just the triggering token or the whole party through the
  transition.

## Dependencies
Prompts 23, 29, 31.
```

---

### Prompt 43: Measuring and ruler tool

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: Map builder / Movement

## Context
The live grid (Prompt 30) and token movement (Prompt 31) exist. Planning a move or checking
whether something is in range currently requires actually dragging a token to find out.

## Task
Read the live map/grid rendering and the rules engine's distance/movement-cost logic. Add a
measuring tool usable by any connected player: click-drag across the grid to see the distance
between two points in feet, accounting for elevation the same way movement cost does, without
moving any token. Make it clearly temporary and non-committal.

## Acceptance Criteria
- Measuring between two cells shows the correct distance, including any elevation cost where
  applicable.
- Using the tool never moves a token or consumes any of its movement for the turn.

## Dependencies
Prompts 29, 30.
```

---

### Prompt 44: Reference image underlay

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: Map builder

## Context
The terrain editor (Prompt 26) exists. Some DMs already have battle-map art (hand-drawn or
purchased) they'd like to build the 3D terrain over, matching an existing image rather than
starting from nothing.

## Task
Read the terrain editor and shared component library. Let a DM upload a reference image into
the editor, positioned and scaled under the grid as a visual guide for sculpting terrain and
placing objects. This is an editor-only aid — it must not be rendered on the live tabletop
during play, only visible to the DM while editing.

## Acceptance Criteria
- A DM can upload, position, and scale a reference image under the editor grid.
- The image is visible while editing.
- The reference image is confirmed absent from the live, player-facing table.

## Dependencies
Prompts 3, 26.
```

---

### Prompt 45: Initiative tracker

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: Combat mode

## Context
Tokens exist on the table and characters have full sheets (Prompts 11, 30). There is no combat
or turn-order system yet.

## Task
Read the token system and character sheets. Build a combat data model and UI: the DM can
start combat for the current session; every combatant (player characters plus any NPC tokens
present) has their initiative manually entered for now (the dice roller doesn't exist yet at
this point in the plan — Prompt 48 later wires an actual roll-initiative button through it
rather than this prompt building a throwaway one); an ordered turn list is displayed to all
connected players; and a "current turn" indicator exists with a control (usable by the DM, or
by whoever's turn it is) to advance to the next combatant, wrapping back to the top after the
last one.

## Acceptance Criteria
- Starting combat prompts for initiative for every combatant present and produces a correctly
  sorted turn order.
- Advancing turns cycles through the order correctly, including wrapping from the last
  combatant back to the first.
- The current turn indicator is synced live to every connected player.

## Dependencies
Prompts 3, 11, 30.
```

---

### Prompt 46: HP and damage tracking

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: Combat mode

## Context
Combat and initiative exist (Prompt 45). Character sheets already track current/max HP
(Prompt 11), but there is no in-combat way to apply damage or healing yet.

## Task
Read the combat/initiative state and the character sheet's HP fields. Add a damage/heal
control, usable by the DM on any combatant and by a player on their own character, during
combat on a selected combatant, which updates their current HP (clamped
between 0 and their max), and reflects the change immediately in both the character sheet and
a visible HP bar on that combatant's token. Sync the change live to every connected player.

## Acceptance Criteria
- Applying damage or healing updates HP correctly and consistently across the sheet and token
  views for every connected client.
- HP cannot be reduced below 0 or raised above the character's max.

## Dependencies
Prompts 11, 30, 45.

## Notes
Prompt 49 (death saving throws) and Prompt 50 (concentration) both hook directly into this
prompt's HP changes — build the damage/heal control so those can cleanly observe "HP just
changed" rather than needing their own separate damage-application path.
```

---

### Prompt 47: Conditions tracking

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: Combat mode

## Context
Combat and HP tracking exist (Prompts 45, 46). There is no way yet to apply status conditions
(e.g. poisoned, prone, stunned, blinded) to a combatant.

## Task
Read the combat state model. Implement applying and removing standard 5e status conditions on
a combatant during combat. Most conditions are simple on/off state; model exhaustion
separately as a stacking level (1 through 6, per SRD) with its own escalating effects rather
than forcing it into the same on/off shape as the others. This prompt is scoped to storing and
displaying condition state, including per-condition mechanical-effect flags (e.g. "blocks
vision," "halves speed") as data — it does not itself enforce those effects on rolls or
movement; that enforcement is consumed by later prompts (53's action economy, 56's vision
engine, 59's advantage/disadvantage) reading these flags. Show applied conditions as a small
badge/icon set on that combatant's token and listed on their character sheet, kept in sync
live for all players.

## Acceptance Criteria
- Applying a condition shows the correct badge on both the token and the sheet for every
  connected player.
- Removing a condition clears its badge everywhere.
- Multiple simultaneous conditions on one combatant display correctly without overlapping or
  hiding each other.
- Exhaustion correctly tracks and displays its current level rather than just on/off.

## Dependencies
Prompt 45.

## Notes
Prompt 56's perception engine will read the blinded condition (and any other condition with a
vision effect) from whatever model this prompt establishes — keep condition data structured
generically enough (e.g. a per-condition set of mechanical effect flags) that a future
condition doesn't require reworking how conditions are stored.
```

---

### Prompt 48: Integrated dice roller

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: Dice rolling

## Context
The rules engine can compute bonuses (Prompt 9), character sheets exist (Prompt 11), and the
realtime channel exists (Prompt 16). There is no dice rolling anywhere in the app yet.

## Task
Read the rules engine's bonus calculations, the character sheet, and the realtime event-bus.
Build a dice rolling system wired to character actions: rolling an attack, a saving throw, an
ability check, or a skill check uses that character's calculated bonus from the rules engine,
displays the roll breakdown (die result plus each contributing modifier), and posts the result
to a shared roll log visible to the whole table, synced live. Also support a general free-form
roll (an arbitrary dice expression) that is not tied to any specific character or action.
Support rolling with advantage or disadvantage (rolling two d20s and taking the higher or
lower result respectively) as a first-class, manually-triggerable option on any d20 roll — this
is a foundational mechanic that later prompts (49's death saves, 50's concentration checks,
59's vision-driven advantage/disadvantage) will all rely on rather than reimplementing.

For an attack roll specifically, resolve the full exchange rather than stopping at the die
result: compare the roll (plus bonus) against the target's AC to determine a hit, with a
natural 20 always hitting regardless of AC and counting as a critical hit (roll double the
attack's damage dice), and a natural 1 always missing regardless of bonus. On a hit, roll
damage (doubled dice on a crit) and apply it to the target's HP through the damage control
built in Prompt 46 rather than leaving damage application as a separate manual step. Also add
a "roll initiative" button to Prompt 45's combat-start flow, using this roller instead
of the manual-entry-only version built there, since Prompt 45 predates this dice roller and
deliberately left rolling for this prompt to wire up.

## Acceptance Criteria
- An attack roll that meets or beats the target's AC is resolved as a hit, rolls damage, and
  applies it to the target's HP via Prompt 46's damage control automatically; a miss applies
  no damage; a natural 20 always hits as a critical (doubled damage dice) and a natural 1
  always misses, regardless of AC or bonus.
- Rolling an attack (or save/check) from a character produces a result using the correct
  bonus from the rules engine and appears in the shared log for every connected player within
  a couple of seconds.
- A free-form roll works correctly independent of any character and also appears in the log.
- Rolling with advantage or disadvantage correctly rolls two d20s and takes the higher/lower,
  and the log clearly shows both results and which was used.

## Dependencies
Prompts 3, 11, 16, 46.
```

---

### Prompt 49: Death saving throws

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: Combat mode

## Context
HP/damage tracking (Prompt 46) clamps HP at a minimum of 0 but doesn't implement what actually
happens at 0 HP. The dice roller (Prompt 48) can roll a d20.

## Task
Read the HP/damage tracking and dice roller. Implement the SRD death saving throw mechanic:
when a player character's HP is reduced to 0, prompt for a death save at the start of each of
their subsequent turns (a plain d20 roll via the dice roller, no modifiers) — 10 or higher is
a success, below 10 is a failure, a natural 1 counts as two failures, and a natural 20
immediately regains 1 HP and ends the sequence. Three successes stabilizes the character at 0
HP (unconscious, no further saves needed until they take damage again); three failures means
the character dies. Also implement the instant-death rule: damage taken while already at 0 HP
that equals or exceeds the character's max HP kills them outright, skipping death saves
entirely. Any other damage taken while at 0 HP (that doesn't trigger instant death) counts as
one death save failure — two if that damage was a critical hit — in addition to whatever
damage-application normally does, per SRD. Reflect the current save count and outcome clearly
on the character sheet and token, synced live to the table.

## Acceptance Criteria
- Reducing a character to exactly 0 HP starts the death save sequence on their next turn.
- Three successes stabilizes them; three failures (or two failures from one natural 1) kills
  them; a natural 20 restores 1 HP and ends the sequence immediately.
- Massive damage taken at 0 HP triggers instant death, bypassing death saves.
- Taking non-lethal damage while already at 0 HP counts as a death save failure (two on a
  critical hit), separate from the normal per-turn death save.
- All of this is visible on the character sheet/token and synced to every connected player.

## Dependencies
Prompts 46, 48.
```

---

### Prompt 50: Concentration tracking

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: Character info / Combat mode

## Context
The rules engine (Prompt 9) knows which spells exist, HP/damage tracking (Prompt 46) applies
damage, and the dice roller (Prompt 48) can roll a Constitution save. Nothing currently tracks
whether a character is concentrating on a spell, or ends it correctly.

## Task
Read the rules engine, HP/damage tracking, and dice roller. Add a "currently concentrating on"
field to a character's active state, settable when casting a spell that requires
concentration (per the rules engine's spell metadata — extend that metadata now if it doesn't
already flag which spells require concentration) and clearable manually or automatically.
Casting a new concentration spell while already concentrating on one ends the previous one.
Whenever a concentrating character takes damage, prompt them for a Constitution saving throw
via the dice roller with a DC of 10 or half the damage taken, whichever is higher, per SRD;
failing ends concentration. Certain conditions (e.g. incapacitation) should also end
concentration immediately — read what the conditions system (Prompt 47) exposes and hook into
it rather than re-checking condition state independently. Show the active concentration
clearly on the character sheet and to the table.

## Acceptance Criteria
- Starting a concentration spell while already concentrating on one correctly ends the first.
- Taking damage while concentrating correctly prompts a CON save at the right DC, and failing
  it clears concentration; succeeding keeps it active.
- A condition that should end concentration does so immediately without requiring a save.
- Current concentration is visible on the character sheet and synced live.

## Dependencies
Prompts 9, 46, 47, 48.
```

---

### Prompt 51: Contextual quick actions panel

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: Combat mode

## Context
Initiative and turn order exist (Prompt 45), tokens can move around the elevation/terrain-aware
grid (Prompt 31), character sheets expose actions/spells with range metadata from the rules
engine (Prompts 9, 11), resources can be spent and rest (Prompt 12), and the dice roller can
execute a roll and log it (Prompt 48). Right now, taking an action in combat means manually
opening the full character sheet every time, with no help figuring out what's actually usable
from the current position.

## Task
Read the initiative/turn state, token positions and movement, the rules engine's range/type
metadata, character resources, and the dice roller. On a player's own turn, compute and
display a quick-actions panel listing the attacks and spells that are currently usable: in
range of at least one enemy combatant given the token's current position (accounting for
remaining movement if repositioning this turn would bring something into range), and with
enough resource/spell-slot availability remaining. Each listed action should be a one-click
button that performs the roll through the dice roller and applies its effect. This panel is a
shortcut only — the player's full character sheet and the ability to freely choose any other
action must remain available and usable at all times; never force a player into a suggested
action.

## Acceptance Criteria
- Standing within melee range of an enemy token surfaces relevant melee attacks in the panel.
- Being in range of a known spell surfaces it if a slot/resource is available, and hides or
  clearly disables it if not.
- Using a quick action performs the correct roll via the dice roller and logs it exactly as a
  manually-triggered roll would.
- A player can still freely open their full sheet and take any other action instead of using
  a suggestion.

## Dependencies
Prompts 9, 11, 12, 31, 45, 48.

## Notes
Prompt 53 (action economy) will extend this panel to also gate on whether the player has an
Action/Bonus Action remaining this turn — read this prompt's implementation first when
building that rather than creating a second, competing action-selection UI.
```

---

### Prompt 52: DM rule-override control

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: Combat mode / DM role

## Context
Character resources track limited-use abilities and reset on rest (Prompts 8, 12). Combat and
the dice roller exist (Prompts 45, 48). Currently, an action blocked by a normal restriction
(e.g. a limited-use ability with no uses remaining) simply cannot be taken — there is no way
for the DM to allow an exception.

## Task
Read the resource-tracking model, combat state, and the dice roller. Implement a DM-only
override control that appears when a player's attempted action is blocked by a resource or
rule restriction (no uses remaining on a limited resource, no spell slot available, etc.). The
player should be able to flag the blocked attempt to the DM. The DM can then approve it, which
bypasses that specific restriction for this one use only (it does not permanently change the
character's resource limits) and lets the action proceed through the normal roll/effect flow
exactly as if it had been available. Record a clear entry in the shared table log noting that
the DM overrode a restriction and what was allowed, so everyone at the table can see it
happened.

## Acceptance Criteria
- A blocked action is shown to the player as disabled with a clear reason, with a way to flag
  it to the DM.
- The DM sees a matching override control for the flagged attempt; approving it lets the
  action complete normally through the usual roll/effect flow.
- The shared log clearly and immediately records that an override occurred and what it
  allowed.
- The override itself does not change the character's stored resource counts — whether a use
  is still consumed is a separate decision the DM can make explicitly.

## Dependencies
Prompts 12, 45, 48.

## Notes
Keep this scoped specifically to bypassing resource/rule restrictions on an attempted action
(matching the "extra use of a limited ability" case) — this is not a general free-form
rules-breaking sandbox covering things like AC, movement, or targeting. Prompt 53 adds a
related but distinct DM control (how strictly the action economy itself is enforced) right
next to this one — read this prompt's DM-control UI area first so the two live together
coherently rather than as two unrelated panels.
```

---

### Prompt 53: Action economy tracking and DM strictness toggle

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: Combat mode / DM role

## Context
Initiative (Prompt 45), the quick actions panel (Prompt 51), and the DM rule-override control
(Prompt 52) exist. Nothing currently tracks whether a combatant has used their Action, Bonus
Action, or Reaction on their turn, so nothing stops a player from taking unlimited actions in
one turn.

## Task
Read initiative/combat state, the quick actions panel, and the DM rule-override control. Build
action economy tracking: for the current combatant's turn, track whether their Action, Bonus
Action ("special action"), Reaction, and Movement have been used, resetting at the start of
their turn. Gate manual actions and the quick-actions panel (Prompt 51) on remaining economy,
and show the player a clear, live readout of what they have left this turn.

Alongside this, add a DM-configurable enforcement setting, placed next to the Prompt 52
rule-override control, with two modes: Strict (the above restrictions are enforced and block
further actions in the UI, matching normal 5e rules) and Freeform (the DM has decided players
can move, take an action, and take a bonus/special action all freely within a turn — usage is
still tracked and displayed for reference, but nothing is ever blocked). The DM can switch
between these modes at any time, including mid-combat, and the current mode is visible to all
connected players.

## Acceptance Criteria
- In Strict mode, attempting to take a second action-type action without something granting
  it extra is blocked with a clear reason, and the remaining-economy display is accurate
  through a full turn cycle.
- In Freeform mode, a player can freely move, use an action, and use a bonus/special action in
  the same turn without being blocked, while usage is still visibly tracked.
- The DM can switch modes at any time, including mid-combat, and every connected player sees
  the current mode.

## Dependencies
Prompts 45, 51, 52.

## Notes
"Special action" here means 5e's bonus action. This control complements Prompt 52's per-action
override rather than replacing it — the override stays for one-off resource exceptions, while
this is the broader, campaign-level dial for how strictly the whole action-economy structure
is enforced.
```

---

### Prompt 54: Opportunity attacks

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: Combat mode

## Context
Action economy and reaction tracking exist (Prompt 53); token movement with cost calculation
exists (Prompt 31). Nothing currently prompts an opportunity attack when a token moves out of
a hostile creature's reach.

## Task
Read action economy tracking and token movement. During combat, when a token moves out of an
adjacent cell (or, using the rules engine's per-creature reach/range metadata from Prompt 9,
out of a longer reach where applicable) of a hostile combatant, without the mover having used
the Disengage action this turn, prompt that hostile combatant's controller — the DM for an
NPC, the player for a PC — with an option to make an opportunity attack. Taking it consumes
their Reaction via the Prompt 53 action-economy tracking and runs through the normal dice
roller attack flow; declining leaves their Reaction available.

## Acceptance Criteria
- Moving a token out of an enemy's reach during combat (without disengaging) correctly prompts
  the right controller with an opportunity-attack option.
- Accepting consumes the Reaction and resolves a normal attack roll via the dice roller;
  declining leaves the Reaction untouched.
- A creature that has already used its Reaction this turn is not prompted again.

## Dependencies
Prompts 31, 53.
```

---

### Prompt 55: Vision — character vision capability and map lighting data model

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: Vision / Map builder

## Context
The character data model (Prompt 8) and map/asset data model (Prompt 23) exist. Nothing
tracks how well a character can see, nor how lit any part of a map is. The project owner wants
per-player vision (darkness, darkvision, blindness, and other conditions) to affect what each
player individually sees on the table, built for light-level obscurement now, with the schema
laid so a future full line-of-sight (wall-blocking) upgrade is additive rather than a rework,
and so players retain what they've previously seen even once it's no longer currently visible.

## Task
Read the character data model and map data model. Extend the character data model with a
vision-capability field (normal vision, or darkvision with a range, sourced from race/class).
Extend the map data model with ambient light per cell (bright / dim / dark, authored the same
way terrain type is) and a light_sources concept — a radius and brightness (bright/dim) that
can be attached either to a fixed map position or to a specific placed object/token so it
moves with whatever is carrying it (e.g. a torch a character is holding).

Also add two things now that this prompt's behavior won't yet use, so a later upgrade doesn't
require a schema rework: a boolean flag on map objects marking whether they block line of
sight (inert until a future full-line-of-sight prompt reads it), and a per-player "seen cells"
record per map (player, map, cell, and enough captured state to reconstruct what that cell
looked like when last perceived) so players can retain knowledge of areas they've previously
seen even once they're no longer currently perceiving them.

## Acceptance Criteria
- A character's vision capability (including darkvision range where applicable) is stored and
  queryable.
- A map's ambient light can be authored per cell, and a light source with a radius/brightness
  can be attached to a fixed point or to a movable object/token.
- The LOS-blocking flag and per-player seen-cells table exist and are migrated correctly, even
  though nothing reads/writes the LOS flag yet.

## Dependencies
Prompts 8, 23.

## Notes
The LOS-blocking flag is intentionally unused until a future full line-of-sight upgrade — the
project owner has explicitly flagged this as the planned next step after light-level-only
vision ships, and wants the schema in place now so that upgrade is additive. Don't build
wall-blocking behavior in this prompt, just the schema hook for it.
```

---

### Prompt 56: Vision — perception rules engine

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: Vision / rules

## Context
Character vision capability and map lighting data exist (Prompt 55). The rules engine (Prompt
9) computes character stats but nothing yet computes what a character can actually perceive.
Conditions tracking (Prompt 47) can apply status effects like blinded.

## Task
Read the vision/lighting data model, the rules engine, and the conditions system. Build a pure
function, living in the rules-engine module, that given an observing character's position,
their vision capability, the ambient light and active light sources on the current map, and
their active conditions, computes a visibility tier for every other cell and token on the map:
fully visible, dimly perceived, or not perceived. Light-based rules: a cell in bright light is
fully visible to anyone who can see it at all; a cell in dim light is fully visible to
darkvision within its range and dimly perceived otherwise; a cell in darkness is fully visible
to darkvision (per SRD, darkvision treats darkness as dim light) and not perceived without it.

Layer condition-based overrides on top generically: design this as a per-condition "vision
effect" property (e.g. blinded means "nothing is perceived, regardless of light") rather than
hardcoding a single condition by name, so any future condition — or a future update to an
existing one — can carry the same behavior without changing this function. Do not implement
wall/line-of-sight blocking in this prompt (that's the future upgrade noted in Prompt 55) —
light, range, and condition overrides only for now.

## Acceptance Criteria
- Unit tests cover: bright/dim/dark light combined with normal vision and with darkvision at
  various ranges, a blinded character perceiving nothing regardless of light, and a generic
  condition-driven override working without being hardcoded to one specific condition name.
- The function is pure and lives entirely in the rules-engine module, independent of any
  rendering code.

## Dependencies
Prompts 9, 47, 55.
```

---

### Prompt 57: Vision — map editor lighting authoring

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: Vision / Map builder

## Context
The map editor (Prompts 26, 27) and lighting data model (Prompt 55) exist. The DM has no way
yet to actually author ambient light or light sources on a map.

## Task
Read the map editor and lighting data model. Extend the map editor with a lighting authoring
mode: paint ambient light (bright/dim/dark) onto cells the same way terrain is painted, and
mark a placed object as a light source with a configurable radius and brightness (e.g. a torch
or lantern). Also let the DM flag a placed object (e.g. a wall segment or door) as blocking
line of sight, writing to the LOS flag added in Prompt 55 — this has no visible effect yet but
captures the DM's intent ahead of the future line-of-sight upgrade.

## Acceptance Criteria
- A DM can paint varied ambient light across a map and save/reload it correctly.
- A DM can mark a placed object as a light source with a radius/brightness, and mark another
  as LOS-blocking; both persist correctly.

## Dependencies
Prompts 26, 27, 55.
```

---

### Prompt 58: Vision — per-player rendering and seen-cell memory

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: Vision / 3D table

## Context
The perception rules engine (Prompt 56) and lighting authoring (Prompt 57) exist. The live map
(Prompt 29), tokens (Prompt 30), and token movement (Prompt 31) render on the table for every
connected player identically today, with no per-player differences.

## Task
Read the perception rules engine, the live map/token rendering, and token movement. A player
may own several characters (Prompt 15's library) but only one is present at the table in a
given session — use whichever character's token that player placed in the current Game Room
(Prompt 30) as their active character for vision purposes — if they've placed tokens for more
than one of their characters, use whichever was placed most recently; a player with no placed
token in this session sees the same unfiltered view as the DM until they place one. For each connected
player (not the DM — the DM's own view always sees everything, unfiltered, as an intentional
bypass), compute their character's current visibility tier per cell/token using
the Prompt 56 engine, recomputed live as light sources move (including ones carried by a
moving token), tokens move, or conditions change. Render three states in that player's own
client: currently fully visible (normal rendering), dimly perceived (visibly desaturated or
darkened but still shown), and not currently perceived. For cells the player has perceived at
some point before but can't currently perceive (e.g. now out of range or no longer lit),
render them using their last-known state from the Prompt 55 seen-cells record — dimmed to mark
it as remembered rather than live — instead of hiding them outright, so players retain
knowledge of what they've previously seen. Update the seen-cells record as new cells are
perceived.

## Acceptance Criteria
- Each connected player's own view is masked to their character's current perception; the
  DM's view is never masked.
- Moving into or out of a lit area, gaining/losing a nearby light source, or becoming blinded
  all update a player's own view live and correctly.
- A cell the player saw earlier but can no longer currently perceive renders using its
  remembered last-seen state (visibly distinguished from currently-visible) rather than
  reverting to fully hidden.
- This is enforced client-side (not server-filtered) per the project owner's preference — this
  is a deliberate trade-off for a trusted friend group, not an oversight, so document it as
  such rather than implying it's tamper-proof.

## Dependencies
Prompts 29, 30, 31, 56, 57.
```

---

### Prompt 59: Vision-driven advantage and disadvantage

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: Vision / Combat mode

## Context
The dice roller (Prompt 48) already supports rolling with advantage or disadvantage manually.
The per-player vision rendering (Prompt 58) now knows, for any observer, whether a given token
is currently perceived by them.

## Task
Read the dice roller and the vision rendering/perception engine. Extend the dice roller so
that an attack roll automatically applies disadvantage when the attacker cannot currently
perceive their target (per the Prompt 56 visibility computation), and automatically applies
advantage when the target is blinded or otherwise noted by the rules engine as an easy target
regardless of visibility. An NPC/monster attacker (Prompt 61) is evaluated through the same
Prompt 56 perception function using a default of normal vision with no darkvision, since the
lightweight monster stat block doesn't carry its own vision-capability field — the DM can still
manually toggle advantage/disadvantage for a monster if its actual vision differs. When both
advantage and disadvantage would apply from different sources, they cancel out to a flat roll
per SRD rules. Show the player why advantage or disadvantage was applied (which condition or
visibility state triggered it) rather than just applying it silently.

## Acceptance Criteria
- Attacking a target the attacker cannot currently perceive applies disadvantage
  automatically.
- Attacking a blinded target applies advantage automatically.
- A case where both would apply correctly cancels out to a flat roll.
- The roll result/breakdown clearly states why advantage or disadvantage was applied.

## Dependencies
Prompts 48, 58.
```

---

### Prompt 60: Vision — Hide/Stealth for players and NPCs

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: Vision / Combat mode

## Context
The perception rules engine (Prompt 56) and per-player vision rendering (Prompt 58) exist,
and the rules engine already computes passive scores including passive Perception (Prompt 9).
Currently any token in a lit, in-range cell is visible to everyone who can perceive that cell
at all — there's no way for a creature to actively hide, whether that creature is a monster or
a player's own rogue/thief-type character.

## Task
Read the perception rules engine, passive-score calculation, and per-player vision rendering.
Implement a Hide action usable by any token's controller — a player controlling their own
character, or the DM controlling an NPC — that rolls a Stealth check via the dice roller and
compares it against the passive Perception of each other combatant who could otherwise
currently perceive that token; a bare placeholder token without a full stat block (Prompt 61)
uses a default passive Perception of 10. For observers whose passive Perception the roll doesn't beat,
that token becomes hidden specifically from them (not from observers who beat it, and not from
the DM's always-unfiltered view) until something reveals it — implement a clearly-stated
reveal trigger (e.g. the hidden creature attacking, or another explicit action) rather than
leaving hidden state permanent or ambiguous. Feed hidden-from-observer state into the Prompt
58 rendering (a hidden token simply doesn't render for an observer it's hidden from) and into
Prompt 59's advantage/disadvantage handling (attacking from an unseen hidden position grants
the hider's attack advantage, per SRD).

## Acceptance Criteria
- Any token's controller (player or DM) can attempt to Hide, rolling Stealth via the dice
  roller.
- The token becomes invisible in the table rendering specifically to observers whose passive
  Perception it beat, while still visible to observers who beat the roll and to the DM.
- A clearly defined action (e.g. the hidden creature attacking) reveals it again to everyone.
- This works identically whether the hiding token is a player character or an NPC.

## Dependencies
Prompts 9, 58.
```

---

### Prompt 61: DM NPC/monster tools

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: DM role / Combat mode

## Context
The DM role helper exists (Prompt 7), tokens and the grid exist (Prompt 30), and initiative
exists (Prompt 45). Right now the only tokens available are full player characters or bare
placeholder NPC tokens with just a name — there is no lightweight way to stat up and drop in a
monster during play.

## Task
Read the DM role helper, token system, initiative/combat state, and the dice roller's attack
resolution flow. Build an NPC/monster creation tool restricted to the current DM: a lightweight
stat block (name, HP, AC, passive Perception, and a small set of attacks with their bonuses and
damage) rather than a full character sheet, usable either ahead of time or live mid-session.
Monster attacks roll through the same Prompt 48 attack-resolution flow as character attacks,
using the stat block's stored attack bonus and damage in place of rules-engine-derived values.
Add a quick-add action that, in one step, prompts the DM to roll or manually enter the
monster's initiative, creates a token for the monster on the current map, and adds it to the
active initiative order at that value.

## Acceptance Criteria
- The DM can create a simple monster stat block quickly, without going through full character
  creation.
- Quick-adding a monster mid-combat prompts for its initiative (rolled or entered), then
  produces a correctly placed token on the current map and a correctly inserted initiative
  entry at that value, in one action.
- A monster's attack rolls resolve through the same hit/damage flow as a character's attack,
  using its stat block's bonus and damage.
- Non-DM campaign members cannot access this tool.

## Dependencies
Prompts 7, 30, 45, 48.

## Notes
If Prompt 60 (Hide/Stealth) exists by the time this is built, an NPC created here should be
able to use it like any other token — check before adding a parallel, monster-specific hiding
mechanism. If the NPC roster (Prompt 33) exists, consider letting a DM promote a narrative NPC
into a combat stat block here rather than re-entering its name from scratch.
```

---

### Prompt 62: Self-hosted deployment packaging

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: Deployment

## Context
The full application is now feature-complete across Prompts 1-61, and has been running via
the local development Docker Compose setup from Prompt 1. It has not yet been packaged for
production deployment on the user's own infrastructure, behind their existing Nginx Proxy
Manager reverse proxy.

## Task
Read the full application and the local Docker Compose setup. Produce a production-ready
Dockerfile for the Next.js app. Extend the Compose setup (or add an accompanying production
Compose file) to bundle the app together with the self-hosted Supabase stack for production
use. Document every required environment variable and secret needed for a production run,
including the LLM API credential from Prompts 37-38 if that feature is included, noting it is
the one external (non-self-hosted) dependency in an otherwise fully self-hosted stack. Provide
configuration notes for placing this behind an existing Nginx Proxy Manager instance, including
correct internal port exposure and WebSocket support so Supabase Realtime continues to work
when accessed through a proxied domain rather than localhost. Run the full Prompt 2
performance-testing suite (bundle size, 3D render benchmark, Lighthouse, realtime load) against
the production build and record final numbers alongside their original baselines.

## Acceptance Criteria
- Running the production Compose setup on a clean checkout, with the documented environment
  variables supplied, builds and serves the full app end to end.
- Realtime features (presence, reconnection, the lobby, map sync, token movement, combat,
  dice, POIs, vision, handout reveals) all continue to work correctly when the app is accessed
  through a reverse-proxied domain, not just localhost.
- The full Prompt 2 performance suite runs against the production build, and results are
  compared against their original baselines with any significant regression called out.

## Dependencies
All prior prompts — this packages the finished application.
```
