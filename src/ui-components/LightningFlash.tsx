"use client";

import { useEffect, useRef } from "react";
import { playSound, SOUND_KEYS } from "@/audio";
import { computeLightningFlash, seedFromString, type LightningFlashState } from "./lightning";

/**
 * Weather & Enemies C3 — the thunderstorm lightning overlay: a full-screen
 * white flash sitting on top of the Game Room's own live scene (and, while
 * thunderstorm is active, C2's Droplets rain-on-glass overlay too — this
 * renders AFTER Droplets in GameRoom.tsx so a flash washes out the rained
 * glass exactly like it would wash out everything else). A plain DOM
 * overlay was chosen over spiking the R3F scene's own directional/ambient
 * light intensities (the C3 prompt's own Context names both options): it
 * reads as a genuine "bright overexposure of the scene" regardless of
 * tone-mapping/exposure on the underlying WebGL renderer, it needs no
 * plumbing through GameTableScene's own light refs, and (like Droplets) it
 * can sit as a screen-space sibling of `<Canvas>` that never intercepts
 * pointer events.
 *
 * The actual flash TIMING comes entirely from computeLightningFlash
 * (lightning.ts) — a pure function of (campaign-derived seed, wall-clock
 * time) that every connected client evaluates independently and gets the
 * identical answer from, which is the whole cross-client synchronization
 * mechanism (see lightning.ts's own top-of-file doc comment for why that
 * was chosen over broadcasting each flash as a realtime event).
 *
 * Sound Effects SP9 — the `thunder` one-shot (SOUND_KEYS.THUNDER) rides this
 * exact SAME per-frame computeLightningFlash evaluation, not a second,
 * independent trigger: the tick() loop below already calls it every rAF
 * frame for the visual opacity, so watching for THAT SAME call's own
 * `state.active` flipping false->true (a new flash beginning) and firing
 * playSound right there gets a synced thunder sound for free — every
 * connected client independently reaches the identical false->true instant
 * from the identical deterministic schedule, with no new broadcast/sync
 * mechanism of its own, the same zero-cross-client-skew property the visual
 * flash already has. Deliberately NOT hooked off the throttled
 * `onDebugChange` callback below (~25Hz, DEBUG_TICK_MS) — that callback
 * exists only to feed a hidden Playwright mirror at a coarse, "good enough
 * to observe a >=160ms window" rate, and polling it for a transition would
 * both lag the real flash instant and risk missing a short flash between two
 * throttled ticks; tick()'s own per-frame `state` is the frame-accurate
 * source both effects should read from.
 *
 * Deliberately follows Droplets' own "don't drive a 60fps animation through
 * React state" discipline: the visible opacity is written straight onto the
 * overlay DOM node via a ref inside a plain requestAnimationFrame loop, so
 * this never causes GameRoom (a very large component) to re-render on every
 * frame. The `onDebugChange` callback IS routed through GameRoom's own
 * state (for the hidden `lightning-state` mirror a real Playwright check
 * reads), but is throttled internally to DEBUG_TICK_MS — far coarser than
 * the rAF loop — since a hidden testid mirror only needs to be fast enough
 * to reliably observe an active flash window (>=160ms, computeLightningFlash's
 * own MIN_DURATION_MS), not frame-accurate.
 */
const DEBUG_TICK_MS = 40;

const INACTIVE_DEBUG_STATE: LightningFlashState = { active: false, opacity: 0, bucket: -1 };

export interface LightningFlashProps {
  /** True only while campaign weather is 'thunderstorm' — false unmounts
   * the overlay and stops its loop entirely, so switching away from
   * thunderstorm stops the flashes immediately, the same way Droplets stops
   * the rain. */
  active: boolean;
  /** The campaign this Game Room belongs to — hashed into a deterministic
   * seed (lightning.ts's seedFromString) so every client rendering the SAME
   * campaign computes the SAME flash schedule. Passing the raw id (rather
   * than requiring the caller to hash it) keeps GameRoom.tsx from needing
   * to know anything about how the seed is derived. */
  campaignId: string;
  /** Fires on every throttled schedule tick while `active` — see this
   * file's own top-of-file doc comment for why this is throttled rather
   * than firing every rAF frame. */
  onDebugChange?: (state: LightningFlashState) => void;
}

export function LightningFlash({ active, campaignId, onDebugChange }: LightningFlashProps) {
  const elRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!active) {
      onDebugChange?.(INACTIVE_DEBUG_STATE);
      return;
    }
    const seed = seedFromString(campaignId);
    let raf = 0;
    let lastDebugAt = 0;
    // Local to this effect run (fresh false on every mount/campaignId
    // change) — see this file's own top-of-file doc comment for why the
    // thunder one-shot fires on THIS flag's false->true transition rather
    // than off the throttled onDebugChange callback.
    let wasActive = false;
    function tick(now: number) {
      const state = computeLightningFlash(seed, Date.now());
      if (elRef.current) elRef.current.style.opacity = String(state.opacity);
      if (state.active && !wasActive) {
        void playSound(SOUND_KEYS.THUNDER);
      }
      wasActive = state.active;
      if (onDebugChange && now - lastDebugAt >= DEBUG_TICK_MS) {
        lastDebugAt = now;
        onDebugChange(state);
      }
      raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // onDebugChange is expected to be a stable callback (useCallback at the
    // call site, matching Droplets' own onStatusChange convention) — not
    // listed as a dependency so a caller re-render between ticks can't tear
    // down and restart this rAF loop mid-flash.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, campaignId]);

  if (!active) return null;

  return (
    <div
      ref={elRef}
      aria-hidden
      style={{
        position: "absolute",
        inset: 0,
        pointerEvents: "none",
        backgroundColor: "#ffffff",
        opacity: 0,
      }}
    />
  );
}

export default LightningFlash;
