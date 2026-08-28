/**
 * Game Room music: resolves which of the two loop-capable music channels
 * (calm_music/combat_music — LOOP_SOUND_KEYS in soundManager.ts) should be
 * playing given whether combat is currently active, and applies that
 * resolution to SP1's own startLoop/stopLoop API. Mirrors weatherAudio.ts's
 * own resolve/apply split exactly: `resolveGameMusic` is a pure function of
 * ONLY the combat-active boolean — no scene state, no side effects — so a
 * real Playwright check can assert the exact expected channel for a given
 * combat state without needing to wait on a fade.
 *
 * Unlike weather's three independently-toggleable channels (a thunderstorm
 * genuinely wants rain AND wind together), calm/combat music is always
 * mutually exclusive — exactly one of the two plays at any moment, never
 * both, never neither, while the Game Room is mounted at all.
 *
 * `applyGameMusic` calls startLoop/stopLoop for BOTH channels on every
 * evaluation rather than diffing against the previous combat-active value,
 * the same "both are already idempotent no-ops when a channel's desired
 * state already matches its current one" reasoning weatherAudio.ts's own
 * applyWeatherAudio doc comment gives — no transition-tracking ref (a
 * previousIsDeadRef-style guard) is needed here either.
 */
import { SOUND_KEYS, startLoop, stopLoop, type LoopSoundKey } from "./soundManager";

export interface GameMusicChannels {
  calm: boolean;
  combat: boolean;
}

export function resolveGameMusic(combatActive: boolean): GameMusicChannels {
  return { calm: !combatActive, combat: combatActive };
}

const CHANNEL_LOOP_KEYS: Record<keyof GameMusicChannels, LoopSoundKey> = {
  calm: SOUND_KEYS.CALM_MUSIC,
  combat: SOUND_KEYS.COMBAT_MUSIC,
};

const ALL_CHANNELS = Object.keys(CHANNEL_LOOP_KEYS) as (keyof GameMusicChannels)[];

export function applyGameMusic(combatActive: boolean, options: { fadeMs?: number } = {}): void {
  const channels = resolveGameMusic(combatActive);
  for (const channel of ALL_CHANNELS) {
    const key = CHANNEL_LOOP_KEYS[channel];
    if (channels[channel]) {
      void startLoop(key, options);
    } else {
      stopLoop(key, options);
    }
  }
}
