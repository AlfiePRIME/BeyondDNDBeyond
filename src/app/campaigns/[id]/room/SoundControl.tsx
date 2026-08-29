"use client";

import { useEffect, useState } from "react";
import {
  ALL_SOUND_KEYS,
  LOOP_SOUND_KEYS,
  getDebugSnapshot,
  playSound,
  setMasterVolume,
  setMuted,
  startLoop,
  stopLoop,
  subscribeDebugState,
} from "@/audio";
import { Button } from "@/ui-components";
import { useSoundSettings } from "./DraggablePanel";
import styles from "./SoundControl.module.css";

interface SoundControlProps {
  /** True for the campaign's DM only — gates the two quick music toggles
   * below, which mirror DmBook.tsx's Day/Night-page controls
   * (calm-music-toggle/combat-music-toggle). Players never see these: the
   * underlying campaigns.calm_music_enabled/combat_music_enabled columns
   * are DM-only settings, same as the book's own copy. */
  isDM: boolean;
  /** GameRoom's own calmMusicEnabled/combatMusicEnabled state — the SAME
   * state DmBook.tsx's toggles already read, passed through here so this
   * is a second UI surface for it, not a second source of truth. */
  calmMusicEnabled: boolean;
  combatMusicEnabled: boolean;
  /** GameRoom's musicSettingsBusy — shared across both toggles (and the
   * book's own pair) since they persist through the same campaigns row. */
  musicSettingsBusy: boolean;
  /** GameRoom's handleToggleCalmMusicEnabled/handleToggleCombatMusicEnabled
   * — the EXACT SAME handlers DmBook.tsx's toggles call, so clicking here
   * or in the book hits the identical read/write path. */
  onToggleCalmMusicEnabled: () => void;
  onToggleCombatMusicEnabled: () => void;
}

/**
 * Sound Effects SP1 — the real, reachable home for the master volume
 * slider + mute toggle: mounted once in GameRoom's top bar
 * (`.overlayControls`, alongside PanelDockBar/the ruler toggle/the camera
 * toggle). Also owns two things every future Sound Effects prompt (SP2-
 * SP9) benefits from, both explained below.
 *
 * Also hosts the DM-only "quick" calm/combat music toggles: the book's own
 * Day/Night-page controls are the only way to reach
 * calm_music_enabled/combat_music_enabled, buried three clicks deep behind
 * opening the 3D book and switching tabs. These are a second, redundant
 * access point for the SAME state/handlers (threaded in as props from
 * GameRoom, which owns them) — small icon-style buttons matching the mute
 * button next to them, not full-width controls, since this is an already
 * fairly busy top bar. The book's own toggles are left completely
 * untouched.
 */
export function SoundControl({
  isDM,
  calmMusicEnabled,
  combatMusicEnabled,
  musicSettingsBusy,
  onToggleCalmMusicEnabled,
  onToggleCombatMusicEnabled,
}: SoundControlProps) {
  const { settings, setVolume, setMuted: setMutedPreference } = useSoundSettings();

  // Hidden render-state mirror for verify-sound-infra.mjs (and every later
  // Sound Effects prompt's own verify script) — this project's established
  // visionDebug/tableSurfaceDebug convention (GameRoom.tsx) applied to the
  // Web Audio graph, which — like a WebGL canvas — has no DOM of its own
  // for Playwright to inspect directly.
  //
  // Declared BEFORE the two sync effects below on purpose — a real,
  // reproduced ordering bug otherwise: React runs a component's effects in
  // the order they're declared, and setMasterVolume/setMuted below each
  // call notifyDebugListeners() synchronously. Subscribing to that
  // notification AFTER those effects would miss the very first one (the
  // mount-time sync that applies a just-loaded/reloaded user's persisted
  // volume) — confirmed directly via verify-sound-infra.mjs's own reload
  // check, which caught this mirror silently staying frozen at the
  // manager's bare startup default after every reload despite the real
  // volume having been applied correctly underneath.
  //
  // ALSO polled on a short interval, not just notify()-driven — a second
  // real, reproduced bug this closes: notify() only fires on discrete
  // manager actions (playSound/startLoop/stopLoop/setMasterVolume/
  // setMuted), but a loop's gain node keeps changing continuously for the
  // whole `fadeMs` crossfade via the Web Audio engine's OWN internal
  // scheduling, with no further JS-visible event marking its progress. A
  // notify()-only mirror froze at whatever gain happened to be true at the
  // one instant a loop transitioned to "active" (typically still ~0, right
  // as its fade-in starts) and never updated again — confirmed directly by
  // sampling the REAL gain node from inside this same module while the
  // mirror sat frozen: the actual audio graph was ramping correctly the
  // entire time, only this DEBUG MIRROR was stale. 200ms is frequent enough
  // to catch a fade's progress meaningfully without costing anything
  // noticeable — this interval only ever drives this one small component's
  // own re-render, never GameRoom's.
  const [debugSnapshot, setDebugSnapshot] = useState(() => getDebugSnapshot());
  useEffect(() => subscribeDebugState(() => setDebugSnapshot(getDebugSnapshot())), []);
  useEffect(() => {
    const interval = setInterval(() => setDebugSnapshot(getDebugSnapshot()), 200);
    return () => clearInterval(interval);
  }, []);

  // Live sync: whenever the caller's persisted soundSettings changes — from
  // dragging THIS slider, from another tab, or from a different campaign's
  // room (ui_preferences is account-wide, not campaign-scoped) —
  // useSoundSettings re-renders this component and these effects push the
  // new value straight into the real audio graph. This is what makes an
  // ALREADY-PLAYING loop's actual gain update immediately on a remote
  // change, not just future sounds: soundManager's single master GainNode
  // means every currently-scheduled node is affected the instant
  // setMasterVolume/setMuted runs. Also runs once on mount, so a returning
  // user's saved preference is applied before the very first sound plays.
  useEffect(() => {
    setMasterVolume(settings.volume);
  }, [settings.volume]);

  useEffect(() => {
    setMuted(settings.muted);
  }, [settings.muted]);

  return (
    <div className={styles.soundControl} data-testid="sound-control">
      <Button
        size="sm"
        variant={settings.muted ? "danger" : "ghost"}
        onClick={() => setMutedPreference(!settings.muted)}
        aria-label={settings.muted ? "Unmute sound" : "Mute sound"}
        title={settings.muted ? "Unmute sound" : "Mute sound"}
        data-testid="sound-mute-toggle"
      >
        <span aria-hidden="true">{settings.muted ? "🔇" : "🔊"}</span>
      </Button>
      <input
        type="range"
        className={styles.volumeSlider}
        min={0}
        max={1}
        step={0.01}
        value={settings.volume}
        onChange={(event) => setVolume(Number(event.target.value))}
        aria-label="Master sound volume"
        title="Master sound volume"
        data-testid="sound-volume-slider"
      />
      {/* DM-only quick music toggles — see this component's own doc comment
          above. Same small icon-button treatment as the mute toggle right
          before them (size="sm", no label text beyond the emoji), so this
          pair reads as "part of the sound control cluster" rather than a
          new full-width control competing for top-bar space. */}
      {isDM ? (
        <>
          <Button
            size="sm"
            variant={calmMusicEnabled ? "teal" : "ghost"}
            onClick={onToggleCalmMusicEnabled}
            disabled={musicSettingsBusy}
            aria-label={calmMusicEnabled ? "Turn off ambient music" : "Turn on ambient music"}
            title={calmMusicEnabled ? "Ambient music: on" : "Ambient music: off"}
            aria-pressed={calmMusicEnabled}
            data-testid="quick-calm-music-toggle"
          >
            <span aria-hidden="true">🎵</span>
          </Button>
          <Button
            size="sm"
            variant={combatMusicEnabled ? "teal" : "ghost"}
            onClick={onToggleCombatMusicEnabled}
            disabled={musicSettingsBusy}
            aria-label={combatMusicEnabled ? "Turn off combat music" : "Turn on combat music"}
            title={combatMusicEnabled ? "Combat music: on" : "Combat music: off"}
            aria-pressed={combatMusicEnabled}
            data-testid="quick-combat-music-toggle"
          >
            <span aria-hidden="true">⚔️</span>
          </Button>
        </>
      ) : null}
      <div data-testid="sound-manager-debug" hidden>
        {JSON.stringify(debugSnapshot)}
      </div>
      {/* Sound Effects SP1's own verification surface: real DOM buttons
          (not a window global) so verify-sound-infra.mjs can exercise
          genuine playSound/startLoop/stopLoop calls via a real Playwright
          `.click()` — deliberately NOT `hidden`/display:none (which has no
          clickable layout box) and NOT a synthetic `locator.dispatchEvent
          ("click")` either: confirmed directly during this component's own
          verify-script development, a dispatchEvent-driven click never
          reached React's onClick handler at all here (no play-log entry,
          no loop ever registered), while an identical real `.click()` works
          every time — real pointer-based clicks are the reliable choice.
          Styled to a tiny, visually negligible on-screen footprint
          (SoundControl.module.css's `.testHarness`) rather than truly
          hidden, specifically so Playwright's real click keeps working —
          this is SP1's own foundation-level test surface for its manager
          API, not a player-facing control; nothing in SP1 itself has a real
          gameplay trigger wired to sound yet (that's SP3-SP8's job — token
          moves, combat hits, dice impacts, etc). */}
      <div className={styles.testHarness} data-testid="sound-test-harness">
        {ALL_SOUND_KEYS.map((key) => (
          <button
            key={key}
            type="button"
            data-testid={`sound-test-play-${key}`}
            onClick={() => void playSound(key)}
          >
            {key}
          </button>
        ))}
        {LOOP_SOUND_KEYS.map((key) => (
          <span key={key}>
            <button
              type="button"
              data-testid={`sound-test-start-loop-${key}`}
              onClick={() => void startLoop(key)}
            >
              start {key}
            </button>
            <button
              type="button"
              data-testid={`sound-test-stop-loop-${key}`}
              onClick={() => stopLoop(key)}
            >
              stop {key}
            </button>
          </span>
        ))}
      </div>
    </div>
  );
}
