// Public entry point for the audio module (Sound Effects SP1). Every other
// Sound Effects prompt (SP2-SP9) — and anything outside src/audio generally
// — should import through here, never reach into soundManager.ts directly
// (see eslint.config.mjs's "audio" element + no-restricted-imports entry,
// the same barrel-only convention every other module in this project
// already enforces).
//
// The actual volume-slider/mute-toggle UI control is NOT exported from
// here — it lives at src/app/campaigns/[id]/room/SoundControl.tsx instead,
// alongside DraggablePanel.tsx's useSoundSettings hook it depends on. This
// module stays a plain, framework-agnostic audio engine with no dependency
// on any specific route/page component — the opposite direction (a
// route-level component importing FROM here) is the correct one, exactly
// how GameRoom.tsx already consumes everything else in this file.
export {
  SOUND_KEYS,
  ALL_SOUND_KEYS,
  LOOP_SOUND_KEYS,
  getVariantCount,
  playSound,
  startLoop,
  stopLoop,
  isLoopActive,
  setMasterVolume,
  setMuted,
  getMasterVolume,
  isMuted,
  getDebugSnapshot,
  subscribeDebugState,
  clearPlayLog,
  supportsSoundManager,
  type SoundKey,
  type LoopSoundKey,
  type SoundManagerDebugSnapshot,
} from "./soundManager";

// Sound Effects SP9 — weather ambience: see weatherAudio.ts's own top-of-file
// doc comment for the full resolveWeatherAudio/applyWeatherAudio writeup and
// the exact per-weather-kind channel matrix.
export { resolveWeatherAudio, applyWeatherAudio, type WeatherKind, type WeatherAudioChannels } from "./weatherAudio";

// Game Room music (calm/combat) — see gameMusic.ts's own top-of-file doc
// comment for the full resolveGameMusic/applyGameMusic writeup.
export { resolveGameMusic, applyGameMusic, type GameMusicChannels } from "./gameMusic";
