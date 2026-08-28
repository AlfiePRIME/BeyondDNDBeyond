-- Extends sound_overrides.sound_key's CHECK constraint (0084, extended by
-- 0085) to admit the three new SOUND_KEYS added for Lobby/Game Room music
-- loops (lobby_music, calm_music, combat_music — see LobbyPresence.tsx's
-- and GameRoom.tsx's own resolveGameMusic wiring, and
-- src/audio/soundManager.ts's LOOP_SOUND_KEYS).
alter table public.sound_overrides drop constraint if exists sound_overrides_sound_key_check;

alter table public.sound_overrides add constraint sound_overrides_sound_key_check
  check (sound_key in (
    'dice_impact',
    'pit_fall',
    'hit_normal',
    'hit_critical',
    'hit_miss',
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
