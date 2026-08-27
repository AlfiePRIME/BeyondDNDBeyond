"use client";

import { useEffect, useMemo, useRef, type RefObject } from "react";
import { useFrame } from "@react-three/fiber";
import { AdditiveBlending, BufferAttribute, BufferGeometry, Color, PointsMaterial } from "three";
import type { WeatherKind } from "./GameTableScene";

/** Verification-only: which particle variant is currently mounted, and how
 * many real points it has — see WeatherParticlesProps.onDebug's own doc
 * comment for why this exists. */
export interface WeatherParticlesDebugState {
  kind: "firestorm" | "acid_storm";
  particleCount: number;
}

export interface WeatherParticlesProps {
  weatherKind: WeatherKind;
  /**
   * Verification-only pass-through, fired whenever the mounted particle
   * variant changes (including to null when neither is active) — the exact
   * onTokenSlideDebug/onWhiteboardDebug convention this scene already uses
   * everywhere else (their own doc comments' reasoning applies verbatim
   * here): WebGL has no DOM of its own for a script to confirm a real,
   * kind-DISTINCT particle system is actually mounted, without
   * pixel-diffing a screenshot. Omitting it changes nothing about what
   * renders.
   */
  onDebug?: (state: WeatherParticlesDebugState | null) => void;
}

/**
 * Two from-scratch three.js Points particle systems for Weather & Enemies
 * C4's fantasy weather kinds (embers/fire-glow for firestorm, a falling
 * green corrosive haze for acid storm).
 *
 * C2's Droplets (a screen-space WebGL shader over the whole Game Room
 * canvas, simulating rain running down glass) was being built in a
 * parallel worktree and hadn't landed in this one — the C4 prompt
 * explicitly allows building a standalone particle effect instead of
 * depending on it ("reuse C2's Droplets ... if that reads well ... or
 * build a simple from-scratch particle effect if not"). Rising embers have
 * nothing in common with rain-on-glass regardless of whether Droplets ever
 * lands, so firestorm always gets its own system here; acid storm's
 * falling-haze motion is closer in spirit to rain, but is kept as its own
 * simple particle system too, for the same "don't depend on C2 landing"
 * reasoning — and because a from-scratch system can look and move exactly
 * like a slow, sickly falling haze rather than sharp rain-on-glass streaks.
 *
 * Purely decorative: this component has no opinion on
 * campaigns.weather_mechanical (the periodic-damage toggle,
 * GameRoom.tsx's own periodic-tick effect) — it renders identically
 * whether or not the mechanical timer is currently armed, matching the C4
 * prompt's own framing that the visual is a property of the weather KIND,
 * not of whether it happens to be dealing damage right now.
 */
export function WeatherParticles({ weatherKind, onDebug }: WeatherParticlesProps) {
  if (weatherKind === "firestorm") return <Embers onDebug={onDebug} />;
  if (weatherKind === "acid_storm") return <AcidHaze onDebug={onDebug} />;
  return <NoParticles onDebug={onDebug} />;
}

function NoParticles({ onDebug }: { onDebug?: (state: WeatherParticlesDebugState | null) => void }) {
  useEffect(() => {
    onDebug?.(null);
  }, [onDebug]);
  return null;
}

// Horizontal spread, in meters, for both particle systems — comfortably
// inside the room's own 24-radius floor circle (GameTableScene's floor
// mesh) and well within normal seated/orbit viewing distance, so the
// effect reads as filling the room around the table rather than being
// confined to just the tabletop surface.
const HORIZONTAL_SPREAD = 13;

/** Builds an EMPTY (zero-filled) BufferGeometry sized for `count` points —
 * deliberately free of any randomness so it stays a pure useMemo (this
 * project's react-hooks/purity lint rule forbids calling Math.random
 * during render, which a useMemo factory counts as). The actual random
 * scatter is filled in by a companion useEffect in each of Embers/AcidHaze
 * below, which — unlike a render-phase useMemo — is allowed to be impure. */
function useEmptyDriftGeometry(count: number) {
  return useMemo(() => {
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new BufferAttribute(new Float32Array(count * 3), 3));
    geometry.setAttribute("color", new BufferAttribute(new Float32Array(count * 3), 3));
    return geometry;
  }, [count]);
}

/** Randomizes `geometry`'s position/color attributes once, on mount — the
 * impure counterpart to useEmptyDriftGeometry above, run from a plain
 * useEffect (not render) specifically so Math.random is never called
 * during render. Also fills `speedsRef.current` (a same-length Float32Array)
 * with one random per-particle speed in [speedMin, speedMax], read every
 * frame by the caller's own useFrame.
 *
 * Takes the REF OBJECT itself, not its `.current` value — this project's
 * react-hooks/refs lint rule forbids reading a ref's `.current` during
 * render, which passing `speedsRef.current` as a plain call argument here
 * would count as (the read happens at the call site, during the calling
 * component's render). Dereferencing `.current` only ever happens inside
 * this hook's own effect body below, which is exempt (effects aren't
 * "render"). */
function useRandomizeDrift(
  geometry: BufferGeometry,
  speedsRef: RefObject<Float32Array>,
  count: number,
  minY: number,
  maxY: number,
  colors: readonly string[],
  speedMin: number,
  speedMax: number
) {
  useEffect(() => {
    const position = geometry.getAttribute("position") as BufferAttribute;
    const color = geometry.getAttribute("color") as BufferAttribute;
    const palette = colors.map((hex) => new Color(hex));
    const speeds = speedsRef.current;
    for (let i = 0; i < count; i++) {
      position.setXYZ(
        i,
        (Math.random() - 0.5) * 2 * HORIZONTAL_SPREAD,
        minY + Math.random() * (maxY - minY),
        (Math.random() - 0.5) * 2 * HORIZONTAL_SPREAD
      );
      const paletteColor = palette[i % palette.length];
      color.setXYZ(i, paletteColor.r, paletteColor.g, paletteColor.b);
      speeds[i] = speedMin + Math.random() * (speedMax - speedMin);
    }
    position.needsUpdate = true;
    color.needsUpdate = true;
    // Intentionally runs once per geometry instance only — geometry is a
    // stable reference for this component's whole lifetime (useMemo keyed
    // on `count`, which never changes for a given Embers/AcidHaze
    // instance), so this never re-randomizes mid-flight and reset an
    // in-progress drift.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geometry]);
}

const EMBER_COUNT = 220;
const EMBER_MIN_Y = 0.3;
const EMBER_MAX_Y = 7.5;
const EMBER_RISE_SPEED_MIN = 0.6;
const EMBER_RISE_SPEED_MAX = 1.6;
const EMBER_COLORS = ["#ff8a3d", "#ffcf5c", "#ff4d2e"] as const;

function Embers({ onDebug }: { onDebug?: (state: WeatherParticlesDebugState | null) => void }) {
  const geometry = useEmptyDriftGeometry(EMBER_COUNT);
  const material = useMemo(
    () =>
      new PointsMaterial({
        size: 0.09,
        vertexColors: true,
        transparent: true,
        opacity: 0.85,
        depthWrite: false,
        blending: AdditiveBlending,
        sizeAttenuation: true,
      }),
    []
  );
  const speedsRef = useRef<Float32Array>(new Float32Array(EMBER_COUNT));
  useRandomizeDrift(
    geometry,
    speedsRef,
    EMBER_COUNT,
    EMBER_MIN_Y,
    EMBER_MAX_Y,
    EMBER_COLORS,
    EMBER_RISE_SPEED_MIN,
    EMBER_RISE_SPEED_MAX
  );

  useEffect(() => {
    onDebug?.({ kind: "firestorm", particleCount: EMBER_COUNT });
    return () => onDebug?.(null);
  }, [onDebug]);

  useEffect(() => {
    return () => {
      geometry.dispose();
      material.dispose();
    };
  }, [geometry, material]);

  useFrame((_, delta) => {
    const position = geometry.getAttribute("position") as BufferAttribute;
    const speeds = speedsRef.current;
    for (let i = 0; i < EMBER_COUNT; i++) {
      let y = position.getY(i) + speeds[i] * delta;
      if (y > EMBER_MAX_Y) y = EMBER_MIN_Y; // loop back to the floor once it drifts out of view
      position.setY(i, y);
      // A gentle sideways sway so embers don't rise in dead-straight lines.
      position.setX(i, position.getX(i) + Math.sin((y + i) * 1.3) * delta * 0.15);
    }
    position.needsUpdate = true;
  });

  return <points geometry={geometry} material={material} />;
}

const ACID_COUNT = 260;
const ACID_MIN_Y = 0.3;
const ACID_MAX_Y = 8;
const ACID_FALL_SPEED_MIN = 1.2;
const ACID_FALL_SPEED_MAX = 2.6;
const ACID_COLORS = ["#7cff6b", "#3ddc84", "#a8ff9e"] as const;

function AcidHaze({ onDebug }: { onDebug?: (state: WeatherParticlesDebugState | null) => void }) {
  const geometry = useEmptyDriftGeometry(ACID_COUNT);
  const material = useMemo(
    () =>
      new PointsMaterial({
        size: 0.12,
        vertexColors: true,
        transparent: true,
        opacity: 0.55,
        depthWrite: false,
        sizeAttenuation: true,
      }),
    []
  );
  const speedsRef = useRef<Float32Array>(new Float32Array(ACID_COUNT));
  useRandomizeDrift(
    geometry,
    speedsRef,
    ACID_COUNT,
    ACID_MIN_Y,
    ACID_MAX_Y,
    ACID_COLORS,
    ACID_FALL_SPEED_MIN,
    ACID_FALL_SPEED_MAX
  );

  useEffect(() => {
    onDebug?.({ kind: "acid_storm", particleCount: ACID_COUNT });
    return () => onDebug?.(null);
  }, [onDebug]);

  useEffect(() => {
    return () => {
      geometry.dispose();
      material.dispose();
    };
  }, [geometry, material]);

  useFrame((_, delta) => {
    const position = geometry.getAttribute("position") as BufferAttribute;
    const speeds = speedsRef.current;
    for (let i = 0; i < ACID_COUNT; i++) {
      let y = position.getY(i) - speeds[i] * delta;
      if (y < ACID_MIN_Y) y = ACID_MAX_Y; // loop back to the ceiling once it settles to the floor
      position.setY(i, y);
      position.setX(i, position.getX(i) + Math.sin((y + i) * 0.9) * delta * 0.1);
    }
    position.needsUpdate = true;
  });

  return <points geometry={geometry} material={material} />;
}
