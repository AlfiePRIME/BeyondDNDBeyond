/**
 * Game Room music: resolves which of the two loop-capable music channels
 * (calm_music/combat_music — LOOP_SOUND_KEYS in soundManager.ts) should be
 * playing given whether combat is currently active AND the DM's own
 * per-channel enable toggles (campaigns.calm_music_enabled/
 * combat_music_enabled — GameRoom.tsx's own handleToggleCalmMusicEnabled/
 * handleToggleCombatMusicEnabled, surfaced in DmBook.tsx's Day/Night page),
 * and applies that resolution to SP1's own startLoop/stopLoop API. Mirrors
 * weatherAudio.ts's own resolve/apply split exactly: `resolveGameMusic` is a
 * pure function of its inputs — no scene state, no side effects — so a real
 * Playwright check can assert the exact expected channel for a given
 * combat/toggle combination without needing to wait on a fade.
 *
 * The two toggles are independent, not one "music on/off" switch: a DM can
 * turn off combat_music while keeping calm_music (or vice versa), so
 * turning one off does NOT fall back to the other — with both channels
 * disabled during combat, for instance, the Game Room is simply silent
 * (no music), never a surprise substitution.
 *
 * Unlike weather's three independently-toggleable channels (a thunderstorm
 * genuinely wants rain AND wind together), when BOTH toggles are enabled
 * calm/combat music stay mutually exclusive — never both playing at once —
 * exactly as before this DM-toggle addition.
 *
 * `applyGameMusic` calls startLoop/stopLoop for BOTH channels on every
 * evaluation rather than diffing against the previous inputs, the same
 * "both are already idempotent no-ops when a channel's desired state
 * already matches its current one" reasoning weatherAudio.ts's own
 * applyWeatherAudio doc comment gives — no transition-tracking ref (a
 * previousIsDeadRef-style guard) is needed here either.
 */
import { SOUND_KEYS, startLoop, stopLoop, type LoopSoundKey } from "./soundManager";

export interface GameMusicChannels {
  calm: boolean;
  combat: boolean;
}

/** The DM's own per-channel enable toggles — see this module's own
 * top-of-file doc comment for why they're independent, not a single
 * music-on/off switch. */
export interface GameMusicSettings {
  calmEnabled: boolean;
  combatEnabled: boolean;
}

export function resolveGameMusic(combatActive: boolean, settings: GameMusicSettings): GameMusicChannels {
  return {
    calm: settings.calmEnabled && !combatActive,
    combat: settings.combatEnabled && combatActive,
  };
}

const CHANNEL_LOOP_KEYS: Record<keyof GameMusicChannels, LoopSoundKey> = {
  calm: SOUND_KEYS.CALM_MUSIC,
  combat: SOUND_KEYS.COMBAT_MUSIC,
};

const ALL_CHANNELS = Object.keys(CHANNEL_LOOP_KEYS) as (keyof GameMusicChannels)[];

export function applyGameMusic(
  combatActive: boolean,
  settings: GameMusicSettings,
  options: { fadeMs?: number } = {}
): void {
  const channels = resolveGameMusic(combatActive, settings);
  for (const channel of ALL_CHANNELS) {
    const key = CHANNEL_LOOP_KEYS[channel];
    if (channels[channel]) {
      void startLoop(key, options);
    } else {
      stopLoop(key, options);
    }
  }
}
