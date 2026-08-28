-- Extends sound_overrides.sound_key's CHECK constraint (0084) to admit the
-- two new SOUND_KEYS added for natural-20/natural-1 rolls on any non-attack
-- d20 (checks/saves/skills/initiative/hide/death_save/concentration_save —
-- see DiceLogPanel.tsx's naturalRollSoundKey and src/audio/soundManager.ts).
-- 0084's own CHECK constraint must be dropped and recreated rather than
-- edited in place, since that migration is already applied — this project's
-- established "never edit an already-applied migration" discipline.
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
    'nat_1'
  ));
