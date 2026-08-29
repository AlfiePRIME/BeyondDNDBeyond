"use client";

import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { Color, IcosahedronGeometry, MeshStandardMaterial, Object3D, type InstancedMesh } from "three";
import type { WeatherKind } from "./GameTableScene";

/**
 * An overhead drifting-cloud layer, visible for EVERY weatherKind (including
 * 'clear' and 'fog') — unlike WeatherParticles.tsx (embers/acid haze, which
 * returns null for every kind except its own two), this component has no
 * null branch at all: it always renders real cloud geometry, only its
 * COLOR/density/altitude/drift speed vary by weatherKind. That's the direct
 * answer to this feature's own brief ("an overhead cloud layer visible for
 * EVERY weather kind") — a weather-conditional mount (WeatherParticles'
 * pattern) would be the wrong shape here, since there is no weatherKind this
 * layer should ever disappear for.
 *
 * Procedural, dependency-free geometry — the same precedent diceGeometry.ts
 * already established for this project (three.js's own built-in primitives,
 * no external asset/texture pipeline): each "cloud" is a small cluster of
 * overlapping low-poly IcosahedronGeometry puffs sharing one InstancedMesh,
 * one draw call for the whole sky regardless of weatherKind. A real texture
 * pass (soft alpha-blended cloud sprites) would look better up close, but
 * the brief explicitly doesn't require a texture/asset pipeline, and simple
 * overlapping solid puffs read fine at this project's normal seated/orbit
 * viewing distances (cloud altitude sits just above the table and this
 * room's own seated camera height — see CLOUD_PRESETS' own extensive doc
 * comment below for the real camera-frustum math this specific band is
 * based on, and its own minY/maxY per kind).
 *
 * **Why this design can't reproduce Droplets.tsx's stale storm-switch bug**
 * (the fixed bug this feature was explicitly asked to learn from): every
 * single visual property this component ever renders — puff position
 * (drift phase → x, altitude lerp → y), which puffs are even visible
 * (active-cluster count → per-instance scale), and the material's own
 * color/opacity — is recomputed FRESH, from CURRENT weatherKind, every
 * single frame, in the one useFrame loop below. There is no separate
 * per-effect "mode" object that only gets updated on a weatherKind
 * TRANSITION (the shape of bug Droplets had: a stale snapshot surviving a
 * change because nothing told it to update). The only state this component
 * keeps across frames at all is the drift clock itself (clusterPhase) and
 * the geometry's fixed, randomized-once shape (cluster/puff layout,
 * per-puff brightness) — nothing here is scoped to "the weather kind that
 * was active when this last changed," so there is nothing that can go
 * stale across a switch. Confirmed directly by verify-weather-clouds.mjs's
 * own round-trip check (every kind → every other kind, including back to a
 * previously-visited one, asserting the mirror always matches
 * resolveCloudPreset for whatever is CURRENT).
 */
export interface CloudLayerProps {
  weatherKind: WeatherKind;
}

/** Pure per-weatherKind cloud appearance — the resolveSceneFog precedent
 * exactly (GameTableScene.tsx's own fog-composition function): a plain,
 * side-effect-free function of one enum input, callable directly from
 * outside the R3F tree (GameRoom.tsx's own hidden weather-state debug
 * mirror) for a real, exact-value read without needing anything off the
 * live WebGL scene. CloudLayer itself calls this same function every frame
 * (see the useFrame loop below) — there is exactly one source of truth for
 * "what should the sky look like right now," read fresh every time, never
 * duplicated into a second copy that could drift out of sync. */
export interface CloudPreset {
  /** Base tint applied to every puff (multiplied by each puff's own baked
   * brightness variance — see PUFF_BRIGHTNESS_MIN/MAX below). */
  color: string;
  /** Material opacity (0 to 1). */
  opacity: number;
  /** How many of TOTAL_CLUSTERS are actually visible (the rest are scaled
   * to zero every frame) — this is how sky COVERAGE varies (sparse for
   * 'clear', a full overcast blanket for 'cloudy'/'thunderstorm') without
   * ever resizing the InstancedMesh itself. */
  activeClusters: number;
  /** Cloud altitude band (world Y), always above TABLE_SURFACE_Y (~1.4) and
   * around/just above the seated camera's own eye height (4.3, seating.ts)
   * — see CLOUD_PRESETS' own "Altitude band" doc comment below for the real
   * camera-frustum math behind this specific range, and each preset's own
   * comment for why the band itself varies by kind. */
  minY: number;
  maxY: number;
  /** Drift speed along X, in world units per second (see DRIFT_WRAP_SPAN
   * below for the wrap-around range this is relative to). */
  driftSpeed: number;
}

/** Total cloud formations always allocated (never resized — see
 * CloudPreset.activeClusters' own doc comment for how density actually
 * varies) and puffs per formation. Raised from 16 to 32 (96 -> 192 total
 * instanced puffs) specifically so thunderstorm could get a genuinely
 * heavier sky than the old shared 16-cluster ceiling allowed — every other
 * kind's own activeClusters value is UNCHANGED, so their look is identical
 * to before this increase; only thunderstorm actually uses the extra
 * headroom. Still one draw call regardless of weatherKind — see
 * scripts/perf/cloud-frame-time-benchmark.mjs for the measured real cost
 * at this new size. */
const TOTAL_CLUSTERS = 32;
const PUFFS_PER_CLUSTER = 6;
const TOTAL_PUFFS = TOTAL_CLUSTERS * PUFFS_PER_CLUSTER;

/** Clusters drift along X and wrap around within [-SPAN/2, SPAN/2]. Kept
 * deliberately modest (well under the room's own 24-radius floor circle's
 * diameter) rather than spanning the room's full extent — clouds scattered
 * out near the floor's own edge sit at a low elevation angle from any
 * camera near the table (this feature's own real, measured finding: at this
 * altitude band, a wide horizontal spread reads as clouds sitting at the
 * horizon rather than genuinely overhead — see CLOUD_PRESETS' own "Altitude
 * band" doc comment for the full camera-geometry writeup). A cloud drifting
 * past the wrap boundary reappears on the other side well outside normal
 * close-viewing range regardless, the same "loop back once it drifts out of
 * view" convention WeatherParticles' embers/acid haze already use on their
 * own Y axis. */
const DRIFT_WRAP_SPAN = 26;

/** Per-puff baked shading variance (a grayscale multiplier on top of the
 * preset's own color, via InstancedMesh.setColorAt — see the mount effect
 * below) — purely cosmetic texture so a cluster reads as a fluffy, uneven
 * cumulus mass rather than a flat blob of one solid color. Baked ONCE per
 * puff at mount and never changed by a weatherKind switch (the variance is
 * a property of "which puff," not "which weather"), while the preset color
 * it multiplies against DOES update live every frame — exactly the same
 * "stable baked shape, live color" split diceGeometry's dice meshes and
 * WeatherParticles' embers/acid both already use. */
const PUFF_BRIGHTNESS_MIN = 0.85;
const PUFF_BRIGHTNESS_MAX = 1.15;

/**
 * Every campaign weather kind's overhead sky, with the reasoning behind
 * each choice — connecting each tint/density/altitude to what that weather
 * kind actually represents, not arbitrary colors:
 *
 * - clear: bright, barely-tinted near-white (a faint violet warmth echoing
 *   DAY_NIGHT_PRESETS.day's own ambientColor #b9a6ff, so a clear sky reads
 *   as lit by this room's own sunlight rather than a generic stock-white).
 *   Deliberately SPARSE (5 of 16 clusters) rather than zero: an early pass
 *   at this feature tried a fully cloudless 'clear' and it was impossible
 *   to tell, from a screenshot alone, whether the cloud layer had failed to
 *   mount at all versus correctly rendering "no clouds" — a few thin,
 *   scattered, high, fast-nowhere-in-particular puffs read unambiguously as
 *   "a working, fair-weather sky" instead. The HIGHEST altitude band of any
 *   kind and the slowest reasonable drift — a calm, unhurried fair-weather
 *   sky, distant and unhurried relative to every other kind.
 *
 * - cloudy (the new weather kind this feature adds): a pale, neutral
 *   grey-white, FULL coverage (16 of 16 clusters, the densest of any kind
 *   tied only with thunderstorm) — the one deliberate visual signature that
 *   makes 'cloudy' unmistakably itself: a genuinely overcast blanket
 *   overhead, distinct from clear's sparse puffs AND from fog's own duller,
 *   thinner grey (below). This is the ONLY visual effect 'cloudy' has —
 *   see resolveSceneFog (GameTableScene.tsx), deliberately untouched by
 *   this addition: 'cloudy' composes its fog exactly like 'clear' (falls
 *   through resolveSceneFog's `if (weatherKind === "fog")` check, since
 *   'cloudy' !== 'fog'), so day/night's own ordinary fog stands completely
 *   unchanged and ground-level visibility is normal. No particles either
 *   (WeatherParticles only special-cases 'firestorm'/'acid_storm'). This is
 *   the deliberate mechanical distinction from 'fog': cloudy is a pure
 *   sky-dressing weather with zero effect on anything at ground level;
 *   fog is a ground-level visibility mechanic that says nothing about the
 *   sky. See migration 0079_cloudy_weather.sql's own comment for the full
 *   writeup of this distinction.
 *
 * - fog: reuses the EXACT grey WEATHER_FOG_PRESET.color (#9aa0ad) already
 *   used for the close, ground-hugging haze itself (GameTableScene.tsx) —
 *   so the low mist and the dull sky above it read as one coherent gloomy
 *   weather system, even though only the ground fog is the actual
 *   visibility-obscuring mechanic (this layer is purely decorative and
 *   never touches resolveSceneFog). Thinner coverage and lower opacity than
 *   'cloudy' (9/16 clusters, 0.7 opacity vs cloudy's 16/16 and 0.95) and the
 *   LOWEST altitude band of any fair-to-overcast kind — a flat, low,
 *   washed-out ceiling sitting just above the haze, not a bold overcast
 *   blanket, keeping 'fog' visually distinct from 'cloudy' at a glance
 *   despite the shared grey.
 *
 * - rain: a slate blue-grey, denser than cloudy's neutral grey (rain-laden
 *   clouds read heavier/wetter than a plain overcast) and faster drift than
 *   any fair-weather kind — a moving weather front, not a static overcast.
 *
 * - thunderstorm: the darkest, most oppressive palette of any kind — a
 *   near-black charcoal with a faint purple cast (a deliberate nod to this
 *   room's own PURPLE accent light/lightning, without inventing an
 *   unrelated hue) — the DENSEST sky of any kind (32/32, double every other
 *   kind's own coverage, including cloudy's 16 — a deliberate, heavy
 *   increase specifically for thunderstorm's own oppressive/overwhelming
 *   feel, using the extra headroom TOTAL_CLUSTERS was raised to provide),
 *   the fastest drift of any kind (a storm system actively moving through),
 *   and the LOWEST altitude band of any kind — a heavy, low, fast-moving
 *   ceiling directly overhead, matching the synchronized LightningFlash
 *   overlay this same weatherKind already activates.
 *
 * - firestorm: a burnt orange-brown, read as ash/smoke clouds lit from
 *   below by WeatherParticles' own rising embers — connects directly to
 *   the existing effect rather than an arbitrary "fire color."
 *
 * - acid_storm: a sickly olive green, deliberately the same hue family as
 *   WeatherParticles' own ACID_COLORS falling haze — the overhead clouds
 *   read as the same corrosive airborne substance, just further away.
 *
 * **Altitude band, and why it's much lower than "sky height" would suggest**
 * (a real finding from this feature's own visual verification, not an
 * arbitrary number): this room's camera is ALWAYS steeply pitched down at
 * the tabletop — seatAtAngle's own seat camera (seating.ts) sits at
 * CAMERA_EYE_HEIGHT=4.3 looking at LOOK_TARGET's table-height 1.4 from only
 * a few units back, and the no-seat fallback camera (FALLBACK_CAMERA_POSITION,
 * this file) is pitched even steeper. Worked out from the seat camera's own
 * real numbers (confirmed directly via a live chair-drag-state read during
 * this feature's own manual verification): a 50°-fov camera pitched ~28°
 * below horizontal has a top-of-frustum edge that ITSELF still points
 * ~3° below horizontal — so nothing positioned above roughly the camera's
 * own eye height is EVER visible in the default view, regardless of how
 * this layer's horizontal position is tuned. WeatherParticles' embers
 * (max height 7.5, confirmed visible near the very top edge of frame in a
 * real screenshot) are the empirical ceiling this feature could actually
 * confirm looks right without requiring a player to deliberately orbit the
 * camera up and away from the table — so CloudLayer's own altitude band
 * sits in that same confirmed-visible range (roughly 4.5-9) rather than at
 * a more conventional "sky height" (e.g. 12+) that would be geometrically
 * present but invisible from this room's own default, table-focused
 * camera. The room has no ceiling mesh at all (see GameTableScene's own
 * "ceiling-less skybox" comment on LOOK_AROUND_MAX_PITCH) — clouds still
 * DO exist much higher up conceptually, this band is just where this
 * room's own camera convention can actually show them without a player
 * needing to deliberately switch to Free Camera and orbit overhead first.
 */
const CLOUD_PRESETS: Record<WeatherKind, CloudPreset> = {
  clear: { color: "#fdf9ff", opacity: 0.85, activeClusters: 5, minY: 6.5, maxY: 9, driftSpeed: 0.6 },
  cloudy: { color: "#c9cdd9", opacity: 0.95, activeClusters: 16, minY: 6, maxY: 8.5, driftSpeed: 0.9 },
  fog: { color: "#9aa0ad", opacity: 0.7, activeClusters: 9, minY: 5, maxY: 7, driftSpeed: 0.4 },
  rain: { color: "#5b6675", opacity: 0.92, activeClusters: 14, minY: 5.5, maxY: 7.5, driftSpeed: 1.6 },
  thunderstorm: { color: "#2b2733", opacity: 0.97, activeClusters: 32, minY: 4.5, maxY: 6.5, driftSpeed: 2.2 },
  firestorm: { color: "#8a3a1f", opacity: 0.88, activeClusters: 12, minY: 5.5, maxY: 7.5, driftSpeed: 1.2 },
  acid_storm: { color: "#5a7a3f", opacity: 0.88, activeClusters: 12, minY: 5.5, maxY: 7.5, driftSpeed: 1.0 },
};

export function resolveCloudPreset(weatherKind: WeatherKind): CloudPreset {
  return CLOUD_PRESETS[weatherKind];
}

export function CloudLayer({ weatherKind }: CloudLayerProps) {
  const meshRef = useRef<InstancedMesh>(null);
  const dummy = useMemo(() => new Object3D(), []);

  // Pure, deterministic construction — no Math.random here (this project's
  // react-hooks/purity lint rule forbids calling it during render, which a
  // useMemo factory counts as). Real randomization happens in the
  // companion useEffect below, the exact useEmptyDriftGeometry/
  // useRandomizeDrift split WeatherParticles.tsx already established.
  const geometry = useMemo(() => new IcosahedronGeometry(1, 1), []);
  const material = useMemo(
    () =>
      new MeshStandardMaterial({
        transparent: true,
        depthWrite: false,
        roughness: 1,
        metalness: 0,
      }),
    []
  );
  // Per-cluster state, mutated every frame (clusterPhase, the drift clock)
  // or fixed once at mount (clusterZ/clusterYT — see the effect below).
  // Plain Float32Arrays, not React state: this updates every single frame,
  // and re-rendering the component 60x/second to hold it in useState would
  // be exactly the kind of cascading-render the project's own lint already
  // steers away from (see WeatherParticles.tsx's own doc comment on this).
  const clusterPhase = useMemo(() => new Float32Array(TOTAL_CLUSTERS), []);
  const clusterZ = useMemo(() => new Float32Array(TOTAL_CLUSTERS), []);
  const clusterYT = useMemo(() => new Float32Array(TOTAL_CLUSTERS), []);
  // Per-puff fixed local offsets from their cluster's own center, plus a
  // fixed per-puff scale/yaw — baked once, forming each cluster's own
  // cumulus-like silhouette (see the randomizing effect below for the
  // actual ranges).
  const puffDx = useMemo(() => new Float32Array(TOTAL_PUFFS), []);
  const puffDy = useMemo(() => new Float32Array(TOTAL_PUFFS), []);
  const puffDz = useMemo(() => new Float32Array(TOTAL_PUFFS), []);
  const puffScale = useMemo(() => new Float32Array(TOTAL_PUFFS), []);
  const puffYaw = useMemo(() => new Float32Array(TOTAL_PUFFS), []);

  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    for (let c = 0; c < TOTAL_CLUSTERS; c++) {
      // Random starting phase so clusters don't all begin lined up at the
      // same X and visibly drift in lockstep.
      clusterPhase[c] = Math.random() * DRIFT_WRAP_SPAN;
      clusterZ[c] = (Math.random() - 0.5) * 2 * (DRIFT_WRAP_SPAN * 0.4);
      clusterYT[c] = Math.random();
    }
    const brightness = new Color();
    for (let i = 0; i < TOTAL_PUFFS; i++) {
      puffDx[i] = (Math.random() - 0.5) * 3.2;
      // Biased slightly upward (puffs stack a bit taller than they hang
      // low) for a rough cumulus silhouette rather than a flat disc.
      puffDy[i] = (Math.random() - 0.35) * 0.8;
      puffDz[i] = (Math.random() - 0.5) * 2.0;
      puffScale[i] = 0.7 + Math.random() * 0.7;
      puffYaw[i] = Math.random() * Math.PI * 2;
      const value = PUFF_BRIGHTNESS_MIN + Math.random() * (PUFF_BRIGHTNESS_MAX - PUFF_BRIGHTNESS_MIN);
      mesh.setColorAt(i, brightness.setScalar(value));
    }
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    // Intentionally runs once for this component's whole lifetime (the
    // memoized arrays above are stable references) — never re-randomizes
    // mid-flight and resets an in-progress drift, the same guarantee
    // useRandomizeDrift documents for WeatherParticles.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    return () => {
      geometry.dispose();
      material.dispose();
    };
  }, [geometry, material]);

  // The one place every visual property this component renders is derived,
  // fresh, from the CURRENT weatherKind every frame — see this file's own
  // top-of-file doc comment for why that's exactly what rules out a
  // Droplets-style stale-overlay bug across a weather switch.
  useFrame((_, rawDelta) => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const delta = Math.min(rawDelta, 1 / 20);
    const preset = resolveCloudPreset(weatherKind);
    let i = 0;
    for (let c = 0; c < TOTAL_CLUSTERS; c++) {
      clusterPhase[c] = (clusterPhase[c] + preset.driftSpeed * delta) % DRIFT_WRAP_SPAN;
      const x = clusterPhase[c] - DRIFT_WRAP_SPAN / 2;
      const y = preset.minY + clusterYT[c] * (preset.maxY - preset.minY);
      const z = clusterZ[c];
      const active = c < preset.activeClusters;
      for (let p = 0; p < PUFFS_PER_CLUSTER; p++, i++) {
        dummy.position.set(x + puffDx[i], y + puffDy[i], z + puffDz[i]);
        dummy.rotation.set(0, puffYaw[i], 0);
        dummy.scale.setScalar(active ? puffScale[i] : 0);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
      }
    }
    mesh.instanceMatrix.needsUpdate = true;
    material.color.set(preset.color);
    material.opacity = preset.opacity;
  });

  return (
    <instancedMesh
      ref={meshRef}
      args={[geometry, material, TOTAL_PUFFS]}
      // The auto-computed bounding sphere three.js uses for frustum culling
      // is derived from the GEOMETRY alone (a single unit icosahedron),
      // centered on this object's own local origin — it has no idea the
      // real instances are scattered/animated across DRIFT_WRAP_SPAN's own
      // extent, so relying on it would risk the whole sky popping in/out incorrectly
      // as the camera moves. Always render; 96 low-poly instances in one
      // draw call is cheap enough that this costs nothing measurable (see
      // scripts/perf/cloud-frame-time-benchmark.mjs).
      frustumCulled={false}
    />
  );
}
