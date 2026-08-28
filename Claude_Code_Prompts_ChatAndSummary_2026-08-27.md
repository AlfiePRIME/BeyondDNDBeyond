# Chat, Floating Text & Session Summary — Prompt Plan (2026-08-27)

Six prompts. B1 and B2 are independent of each other and can run in parallel.
B3 and B4 both depend on B1+B2. B5 depends on the Map Editor batch's A6 (shared
interaction-event table) and A4 (item-pickup events, which now write to that
table directly — see the Map Editor batch file). B6 depends on B1 and B5.

**Scope decision on where chat lives:** chat is Game Room-only for this plan.
B1's data model and RLS are written campaign-wide (matching roll_log's
precedent) because that costs nothing extra, but the actual UI surfaces —
sending a message, the floating bubble, and the log panel — only exist inside
the Game Room in B3/B4. There is no chat-sending UI anywhere else in the app in
this plan. If a later request wants chat reachable from outside the 3D room,
that's new scope on top of this, not something these six prompts already cover.

---

## B1 — Chat data model + RLS

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: Chat & Summary B1

## Context
No chat system exists anywhere in this codebase today. Read
supabase/migrations/0030_dice_rolls.sql (roll_log's RLS shape: whole-campaign
SELECT, sender-only INSERT, no UPDATE/DELETE at all) and
src/data-access/rolls.ts's wrapper as the closest structural precedent — chat
is visible campaign-wide like roll_log, but unlike roll_log it needs a short
post-send edit window (no deletion, ever, per the project owner).

## Task
Add a migration for a chat_messages table: campaign_id, sender_user_id, body
text (store the raw string including any formatting codes as-is — a separate
feature parses this at render time, not storage time), created_at, edited_at
nullable. RLS: any campaign member can SELECT all of a campaign's messages;
INSERT restricted to sender_user_id = auth.uid(); UPDATE restricted to the
sender AND only while now() is within a short window of created_at (pick 2
minutes) — enforce this window server-side in the RLS policy itself, not just
client-side, so a direct API call after the window closes is genuinely
rejected; no DELETE policy at all, ever. Add src/data-access/chat.ts with
listChatMessages, sendChatMessage, editChatMessage, and
subscribeToChatMessages using the same postgres_changes mechanism roll_log
uses (not the Game Room's own broadcast channel — chat should work anywhere a
member might read it, not only while a specific room's channel is joined).

## Acceptance Criteria
- Any campaign member can read every message in that campaign.
- A member can only send as themselves (RLS-verified, not just UI-assumed).
- Editing succeeds only for the sender and only within the time window —
  verify a direct API call attempting to edit after the window closes is
  rejected by RLS, not merely hidden by the UI.
- No update or delete path exists once the window closes; there is no delete
  path at all under any circumstance.
- A live subscription delivers new and edited messages to other connected
  clients.
- yarn lint / yarn tsc --noEmit / yarn test pass; a real Playwright/API-level
  check covers: send, live-receive on a second client, edit within window
  (succeeds), edit attempt after window (rejected), and a cross-member send
  attempt (rejected).

## Dependencies
None.

## Notes
Store the raw text with formatting codes intact (e.g. a literal "&cHello
&lworld" string) — a separate rendering feature parses this from the same raw
column, so don't add a second "rendered" column.
```

---

## B2 — Minecraft-style chat formatting parser

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: Chat & Summary B2

## Context
Read src/scene-3d/DmBookProp.tsx's existing use of drei's <Html> (position/
anchoring, transform={false}, zIndexRange, pointerEvents) in full as the
concrete precedent for rendering arbitrary real DOM content anchored to a 3D
position — this is the right approach for chat text (unlike the fixed-size,
cached-by-string canvas-texture badges dice results use, which don't suit
arbitrary player-authored text).

## Task
Write a small, pure, unit-tested parser module (e.g. chatFormatting.ts) that
takes a raw message string containing "&"-prefixed format codes — a practical
subset of Minecraft's own scheme: color codes covering this app's existing
accent palette plus a handful of standard colors, &l bold, &o italic, &n
underline, &m strikethrough, &k obfuscated, &r reset — and produces a sequence
of styled spans (color/weight/style/decoration per span, plus a marker for
which spans are obfuscated). Unknown or malformed codes should degrade
gracefully to literal text, never crash or silently eat characters. For
obfuscated spans, implement a real continuously-scrambling effect: each
character cycles through random glyphs on a fixed interval (~50ms), driven by
one shared interval timer for all currently-visible obfuscated spans on the
page (not one timer per span), so it can't become a performance problem with
several obfuscated messages visible at once. Build a small ChatText React
component that renders this parser's output as real styled DOM spans, for
reuse by other chat-rendering features.

## Acceptance Criteria
- A representative set of format codes renders correctly: color changes,
  bold/italic/underline/strikethrough, and continuously-animating obfuscated
  text (not a static garble).
- Malformed/unknown codes render as literal text without crashing or dropping
  other characters.
- A real unit test suite exercises the parser's span-splitting logic directly
  (not just visually).
- A Playwright check confirms obfuscated text is actually animating (two
  screenshots a short interval apart differ) and that CPU/frame cost stays
  reasonable with several obfuscated messages visible simultaneously.
- yarn lint / yarn tsc --noEmit / yarn test pass.

## Dependencies
None — pure logic plus a small reusable component.

## Notes
Codes are hand-typed by players, Minecraft-style — do not build a formatting
toolbar UI in this prompt. Keep the parser itself free of any React Three
Fiber dependency so it stays trivially unit-testable; only the small wrapper
component touches rendering.
```

---

## B3 — Floating chat bubble above a character's chair

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: Chat & Summary B3

## Context
Depends on B1 (data/live delivery) and B2 (formatting/rendering) — read both
resulting modules in full first. Read src/scene-3d/seating.ts's
getEffectiveSeat (resolves a member's current seat position including any
persisted chair-drag offset) and src/scene-3d/GameTableScene.tsx's seat
rendering loop, plus DmBookProp.tsx's <Html> anchoring pattern, in full.

## Task
Build a ChatBubble component (<Html transform={false}>, matching the book
prop's anchoring approach) shown above a seat whenever that seat's occupant has
a current message, positioned via getEffectiveSeat so it tracks a mid-drag
chair correctly. Wire it to B1's live subscription: sending a message shows it
above the sender's own seat, on every connected client including the sender's
own, rendered via B2's ChatText. Duration scales with message length with a
5-second minimum, then fades out. Give the DM's own bubble a visually distinct
treatment (e.g. a different border/background using this app's existing DM
purple accent color) so it reads as DM speech rather than a player's. If a
sender sends a new message while their previous bubble is still showing, queue
the new one to display immediately after the current one finishes, rather than
overlapping or replacing it mid-display. Add a minimal chat-input control
somewhere sensible in the Game Room for this to be end-to-end testable (a plain
text box plus send button is enough — a later prompt may relocate this into a
fuller log panel).

## Acceptance Criteria
- Sending a message shows a correctly-formatted bubble above the sender's own
  seat, on every connected client.
- The DM's bubble is visually distinct from a player's.
- A short message stays up at least 5 seconds; a longer message stays up
  longer.
- Two rapid messages from the same sender display sequentially, never
  overlapping.
- A message sent while the sender's seat is mid-drag still anchors to the
  seat's live position.
- yarn lint / yarn tsc --noEmit / yarn test pass; a real Playwright check with
  two connected clients covers all of the above.

## Dependencies
B1, B2.

## Notes
This prompt's chat input is intentionally minimal — B4 builds the real
persistent log panel and may absorb or replace this input.
```

---

## B4 — Persistent chat log panel

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: Chat & Summary B4

## Context
Depends on B1 (history) and B2 (rendering). Read DiceLogPanel.tsx in full as
the direct structural precedent for a scrollable, live-subscribed log panel
within this app's existing panel-docking system (DraggablePanel/
PanelLayoutProvider).

## Task
Build a ChatLogPanel following DiceLogPanel's structure: a scrollable list of
past messages (sender identity, timestamp, B2-rendered body), backed by B1's
listChatMessages/subscribeToChatMessages, auto-scrolling to the newest message
on arrival. Include the real chat-input control here (text box plus send
button), superseding B3's minimal placeholder input if that prompt put one in
a temporary spot. Support editing your own message within B1's edit window: an
edit affordance appears only on your own still-editable messages and
disappears once the window closes; a successfully edited message shows a
visible "(edited)" marker.

## Acceptance Criteria
- The panel shows full chat history on open and scrolls to new messages live.
- Formatting codes render correctly via B2 inside the panel.
- A sender can edit their own message within the time window, with a visible
  edited marker after; editing is unavailable once the window closes.
- A message from another member cannot be edited (no edit control shown, and a
  direct attempt is rejected server-side per B1's RLS).
- The panel and B3's floating bubbles coexist correctly — sending from the
  panel produces both a bubble and a log entry, from the same underlying send
  action.
- yarn lint / yarn tsc --noEmit / yarn test pass; a real Playwright check
  covers send-and-see-in-log, edit-within-window, and edit-attempt-after-
  window (rejected).

## Dependencies
B1, B2.

## Notes
Match this app's existing DraggablePanel/PanelLayoutProvider docking
conventions rather than building new panel chrome.
```

---

## B5 — Session-activity log (live DM feed)

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: Chat & Summary B5

## Context
Depends on the Map Editor batch's A6 prompt (creates the shared
interaction-event table and wires step-on/click object triggers into it) AND
its A4 prompt (item pickups write to that same table directly — this is no
longer optional/best-effort, A4 was written to build this wiring itself). Read
that table and all three writer paths (step-on, click-trigger, item-pickup) in
full first. Also read src/data-access/rolls.ts's resolveAttackDamage/
RollBreakdown shape (existing damage-event data) and src/scene-3d/DmBook.tsx's
page structure in full.

## Task
Add a live "Activity" view to the DM's book (a new page, or a section of an
existing one — pick whichever reads more naturally once you see the book's
current layout) showing: a running list of interaction-event rows (who
triggered which tagged object, item pickups included, and when), and a view of
recent damage events pulled from roll_log. This is DM-only — never shown to
players.

## Acceptance Criteria
- The DM sees a live, real-time feed of who triggered which tagged object
  (including item pickups) and when, visible only to the DM.
- The feed also surfaces recent damage-dealt events.
- The feed updates live as events occur from any connected client's actions,
  not just the DM's own.
- A real Playwright check has one player trigger a tagged object, and a
  separate player take an item from a container, and confirms the DM's feed
  shows both promptly.
- yarn lint / yarn tsc --noEmit / yarn test pass.

## Dependencies
A6 and A4 (both Map Editor batch), in that order.

## Notes
Keep this a plain list — no synthesis or summarization here. A later prompt
builds the end-of-session AI summary on top of this same data.
```

---

## B6 — Auto-triggered AI end-of-session summary

```
Project: BeyondDNDBeyond
Local Path: /home/alfie/git/BeyondDNDBeyond
Requirement: Chat & Summary B6

## Context
Depends on B1 (chat) and B5 (activity feed/log) — read both in full first.
Read src/ai/generateDraft.ts and src/ai/index.ts's export boundary (only
src/ai may import the Anthropic SDK, enforced by eslint-plugin-boundaries) in
full — this existing infrastructure is DM-gated and Haiku-tier, but sized for a
short (under 500 characters) DM-authored prompt, not a full session transcript;
treat it as a pattern to extend, not a drop-in call. Read
src/data-access/narrative.ts's session_log / createSessionLogEntry /
updateSessionLogEntry and src/data-access/campaigns.ts's startSession /
endSession in full. Per the project owner: the summary auto-triggers on ending
a session, the DM previews and can edit it before anything is saved (never
silently auto-published), it should include both a narrative recap AND a
structured breakdown (who damaged what, who triggered/touched what), and the
DM must have a way to pause a session (e.g. a break) without that pause
triggering its own summary — only a genuine end should generate one.

## Task
Add a distinct pause action, separate from endSession: introduce a
pauseSession (and resumeSession) pair in campaigns.ts that stops whatever
"live" signal endSession currently stops, WITHOUT closing out the session
record or triggering summary generation. A session's summary-eligible window
is bounded by its original startSession call through its eventual real
endSession call, regardless of how many pause/resume cycles happen in between
— pausing never resets or splits that window. Extend src/ai with a
session-summary generator: given a campaign and that full start-to-end window
(spanning any pauses), gather all of that window's chat messages (B1) and
interaction/damage events (B5), build a prompt from both, and call the
Anthropic API for a two-part result — a narrative recap paragraph and a
structured list of mechanical highlights. Check whether the existing model
choice and max-tokens setting need adjusting for this larger input than
generateDraft's short-brief use case, and decide (documenting your reasoning)
whether one call producing both parts is reliable enough or whether two
separate calls produce better results. Wire generation to auto-trigger only on
a genuine endSession call (never on pauseSession): show the DM a preview/edit
screen (the narrative text is editable; the structured breakdown can be
read-only) before anything is saved. On confirm, save the DM's (possibly
edited) narrative into a new session_log entry's recap field via the existing
createSessionLogEntry, and store the structured breakdown in a new, separate
table keyed by that session_log entry's id (not a jsonb column on session_log
itself) — this is the more extensible choice, since it lets the structured
events be queried/indexed independently of the narrative text later.

## Acceptance Criteria
- Pausing a session (pauseSession) stops the live signal but does not generate
  a summary and does not close the session's window.
- Resuming (resumeSession) after a pause continues the same session; a later
  endSession's summary covers the ENTIRE span from the original start through
  the final end, including activity from before and after the pause.
- Ending a session (without ever pausing) still generates a summary exactly as
  before, covering that session's actual chat and activity — not placeholder
  text.
- The DM sees and can edit the narrative before it's saved; nothing reaches
  players until the DM confirms.
- Confirming saves the (possibly edited) narrative into session_log, readable
  by all members afterward per that table's existing read policy, and saves
  the structured breakdown into its own new table keyed to that entry.
- A session with no chat and no activity still completes gracefully (a minimal
  or explicitly-empty summary, not an error).
- The AI call is DM-gated and behind the existing isAiConfigured() guard,
  matching every other AI-generation path in this app.
- yarn lint / yarn tsc --noEmit / yarn test pass; a real Playwright check ends
  a session with some chat and some triggered activity present, confirms a
  real preview appears reflecting that content, edits it, confirms, and
  verifies the saved session_log entry and its structured-breakdown row. A
  separate check pauses a session, confirms no summary is generated, resumes,
  adds more chat/activity, then ends it, and confirms the final summary
  reflects activity from both before and after the pause.

## Dependencies
B1, B5.

## Notes
This is the most architecturally novel prompt in either track — budget real
iteration time on getting the AI to reliably separate narrative from
structured output (or on splitting it into two calls) rather than assuming the
first attempt reads well. Don't let a single all-in-one-call design become the
hill to die on if it isn't producing clean output.
```
