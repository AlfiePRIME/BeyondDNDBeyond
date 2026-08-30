-- map_transitions stays DM-only readable (0025) by design — a player's
-- client must never learn WHERE a transition leads (spoiler prevention),
-- keeping to_map_id/to_x/to_y fully DM-only. But a real regression this
-- session showed the cost of that being ALL-or-nothing: a structural
-- object (a decorative building) sitting on the same cell as a transition
-- already correctly falls through to a normal move for the DM's own client
-- (GameRoom.tsx's handleSelectedTokenCellClick + blockedCellsForMovement),
-- since the DM's client has the full map_transitions list. A PLAYER's
-- client has none of it (map_transitions RLS returns nothing for a
-- non-DM), so the identical cell is flatly blocked for a player's own
-- move — "Something's in the way there" — even though the intended
-- behavior is the DM deciding whether the party may cross, exactly like
-- concealed_pits' own "DM resolves it after the move lands" pattern
-- (0050), except a pit was never a blocking OBJECT in the first place, so
-- it never needed this.
--
-- This narrow view exposes ONLY the three columns needed to know "does a
-- transition exist at this cell" (no destination) to anyone who can
-- otherwise read the map itself — can_read_map(from_map_id) already
-- encodes exactly that "DM, or member viewing the live map" rule (0015).
-- Views run as their OWNER for permission purposes (not the querying
-- role), so this intentionally does NOT rely on map_transitions' own RLS
-- at all — the `where` clause below is the entire access check, evaluated
-- fresh per row against the real caller's auth.uid() (can_read_map is
-- security definer), not bypassed or widened for anyone it wouldn't
-- already apply to.
create or replace view public.map_transition_anchors as
  select from_map_id, from_x, from_y
  from public.map_transitions
  where public.can_read_map(from_map_id);

grant select on public.map_transition_anchors to authenticated;
