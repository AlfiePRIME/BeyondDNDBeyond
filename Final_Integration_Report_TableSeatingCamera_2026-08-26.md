# Final Integration Report — Table, Seating, Camera, Trays & Model Rigging Plan

Closes out `Claude_Code_Prompts_TableSeatingCamera_2026-08-25.md`. All 13 prompts plus one owner-requested follow-up are merged into `master`, verified independently, and (as of this report) deployed to production at `beyond.alfieprime.com`.

## What shipped

**Table & seating foundation**
- Prompt 1 — Fixed chair forward-direction and rescale: root-caused as a bad bounding-box measurement (stray geometry skewing the scale-to-height math), not a wrong target constant; corrected per-model forward-axis rotation baked into `ChairModel`.
- Prompt 2 — Two tables join into one square surface, centered on the seam; fixed the visible top-alignment gap raised directly by the owner (legs now clip under the table rather than forcing a visible gap between tops).
- Prompt 3 — Dynamic table-capacity auto-expansion as the party grows past a single table's seat count.
- Prompt 4a/4b — Persisted per-seat position override (data layer) + a live chair-drag gesture with camera follow, so a player can drag their own chair anywhere and the camera tracks it.
- Owner follow-up — Chair resize: player chairs 2.5x, DM throne 1.75x, per the owner's exact multipliers.

**Model orientation & rigging**
- Prompt 5 — Research spike: design for per-model forward-direction metadata and a skeleton-posing approach for arbitrary uploaded rigs.
- Prompt 6 — Forward-direction metadata storage + an upload-time UI for setting it per custom asset.
- Prompt 7 — Skeleton-based posing for seated avatars and placed NPC tokens, replacing rigid unposed models.

**Dice trays**
- Prompt 8a — Per-member dice-tray-model preference and tray-position data layer.
- Prompt 8b — Replaced the single shared dice tray with one personal tray per connected member, each following that member's own seat/chair position live.

**Camera**
- Prompt 9 — Turn-based camera angle: an automatically-offered better viewing angle on a player's own combat turn.
- Prompt 10 — Arrow-key seated look-around, independent of camera position, with a 30-second auto-recenter.

**Token movement**
- Prompt 11 — Reachable-cell computation: a budget-limited movement-range search respecting terrain cost and elevation.
- Prompt 12 — Replaced token drag-to-move with click-select → highlight reachable cells → click-to-confirm.
- Prompt 13 — Animated token moves as a smooth slide instead of an instant snap.

## Verification

Every prompt above was independently verified via this project's established `scripts/db/verify-*.mjs` real-Playwright-browser convention (not just unit tests), plus `yarn lint` / `yarn tsc --noEmit` / `yarn test` clean at each merge point. The full suite currently stands at 688 tests across 48 files, all passing on `master`.

## Known issue surfaced by this work, still open

Three separate investigation passes (spanning this plan and later map-editor work) attempted to reproduce a reported bug where the DM's or a player's model occasionally teleports to the table center or loads at a hugely wrong scale, reportedly tied to custom uploaded models specifically after a page reload. Despite a real, narrowly-targeted reproduction script (`scripts/db/verify-avatar-reload.mjs`, 16+ real reload cycles across two rigged fixtures) built specifically around the owner's precise repro description, the bug has not been reproduced. One genuine, separate regression was found and fixed along the way (an SSR hydration mismatch in `seating.ts`'s trig-derived seat coordinates), confirmed not to be the cause of the reported symptom. This remains open — tracked separately, pending either a live capture of the browser's console/network state the next time it occurs, or new reproduction information.

## Architecture notes for future work in this area

- `GameRoom.tsx` remains the single most-touched file across this whole plan (Prompts 4b, 8b, 9, 10, 12 all edit it) — subsequent map-editor work (per-viewer maps, pits/falling, bridges/stairs, Freeform combat) has continued to land there too. Any future prompt touching seating/camera/tokens should expect to integrate serially against this file regardless of how independent the underlying designs are.
- Chair/avatar geometry uses real glTF models measured via `Box3` at runtime (the `ChairModel`/`SeatAvatar` pattern), not procedural placeholders — the established precedent for any future seat-furniture or avatar work.
- Per-viewer/per-seat state (dice trays, chair offsets, look-around) all follow the same "keyed by `user_id`, synced via the campaign realtime channel" shape — the precedent to reuse for any new per-player UI state.
