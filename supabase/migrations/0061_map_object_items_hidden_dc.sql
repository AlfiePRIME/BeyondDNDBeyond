-- Map Editor Batch A5: hidden items with passive-Perception reveal. Adds an
-- OPTIONAL DC to a container item (A4's map_object_items row) — null (the
-- default, and every row A4 ever wrote) means "not hidden", exactly A4's
-- original always-visible-once-opened behavior, unchanged.
--
-- Deliberately NOT a per-viewer reveal table (unlike combatant_hidden_from,
-- Prompt 60's hidden-from-a-specific-character mechanism) — reveal here is
-- computed, not stored: a character's passive Perception is already fully
-- determined by their own ability scores/proficiencies/level (all plain
-- character-sheet columns), so there is nothing stateful to persist per
-- (item, character) pair, and nothing here would ever go stale the way a
-- Hide roll's result would. The Game Room computes "is this item visible to
-- THIS character" live, every render, off this one column plus the
-- viewer's own already-loaded character row — see vision.ts's
-- isItemVisibleToCharacter. This is the same "per-viewer presentation
-- masking in the Game Room, not RLS" posture hiddenFrom.ts's own top
-- comment describes for combatant_hidden_from's rendering side: RLS below
-- is intentionally UNCHANGED from 0060 (a member can still read a chest's
-- hidden_dc column like every other column on a chest item they're already
-- allowed to read at all) — the DC value itself isn't the secret, whether
-- the DM decides to reveal the ITEM to a given viewer is a client-side
-- rendering decision, exactly like a hidden token's position already is.
alter table public.map_object_items
  add column if not exists hidden_dc integer;

alter table public.map_object_items
  add constraint map_object_items_hidden_dc_positive
  check (hidden_dc is null or hidden_dc > 0);
