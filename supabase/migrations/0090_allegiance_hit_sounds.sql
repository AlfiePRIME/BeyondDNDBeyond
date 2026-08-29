-- Extends sound_overrides.sound_key's CHECK constraint (0084/0085/0086) to
-- admit 3 new allegiance-keyed hit sounds: hit_player/hit_enemy/hit_npc —
-- an ordinary (non-critical, non-miss) attack roll now picks its sound by
-- WHO got hit (a party member, a hostile, or a neutral NPC) instead of the
-- single flat hit_normal every target used to share. hit_normal itself
-- stays in the registry as the fallback for the rare case a target's
-- allegiance can't be resolved client-side (see DiceLogPanel.tsx's
-- attackRollSoundKey) — hit_critical/hit_miss are untouched, still fired
-- regardless of who was hit.
alter table public.sound_overrides drop constraint if exists sound_overrides_sound_key_check;

alter table public.sound_overrides add constraint sound_overrides_sound_key_check
  check (sound_key in (
    'dice_impact',
    'pit_fall',
    'hit_normal',
    'hit_critical',
    'hit_miss',
    'hit_player',
    'hit_enemy',
    'hit_npc',
    'token_move',
    'door_transition',
    'death',
    'rain_loop',
    'wind_loop',
    'thunder',
    'fire_loop',
    'nat_20',
    'nat_1',
    'lobby_music',
    'calm_music',
    'combat_music'
  ));
