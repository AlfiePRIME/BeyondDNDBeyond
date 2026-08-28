/**
 * Sound Effects SP9 — weather ambience: resolves which of the three
 * loop-capable channels (rain/wind/fire — LOOP_SOUND_KEYS in soundManager.ts;
 * `thunder` is a one-shot, wired separately in LightningFlash.tsx alongside
 * the existing visual flash) should be playing for a given campaign
 * weather_kind, and applies that resolution to SP1's own startLoop/stopLoop
 * API.
 *
 * `resolveWeatherAudio` is a pure function of ONLY the weather kind — no
 * scene state, no side effects — the exact same shape as GameTableScene.tsx's
 * own `resolveSceneFog` and CloudLayer.tsx's own `resolveCloudPreset`: a
 * small lookup callable both from real wiring (`applyWeatherAudio` below,
 * called from a GameRoom.tsx effect keyed on weatherKind) and directly from
 * a debug mirror, so a real Playwright check can assert the exact expected
 * channel combination for a kind without needing to wait on a fade or infer
 * it indirectly from the sound manager's own real (necessarily
 * fade-delayed) active-loop state.
 *
 * The channel matrix (the project owner's own confirmed final weather-audio
 * brief, matched one-for-one against GameTableScene.tsx's seven WeatherKind
 * values):
 *   clear        — none
 *   fog          — wind only
 *   cloudy       — none (CloudLayer's own overhead sky-dressing is the only
 *                  effect 'cloudy' activates anywhere in this app — see its
 *                  own doc comment for the full 'cloudy' vs 'fog'
 *                  distinction; weather audio follows the same rule)
 *   rain         — rain only
 *   thunderstorm — rain AND wind together (the storm's own rain plus the
 *                  same storm system's wind — one of the two genuinely
 *                  dual-channel kinds; easy to under-implement as "rain
 *                  only," which is explicitly wrong per the brief)
 *   firestorm    — wind AND fire together (wind fanning/carrying the blaze
 *                  plus the ambient roar of the fire itself — the OTHER
 *                  dual-channel kind; easy to under-implement as "fire
 *                  only," equally wrong)
 *   acid_storm   — wind only (the same corrosive-air-movement reasoning as
 *                  fog — no rain/fire channel of its own)
 *
 * This module deliberately declares its own local WeatherKind union rather
 * than importing scene-3d's (GameTableScene.tsx's own WeatherKind doc
 * comment already establishes this "separately-declared identical union,
 * not an import" convention between scene-3d and data-access) — src/audio
 * stays a plain, framework-agnostic engine with no dependency on any
 * specific scene/route module (see this module's own barrel index.ts
 * top-of-file doc comment). A caller passing a scene-3d WeatherKind value
 * here still type-checks: both unions are the exact same seven string
 * literals, so TypeScript's structural typing accepts either at either call
 * site with no cast needed.
 */
import { SOUND_KEYS, startLoop, stopLoop, type LoopSoundKey } from "./soundManager";

export type WeatherKind = "clear" | "fog" | "cloudy" | "rain" | "thunderstorm" | "firestorm" | "acid_storm";

/** Which of the three loop-capable ambient channels should be active for a
 * given weather kind. Boolean per channel (not a single enum) specifically
 * because two kinds — thunderstorm, firestorm — need MORE than one channel
 * active simultaneously; an enum could only ever express one winner. */
export interface WeatherAudioChannels {
  rain: boolean;
  wind: boolean;
  fire: boolean;
}

const WEATHER_AUDIO_CHANNELS: Record<WeatherKind, WeatherAudioChannels> = {
  clear: { rain: false, wind: false, fire: false },
  fog: { rain: false, wind: true, fire: false },
  cloudy: { rain: false, wind: false, fire: false },
  rain: { rain: true, wind: false, fire: false },
  thunderstorm: { rain: true, wind: true, fire: false },
  firestorm: { rain: false, wind: true, fire: true },
  acid_storm: { rain: false, wind: true, fire: false },
};

export function resolveWeatherAudio(weatherKind: WeatherKind): WeatherAudioChannels {
  return WEATHER_AUDIO_CHANNELS[weatherKind];
}

/** Maps each boolean channel above to the real LOOP_SOUND_KEYS registry key
 * startLoop/stopLoop expect — the one place this module's own `rain`/`wind`/
 * `fire` vocabulary is translated into soundManager.ts's SoundKey strings. */
const CHANNEL_LOOP_KEYS: Record<keyof WeatherAudioChannels, LoopSoundKey> = {
  rain: SOUND_KEYS.RAIN_LOOP,
  wind: SOUND_KEYS.WIND_LOOP,
  fire: SOUND_KEYS.FIRE_LOOP,
};

const ALL_CHANNELS = Object.keys(CHANNEL_LOOP_KEYS) as (keyof WeatherAudioChannels)[];

/**
 * Applies resolveWeatherAudio(weatherKind) to the real audio graph — the one
 * wiring point a weather-kind change (a real DM click, or another client's
 * live sync of the exact same DB row) needs to call. Deliberately calls
 * startLoop/stopLoop for EVERY channel on every evaluation rather than
 * diffing against whatever the previous weatherKind was: both are already
 * idempotent no-ops when a channel's desired state already matches its
 * current one (see startLoop/stopLoop's own doc comments in soundManager.ts)
 * — starting an already-active loop or stopping an already-inactive one is a
 * safe, cheap no-op — so this needs no "what changed" tracking of its own,
 * and a rapid back-to-back weather flip still only ever produces one real
 * crossfade per channel (startLoop's own "caught mid-fade-out" reversal,
 * stopLoop's own "already fading out" no-op guard) rather than stacking
 * overlapping fades. Both startLoop and stopLoop are themselves no-ops
 * outside a browser (soundManager's own `typeof window === "undefined"`
 * guard), so calling this during SSR or in a test environment is always
 * safe.
 */
export function applyWeatherAudio(weatherKind: WeatherKind, options: { fadeMs?: number } = {}): void {
  const channels = resolveWeatherAudio(weatherKind);
  for (const channel of ALL_CHANNELS) {
    const key = CHANNEL_LOOP_KEYS[channel];
    if (channels[channel]) {
      void startLoop(key, options);
    } else {
      stopLoop(key, options);
    }
  }
}
